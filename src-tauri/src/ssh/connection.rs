//! SSH connection lifecycle: authentication (on-disk key, or password), optional
//! `ProxyJump` bastions, and the shared [`Connection`] handle that the SFTP and
//! PTY layers build channels on top of.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use russh::client;
use russh::Channel;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{watch, Mutex, OwnedMutexGuard, RwLock};
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
    /// Probes are failing or slow but there is NO hard evidence of death —
    /// every channel stays open and usable (possibly slow). Doubt is not
    /// death: only a transport error escalates to `Reconnecting`
    /// (docs/connections.md).
    Degraded,
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
    /// Unix millis of the last *confirmed* server response — PTY output, a
    /// completed SFTP op, a successful channel open. Recent activity is proof
    /// of life: the supervisor skips its probe entirely (an active terminal or
    /// running transfer IS the health check), so bulk load can never make the
    /// connection look sick.
    last_activity: AtomicU64,
    /// The lazily-dialed **data lane** — a SECOND SSH connection to the same
    /// host carrying SFTP + exec (everything that moves data rather than
    /// keystrokes), so heavy file traffic can never congest or kill the
    /// terminals riding this main lane (docs/connections.md Phase 1). Only
    /// used on main-lane objects; a data lane's own slot stays None. Held in a
    /// tokio Mutex so one dial at a time.
    data: Mutex<Option<Arc<Connection>>>,
    /// When the last data-lane dial failed (cooldown: retry at most once a
    /// minute; between tries data work shares this lane).
    data_fail: std::sync::Mutex<Option<std::time::Instant>>,
    /// Serializes **session lane** dials for this host (one handshake at a
    /// time — politeness toward sshd's MaxStartups; also makes the cap check
    /// race-free). Session lanes are per-agent connections created by the
    /// SESSIONS ＋ (docs/connections.md Phase D).
    session_dial: Mutex<()>,
    /// This lane's dial profile — compression, keepalive tolerance, and
    /// channel window differ by lane kind (docs/connections.md).
    /// Reconnects re-negotiate the same profile.
    profile: LaneProfile,
    /// Bumped on every `reestablish` (the live handle was swapped). In-flight
    /// transfers subscribe and yank themselves off the dead session the moment
    /// the lane reconnects, then auto-resume (docs/connections.md Phase 2).
    epoch: watch::Sender<u64>,
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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
            // 32 pipelined write acks (default 8): uploads are throughput ÷
            // round-trip too — 8 × 255 KB capped a 37 ms route at ~54 MB/s.
            let session = SftpSession::new_with_config(
                channel.into_stream(),
                russh_sftp::client::Config {
                    max_concurrent_writes: 32,
                    ..Default::default()
                },
            )
                .await
                .map_err(|e| format!("failed to initialize SFTP: {e}"))?;
            *guard = Some(session);
        }
        Ok(guard)
    }

    /// Open a fresh session channel, surfacing the raw russh error — the
    /// supervisor must tell an active REFUSAL (server alive, just full) from a
    /// dead transport.
    pub async fn open_channel_raw(&self) -> Result<Channel<client::Msg>, russh::Error> {
        // Clone the (cheap) handle and drop the read guard before the network
        // round-trip, so an in-flight channel open never blocks a reconnect
        // (which needs the write lock).
        let handle = self.live.read().await.handle.clone();
        let result = handle.channel_open_session().await;
        if result.is_ok() {
            self.touch_activity(); // a confirmed server round-trip
        }
        result
    }

    /// Record a confirmed server response (see `last_activity`).
    pub fn touch_activity(&self) {
        self.last_activity.store(now_millis(), Ordering::Relaxed);
    }

    /// Seconds since the last confirmed server response.
    pub fn idle_secs(&self) -> u64 {
        now_millis()
            .saturating_sub(self.last_activity.load(Ordering::Relaxed))
            / 1000
    }

    /// Subscribe to reconnects: the value bumps each time `reestablish` swaps
    /// the live handle (see the `epoch` field).
    pub fn subscribe_epoch(&self) -> watch::Receiver<u64> {
        self.epoch.subscribe()
    }

    /// Dial an ephemeral **transfer lane** — one transfer's private connection
    /// (docs/connections.md Phase T), tuned purely for throughput
    /// (LANE_TRANSFER: no compression, 16 MiB window, ~1 min keepalive). No
    /// supervisor: the transfer's retry rounds redial a fresh lane instead of
    /// nursing a dead one. Serialized with session dials (one handshake at a
    /// time per host — MaxStartups politeness).
    pub async fn open_transfer_lane(
        self: &Arc<Self>,
        app: &AppHandle,
    ) -> Result<Arc<Connection>, String> {
        let _dial = self.session_dial.lock().await;
        let id = format!("{}::transfer-{}", self.id, &Uuid::new_v4().to_string()[..8]);
        emit_status(app, &id, ConnectionState::Connecting, None);
        match open_sibling(self, id.clone(), LANE_TRANSFER).await {
            Ok(lane) => {
                emit_status(app, &id, ConnectionState::Connected, None);
                log::info!("transfer lane {id} opened");
                Ok(lane)
            }
            Err(e) => {
                emit_status(app, &id, ConnectionState::Disconnected, Some(e.clone()));
                log::warn!(
                    "transfer lane {id} failed to open ({e}) — falling back to the data lane"
                );
                Err(e)
            }
        }
    }

    /// One bounded liveness probe (channel open + close). Transfers use it to
    /// classify a round error: a lane that answers is healthy — the error was
    /// a genuine filesystem error and stays fatal; one that doesn't answer
    /// gets redialed and the round retried.
    pub async fn is_transport_alive(&self) -> bool {
        matches!(probe(self).await, Probe::Alive)
    }

    /// The data lane for this host — dialed on first use, supervised and
    /// reestablished IN PLACE forever after (the Arc stays valid across
    /// reconnects, which in-flight transfers rely on). On dial failure the
    /// main lane is shared instead, retried at most once a minute.
    pub async fn data_lane(self: &Arc<Self>, app: &AppHandle) -> Arc<Connection> {
        let mut slot = self.data.lock().await;
        if let Some(lane) = slot.as_ref() {
            return lane.clone();
        }
        if let Some(failed_at) = *self.data_fail.lock().unwrap() {
            if failed_at.elapsed() < Duration::from_secs(60) {
                return self.clone(); // cooldown — share the main lane
            }
        }
        let id = format!("{}::data", self.id);
        emit_status(app, &id, ConnectionState::Connecting, None);
        // No compression on the data lane: bulk transfers are the one place
        // zlib turns from a slow-link win into a hard CPU ceiling.
        match open_sibling(self, id.clone(), LANE_DATA).await {
            Ok(sibling) => {
                emit_status(app, &id, ConnectionState::Connected, None);
                log::info!("data lane {id} opened");
                ensure_supervisor(app.clone(), sibling.clone());
                *slot = Some(sibling.clone());
                sibling
            }
            Err(e) => {
                log::warn!("data lane {id} failed to open ({e}) — sharing the main lane");
                emit_status(
                    app,
                    &id,
                    ConnectionState::Disconnected,
                    Some(format!("data lane unavailable ({e}) — sharing the main connection")),
                );
                *self.data_fail.lock().unwrap() = Some(std::time::Instant::now());
                self.clone()
            }
        }
    }

    /// Open a fresh session channel on the live handle. Used by SFTP, the PTY
    /// layer, and exec; reading the lock means a reconnect (which write-locks)
    /// is briefly serialized against new channels.
    pub async fn open_channel(&self) -> Result<Channel<client::Msg>, String> {
        self.open_channel_raw().await.map_err(|e| match e {
            // The refusal users actually hit: the server's per-connection
            // session cap — every terminal, the file browser (SFTP), and each
            // background command counts against it.
            russh::Error::ChannelOpenFailure(_) => {
                "the server's session limit is reached (sshd MaxSessions, default 10) — \
                 close a terminal, or raise MaxSessions in sshd_config"
                    .to_string()
            }
            e => format!("could not open SSH channel: {e}"),
        })
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

/// A lane kind's dial parameters (docs/connections.md — "The lanes").
///
/// - `compress`: terminal lanes (main + session) prefer zlib — their traffic
///   is text and shrinks 3–5× on slow links at trivial volume. Bulk lanes
///   (data + transfer) negotiate none: payloads are often incompressible and
///   single-threaded zlib caps a same-machine link at a few dozen MB/s
///   (scp/rsync ship uncompressed by default for the same reason).
/// - `keepalive_max`: with 15 s pings, how much TOTAL silence before russh
///   declares the transport dead. 20 ≈ 5 min for lanes carrying precious
///   state (doubt is not death); 4 ≈ 1 min for expendable transfer lanes —
///   they have no supervisor, a dead one should redial fast, and a misjudged
///   stall costs nothing (the retry round just redials).
/// - `window`: the receive window WE grant — the ceiling on in-flight data
///   flowing to us. Bulk lanes get 16 MiB so a deep read pipeline can stand;
///   terminal lanes keep russh's 2 MiB default.
#[derive(Clone, Copy)]
pub struct LaneProfile {
    compress: bool,
    keepalive_max: usize,
    window: u32,
}

const MIB: u32 = 1024 * 1024;
/// Main lane: terminals + forwards. Text, precious, patient.
pub const LANE_MAIN: LaneProfile = LaneProfile { compress: true, keepalive_max: 20, window: 2 * MIB };
/// Session lanes: one agent's PTY. Text, precious, patient.
pub const LANE_SESSION: LaneProfile = LaneProfile { compress: true, keepalive_max: 20, window: 2 * MIB };
/// Data lane: SFTP + exec. Bulk-ish, standing, patient.
pub const LANE_DATA: LaneProfile = LaneProfile { compress: false, keepalive_max: 20, window: 16 * MIB };
/// Transfer lanes: one transfer's bytes. Bulk, ephemeral, impatient.
pub const LANE_TRANSFER: LaneProfile = LaneProfile { compress: false, keepalive_max: 4, window: 16 * MIB };

fn client_config(profile: LaneProfile) -> Arc<client::Config> {
    Arc::new(client::Config {
        // Keep interactive sessions alive; we never want the library to drop an
        // idle terminal out from under the user.
        inactivity_timeout: None,
        // Keepalive pings double as a NAT refresher and the hard-silence
        // backstop (see LaneProfile). The old blanket value (3 ≈ 45 s)
        // executed healthy connections during ordinary stalls — which is what
        // restarted every terminal hourly on a flaky link while plain ssh (no
        // keepalive kill at all) survived for days.
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: profile.keepalive_max,
        window_size: profile.window,
        preferred: russh::Preferred {
            compression: std::borrow::Cow::Borrowed(if profile.compress {
                &[
                    russh::compression::ZLIB_LEGACY,
                    russh::compression::ZLIB,
                    russh::compression::NONE,
                ]
            } else {
                &[russh::compression::NONE]
            }),
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

/// TCP-connect with `TCP_NODELAY` set, then hand russh the stream. russh's own
/// `client::connect` never disables Nagle — with SFTP's request/response
/// rhythm, every request then eats a Nagle + delayed-ACK stall (~40 ms), which
/// capped even LOOPBACK transfers at ~7 MB/s while scp did 160 (the request
/// sits in two TCP segments; the second waits for an ACK the peer is
/// deliberately delaying). Interactive typing echo benefits too.
async fn connect_nodelay(
    config: Arc<client::Config>,
    host: &str,
    port: u16,
    handler: ClientHandler,
) -> Result<client::Handle<ClientHandler>, russh::Error> {
    let socket = tokio::net::TcpStream::connect((host, port)).await?;
    let _ = socket.set_nodelay(true);
    client::connect_stream(config, socket, handler).await
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
            let handle = connect_nodelay(config, host, port, target_handler(host, port, outcome))
                .await
                .map_err(|e| format!("could not reach {host}:{port}: {e}"))?;
            Ok((handle, None))
        }
        Some(spec) => {
            let (juser, jhost, jport) = parse_jump(spec, user);
            let mut jump =
                connect_nodelay(config.clone(), jhost.as_str(), jport, jump_handler(&jhost, jport))
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
        client_config(LANE_MAIN),
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
        last_activity: AtomicU64::new(now_millis()),
        data: Mutex::new(None),
        data_fail: std::sync::Mutex::new(None),
        session_dial: Mutex::new(()),
        profile: LANE_MAIN,
        epoch: watch::Sender::new(0),
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
        // The data lane goes down with its host (bounded — its socket may be
        // a corpse already).
        if let Some(lane) = connection.data.lock().await.take() {
            lane.mark_stopped();
            let _ = tokio::time::timeout(Duration::from_secs(3), async {
                let _ = lane
                    .live
                    .read()
                    .await
                    .handle
                    .disconnect(russh::Disconnect::ByApplication, "", "en")
                    .await;
            })
            .await;
            emit_status(&app, &format!("{conn_id}::data"), ConnectionState::Disconnected, None);
        }
        // Session AND transfer lanes (any `<id>::…` child) go down with their
        // host too.
        let lanes: Vec<(String, Arc<Connection>)> = {
            let mut sessions = state.sessions.lock().await;
            let prefix = format!("{conn_id}::");
            let ids: Vec<String> = sessions
                .keys()
                .filter(|k| k.starts_with(&prefix))
                .cloned()
                .collect();
            ids.into_iter()
                .filter_map(|id| match sessions.remove(&id) {
                    Some(crate::Session::Ssh(c)) => Some((id, c)),
                    _ => None,
                })
                .collect()
        };
        for (id, lane) in lanes {
            lane.mark_stopped();
            let _ = tokio::time::timeout(Duration::from_secs(3), async {
                let _ = lane
                    .live
                    .read()
                    .await
                    .handle
                    .disconnect(russh::Disconnect::ByApplication, "", "en")
                    .await;
            })
            .await;
            emit_status(&app, &id, ConnectionState::Disconnected, None);
        }
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
            conn.touch_activity();
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

/// Drop EVERYTHING the backend holds for a previous frontend. Called once at
/// webview boot: after a dev reload or a renderer crash-recovery, the fresh
/// page knows no connection ids — so every session, lane, transfer, PTY, and
/// forward left behind is an orphan: still holding server slots, still
/// probing, and (worst) a headless transfer keeps pumping with nobody able to
/// cancel it. That combination is what turned one renderer crash into a
/// wedged app and a starved WSL relay.
#[tauri::command]
pub async fn backend_reset(state: State<'_, crate::AppState>) -> Result<(), String> {
    for intr in state.transfers.lock().await.values() {
        intr.trip_cancel();
    }
    // Session lanes are top-level map entries too, so draining covers main
    // lanes, session lanes, and stale Local entries alike.
    let sessions: Vec<(String, crate::Session)> =
        state.sessions.lock().await.drain().collect();
    let mut dropped = 0u32;
    for (_, session) in sessions {
        if let crate::Session::Ssh(conn) = session {
            dropped += 1;
            conn.mark_stopped();
            if let Some(lane) = conn.data.lock().await.take() {
                lane.mark_stopped();
                let _ = tokio::time::timeout(Duration::from_secs(2), async {
                    let _ = lane
                        .live
                        .read()
                        .await
                        .handle
                        .disconnect(russh::Disconnect::ByApplication, "", "en")
                        .await;
                })
                .await;
            }
            let _ = tokio::time::timeout(Duration::from_secs(2), async {
                let _ = conn
                    .live
                    .read()
                    .await
                    .handle
                    .disconnect(russh::Disconnect::ByApplication, "", "en")
                    .await;
            })
            .await;
        }
    }
    // Dropping the handles ends the PTY tasks (their command channel closes).
    state.ptys.lock().await.clear();
    for (_, forward) in state.forwards.lock().await.drain() {
        forward.task.abort();
    }
    if dropped > 0 {
        log::info!(
            "backend reset: dropped {dropped} orphaned connection(s) left by a previous page"
        );
    }
    Ok(())
}

/// Hang up an ephemeral transfer lane and forget it (bounded — the socket may
/// be a corpse). Quiet by design: the clean-close Disconnected event carries
/// no message and the UI ignores it.
pub async fn drop_transfer_lane(state: &crate::AppState, app: &AppHandle, lane_id: &str) {
    let session = state.sessions.lock().await.remove(lane_id);
    if let Some(crate::Session::Ssh(lane)) = session {
        lane.mark_stopped();
        let _ = tokio::time::timeout(Duration::from_secs(3), async {
            let _ = lane
                .live
                .read()
                .await
                .handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
        })
        .await;
        emit_status(app, lane_id, ConnectionState::Disconnected, None);
    }
}

/// Error prefix the frontend matches to fall back to the main lane when the
/// per-host session-lane cap is reached (Preferences → Session connections).
pub const SESSION_LANE_LIMIT: &str = "SESSION_LANE_LIMIT:";

/// Open a **session lane**: a dedicated SSH connection for ONE agent created
/// from the SESSIONS panel / F11 (docs/connections.md Phase D) — its PTY
/// rides alone, so a busy agent can't slow or break any other terminal. Dials
/// are serialized per host (MaxStartups politeness) and capped by `limit`
/// (the user's Preferences value): at the cap this returns
/// `SESSION_LANE_LIMIT:` and the frontend opens the agent on the shared main
/// lane instead. A dial failure is a plain error — the frontend explains and
/// does NOT silently share (that would mask a struggling host).
#[tauri::command]
pub async fn session_lane_connect(
    state: State<'_, crate::AppState>,
    app: AppHandle,
    conn_id: String,
    label: String,
    limit: u32,
) -> Result<String, String> {
    let parent = state.ssh_connection(&conn_id).await?;
    // Serialize the cap check + dial per host: no race can overshoot the cap,
    // and sshd never sees more than one handshake from us at a time.
    let _dial = parent.session_dial.lock().await;
    let prefix = format!("{conn_id}::session-");
    let count = state
        .sessions
        .lock()
        .await
        .keys()
        .filter(|k| k.starts_with(&prefix))
        .count() as u32;
    if count >= limit {
        return Err(format!("{SESSION_LANE_LIMIT}{limit}"));
    }
    let id = format!(
        "{conn_id}::session-{}",
        &Uuid::new_v4().to_string()[..8]
    );
    emit_status(&app, &id, ConnectionState::Connecting, None);
    // Session lanes carry a terminal (agent text) — compression stays on.
    match open_sibling(&parent, id.clone(), LANE_SESSION).await {
        Ok(lane) => {
            state
                .sessions
                .lock()
                .await
                .insert(id.clone(), crate::Session::Ssh(lane.clone()));
            emit_status(&app, &id, ConnectionState::Connected, None);
            ensure_supervisor(app, lane);
            log::info!("session lane {id} opened for \"{label}\"");
            Ok(id)
        }
        Err(e) => {
            emit_status(&app, &id, ConnectionState::Disconnected, Some(e.clone()));
            log::warn!("session lane for \"{label}\" failed to open: {e}");
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

/// What one health probe learned. The three-way split is the heart of the v2
/// doctrine (docs/connections.md): silence is DOUBT (the link may just be
/// stalled — mark Degraded, touch nothing), only a hard transport error is
/// CERTAINTY (russh says the handle is gone — reconnect).
enum Probe {
    Alive,
    /// No response inside the timeout — a stalled-or-dead link we can't tell
    /// apart yet. Never a reason to tear anything down.
    Doubt,
    /// The transport itself errored — the connection is factually dead.
    Dead(String),
}

/// Watch a connection's health. Doubt (probe timeouts) only marks the
/// connection `Degraded` — every channel stays open; most stalls recover and
/// nothing is lost. Only hard evidence (a transport error, confirmed twice)
/// moves to `Reconnecting` + the reestablish loop, which retries with backoff
/// (capped at 30 s) until it recovers or the user disconnects — never give up
/// on our own (the house no-automatic-timeouts rule: the user decides).
async fn supervise(app: AppHandle, conn: Arc<Connection>) {
    // When the current Degraded episode started (None = healthy).
    let mut degraded_since: Option<std::time::Instant> = None;
    loop {
        if sleep_or_stopped(&conn, PROBE_INTERVAL_SECS).await {
            return;
        }

        // Traffic within the last interval is proof of life — skip the probe
        // (an active terminal or a moving transfer IS the health check).
        if conn.idle_secs() < PROBE_INTERVAL_SECS {
            recover_if_degraded(&app, &conn, &mut degraded_since, "traffic resumed").await;
            continue;
        }

        match probe(&conn).await {
            Probe::Alive => {
                recover_if_degraded(&app, &conn, &mut degraded_since, "probe answered").await;
                continue;
            }
            Probe::Doubt => {
                if conn.is_stopped() {
                    return;
                }
                match degraded_since {
                    None => {
                        degraded_since = Some(std::time::Instant::now());
                        *conn.state.lock().await = ConnectionState::Degraded;
                        emit_status(
                            &app,
                            &conn.id,
                            ConnectionState::Degraded,
                            Some(format!(
                                "connection stalled (no reply in {}s) — terminals stay open",
                                PROBE_TIMEOUT.as_secs()
                            )),
                        );
                        log::warn!(
                            "connection {} degraded: probe timeout ({}s), idle {}s — holding, NOT tearing down",
                            conn.id,
                            PROBE_TIMEOUT.as_secs(),
                            conn.idle_secs()
                        );
                    }
                    Some(since) => {
                        // Still stalled — update the status line (same state, so
                        // the UI won't re-toast), keep holding.
                        let secs = since.elapsed().as_secs();
                        emit_status(
                            &app,
                            &conn.id,
                            ConnectionState::Degraded,
                            Some(format!("still stalled ({secs}s) — terminals stay open")),
                        );
                        log::info!("connection {} still degraded ({secs}s)", conn.id);
                    }
                }
                continue;
            }
            Probe::Dead(first) => {
                if conn.is_stopped() {
                    return;
                }
                // A hard error is near-certain death, but teardown restarts
                // every terminal — confirm with a second probe after a beat. A
                // dead handle errors instantly, so this costs ~2 s.
                if sleep_or_stopped(&conn, 2).await {
                    return;
                }
                let cause = match probe(&conn).await {
                    Probe::Dead(second) => second,
                    Probe::Alive => {
                        log::info!(
                            "connection {}: transient transport error ({first}) — probe recovered, holding",
                            conn.id
                        );
                        recover_if_degraded(&app, &conn, &mut degraded_since, "probe recovered")
                            .await;
                        continue;
                    }
                    Probe::Doubt => {
                        // Error then silence — treat as a stall, not death.
                        log::warn!(
                            "connection {}: transport error ({first}) then silence — degrading, not tearing down",
                            conn.id
                        );
                        if degraded_since.is_none() {
                            degraded_since = Some(std::time::Instant::now());
                            *conn.state.lock().await = ConnectionState::Degraded;
                            emit_status(
                                &app,
                                &conn.id,
                                ConnectionState::Degraded,
                                Some("connection stalled — terminals stay open".to_string()),
                            );
                        }
                        continue;
                    }
                };
                if conn.is_stopped() {
                    return;
                }

                let stalled = degraded_since
                    .take()
                    .map(|s| format!(" after {}s degraded", s.elapsed().as_secs()))
                    .unwrap_or_default();
                *conn.state.lock().await = ConnectionState::Reconnecting;
                emit_status(
                    &app,
                    &conn.id,
                    ConnectionState::Reconnecting,
                    Some(format!("connection lost ({cause}) — reconnecting…")),
                );
                log::warn!(
                    "connection {} transport dead ({cause}){stalled}; reconnecting",
                    conn.id
                );

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
                            conn.touch_activity();
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
    }
}

/// Leave `Degraded` for `Connected` when life is confirmed again.
async fn recover_if_degraded(
    app: &AppHandle,
    conn: &Connection,
    degraded_since: &mut Option<std::time::Instant>,
    how: &str,
) {
    let Some(since) = degraded_since.take() else {
        return;
    };
    let mut state = conn.state.lock().await;
    if *state == ConnectionState::Degraded {
        *state = ConnectionState::Connected;
        drop(state);
        emit_status(app, &conn.id, ConnectionState::Connected, None);
        log::info!(
            "connection {} recovered from degraded after {}s ({how}) — nothing was restarted",
            conn.id,
            since.elapsed().as_secs()
        );
    }
}

/// One health probe: open + close a throwaway channel. An active REFUSAL (e.g.
/// `MaxSessions` reached — every terminal + SFTP + exec counts against it) is
/// proof of life: the server answered us. A TIMEOUT is only doubt — a stalled
/// link and a dead one are indistinguishable from silence, and a full server
/// must never be mistaken for a dead one (that mistake restarted every
/// terminal in a loop; F23). Only a hard transport error means dead.
async fn probe(conn: &Connection) -> Probe {
    match tokio::time::timeout(PROBE_TIMEOUT, conn.open_channel_raw()).await {
        Ok(Ok(channel)) => {
            // Close the probe channel so an idle connection doesn't leak one
            // channel per interval — but never block the loop on a half-open
            // socket waiting for the close handshake.
            let _ = tokio::time::timeout(Duration::from_secs(3), channel.close()).await;
            Probe::Alive
        }
        Ok(Err(russh::Error::ChannelOpenFailure(_))) => Probe::Alive,
        Ok(Err(e)) => Probe::Dead(e.to_string()),
        Err(_) => Probe::Doubt,
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
/// Dial a second, independent SSH connection to the same host — a data or
/// session lane (docs/connections.md). Silent like `reestablish`: no
/// prompting — the host key was verified at first connect, and the retained
/// auth (key path / in-memory password) replays. `compress` picks the lane's
/// compression (terminal lanes yes, the data lane no — see `client_config`).
async fn open_sibling(
    conn: &Connection,
    id: String,
    profile: LaneProfile,
) -> Result<Arc<Connection>, String> {
    let outcome = Arc::new(std::sync::Mutex::new(HostKeyOutcome::Pending));
    let connect = open_handle(
        client_config(profile),
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
    Ok(Arc::new(Connection {
        id,
        info: ConnectionInfo {
            host: conn.info.host.clone(),
            port: conn.info.port,
            user: conn.info.user.clone(),
        },
        live: RwLock::new(Live { handle: Arc::new(handle), _jump: jump }),
        sftp: RwLock::new(Arc::new(Mutex::new(None))),
        state: Mutex::new(ConnectionState::Connected),
        auth: conn.auth.clone(),
        proxy_jump: conn.proxy_jump.clone(),
        stop: AtomicBool::new(false),
        supervising: AtomicBool::new(false),
        last_activity: AtomicU64::new(now_millis()),
        data: Mutex::new(None),
        data_fail: std::sync::Mutex::new(None),
        session_dial: Mutex::new(()),
        profile,
        epoch: watch::Sender::new(0),
    }))
}

async fn reestablish(conn: &Connection) -> Result<(), String> {
    // A reconnect can't prompt; on a known host the key still verifies (and a
    // changed key correctly refuses — the supervisor keeps retrying).
    let outcome = Arc::new(std::sync::Mutex::new(HostKeyOutcome::Pending));
    let connect = open_handle(
        client_config(conn.profile), // reconnects keep the lane's profile
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
    // Tell in-flight work (transfers) the old session is a corpse — they yank
    // themselves off it and auto-resume on the fresh one (Phase 2).
    conn.epoch.send_modify(|v| *v = v.wrapping_add(1));
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

