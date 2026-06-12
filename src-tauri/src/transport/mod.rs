//! Transport abstraction.
//!
//! A [`FileTransport`] performs directory/file operations, implemented over SFTP
//! (remote, [`crate::ssh::sftp::SftpTransport`]) and the local filesystem
//! ([`local::LocalTransport`]). The `fs_*` Tauri commands are transport-agnostic
//! and dispatch on the session behind a connection id. This is the foundation
//! for multi-transport support (Local + SSH + WSL).

pub mod local;

use serde::Serialize;
use tauri::State;

use crate::AppState;

/// Hard cap on how much of a single file we read into memory.
pub const MAX_READ_BYTES: u64 = 50 * 1024 * 1024;
/// How many leading bytes to inspect for NUL bytes when sniffing for binary.
pub const BINARY_SNIFF: usize = 8192;

/// One entry in a directory listing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub symlink_target: Option<String>,
    /// `rwxr-xr-x`-style permission string.
    pub permissions: String,
    pub owner: String,
    pub group: String,
    /// Unix mtime in seconds.
    pub modified: i64,
}

/// File contents plus enough metadata for the editor and status bar.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    /// Decoded text. Empty when `is_binary` is true.
    pub content: String,
    pub is_binary: bool,
    pub encoding: String,
    pub size: u64,
    pub modified: i64,
    pub truncated: bool,
}

/// A directory listing together with the absolute path it resolved to.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    pub entries: Vec<FileEntry>,
}

/// Lightweight stat result.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub modified: i64,
    pub permissions: String,
}

/// Read-only file operations. Phase 2 adds `write_file` here.
#[async_trait::async_trait]
pub trait FileTransport: Send + Sync {
    /// List a directory. An empty path resolves to a transport-defined default
    /// (the remote/local home directory).
    async fn list_dir(&self, path: &str) -> Result<DirListing, String>;
    async fn read_file(&self, path: &str) -> Result<FileContent, String>;
    async fn stat(&self, path: &str) -> Result<FileStat, String>;
}

/// Convert the low 9 permission bits of a Unix mode into `rwxr-xr-x`.
pub fn mode_to_rwx(mode: u32) -> String {
    let bits = mode & 0o777;
    let mut s = String::with_capacity(9);
    for shift in [6, 3, 0] {
        let v = (bits >> shift) & 0o7;
        s.push(if v & 0o4 != 0 { 'r' } else { '-' });
        s.push(if v & 0o2 != 0 { 'w' } else { '-' });
        s.push(if v & 0o1 != 0 { 'x' } else { '-' });
    }
    s
}

/// Join a POSIX (remote) parent directory with a child name. SFTP paths are
/// always `/`-separated regardless of the client OS.
pub fn join_path(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else if parent == "/" {
        format!("/{name}")
    } else if parent.ends_with('/') {
        format!("{parent}{name}")
    } else {
        format!("{parent}/{name}")
    }
}

/// True if a content prefix looks binary (NUL byte in the first sniff window).
pub fn looks_binary(prefix: &[u8]) -> bool {
    prefix[..prefix.len().min(BINARY_SNIFF)].contains(&0)
}

/// Sort entries directories-first, then case-insensitively by name.
pub fn sort_entries(entries: &mut [FileEntry]) {
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

// ---------------------------------------------------------------------------
// Transport-agnostic commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn fs_list_dir(
    state: State<'_, AppState>,
    conn_id: String,
    path: String,
) -> Result<DirListing, String> {
    state.transport(&conn_id).await?.list_dir(&path).await
}

#[tauri::command]
pub async fn fs_read_file(
    state: State<'_, AppState>,
    conn_id: String,
    path: String,
) -> Result<FileContent, String> {
    state.transport(&conn_id).await?.read_file(&path).await
}

#[tauri::command]
pub async fn fs_stat(
    state: State<'_, AppState>,
    conn_id: String,
    path: String,
) -> Result<FileStat, String> {
    state.transport(&conn_id).await?.stat(&path).await
}

/// Open a local-filesystem session and return its connection id.
#[tauri::command]
pub async fn local_connect(state: State<'_, AppState>) -> Result<String, String> {
    let conn_id = uuid::Uuid::new_v4().to_string();
    state
        .sessions
        .lock()
        .await
        .insert(conn_id.clone(), crate::Session::Local);
    log::info!("opened local session {conn_id}");
    Ok(conn_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rwx_formatting() {
        assert_eq!(mode_to_rwx(0o755), "rwxr-xr-x");
        assert_eq!(mode_to_rwx(0o644), "rw-r--r--");
        assert_eq!(mode_to_rwx(0o000), "---------");
        assert_eq!(mode_to_rwx(0o100644), "rw-r--r--");
    }

    #[test]
    fn path_joining() {
        assert_eq!(join_path("/", "etc"), "/etc");
        assert_eq!(join_path("/home/me", "file.txt"), "/home/me/file.txt");
        assert_eq!(join_path("/home/me/", "file.txt"), "/home/me/file.txt");
        assert_eq!(join_path("", "rel"), "rel");
    }

    #[test]
    fn binary_sniffing() {
        assert!(looks_binary(b"abc\0def"));
        assert!(!looks_binary(b"plain text"));
    }
}
