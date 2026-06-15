//! Straylight — Tauri v2 backend.
//!
//! A "session" is one workspace the UI is attached to. It can be a remote SSH
//! connection or the local filesystem (WSL is planned). File operations go
//! through the transport-agnostic [`transport::FileTransport`]; terminals are
//! currently SSH-only.

pub mod ssh;
pub mod transport;

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
    /// Active sessions, keyed by the connection id the frontend holds.
    pub sessions: Mutex<HashMap<String, Session>>,
    /// Open PTY/terminal sessions, keyed by the id from [`ssh::pty::pty_open`].
    pub ptys: Mutex<HashMap<String, PtyHandle>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            ptys: Mutex::new(HashMap::new()),
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            ssh::config::ssh_list_config_hosts,
            ssh::config::ssh_config_path,
            ssh::connection::ssh_connect,
            ssh::connection::ssh_disconnect,
            ssh::connection::ssh_get_status,
            transport::local_connect,
            transport::fs_list_dir,
            transport::fs_read_file,
            transport::fs_stat,
            transport::fs_write_file,
            transport::fs_rename,
            transport::fs_create,
            transport::fs_remove,
            ssh::pty::pty_open,
            ssh::pty::pty_write,
            ssh::pty::pty_resize,
            ssh::pty::pty_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Straylight application");
}
