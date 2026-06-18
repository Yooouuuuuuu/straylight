//! Transport abstraction.
//!
//! A [`FileTransport`] performs directory/file operations, implemented over SFTP
//! (remote, [`crate::ssh::sftp::SftpTransport`]) and the local filesystem
//! ([`local::LocalTransport`]). The `fs_*` Tauri commands are transport-agnostic
//! and dispatch on the session behind a connection id. This is the foundation
//! for multi-transport support (Local + SSH + WSL).

pub mod local;

use std::future::Future;
use std::pin::Pin;

use serde::Serialize;
use tauri::State;

use crate::AppState;

/// Hard cap on how much of a single file we read into memory.
pub const MAX_READ_BYTES: u64 = 50 * 1024 * 1024;
/// Cap on a single file copied in one in-memory cross-connection transfer.
/// (Streaming, which removes this, is the first follow-up — see docs/drag-drop.md.)
pub const MAX_TRANSFER_BYTES: u64 = 512 * 1024 * 1024;
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

/// Result of a write. On conflict the write is NOT performed and `modified`
/// holds the file's current (newer) mtime; otherwise it holds the new mtime.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub conflict: bool,
    pub modified: i64,
}

/// Read-only file operations. Phase 2 adds `write_file` here.
#[async_trait::async_trait]
pub trait FileTransport: Send + Sync {
    /// List a directory. An empty path resolves to a transport-defined default
    /// (the remote/local home directory).
    async fn list_dir(&self, path: &str) -> Result<DirListing, String>;
    async fn read_file(&self, path: &str) -> Result<FileContent, String>;
    async fn stat(&self, path: &str) -> Result<FileStat, String>;

    /// Write `content` to `path`. When `expected_modified` is `Some(t)` and `t`
    /// is non-zero, the write is refused (conflict) if the file's current mtime
    /// is newer than `t` — i.e. it changed since the caller last read it.
    async fn write_file(
        &self,
        path: &str,
        content: &str,
        expected_modified: Option<i64>,
    ) -> Result<WriteResult, String>;

    /// Rename the entry at `path` to `new_name` within the same directory.
    /// Returns the new absolute path.
    async fn rename(&self, path: &str, new_name: &str) -> Result<String, String>;

    /// Create an empty file or a directory named `name` inside `parent`. Fails
    /// if it already exists. Returns the new absolute path.
    async fn create_entry(
        &self,
        parent: &str,
        name: &str,
        is_dir: bool,
    ) -> Result<String, String>;

    /// Remove `path` (recursively for directories).
    async fn remove(&self, path: &str) -> Result<(), String>;

    /// Move `path` into `dest_dir` (same connection), keeping its basename.
    /// A no-op if it's already there; errors if the target name is taken.
    /// Returns the new absolute path.
    async fn move_to(&self, path: &str, dest_dir: &str) -> Result<String, String>;

    /// Copy `path` into `dest_dir` (recursively for directories), auto-renaming
    /// (`name copy`, `name copy 2`, …) on a name collision. Returns the new path.
    async fn copy_to(&self, path: &str, dest_dir: &str) -> Result<String, String>;

    /// Read a file's raw bytes (no text decoding), for cross-connection
    /// transfers. Errors if the file exceeds [`MAX_TRANSFER_BYTES`].
    async fn read_bytes(&self, path: &str) -> Result<Vec<u8>, String>;

    /// Write raw bytes to `path`, creating or truncating it.
    async fn write_bytes(&self, path: &str, bytes: &[u8]) -> Result<(), String>;

    /// Join a parent directory with a child name in this transport's path style
    /// (POSIX for SFTP, the OS separator for local).
    fn join(&self, parent: &str, name: &str) -> String;
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

/// Split a filename into `(stem, extension)` where the extension includes the
/// leading dot (empty if none). A leading dot (a dotfile) stays in the stem.
pub fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

/// The Nth "copy" variant of a filename: `a.txt` → `a copy.txt` / `a copy 2.txt`.
pub fn copy_variant(name: &str, n: usize) -> String {
    let (stem, ext) = split_ext(name);
    if n <= 1 {
        format!("{stem} copy{ext}")
    } else {
        format!("{stem} copy {n}{ext}")
    }
}

/// Basename tolerant of either separator — the source path of a transfer may be
/// POSIX (SFTP/WSL) or Windows (local) depending on the source transport.
pub fn any_basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches(['/', '\\']);
    match trimmed.rsplit(['/', '\\']).next() {
        Some(name) if !name.is_empty() => name,
        _ => trimmed,
    }
}

/// POSIX basename — the final path component (for `/`-separated SFTP paths).
pub fn posix_basename(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rsplit_once('/') {
        Some((_, name)) => name.to_string(),
        None => trimmed.to_string(),
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

#[tauri::command]
pub async fn fs_write_file(
    state: State<'_, AppState>,
    conn_id: String,
    path: String,
    content: String,
    expected_modified: Option<i64>,
) -> Result<WriteResult, String> {
    state
        .transport(&conn_id)
        .await?
        .write_file(&path, &content, expected_modified)
        .await
}

#[tauri::command]
pub async fn fs_rename(
    state: State<'_, AppState>,
    conn_id: String,
    path: String,
    new_name: String,
) -> Result<String, String> {
    state.transport(&conn_id).await?.rename(&path, &new_name).await
}

#[tauri::command]
pub async fn fs_create(
    state: State<'_, AppState>,
    conn_id: String,
    parent: String,
    name: String,
    is_dir: bool,
) -> Result<String, String> {
    state
        .transport(&conn_id)
        .await?
        .create_entry(&parent, &name, is_dir)
        .await
}

#[tauri::command]
pub async fn fs_remove(
    state: State<'_, AppState>,
    conn_id: String,
    path: String,
) -> Result<(), String> {
    state.transport(&conn_id).await?.remove(&path).await
}

#[tauri::command]
pub async fn fs_move(
    state: State<'_, AppState>,
    conn_id: String,
    path: String,
    dest_dir: String,
) -> Result<String, String> {
    state
        .transport(&conn_id)
        .await?
        .move_to(&path, &dest_dir)
        .await
}

#[tauri::command]
pub async fn fs_copy(
    state: State<'_, AppState>,
    conn_id: String,
    path: String,
    dest_dir: String,
) -> Result<String, String> {
    state
        .transport(&conn_id)
        .await?
        .copy_to(&path, &dest_dir)
        .await
}

/// Copy an entry from one connection into a directory on another (the relay
/// behind cross-connection transfers). Copy-only — never moves. `rename_on_conflict`
/// resolves a top-level name clash by appending "copy"; otherwise it overwrites a
/// file / merges into an existing folder. Returns the new destination path.
#[tauri::command]
pub async fn fs_transfer(
    state: State<'_, AppState>,
    src_conn_id: String,
    src_path: String,
    dest_conn_id: String,
    dest_dir: String,
    rename_on_conflict: bool,
) -> Result<String, String> {
    let src = state.transport(&src_conn_id).await?;
    let dest = state.transport(&dest_conn_id).await?;
    transfer_entry(
        src.as_ref(),
        &src_path,
        dest.as_ref(),
        &dest_dir,
        rename_on_conflict,
        true,
    )
    .await
}

/// Whether transferring `src_path` into `dest_dir` on `dest_conn` would collide
/// with an existing top-level entry — so the UI can prompt before overwriting.
#[tauri::command]
pub async fn fs_transfer_check(
    state: State<'_, AppState>,
    src_path: String,
    dest_conn_id: String,
    dest_dir: String,
) -> Result<bool, String> {
    let dest = state.transport(&dest_conn_id).await?;
    let dest_path = dest.join(&dest_dir, any_basename(&src_path));
    Ok(dest.stat(&dest_path).await.is_ok())
}

fn transfer_entry<'a>(
    src: &'a dyn FileTransport,
    src_path: &'a str,
    dest: &'a dyn FileTransport,
    dest_dir: &'a str,
    rename_on_conflict: bool,
    top: bool,
) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>> {
    Box::pin(async move {
        let meta = src.stat(src_path).await?;
        let base = any_basename(src_path);
        let mut name = base.to_string();
        let mut dest_path = dest.join(dest_dir, &name);
        // Resolve a top-level collision; nested entries just overwrite/merge.
        if top {
            let mut n = 1;
            while dest.stat(&dest_path).await.is_ok() {
                if !rename_on_conflict {
                    break;
                }
                name = copy_variant(base, n);
                dest_path = dest.join(dest_dir, &name);
                n += 1;
            }
        }
        if meta.is_dir {
            // Create (or reuse) the destination folder, then recurse.
            let _ = dest.create_entry(dest_dir, &name, true).await;
            let listing = src.list_dir(src_path).await?;
            for entry in listing.entries {
                transfer_entry(src, &entry.path, dest, &dest_path, false, false).await?;
            }
        } else {
            let bytes = src.read_bytes(src_path).await?;
            dest.write_bytes(&dest_path, &bytes).await?;
        }
        Ok(dest_path)
    })
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

    #[test]
    fn copy_naming() {
        assert_eq!(split_ext("a.txt"), ("a", ".txt"));
        assert_eq!(split_ext("Makefile"), ("Makefile", ""));
        assert_eq!(split_ext(".gitignore"), (".gitignore", ""));
        assert_eq!(copy_variant("a.txt", 1), "a copy.txt");
        assert_eq!(copy_variant("a.txt", 3), "a copy 3.txt");
        assert_eq!(copy_variant("src", 1), "src copy");
    }

    #[test]
    fn posix_basenames() {
        assert_eq!(posix_basename("/home/me/file.txt"), "file.txt");
        assert_eq!(posix_basename("/home/me/dir/"), "dir");
        assert_eq!(posix_basename("solo"), "solo");
    }

    #[test]
    fn any_basenames() {
        assert_eq!(any_basename("/home/me/file.txt"), "file.txt");
        assert_eq!(any_basename("C:\\foo\\bar.txt"), "bar.txt");
        assert_eq!(any_basename("/home/me/dir/"), "dir");
        assert_eq!(any_basename("solo"), "solo");
    }
}
