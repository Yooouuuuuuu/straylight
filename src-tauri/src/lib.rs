//! Straylight — Tauri v2 backend.
//!
//! The application is built around a single SSH connection per server,
//! multiplexed into channels for SFTP (file operations) and PTY (terminal).
//! All connection and PTY state lives in [`AppState`], managed by Tauri and
//! shared across commands.

pub mod ssh;

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

use ssh::connection::Connection;
use ssh::pty::PtyHandle;

/// Global application state, shared across all Tauri commands.
///
/// Both maps are guarded by async mutexes because every consumer is an async
/// command and we hold the locks across `.await` points (opening channels,
/// SFTP round-trips, etc.).
pub struct AppState {
    /// Active SSH connections, keyed by the connection id returned from
    /// [`ssh::connection::ssh_connect`].
    pub connections: Mutex<HashMap<String, Arc<Connection>>>,
    /// Open PTY/terminal sessions, keyed by the id returned from
    /// [`ssh::pty::pty_open`].
    pub ptys: Mutex<HashMap<String, PtyHandle>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            ptys: Mutex::new(HashMap::new()),
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
            ssh::config::open_ssh_config,
            ssh::connection::ssh_connect,
            ssh::connection::ssh_disconnect,
            ssh::connection::ssh_get_status,
            ssh::sftp::sftp_list_dir,
            ssh::sftp::sftp_read_file,
            ssh::sftp::sftp_stat,
            ssh::pty::pty_open,
            ssh::pty::pty_write,
            ssh::pty::pty_resize,
            ssh::pty::pty_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Straylight application");
}
