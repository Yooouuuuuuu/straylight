//! SSH connection lifecycle: authentication (on-disk key, or password), optional
//! `ProxyJump` bastions, and the shared [`Connection`] handle that the SFTP and
//! PTY layers build channels on top of.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use russh::client;
use russh::Channel;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{Mutex, MutexGuard, RwLock};
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

/// Static details about a connection, used to re-establish it on reconnect.
pub struct ConnectionInfo {
    pub host: String,
    pub port: u16,
    pub user: String,
}

/// The live transport for a connection: the authenticated handle plus, when
/// jumped, the bastion handle kept alive so the tunnel stays open. Replaced
/// wholesale on reconnect, which is why it sits behind a lock.
struct Live {
    /// Behind an `Arc` so `open_channel` can clone it and release the `live`
    /// read lock before the network round-trip (russh's `Handle` isn't `Clone`).
    handle: Arc<client::Handle<ClientHandler>>,
    _jump: Option<client::Handle<ClientHandler>>,
}

/// A live SSH connection. One per server; channels (SFTP, PTY, exec) are
/// multiplexed over it.
pub struct Connection {
    pub id: String,
    pub info: ConnectionInfo,
    /// The live handle (and bastion tunnel), behind an `RwLock` so the reconnect
    /// supervisor can swap it in place — the connection id, and every tab,
    /// terminal, and tree root that references it, survives a reconnect.
    live: RwLock<Live>,
    /// Lazily-opened SFTP session, reused across file operations. Guarded by an
    /// async mutex because SFTP requests are serialized over a single channel.
    pub sftp: Mutex<Option<SftpSession>>,
    /// Current coarse state.
    pub state: Mutex<ConnectionState>,
    /// Retained so the supervisor can re-authenticate silently after a drop:
    /// key auth re-reads the on-disk key; a password is reused from memory only
    /// (it is never written to disk).
    auth: AuthMethod,
    proxy_jump: Option<String>,
    /// Set when the user explicitly disconnects, so the supervisor stops.
    stop: AtomicBool,
    /// Guards against running more than one supervisor task per connection.
    supervising: AtomicBool,
}

impl Connection {
    /// Borrow the SFTP session, opening it on first use.
    ///
    /// The returned guard serializes SFTP operations for this connection, which
    /// is acceptable for an interactive file browser.
    pub async fn sftp(&self) -> Result<MutexGuard<'_, Option<SftpSession>>, String> {
        let mut guard = self.sftp.lock().await;
        if guard.is_none() {
            let channel = self.open_channel().await?;
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

    /// Open a fresh session channel on the live handle. Used by SFTP, the PTY
    /// layer, and the supervisor's health probe; reading the lock means a
    /// reconnect (which write-locks) is briefly serialized against new channels.
    pub async fn open_channel(&self) -> Result<Channel<client::Msg>, String> {
        // Clone the (cheap) handle and drop the read guard before the network
        // round-trip, so an in-flight channel open never blocks a reconnect
        // (which needs the write lock).
        let handle = self.live.read().await.handle.clone();
        handle
            .channel_open_session()
            .await
            .map_err(|e| format!("could not open SSH channel: {e}"))
    }

    /// Open a `direct-tcpip` channel to `host:port` as reachable from the server
    /// — the per-connection tunnel behind local port forwarding.
    pub async fn open_direct_tcpip(
        &self,
        host: &str,
        port: u32,
    ) -> Result<Channel<client::Msg>, String> {
        let handle = self.live.read().await.handle.clone();
        handle
            .channel_open_direct_tcpip(host.to_string(), port, "127.0.0.1".to_string(), 0)
            .await
            .map_err(|e| format!("could not open tunnel to {host}:{port}: {e}"))
    }

    /// Drop the cached SFTP session so the next operation re-opens it. Used when
    /// an SFTP call fails (e.g. the channel died) and after a reconnect.
    pub async fn reset_sftp(&self) {
        *self.sftp.lock().await = None;
    }

    fn mark_stopped(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }

    fn is_stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
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
        // Probe the peer so a silently-dropped TCP (sleep, Wi-Fi change) surfaces
        // as a dead handle instead of hanging — the supervisor reconnects.
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
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
        live: RwLock::new(Live { handle: Arc::new(handle), _jump: jump }),
        sftp: Mutex::new(None),
        state: Mutex::new(ConnectionState::Connected),
        auth,
        proxy_jump,
        stop: AtomicBool::new(false),
        supervising: AtomicBool::new(false),
    });

    state
        .sessions
        .lock()
        .await
        .insert(conn_id.clone(), crate::Session::Ssh(connection.clone()));
    emit_status(&app, &conn_id, ConnectionState::Connected, None);
    ensure_supervisor(app.clone(), connection);
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
        // Stop the supervisor before dropping the transport, so it doesn't see
        // the close as a drop and try to reconnect.
        connection.mark_stopped();
        let _ = connection
            .live
            .read()
            .await
            .handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }
    emit_status(&app, &conn_id, ConnectionState::Disconnected, None);
    log::info!("session {conn_id} closed");
    Ok(())
}

/// Manually re-establish a connection — used by the UI's "Reconnect" action
/// after the supervisor has given up. Reuses the stored credentials and keeps
/// the same connection id, so open tabs and the terminal reattach.
#[tauri::command]
pub async fn ssh_reconnect(
    state: State<'_, AppState>,
    app: AppHandle,
    conn_id: String,
) -> Result<(), String> {
    let conn = state.ssh_connection(&conn_id).await?;
    conn.stop.store(false, Ordering::SeqCst);
    *conn.state.lock().await = ConnectionState::Reconnecting;
    emit_status(&app, &conn_id, ConnectionState::Reconnecting, None);
    match reestablish(&conn).await {
        Ok(()) => {
            conn.reset_sftp().await;
            *conn.state.lock().await = ConnectionState::Connected;
            emit_status(&app, &conn_id, ConnectionState::Connected, None);
            ensure_supervisor(app, conn);
            log::info!("connection {conn_id} reconnected (manual)");
            Ok(())
        }
        Err(e) => {
            *conn.state.lock().await = ConnectionState::Disconnected;
            emit_status(&app, &conn_id, ConnectionState::Disconnected, Some(e.clone()));
            Err(e)
        }
    }
}

/// How often the supervisor probes a connection's health (seconds).
const PROBE_INTERVAL_SECS: u64 = 12;
/// A live connection answers a channel-open quickly; bound the probe so a
/// half-open socket (sleep, Wi-Fi roam) is treated as dead rather than hanging.
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
/// Give up automatic reconnection after this many consecutive failures (the UI
/// then offers a manual Reconnect).
const MAX_RECONNECT_ATTEMPTS: u32 = 8;

/// Spawn the reconnect supervisor for a connection, unless one is already
/// running for it.
fn ensure_supervisor(app: AppHandle, conn: Arc<Connection>) {
    if conn.supervising.swap(true, Ordering::SeqCst) {
        return; // a supervisor is already watching this connection
    }
    tokio::spawn(async move {
        supervise(app, conn.clone()).await;
        conn.supervising.store(false, Ordering::SeqCst);
    });
}

/// Watch a connection's health; on a dropped transport, transition to
/// `Reconnecting` and retry with backoff until it recovers, the user
/// disconnects, or we exhaust the attempt budget.
async fn supervise(app: AppHandle, conn: Arc<Connection>) {
    loop {
        if sleep_or_stopped(&conn, PROBE_INTERVAL_SECS).await {
            return;
        }

        let alive = match tokio::time::timeout(PROBE_TIMEOUT, conn.open_channel()).await {
            Ok(Ok(channel)) => {
                // Close the probe channel so an idle connection doesn't leak one
                // channel per interval — but never block the loop on a half-open
                // socket waiting for the close handshake.
                let _ = tokio::time::timeout(Duration::from_secs(3), channel.close()).await;
                true
            }
            _ => false,
        };
        if alive {
            continue;
        }
        if conn.is_stopped() {
            return;
        }

        *conn.state.lock().await = ConnectionState::Reconnecting;
        emit_status(
            &app,
            &conn.id,
            ConnectionState::Reconnecting,
            Some("connection lost — reconnecting…".to_string()),
        );
        log::warn!("connection {} dropped; reconnecting", conn.id);

        let mut delay = 1u64;
        let mut attempt = 0u32;
        loop {
            if conn.is_stopped() {
                return;
            }
            attempt += 1;
            match reestablish(&conn).await {
                Ok(()) => {
                    conn.reset_sftp().await;
                    *conn.state.lock().await = ConnectionState::Connected;
                    emit_status(&app, &conn.id, ConnectionState::Connected, None);
                    log::info!("connection {} reconnected", conn.id);
                    break;
                }
                Err(e) => {
                    if attempt >= MAX_RECONNECT_ATTEMPTS {
                        *conn.state.lock().await = ConnectionState::Disconnected;
                        emit_status(
                            &app,
                            &conn.id,
                            ConnectionState::Disconnected,
                            Some(format!("could not reconnect after {attempt} attempts: {e}")),
                        );
                        log::warn!("connection {} gave up reconnecting: {e}", conn.id);
                        return;
                    }
                    emit_status(
                        &app,
                        &conn.id,
                        ConnectionState::Reconnecting,
                        Some(format!("reconnect attempt {attempt} failed: {e}")),
                    );
                    if sleep_or_stopped(&conn, delay).await {
                        return;
                    }
                    delay = (delay * 2).min(30);
                }
            }
        }
    }
}

/// Sleep up to `secs`, waking early (returning `true`) if the connection has
/// been stopped — so an explicit disconnect or shutdown isn't held up by a long
/// backoff or the idle probe interval.
async fn sleep_or_stopped(conn: &Connection, secs: u64) -> bool {
    let mut remaining_ms = secs.saturating_mul(1000);
    while remaining_ms > 0 {
        if conn.is_stopped() {
            return true;
        }
        let step = remaining_ms.min(250);
        tokio::time::sleep(Duration::from_millis(step)).await;
        remaining_ms -= step;
    }
    conn.is_stopped()
}

/// Re-open and re-authenticate the transport, swapping the live handle in place
/// so the connection id and all channels opened afterwards target the new link.
async fn reestablish(conn: &Connection) -> Result<(), String> {
    let connect = open_handle(
        client_config(),
        &conn.info.host,
        conn.info.port,
        &conn.info.user,
        conn.proxy_jump.as_deref(),
    );
    let (mut handle, jump) = match tokio::time::timeout(Duration::from_secs(10), connect).await {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => return Err(e),
        Err(_) => {
            return Err(format!(
                "connection to {}:{} timed out",
                conn.info.host, conn.info.port
            ))
        }
    };
    authenticate(&mut handle, &conn.info.user, &conn.auth).await?;
    let old = {
        let mut live = conn.live.write().await;
        std::mem::replace(&mut *live, Live { handle: Arc::new(handle), _jump: jump })
    };
    // Tear the old transport down off the critical path, time-bounded so a dead
    // socket can't hang us and a still-live bastion tunnel isn't leaked.
    tokio::spawn(async move {
        let _ = tokio::time::timeout(Duration::from_secs(5), async move {
            if let Some(jump) = old._jump {
                let _ = jump
                    .disconnect(russh::Disconnect::ByApplication, "", "en")
                    .await;
            }
            let _ = old
                .handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
        })
        .await;
    });
    Ok(())
}

