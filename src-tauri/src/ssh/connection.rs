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
use tokio::sync::{Mutex, OwnedMutexGuard, RwLock};
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
    /// the default on-disk keys (`~/.ssh/id_*`). A `passphrase` for an encrypted
    /// key is held in memory for the session only (never written to disk); when
    /// an encrypted key is found and no passphrase is set, connect fails with a
    /// `KEY_NEEDS_PASSPHRASE:` error so the UI can prompt. No ssh-agent yet.
    Auto {
        #[serde(default)]
        identity_file: Option<String>,
        #[serde(default)]
        passphrase: Option<String>,
    },
}

/// Error prefix (`KEY_NEEDS_PASSPHRASE:<key path>`) the frontend matches to
/// pop a passphrase prompt for an encrypted key.
pub const KEY_NEEDS_PASSPHRASE: &str = "KEY_NEEDS_PASSPHRASE:";

/// Coarse connection state surfaced to the UI status bar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionState {
    Connecting,
    Connected,
    Reconnecting,
    Disconnected,
}

/// Status payload emitted on the `ssh-status` event.
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
    /// Lazily-opened SFTP session, reused across file operations, behind a
    /// swappable holder: a reconnect installs a FRESH holder (`reset_sftp`) so a
    /// hung op stranded on the dead handle can't block new file ops. The inner
    /// mutex still serializes requests over the one channel.
    pub sftp: RwLock<Arc<Mutex<Option<SftpSession>>>>,
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
    /// Lock the SFTP session, opening it on first use. Returns an OWNED guard
    /// (it carries the holder Arc) that serializes SFTP operations for this
    /// connection — acceptable for an interactive file browser.
    pub async fn sftp(&self) -> Result<OwnedMutexGuard<Option<SftpSession>>, String> {
        // Clone the current holder (the read-lock is released at once) so a
        // reconnect can swap a fresh holder in without waiting on our op.
        let holder = self.sftp.read().await.clone();
        let mut guard = holder.lock_owned().await;
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

    /// Swap in a fresh, empty SFTP holder so the next `sftp()` opens a new
    /// session on the live handle. Non-blocking by design: a hung op is stuck on
    /// the OLD holder's mutex, but we only take the (uncontended) outer swap
    /// lock, so a reconnect never waits on it — the old session dies with its
    /// handle and drops once that op finally errors out.
    pub async fn reset_sftp(&self) {
        *self.sftp.write().await = Arc::new(Mutex::new(None));
    }

    fn mark_stopped(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }

    fn is_stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }
}

/// Markers the frontend matches to act on a host-key refusal. UNKNOWN carries
/// the `SHA256:…` fingerprint (show it, offer to trust); CHANGED is bare
/// (refuse loudly — the key differs from `known_hosts`). Host/port come from
/// the connect profile on the UI side.
pub const HOST_KEY_UNKNOWN: &str = "HOST_KEY_UNKNOWN:";
pub const HOST_KEY_CHANGED: &str = "HOST_KEY_CHANGED";

/// Filled by `check_server_key` so `ssh_connect` can turn a refusal into the
/// right prompt after the (aborted) handshake.
#[derive(Default)]
enum HostKeyOutcome {
    #[default]
    Pending,
    Trusted,
    Unknown {
        fingerprint: String,
        key: russh_keys::key::PublicKey,
    },
    Changed,
}

/// The user's `~/.ssh/known_hosts` (the real OpenSSH location on every OS — the
/// russh-keys convenience helper uses `~/ssh` without the dot on Windows, so we
/// resolve it ourselves and use the `_path` APIs).
fn known_hosts_path() -> Option<std::path::PathBuf> {
    directories::UserDirs::new().map(|d| d.home_dir().join(".ssh").join("known_hosts"))
}

/// Loopback (WSL / localhost) has no MITM surface — verifying it would only nag
/// the user about their own provisioned distro (OpenSSH's
/// `NoHostAuthenticationForLocalhost`).
fn is_loopback(host: &str) -> bool {
    host == "localhost" || host == "::1" || host.starts_with("127.")
}

/// russh client handler. Verifies the server key against `known_hosts` (unless
/// `verify` is false, e.g. loopback), refusing an unknown or changed key so the
/// UI can prompt — no auth is ever attempted against an unverified host.
pub struct ClientHandler {
    host: String,
    port: u16,
    verify: bool,
    outcome: Arc<std::sync::Mutex<HostKeyOutcome>>,
}

fn target_handler(
    host: &str,
    port: u16,
    outcome: Arc<std::sync::Mutex<HostKeyOutcome>>,
) -> ClientHandler {
    ClientHandler {
        host: host.to_string(),
        port,
        verify: !is_loopback(host),
        outcome,
    }
}

/// A jump/bastion handler. Jump-host key verification is a follow-up (we don't
/// refuse an unknown bastion here), so it never verifies.
fn jump_handler(host: &str, port: u16) -> ClientHandler {
    ClientHandler {
        host: host.to_string(),
        port,
        verify: false,
        outcome: Arc::new(std::sync::Mutex::new(HostKeyOutcome::Pending)),
    }
}

#[async_trait::async_trait]
impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh_keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let mut out = self.outcome.lock().unwrap();
        if !self.verify {
            *out = HostKeyOutcome::Trusted;
            return Ok(true);
        }
        let Some(path) = known_hosts_path() else {
            // No home dir to check against — don't hard-block, but this is rare.
            *out = HostKeyOutcome::Trusted;
            return Ok(true);
        };
        let unknown = || HostKeyOutcome::Unknown {
            fingerprint: format!("SHA256:{}", server_public_key.fingerprint()),
            key: server_public_key.clone(),
        };
        match russh_keys::known_hosts::check_known_hosts_path(
            &self.host,
            self.port,
            server_public_key,
            &path,
        ) {
            Ok(true) => {
                *out = HostKeyOutcome::Trusted;
                Ok(true)
            }
            // Present but the key differs — the MITM / swapped-server case.
            Err(russh_keys::Error::KeyChanged { .. }) => {
                *out = HostKeyOutcome::Changed;
                Ok(false)
            }
            // Absent, or no known_hosts file yet — first-connect, needs consent.
            _ => {
                *out = unknown();
                Ok(false)
            }
        }
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
        // Prefer compression (atomic-save.md decision 14): text traffic —
        // saves, transfers, terminal scroll — shrinks 3–5× on slow links.
        // `zlib@openssh.com` is what OpenSSH servers offer; servers without
        // compression negotiate `none` and nothing changes.
        preferred: russh::Preferred {
            compression: std::borrow::Cow::Borrowed(&[
                russh::compression::ZLIB_LEGACY,
                russh::compression::ZLIB,
                russh::compression::NONE,
            ]),
            ..Default::default()
        },
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
    let (host, port) = split_host_port(rest);
    (user, host, port)
}

/// Split `host[:port]`, tolerating IPv6. Bracketed forms carry an optional
/// port (`[::1]` → port 22, `[::1]:2222` → 2222); a bare IPv6 literal (two or
/// more colons, no brackets) can't express a port, so it's all host; otherwise
/// split on the single colon.
fn split_host_port(s: &str) -> (String, u16) {
    if let Some(rest) = s.strip_prefix('[') {
        if let Some(close) = rest.find(']') {
            let host = rest[..close].to_string();
            let port = rest[close + 1..]
                .strip_prefix(':')
                .and_then(|p| p.parse().ok())
                .unwrap_or(22);
            return (host, port);
        }
    }
    if s.matches(':').count() >= 2 {
        return (s.to_string(), 22); // bare IPv6, no port possible
    }
    match s.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().unwrap_or(22)),
        None => (s.to_string(), 22),
    }
}

#[cfg(test)]
mod tests {
    use super::parse_jump;

    #[test]
    fn parse_jump_forms_and_ipv6() {
        let j = |s: &str| parse_jump(s, "me");
        // Basic [user@]host[:port]
        assert_eq!(j("host"), ("me".into(), "host".into(), 22));
        assert_eq!(j("user@host:2222"), ("user".into(), "host".into(), 2222));
        assert_eq!(
            j("jump@bastion.example.com:22"),
            ("jump".into(), "bastion.example.com".into(), 22)
        );
        // IPv6: bracketed (optional port) and bare (no port possible)
        assert_eq!(j("[::1]:22"), ("me".into(), "::1".into(), 22));
        assert_eq!(j("[::1]"), ("me".into(), "::1".into(), 22));
        assert_eq!(
            j("u@[2001:db8::1]:2222"),
            ("u".into(), "2001:db8::1".into(), 2222)
        );
        assert_eq!(j("::1"), ("me".into(), "::1".into(), 22));
        // Chained ProxyJump: only the first hop is used.
        assert_eq!(j("a@h1:22,b@h2:33"), ("a".into(), "h1".into(), 22));
    }
}

/// Open a (possibly jumped) SSH transport and return the unauthenticated handle
/// for the target, plus the jump handle to keep alive.
async fn open_handle(
    config: Arc<client::Config>,
    host: &str,
    port: u16,
    user: &str,
    proxy_jump: Option<&str>,
    outcome: Arc<std::sync::Mutex<HostKeyOutcome>>,
) -> Result<(client::Handle<ClientHandler>, Option<client::Handle<ClientHandler>>), String> {
    match proxy_jump {
        None | Some("") => {
            let handle = client::connect(config, (host, port), target_handler(host, port, outcome))
                .await
                .map_err(|e| format!("could not reach {host}:{port}: {e}"))?;
            Ok((handle, None))
        }
        Some(spec) => {
            let (juser, jhost, jport) = parse_jump(spec, user);
            let mut jump =
                client::connect(config.clone(), (jhost.as_str(), jport), jump_handler(&jhost, jport))
                    .await
                    .map_err(|e| format!("could not reach jump host {jhost}:{jport}: {e}"))?;
            // Authenticate the bastion with the same on-disk-key chain.
            auth_auto(&mut jump, &juser, None, None)
                .await
                .map_err(|e| format!("jump host authentication failed: {e}"))?;
            let channel = jump
                .channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0)
                .await
                .map_err(|e| format!("jump host could not reach {host}:{port}: {e}"))?;
            let handle = client::connect_stream(
                config,
                channel.into_stream(),
                target_handler(host, port, outcome),
            )
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
        AuthMethod::Auto {
            identity_file,
            passphrase,
        } => auth_auto(handle, user, identity_file.as_deref(), passphrase.as_deref()).await,
    }
}

/// Key-based auth: try the config IdentityFile, then the default on-disk keys.
/// `passphrase` (if any) unlocks an encrypted key. An encrypted key found with
/// no passphrase returns `KEY_NEEDS_PASSPHRASE:<path>` so the UI can prompt; a
/// passphrase that fails to unlock returns a clear "incorrect passphrase".
async fn auth_auto(
    handle: &mut client::Handle<ClientHandler>,
    user: &str,
    identity_file: Option<&str>,
    passphrase: Option<&str>,
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

    // An encrypted key we couldn't open with no passphrase (→ prompt), and
    // whether a supplied passphrase failed to load a key (→ "incorrect").
    let mut encrypted_locked: Option<String> = None;
    let mut load_failed_with_pass = false;

    for path in candidates {
        if !path.exists() {
            continue;
        }
        match russh_keys::load_secret_key(&path, passphrase) {
            Ok(key) => {
                if let Ok(true) = handle.authenticate_publickey(user, Arc::new(key)).await {
                    log::info!("authenticated with key {}", path.display());
                    return Ok(());
                }
            }
            // Encrypted, and no passphrase was given to unlock it.
            Err(russh_keys::Error::KeyIsEncrypted) => {
                if encrypted_locked.is_none() {
                    encrypted_locked = Some(path.to_string_lossy().into_owned());
                }
            }
            // Any other load error while a passphrase was set is almost always
            // a wrong passphrase (a corrupt key is far rarer).
            Err(_) if passphrase.is_some() => load_failed_with_pass = true,
            Err(_) => {}
        }
    }

    if passphrase.is_some() && load_failed_with_pass {
        return Err("could not unlock the key — the passphrase may be incorrect".to_string());
    }
    if let Some(path) = encrypted_locked {
        return Err(format!("{KEY_NEEDS_PASSPHRASE}{path}"));
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
    let outcome = Arc::new(std::sync::Mutex::new(HostKeyOutcome::Pending));
    let connect = open_handle(
        client_config(),
        &host,
        port,
        &user,
        proxy_jump.as_deref(),
        outcome.clone(),
    );
    let (mut handle, jump) =
        match tokio::time::timeout(std::time::Duration::from_secs(10), connect).await {
            Ok(Ok(pair)) => pair,
            Ok(Err(e)) => {
                // A host-key refusal surfaces as a specific, actionable error.
                // The error carries only the fingerprint — the UI already has
                // host/port from the connect profile (avoids parsing them back
                // out past an IPv6 host or the fingerprint's own colons).
                let refusal = {
                    match &*outcome.lock().unwrap() {
                        HostKeyOutcome::Unknown { fingerprint, key } => {
                            Some((format!("{HOST_KEY_UNKNOWN}{fingerprint}"), Some(key.clone())))
                        }
                        HostKeyOutcome::Changed => Some((HOST_KEY_CHANGED.to_string(), None)),
                        _ => None,
                    }
                };
                if let Some((_, Some(key))) = &refusal {
                    // Stash the key so `ssh_trust_host` can record it if the user accepts.
                    state
                        .pending_host_keys
                        .lock()
                        .await
                        .insert(format!("{host}:{port}"), key.clone());
                }
                return Err(fail(&app, &conn_id, refusal.map(|(m, _)| m).unwrap_or(e)));
            }
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
        sftp: RwLock::new(Arc::new(Mutex::new(None))),
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

/// Record a host's public key in `~/.ssh/known_hosts` after the user accepts it
/// from the fingerprint prompt (the key was stashed when the unknown-host
/// connect was refused). The frontend then retries the connection, which now
/// verifies.
#[tauri::command]
pub async fn ssh_trust_host(
    state: State<'_, AppState>,
    host: String,
    port: u16,
) -> Result<(), String> {
    let key = state
        .pending_host_keys
        .lock()
        .await
        .remove(&format!("{host}:{port}"))
        .ok_or("no pending host key to trust — reconnect and try again")?;
    let path = known_hosts_path().ok_or("could not resolve ~/.ssh/known_hosts")?;
    russh_keys::known_hosts::learn_known_hosts_path(&host, port, &key, &path)
        .map_err(|e| format!("could not record the host key: {e}"))?;
    log::info!("trusted host key for {host}:{port}");
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
/// `Reconnecting` and retry with backoff (capped at 30 s) until it recovers or
/// the user explicitly disconnects — never give up on our own (the house
/// no-automatic-timeouts rule: the user decides). A long outage costs one
/// probe every ~30 s.
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
                    emit_status(
                        &app,
                        &conn.id,
                        ConnectionState::Reconnecting,
                        Some(format!(
                            "reconnect attempt {attempt} failed: {e} — retrying in {delay}s"
                        )),
                    );
                    log::info!(
                        "connection {} reconnect attempt {attempt} failed: {e}",
                        conn.id
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
    // A reconnect can't prompt; on a known host the key still verifies (and a
    // changed key correctly refuses — the supervisor keeps retrying).
    let outcome = Arc::new(std::sync::Mutex::new(HostKeyOutcome::Pending));
    let connect = open_handle(
        client_config(),
        &conn.info.host,
        conn.info.port,
        &conn.info.user,
        conn.proxy_jump.as_deref(),
        outcome,
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

