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
pub mod ssh;
pub mod transport;
pub mod vcs;
pub mod watch;
pub mod wsl;

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
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
    /// Active sessions, keyed by the connection id the frontend holds.
    pub sessions: Mutex<HashMap<String, Session>>,
    /// Open PTY/terminal sessions, keyed by the id from [`ssh::pty::pty_open`].
    pub ptys: Mutex<HashMap<String, PtyHandle>>,
    /// Cancellation flags for in-flight transfers, keyed by transfer id.
    pub transfers: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Per-repo locks (keyed by `connId::root`) serializing VCS mutations so two
    /// commits/stages can't race on git's `index.lock`.
    pub vcs_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Active local port forwards, keyed by forward id.
    pub forwards: Mutex<HashMap<String, forward::ForwardEntry>>,
    /// Filesystem watchers on local repos, keyed by `connId::root`.
    pub repo_watchers: Mutex<HashMap<String, watch::RepoWatcher>>,
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
}

impl AppState {
    fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            ptys: Mutex::new(HashMap::new()),
            transfers: Mutex::new(HashMap::new()),
            vcs_locks: Mutex::new(HashMap::new()),
            forwards: Mutex::new(HashMap::new()),
            repo_watchers: Mutex::new(HashMap::new()),
            file_watchers: Mutex::new(HashMap::new()),
            jj_paths: Mutex::new(HashMap::new()),
            vcs_ops: Mutex::new(HashMap::new()),
        }
    }

    /// Resolve a session id to a file transport (SFTP or local).
    pub async fn transport(&self, conn_id: &str) -> Result<Box<dyn FileTransport>, String> {
        let sessions = self.sessions.lock().await;
        match sessions.get(conn_id) {
            Some(Session::Ssh(conn)) => Ok(Box::new(ssh::sftp::SftpTransport(conn.clone()))),
            Some(Session::Local) => Ok(Box::new(LocalTransport)),
            None => Err(format!("session '{conn_id}' is not open")),
        }
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info,russh=warn"),
    )
    .format_timestamp_millis()
    .init();

    tauri::Builder::default()
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            ssh::config::ssh_list_config_hosts,
            ssh::config::ssh_config_path,
            ssh::connection::ssh_connect,
            ssh::connection::ssh_disconnect,
            ssh::connection::ssh_reconnect,
            transport::local_connect,
            transport::list_drives,
            transport::fs_find,
            transport::fs_search,
            transport::fs_list_dir,
            transport::fs_read_file,
            transport::fs_stat,
            transport::fs_write_file,
            transport::fs_rename,
            transport::fs_create,
            transport::fs_remove,
            transport::fs_move,
            transport::fs_copy,
            transport::fs_transfer_batch,
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
            wsl::wsl_connect,
            forward::port_forward_start,
            forward::port_forward_stop,
            forward::port_forward_list,
            containers::container_list,
            ports::port_list,
            vcs::vcs_incoming,
            prefs::settings_path,
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
            vcs::vcs_describe,
            vcs::vcs_squash,
            vcs::vcs_remote_cancel,
            watch::vcs_watch,
            watch::vcs_unwatch,
            watch::file_watch,
            watch::file_unwatch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Straylight application");
}
