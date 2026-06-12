//! SSH connection lifecycle: authentication (on-disk key, or password), optional
//! `ProxyJump` bastions, and the shared [`Connection`] handle that the SFTP and
//! PTY layers build channels on top of.

use std::sync::Arc;

use russh::client;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{Mutex, MutexGuard};
use uuid::Uuid;

use crate::AppState;

/// How to authenticate to a server. Serialized from the frontend as an
/// internally-tagged enum: `{ "type": "password", "password": "..." }` for a
/// manual connection, or `{ "type": "auto", "identityFile": "..." }` for a
/// config host (key-based).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AuthMethod {
    /// Authenticate with a password held in memory for this session only.
    Password { password: String },
    /// Key-based auth that mirrors OpenSSH: try the config `IdentityFile`, then
    /// the default on-disk keys (`~/.ssh/id_*`). Unencrypted keys only — there
    /// is no ssh-agent and no passphrase prompt; add an `IdentityFile` host to
    /// your SSH config to use a key.
    Auto {
        #[serde(default)]
        identity_file: Option<String>,
    },
}

/// Coarse connection state surfaced to the UI status bar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionState {
    Connecting,
    Connected,
    Reconnecting,
    Disconnected,
}

/// Status payload emitted on the `ssh-status` event and returned by
/// [`ssh_get_status`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub conn_id: String,
    pub state: ConnectionState,
    pub message: Option<String>,
}

/// Static details about a connection, retained for reconnect logic (Phase 2).
pub struct ConnectionInfo {
    pub host: String,
    pub port: u16,
    pub user: String,
}

/// A live SSH connection. One per server; channels (SFTP, PTY, exec) are
/// multiplexed over it.
pub struct Connection {
    pub id: String,
    pub info: ConnectionInfo,
    /// The authenticated russh client handle. All channel-opening methods take
    /// `&self`, so this is shared behind an [`Arc<Connection>`].
    pub handle: client::Handle<ClientHandler>,
    /// Lazily-opened SFTP session, reused across file operations. Guarded by an
    /// async mutex because SFTP requests are serialized over a single channel.
    pub sftp: Mutex<Option<SftpSession>>,
    /// Current coarse state.
    pub state: Mutex<ConnectionState>,
    /// When connecting through a bastion, the jump host's handle is kept alive
    /// here for the lifetime of the connection so the tunnel stays open.
    _jump: Option<client::Handle<ClientHandler>>,
}

impl Connection {
    /// Borrow the SFTP session, opening it on first use.
    ///
    /// The returned guard serializes SFTP operations for this connection, which
    /// is acceptable for an interactive file browser.
    pub async fn sftp(&self) -> Result<MutexGuard<'_, Option<SftpSession>>, String> {
        let mut guard = self.sftp.lock().await;
        if guard.is_none() {
            let channel = self
                .handle
                .channel_open_session()
                .await
                .map_err(|e| format!("failed to open SFTP channel: {e}"))?;
            channel
                .request_subsystem(true, "sftp")
                .await
                .map_err(|e| format!("failed to start SFTP subsystem: {e}"))?;
            let session = SftpSession::new(channel.into_stream())
                .await
                .map_err(|e| format!("failed to initialize SFTP: {e}"))?;
            *guard = Some(session);
        }
        Ok(guard)
    }

    /// Drop the cached SFTP session so the next operation re-opens it. Used when
    /// an SFTP call fails (e.g. the channel died).
    pub async fn reset_sftp(&self) {
        *self.sftp.lock().await = None;
    }
}

/// russh client handler. Phase 1 trusts every host key (trust-on-first-use);
/// Phase 2 will verify against `known_hosts`.
pub struct ClientHandler;

#[async_trait::async_trait]
impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh_keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

fn client_config() -> Arc<client::Config> {
    Arc::new(client::Config {
        // Keep interactive sessions alive; we never want the library to drop an
        // idle terminal out from under the user.
        inactivity_timeout: None,
        ..Default::default()
    })
}

fn emit_status(app: &AppHandle, conn_id: &str, state: ConnectionState, message: Option<String>) {
    let _ = app.emit(
        "ssh-status",
        ConnectionStatus {
            conn_id: conn_id.to_string(),
            state,
            message,
        },
    );
}

/// Parse the first hop of a `ProxyJump` value (`[user@]host[:port]`).
fn parse_jump(spec: &str, default_user: &str) -> (String, String, u16) {
    let first = spec.split(',').next().unwrap_or(spec).trim();
    let (user, rest) = match first.split_once('@') {
        Some((u, r)) => (u.to_string(), r),
        None => (default_user.to_string(), first),
    };
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().unwrap_or(22)),
        None => (rest.to_string(), 22),
    };
    (user, host, port)
}

/// Open a (possibly jumped) SSH transport and return the unauthenticated handle
/// for the target, plus the jump handle to keep alive.
async fn open_handle(
    config: Arc<client::Config>,
    host: &str,
    port: u16,
    user: &str,
    proxy_jump: Option<&str>,
) -> Result<(client::Handle<ClientHandler>, Option<client::Handle<ClientHandler>>), String> {
    match proxy_jump {
        None | Some("") => {
            let handle = client::connect(config, (host, port), ClientHandler)
                .await
                .map_err(|e| format!("could not reach {host}:{port}: {e}"))?;
            Ok((handle, None))
        }
        Some(spec) => {
            let (juser, jhost, jport) = parse_jump(spec, user);
            let mut jump = client::connect(config.clone(), (jhost.as_str(), jport), ClientHandler)
                .await
                .map_err(|e| format!("could not reach jump host {jhost}:{jport}: {e}"))?;
            // Authenticate the bastion with the same on-disk-key chain.
            auth_auto(&mut jump, &juser, None)
                .await
                .map_err(|e| format!("jump host authentication failed: {e}"))?;
            let channel = jump
                .channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0)
                .await
                .map_err(|e| format!("jump host could not reach {host}:{port}: {e}"))?;
            let handle = client::connect_stream(config, channel.into_stream(), ClientHandler)
                .await
                .map_err(|e| format!("could not establish SSH through jump host: {e}"))?;
            Ok((handle, Some(jump)))
        }
    }
}

async fn authenticate(
    handle: &mut client::Handle<ClientHandler>,
    user: &str,
    auth: &AuthMethod,
) -> Result<(), String> {
    match auth {
        AuthMethod::Password { password } => {
            let accepted = handle
                .authenticate_password(user, password.as_str())
                .await
                .map_err(|e| format!("password authentication error: {e}"))?;
            if accepted {
                Ok(())
            } else {
                Err("the server rejected the password".to_string())
            }
        }
        AuthMethod::Auto { identity_file } => {
            auth_auto(handle, user, identity_file.as_deref()).await
        }
    }
}

/// Key-based auth: try the config IdentityFile, then the default on-disk keys.
async fn auth_auto(
    handle: &mut client::Handle<ClientHandler>,
    user: &str,
    identity_file: Option<&str>,
) -> Result<(), String> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Some(path) = identity_file {
        candidates.push(std::path::PathBuf::from(path));
    }
    if let Some(dirs) = directories::UserDirs::new() {
        let ssh = dirs.home_dir().join(".ssh");
        for name in ["id_ed25519", "id_ecdsa", "id_rsa"] {
            candidates.push(ssh.join(name));
        }
    }

    for path in candidates {
        if !path.exists() {
            continue;
        }
        if let Ok(key) = russh_keys::load_secret_key(&path, None) {
            if let Ok(true) = handle
                .authenticate_publickey(user, Arc::new(key))
                .await
            {
                log::info!("authenticated with key {}", path.display());
                return Ok(());
            }
        }
    }

    Err("key authentication failed — no usable key was accepted. Add a host with \
         an IdentityFile to your SSH config, or use a password connection."
        .to_string())
}

/// Establish and authenticate a connection. Returns the connection id.
#[tauri::command]
pub async fn ssh_connect(
    state: State<'_, AppState>,
    app: AppHandle,
    host: String,
    port: u16,
    user: String,
    auth: AuthMethod,
    proxy_jump: Option<String>,
) -> Result<String, String> {
    let conn_id = Uuid::new_v4().to_string();
    emit_status(&app, &conn_id, ConnectionState::Connecting, None);
    log::info!("connecting to {user}@{host}:{port}");

    let fail = |app: &AppHandle, id: &str, e: String| -> String {
        log::warn!("connection {id} to {host}:{port} failed: {e}");
        emit_status(app, id, ConnectionState::Disconnected, Some(e.clone()));
        e
    };

    // Enforce a connect timeout so an unreachable host fails fast instead of
    // hanging on the OS default (~20s on Windows).
    let connect = open_handle(client_config(), &host, port, &user, proxy_jump.as_deref());
    let (mut handle, jump) =
        match tokio::time::timeout(std::time::Duration::from_secs(10), connect).await {
            Ok(Ok(pair)) => pair,
            Ok(Err(e)) => return Err(fail(&app, &conn_id, e)),
            Err(_) => {
                return Err(fail(
                    &app,
                    &conn_id,
                    format!("connection to {host}:{port} timed out after 10s (is the host reachable?)"),
                ))
            }
        };

    authenticate(&mut handle, &user, &auth)
        .await
        .map_err(|e| fail(&app, &conn_id, e))?;

    let connection = Arc::new(Connection {
        id: conn_id.clone(),
        info: ConnectionInfo { host, port, user },
        handle,
        sftp: Mutex::new(None),
        state: Mutex::new(ConnectionState::Connected),
        _jump: jump,
    });

    state
        .sessions
        .lock()
        .await
        .insert(conn_id.clone(), crate::Session::Ssh(connection));
    emit_status(&app, &conn_id, ConnectionState::Connected, None);
    log::info!("ssh connection {conn_id} established");
    Ok(conn_id)
}

/// Tear down a connection and notify the UI.
#[tauri::command]
pub async fn ssh_disconnect(
    state: State<'_, AppState>,
    app: AppHandle,
    conn_id: String,
) -> Result<(), String> {
    let session = state.sessions.lock().await.remove(&conn_id);
    if let Some(crate::Session::Ssh(connection)) = session {
        let _ = connection
            .handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }
    emit_status(&app, &conn_id, ConnectionState::Disconnected, None);
    log::info!("session {conn_id} closed");
    Ok(())
}

/// Report the current state of a connection.
#[tauri::command]
pub async fn ssh_get_status(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<ConnectionStatus, String> {
    let sessions = state.sessions.lock().await;
    let current = match sessions.get(&conn_id) {
        Some(crate::Session::Ssh(conn)) => *conn.state.lock().await,
        Some(crate::Session::Local) => ConnectionState::Connected,
        None => ConnectionState::Disconnected,
    };
    Ok(ConnectionStatus {
        conn_id,
        state: current,
        message: None,
    })
}
