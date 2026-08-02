//! Straylight — Tauri v2 backend.
//!
//! A "session" is one workspace the UI is attached to: a remote SSH connection,
//! a WSL distro (also reached over SSH — see [`wsl`]), or the local filesystem.
//! File operations go through the transport-agnostic [`transport::FileTransport`].

pub mod containers;
pub mod diag;
pub mod ports;
pub mod exec;
pub mod forward;
pub mod prefs;
pub mod save;
pub mod ssh;
pub mod transport;
pub mod vcs;
pub mod watch;
pub mod wsl;

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

use ssh::connection::Connection;
use ssh::pty::PtyHandle;
use transport::local::LocalTransport;
use transport::FileTransport;

/// A connected workspace.
pub enum Session {
    /// A remote SSH connection (SFTP + PTY).
    Ssh(Arc<Connection>),
    /// The local filesystem.
    Local,
}

/// A local path handed to us on launch by the Windows "Open with Straylight"
/// context-menu verb (`straylight.exe "<path>"`). A folder becomes a pinned
/// Local root; a file opens in the editor.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTarget {
    pub path: String,
    pub is_dir: bool,
}

/// Pick the first launch argument that is an existing path on disk (skip the
/// exe name and any `-` flags), and note whether it's a directory. Returns None
/// for a plain launch.
fn resolve_open_target(argv: &[String]) -> Option<OpenTarget> {
    for arg in argv.iter().skip(1) {
        if arg.starts_with('-') {
            continue;
        }
        if let Ok(meta) = std::fs::metadata(arg) {
            return Some(OpenTarget {
                path: arg.clone(),
                is_dir: meta.is_dir(),
            });
        }
    }
    None
}

/// The path to open on first-launch, handed to the frontend once it's up (the
/// running-instance case is delivered as an `open-path` event instead). Taken
/// exactly once.
#[tauri::command]
fn take_open_path(state: tauri::State<AppState>) -> Option<OpenTarget> {
    state.pending_open.lock().unwrap().take()
}

/// The main window publishes its connection list here (JSON authored by the
/// frontend) so a workspace window can adopt the SAME connIds instead of dialing
/// its own. Latest-wins, and broadcast live to every window as `conns-snapshot`
/// (docs/dev/multi-window.md).
#[tauri::command]
fn set_conns_snapshot(app: tauri::AppHandle, state: tauri::State<AppState>, snapshot: String) {
    use tauri::Emitter;
    *state.conns_snapshot.lock().unwrap() = Some(snapshot.clone());
    let _ = app.emit("conns-snapshot", snapshot);
}

/// A workspace window pulls the latest connection snapshot on boot; the live
/// `conns-snapshot` event carries every later change.
#[tauri::command]
fn get_conns_snapshot(state: tauri::State<AppState>) -> Option<String> {
    state.conns_snapshot.lock().unwrap().clone()
}

/// The main window publishes its CHAT-session list here so the sessions pop-out
/// window can adopt it and re-attach to the same backend PTYs. Latest wins,
/// broadcast live as `sessions-snapshot` (docs/dev/multi-window.md).
#[tauri::command]
fn set_sessions_snapshot(app: tauri::AppHandle, state: tauri::State<AppState>, snapshot: String) {
    use tauri::Emitter;
    *state.sessions_snapshot.lock().unwrap() = Some(snapshot.clone());
    let _ = app.emit("sessions-snapshot", snapshot);
}

/// The sessions pop-out pulls the latest session snapshot on boot; later changes
/// arrive via the `sessions-snapshot` event.
#[tauri::command]
fn get_sessions_snapshot(state: tauri::State<AppState>) -> Option<String> {
    state.sessions_snapshot.lock().unwrap().clone()
}

/// The sessions pop-out sets this true on boot and (via the window-destroy
/// handler) false on close. The main window watches `sessions-popped` to lock /
/// unlock its CHAT panel — the lock model (docs/dev/multi-window.md).
#[tauri::command]
fn set_sessions_popped(app: tauri::AppHandle, state: tauri::State<AppState>, on: bool) {
    use tauri::Emitter;
    *state.sessions_popped.lock().unwrap() = on;
    let _ = app.emit("sessions-popped", on);
}

/// The main window reads this on boot (in case it reloaded while the sessions
/// window was open) to restore its lock state.
#[tauri::command]
fn get_sessions_popped(state: tauri::State<AppState>) -> bool {
    *state.sessions_popped.lock().unwrap()
}

/// The workspace window sets this true on boot / false on close so main can lock
/// its workspace button while the window is open (docs/dev/multi-window.md).
#[tauri::command]
fn set_workspace_popped(app: tauri::AppHandle, state: tauri::State<AppState>, on: bool) {
    use tauri::Emitter;
    *state.workspace_popped.lock().unwrap() = on;
    let _ = app.emit("workspace-popped", on);
}

/// Main reads this on boot to restore its workspace-button lock.
#[tauri::command]
fn get_workspace_popped(state: tauri::State<AppState>) -> bool {
    *state.workspace_popped.lock().unwrap()
}

/// Stash a session's serialized terminal state for the window that will re-attach
/// to it (set by the window releasing the view — main on pop-out, the sessions
/// window on close).
#[tauri::command]
fn set_session_replay(state: tauri::State<AppState>, id: String, data: String) {
    state.session_replays.lock().unwrap().insert(id, data);
}

/// Take (once) a session's stashed replay state — the attaching view writes it
/// into its fresh xterm to reconstruct a TUI's modes/cursor/screen.
#[tauri::command]
fn take_session_replay(state: tauri::State<AppState>, id: String) -> Option<String> {
    state.session_replays.lock().unwrap().remove(&id)
}

/// The calling window claims a PTY's rendering, so its output is emitted only to
/// this window instead of broadcast to all (docs/dev/multi-window.md). Called on
/// view mount by whichever window shows the terminal.
#[tauri::command]
fn set_pty_owner(window: tauri::WebviewWindow, state: tauri::State<AppState>, pty_id: String) {
    state
        .pty_owners
        .lock()
        .unwrap()
        .insert(pty_id, window.label().to_string());
}

// The multi-window liveness registry (`window_refs`) keys resources by their ROOT
// connection: windows declare connections, and PTYs / forwards / session lanes
// cascade off them in the sweep (docs/dev/multi-window.md).
pub fn conn_key(root_id: &str) -> String {
    format!("conn:{root_id}")
}
/// The root (main) connId of a lane id: `mainId::session-3` → `mainId`, so a data
/// or session lane shares its parent connection's fate in the sweep.
pub fn root_conn_id(id: &str) -> &str {
    id.split("::").next().unwrap_or(id)
}

/// Global application state, shared across all Tauri commands.
pub struct AppState {
    /// The Tauri app handle, set once at startup — lets deep code (the lazy
    /// data-lane dial) emit events and spawn supervisors without threading an
    /// `AppHandle` through every command signature.
    pub app: std::sync::OnceLock<tauri::AppHandle>,
    /// Active sessions, keyed by the connection id the frontend holds. An SSH
    /// entry is a host's MAIN lane (terminals + forwards); its data lane hangs
    /// off the connection itself (`Connection::data_lane`), and per-agent
    /// session lanes live here too under `<id>::session-<k>` keys.
    pub sessions: Mutex<HashMap<String, Session>>,
    /// Open PTY/terminal sessions, keyed by the id from [`ssh::pty::pty_open`].
    pub ptys: Mutex<HashMap<String, PtyHandle>>,
    /// Interrupt handles for in-flight transfers, keyed by transfer id
    /// (user cancel + connection-reset signals; see `TransferInterrupt`).
    pub transfers: Mutex<HashMap<String, Arc<transport::TransferInterrupt>>>,
    /// Per-repo locks (keyed by `connId::root`) serializing VCS mutations so two
    /// commits/stages can't race on git's `index.lock`.
    pub vcs_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Active local port forwards, keyed by forward id.
    pub forwards: Mutex<HashMap<String, forward::ForwardEntry>>,
    /// Filesystem watchers on local repos, keyed by `connId::root`.
    pub repo_watchers: Mutex<HashMap<String, watch::RepoWatcher>>,
    /// Filesystem watchers on pinned local folders (explorer tree
    /// auto-refresh), keyed by `connId::root`.
    pub dir_watchers: Mutex<HashMap<String, watch::RepoWatcher>>,
    /// Filesystem watchers on open local files (tab auto-reload + settings
    /// live-reload), keyed by `connId::path` and refcounted per owner.
    pub file_watchers: Mutex<HashMap<String, watch::FileWatcher>>,
    /// Probed absolute path of `jj` per SSH connection (None = not installed).
    /// SSH exec shells are non-login, so jj in `~/.cargo/bin` is off the PATH.
    pub jj_paths: Mutex<HashMap<String, Option<String>>>,
    /// Cancel handle for the repo's single in-flight remote VCS op, keyed by
    /// `connId::root`. The string is a per-op token so an op only ever clears
    /// its own slot (see `vcs::run_cancellable`).
    pub vcs_ops: Mutex<HashMap<String, (String, tokio::sync::oneshot::Sender<()>)>>,
    /// Server public keys awaiting the user's trust decision (keyed by
    /// `host:port`), stashed when an unknown-host connect was refused so
    /// `ssh_trust_host` can write the accepted one into `known_hosts`.
    pub pending_host_keys: Mutex<HashMap<String, russh::keys::PublicKey>>,
    /// A path from a "Open with Straylight" launch, waiting for the frontend to
    /// pick it up on boot (std Mutex — touched from the sync single-instance
    /// callback and the `take_open_path` command).
    pub pending_open: std::sync::Mutex<Option<OpenTarget>>,
    /// Multi-window liveness (docs/dev/multi-window.md): per window label, the set
    /// of backend resource keys (`conn:<rootId>`, `pty:<id>`, `fwd:<id>`,
    /// `xfer:<id>`) that window declares it needs. The one rule: a resource
    /// survives iff at least one LIVE window's set holds its key — `sweep_dead`
    /// tears down the rest. std Mutex: ops are quick and never `.await` (the sync
    /// window-destroy handler touches it too).
    pub window_refs: std::sync::Mutex<HashMap<String, std::collections::HashSet<String>>>,
    /// The MAIN window's published connection list (JSON authored by the
    /// frontend). A workspace window adopts it so it references the SAME backend
    /// connections instead of dialing its own (docs/dev/multi-window.md). Latest
    /// wins; changes are also broadcast live as the `conns-snapshot` event.
    pub conns_snapshot: std::sync::Mutex<Option<String>>,
    /// The MAIN window's published CHAT-session list (JSON). The sessions
    /// pop-out window adopts it and re-attaches to the SAME backend PTYs
    /// (docs/dev/multi-window.md). Broadcast live as `sessions-snapshot`.
    pub sessions_snapshot: std::sync::Mutex<Option<String>>,
    /// Whether the sessions pop-out window is currently open. While true the main
    /// window LOCKS its CHAT panel so exactly one window renders the sessions
    /// (the lock model — no double-render, no sync). Broadcast as `sessions-popped`.
    pub sessions_popped: std::sync::Mutex<bool>,
    /// Whether the workspace window is open — only so main can lock its workspace
    /// button while it is (docs/dev/multi-window.md). Broadcast as `workspace-popped`.
    pub workspace_popped: std::sync::Mutex<bool>,
    /// Per-session serialized terminal state (keyed by terminal id), handed off
    /// between windows so a re-attaching view can restore a full-screen TUI's
    /// modes + cursor + screen instead of appearing blank (docs/dev/multi-window.md).
    /// The releasing window sets it; the attaching window takes it (once).
    pub session_replays: std::sync::Mutex<HashMap<String, String>>,
    /// Which window renders each PTY (pty id → window label), so its output is
    /// emitted to that ONE window instead of broadcast to all — the lock model
    /// guarantees exactly one renderer (docs/dev/multi-window.md). Claimed by the
    /// frontend on view mount; cleared when the PTY's task ends.
    pub pty_owners: std::sync::Mutex<HashMap<String, String>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            app: std::sync::OnceLock::new(),
            sessions: Mutex::new(HashMap::new()),
            ptys: Mutex::new(HashMap::new()),
            transfers: Mutex::new(HashMap::new()),
            vcs_locks: Mutex::new(HashMap::new()),
            forwards: Mutex::new(HashMap::new()),
            repo_watchers: Mutex::new(HashMap::new()),
            dir_watchers: Mutex::new(HashMap::new()),
            file_watchers: Mutex::new(HashMap::new()),
            jj_paths: Mutex::new(HashMap::new()),
            vcs_ops: Mutex::new(HashMap::new()),
            pending_host_keys: Mutex::new(HashMap::new()),
            pending_open: std::sync::Mutex::new(None),
            window_refs: std::sync::Mutex::new(HashMap::new()),
            conns_snapshot: std::sync::Mutex::new(None),
            sessions_snapshot: std::sync::Mutex::new(None),
            sessions_popped: std::sync::Mutex::new(false),
            workspace_popped: std::sync::Mutex::new(false),
            session_replays: std::sync::Mutex::new(HashMap::new()),
            pty_owners: std::sync::Mutex::new(HashMap::new()),
        }
    }

    /// Forget a window's whole set — its boot clears it (then re-declares as it
    /// re-attaches), its close removes it for good.
    pub fn reg_clear_window(&self, label: &str) {
        self.window_refs.lock().unwrap().remove(label);
    }

    /// The survive-set: the union of the ref-sets of the windows named in `live`.
    pub fn reg_live_union(
        &self,
        live: &std::collections::HashSet<String>,
    ) -> std::collections::HashSet<String> {
        let refs = self.window_refs.lock().unwrap();
        let mut union = std::collections::HashSet::new();
        for (label, set) in refs.iter() {
            if live.contains(label) {
                union.extend(set.iter().cloned());
            }
        }
        union
    }

    /// Resolve a session id to a file transport (SFTP or local). SFTP rides
    /// the data lane — a second SSH connection dialed on first use —
    /// so file traffic can't congest or kill the terminals on the interactive
    /// lane (docs/connections.md Phase 1; falls back to sharing when the
    /// second dial fails).
    pub async fn transport(&self, conn_id: &str) -> Result<Box<dyn FileTransport>, String> {
        Ok(self.transfer_endpoint(conn_id).await?.0)
    }

    /// Like [`transport`](Self::transport), but also hands back the underlying
    /// lane connection for SSH endpoints — transfers subscribe to its
    /// reconnect epoch so a lane swap aborts the current file instead of
    /// leaving it dangling on a dead session (Phase 2).
    pub async fn transfer_endpoint(
        &self,
        conn_id: &str,
    ) -> Result<(Box<dyn FileTransport>, Option<Arc<Connection>>), String> {
        let conn = {
            let sessions = self.sessions.lock().await;
            match sessions.get(conn_id) {
                Some(Session::Ssh(conn)) => Some(conn.clone()),
                Some(Session::Local) => None,
                None => return Err(format!("session '{conn_id}' is not open")),
            }
        };
        match conn {
            Some(conn) => {
                let lane = match self.app.get() {
                    Some(app) => conn.data_lane(app).await,
                    None => conn, // startup edge: no handle yet — share lane A
                };
                Ok((Box::new(ssh::sftp::SftpTransport(lane.clone())), Some(lane)))
            }
            None => Ok((Box::new(LocalTransport), None)),
        }
    }

    /// A transfer endpoint on a DEDICATED transfer lane (docs/connections.md
    /// Phase T): the transfer's bytes get their own connection so they can't
    /// congest the data lane's everyday work, tuned purely for throughput.
    /// Falls back to the shared data lane when the dial fails. The third
    /// element is the dialed lane's id — the caller hands it to
    /// [`ssh::connection::drop_transfer_lane`] when the round is over.
    pub async fn transfer_endpoint_dedicated(
        &self,
        conn_id: &str,
    ) -> Result<(Arc<dyn FileTransport>, Option<Arc<Connection>>, Option<String>), String> {
        let conn = {
            let sessions = self.sessions.lock().await;
            match sessions.get(conn_id) {
                Some(Session::Ssh(conn)) => Some(conn.clone()),
                Some(Session::Local) => None,
                None => return Err(format!("session '{conn_id}' is not open")),
            }
        };
        let Some(conn) = conn else {
            return Ok((Arc::new(LocalTransport), None, None));
        };
        if let Some(app) = self.app.get() {
            if let Ok(lane) = conn.open_transfer_lane(app).await {
                let id = lane.id.clone();
                // Registered so the host-disconnect sweep and the liveness sweep
                // kill it with everything else; removed by drop_transfer_lane.
                self.sessions
                    .lock()
                    .await
                    .insert(id.clone(), Session::Ssh(lane.clone()));
                return Ok((
                    Arc::new(ssh::sftp::SftpTransport(lane.clone())),
                    Some(lane),
                    Some(id),
                ));
            }
        }
        // Dial failed (or startup edge) — share the data lane as before.
        let lane = match self.app.get() {
            Some(app) => conn.data_lane(app).await,
            None => conn,
        };
        Ok((Arc::new(ssh::sftp::SftpTransport(lane.clone())), Some(lane), None))
    }

    /// Resolve a session id to its SSH connection, erroring for non-SSH sessions.
    pub async fn ssh_connection(&self, conn_id: &str) -> Result<Arc<Connection>, String> {
        let sessions = self.sessions.lock().await;
        match sessions.get(conn_id) {
            Some(Session::Ssh(conn)) => Ok(conn.clone()),
            Some(_) => Err("a terminal is only available on SSH connections".to_string()),
            None => Err(format!("session '{conn_id}' is not open")),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

/// The real Windows build number (0 elsewhere / on failure). xterm's ConPTY
/// heuristics are keyed by build — modern Win11 ConPTY reflows natively on
/// resize, older builds need xterm's compensation. The frontend falls back to
/// a safe Win10 build when this returns 0.
#[tauri::command]
fn windows_build_number() -> u32 {
    #[cfg(windows)]
    {
        windows_version::OsVersion::current().build
    }
    #[cfg(not(windows))]
    {
        0
    }
}

/// Close the web inspector if the browser opened it (debug WebView2 handles
/// Ctrl+Shift+I at the browser level before the page sees the key, so the
/// CHAT toggle also fires this to keep DevTools locked; packaged builds have
/// no inspector at all).
#[tauri::command]
fn ui_close_devtools(window: tauri::WebviewWindow) {
    #[cfg(any(debug_assertions, feature = "devtools"))]
    if window.is_devtools_open() {
        window.close_devtools();
    }
    #[cfg(not(any(debug_assertions, feature = "devtools")))]
    let _ = window;
}

/// Reveal a LOCAL path in the OS file manager (Explorer/Finder/…), selecting
/// the item. Used by the "Reveal in file manager" action on local files.
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // explorer /select,<path> selects the file in a new window. The path
        // MUST use backslashes — with forward slashes Explorer ignores /select
        // and just opens the default folder. raw_arg keeps our quotes verbatim
        // (Command would otherwise re-quote the whole /select,… token) so paths
        // with spaces still resolve. explorer exits non-zero even on success,
        // so we only care that it spawned.
        let win = path.replace('/', "\\");
        std::process::Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{win}\""))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        // No universal "select" on Linux — open the containing folder.
        let dir = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from(&path));
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Open an http(s) URL in the user's default browser. Backs the editor's
/// Ctrl-click link handler — Monaco shows the "follow link" hint, but the
/// WebView2 has no working `window.open` to an external browser. Restricted to
/// http(s) so the OS is never handed a file path or a custom-scheme URL.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("refusing to open a non-http(s) URL".to_string());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer.exe")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info,russh=warn"),
    )
    .format_timestamp_millis()
    .init();

    tauri::Builder::default()
        // MUST be the first plugin (single-instance requirement). A second launch
        // — the "Open with Straylight" verb while the app is already open, or a
        // second exe start — forwards its argv here and exits, instead of opening
        // a duplicate window. We focus the existing window and hand the path to
        // the frontend as an `open-path` event.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            use tauri::{Emitter, Manager};
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            if let Some(target) = resolve_open_target(&argv) {
                let _ = app.emit("open-path", target);
            }
        }))
        // Remember window size / position / maximized across launches.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // Auto-update (GitHub Releases) + relaunch after an update installs.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState::new())
        .setup(|app| {
            // Stash the handle so deep code (lazy data-lane dial) can emit
            // events + spawn supervisors without an AppHandle parameter.
            use tauri::Manager;
            let state = app.state::<AppState>();
            let _ = state.app.set(app.handle().clone());
            // Diagnostics ring buffer + CPU self-monitor (detect-and-report).
            diag::init(app.handle().clone());
            // A first-launch "Open with Straylight" path (the running-instance
            // case comes through the single-instance callback instead). Stashed
            // for the frontend to pick up via `take_open_path` once it's booted.
            *state.pending_open.lock().unwrap() =
                resolve_open_target(&std::env::args().collect::<Vec<_>>());
            Ok(())
        })
        .on_window_event(|window, event| {
            use tauri::{Emitter, Manager};
            // Multi-window liveness (docs/dev/multi-window.md): when a window
            // CLOSES, forget its declared resources and sweep anything no live
            // window still needs. A page reload does NOT fire this (the window
            // persists) — reload cleanup stays with `window_boot`.
            if let tauri::WindowEvent::Destroyed = event {
                let app = window.app_handle().clone();
                let label = window.label().to_string();
                // `main` is primary: secondary windows (workspace, sessions) are
                // subordinate views and must not outlive it. Force-close them —
                // `destroy` (not `close`) bypasses their close handlers (the
                // sessions window's stash-on-close is pointless once main is gone
                // and would only delay exit) — so closing main closes the app
                // (docs/dev/multi-window.md).
                if label == "main" {
                    for (l, w) in app.webview_windows() {
                        if l != "main" {
                            let _ = w.destroy();
                        }
                    }
                }
                // The sessions pop-out closed → clear the popped flag so main
                // unlocks its CHAT panel (the lock model).
                if label == "sessions" {
                    *app.state::<AppState>().sessions_popped.lock().unwrap() = false;
                    let _ = app.emit("sessions-popped", false);
                }
                // The workspace window closed → unlock main's workspace button.
                if label == "workspace" {
                    *app.state::<AppState>().workspace_popped.lock().unwrap() = false;
                    let _ = app.emit("workspace-popped", false);
                }
                app.state::<AppState>().reg_clear_window(&label);
                // Forget any PTYs this window was rendering: otherwise their
                // next output keeps targeting a now-dead handle (emit_to →
                // PostMessage 0x80070578). Cleared, they fall back to broadcast
                // until a live window re-claims them (docs/dev/multi-window.md).
                app.state::<AppState>()
                    .pty_owners
                    .lock()
                    .unwrap()
                    .retain(|_, owner| *owner != label);
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<AppState>();
                    ssh::connection::sweep_dead(state.inner(), &app).await;
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            ssh::config::ssh_list_config_hosts,
            ssh::config::ssh_config_path,
            ssh::connection::ssh_connect,
            ssh::connection::ssh_disconnect,
            ssh::connection::ssh_reconnect,
            ssh::connection::ssh_trust_host,
            ssh::connection::session_lane_connect,
            ssh::connection::window_boot,
            ssh::connection::window_set_refs,
            ui_close_devtools,
            reveal_path,
            open_external,
            transport::local_connect,
            transport::list_drives,
            transport::fs_find,
            transport::fs_search,
            transport::fs_list_dir,
            transport::fs_read_file,
            transport::fs_read_base64,
            transport::fs_stat,
            transport::fs_write_file,
            transport::fs_rename,
            transport::fs_create,
            transport::fs_remove,
            transport::fs_remove_many,
            transport::fs_move,
            transport::fs_copy,
            transport::fs_transfer_batch,
            transport::fs_transfer_measure,
            transport::fs_transfer_cancel,
            transport::fs_transfer_check,
            transport::fs_entry_meta,
            transport::fs_measure,
            ssh::pty::pty_open,
            ssh::pty::pty_write,
            ssh::pty::pty_resize,
            ssh::pty::pty_close,
            ssh::pty::list_terminal_profiles,
            wsl::wsl_list_distros,
            wsl::wsl_probe_ssh,
            wsl::wsl_connect,
            forward::port_forward_start,
            forward::port_forward_stop,
            forward::port_forward_list,
            containers::container_list,
            ports::port_list,
            vcs::vcs_incoming,
            prefs::settings_path,
            save::save_commit,
            vcs::vcs_open,
            vcs::vcs_status,
            vcs::vcs_file_base,
            vcs::vcs_stage,
            vcs::vcs_unstage,
            vcs::vcs_commit,
            vcs::vcs_log,
            diag::diag_dump,
            take_open_path,
            set_conns_snapshot,
            get_conns_snapshot,
            set_sessions_snapshot,
            get_sessions_snapshot,
            set_sessions_popped,
            get_sessions_popped,
            set_workspace_popped,
            get_workspace_popped,
            set_session_replay,
            take_session_replay,
            set_pty_owner,
            vcs::vcs_remote,
            vcs::vcs_tag,
            vcs::vcs_commit_files,
            vcs::vcs_file_at,
            vcs::vcs_discard,
            vcs::vcs_branches,
            vcs::vcs_switch,
            vcs::vcs_create_branch,
            vcs::vcs_amend,
            vcs::vcs_stash,
            vcs::vcs_update,
            vcs::vcs_remote_cancel,
            watch::vcs_watch,
            watch::vcs_unwatch,
            watch::dir_watch,
            watch::dir_unwatch,
            watch::file_watch,
            watch::file_unwatch,
            windows_build_number,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Straylight application");
}
