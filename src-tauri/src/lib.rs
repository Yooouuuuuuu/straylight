//! Straylight — Tauri v2 backend.
//!
//! A "session" is one workspace the UI is attached to: a remote SSH connection,
//! a WSL distro (also reached over SSH — see [`wsl`]), or the local filesystem.
//! File operations go through the transport-agnostic [`transport::FileTransport`].

pub mod containers;
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
        }
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
                // Registered so the host-disconnect sweep and backend_reset
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ssh::config::ssh_list_config_hosts,
            ssh::config::ssh_config_path,
            ssh::connection::ssh_connect,
            ssh::connection::ssh_disconnect,
            ssh::connection::ssh_reconnect,
            ssh::connection::ssh_trust_host,
            ssh::connection::session_lane_connect,
            ssh::connection::backend_reset,
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
            vcs::vcs_remote,
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
