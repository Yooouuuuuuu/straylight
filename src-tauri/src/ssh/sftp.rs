//! Read-only SFTP operations needed for Phase 1: directory listing, file
//! reading (with binary detection), and stat. Writing, deleting, and transfers
//! arrive in Phase 2.

use serde::Serialize;
use tauri::State;
use tokio::io::AsyncReadExt;

use crate::ssh::connection::get_connection;
use crate::ssh::{join_path, mode_to_rwx};
use crate::AppState;

/// Hard cap on how much of a single file we read into memory. Files larger than
/// this are returned truncated and flagged so the editor can warn.
const MAX_READ_BYTES: u64 = 50 * 1024 * 1024;
/// How many leading bytes to inspect for NUL bytes when sniffing for binary.
const BINARY_SNIFF: usize = 8192;

/// A single entry in a remote directory listing.
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

/// The contents of a file plus enough metadata for the editor and status bar.
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
    /// True when the file exceeded [`MAX_READ_BYTES`] and was cut off.
    pub truncated: bool,
}

/// A directory listing together with the absolute path it was resolved to. The
/// resolved `path` lets the frontend learn the canonical home directory when it
/// lists `""`.
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

/// List a remote directory. An empty or `"."` path is canonicalized to the
/// user's home directory, and the resolved absolute path is reflected back in
/// each entry's `path`, so the frontend can navigate without tracking the cwd
/// itself.
#[tauri::command]
pub async fn sftp_list_dir(
    state: State<'_, AppState>,
    conn_id: String,
    path: String,
) -> Result<DirListing, String> {
    let connection = get_connection(&state, &conn_id).await?;
    let guard = connection.sftp().await?;
    let sftp = guard.as_ref().expect("sftp session initialized above");

    let base = if path.is_empty() || path == "." {
        sftp.canonicalize(".")
            .await
            .map_err(|e| format!("could not resolve home directory: {e}"))?
    } else {
        path
    };

    let read_dir = sftp
        .read_dir(base.clone())
        .await
        .map_err(|e| format!("could not list {base}: {e}"))?;

    let mut entries: Vec<FileEntry> = Vec::new();
    for entry in read_dir {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = entry.metadata();
        let full = join_path(&base, &name);
        let is_symlink = meta.is_symlink();

        // For symlinks, follow to the target to decide whether it behaves like a
        // directory (so it can be expanded) and to show the target path.
        let (is_dir, size, symlink_target) = if is_symlink {
            let target = sftp.read_link(full.clone()).await.ok();
            match sftp.metadata(full.clone()).await {
                Ok(resolved) => (resolved.is_dir(), resolved.size.unwrap_or(0), target),
                Err(_) => (false, meta.size.unwrap_or(0), target),
            }
        } else {
            (meta.is_dir(), meta.size.unwrap_or(0), None)
        };

        entries.push(FileEntry {
            name,
            path: full,
            size,
            is_dir,
            is_symlink,
            symlink_target,
            permissions: mode_to_rwx(meta.permissions.unwrap_or(0)),
            owner: meta
                .user
                .clone()
                .or_else(|| meta.uid.map(|u| u.to_string()))
                .unwrap_or_default(),
            group: meta
                .group
                .clone()
                .or_else(|| meta.gid.map(|g| g.to_string()))
                .unwrap_or_default(),
            modified: meta.mtime.map(|m| m as i64).unwrap_or(0),
        });
    }

    // Directories first, then case-insensitive by name — the familiar order.
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(DirListing {
        path: base,
        entries,
    })
}

/// Read a file's contents. Detects binary files (NUL byte in the first 8 KB) and
/// returns them flagged with empty content so the UI can show an info card
/// instead of loading them into the editor.
#[tauri::command]
pub async fn sftp_read_file(
    state: State<'_, AppState>,
    conn_id: String,
    path: String,
) -> Result<FileContent, String> {
    let connection = get_connection(&state, &conn_id).await?;
    let guard = connection.sftp().await?;
    let sftp = guard.as_ref().expect("sftp session initialized above");

    let meta = sftp
        .metadata(path.clone())
        .await
        .map_err(|e| format!("could not stat {path}: {e}"))?;
    let size = meta.size.unwrap_or(0);
    let modified = meta.mtime.map(|m| m as i64).unwrap_or(0);

    let truncated = size > MAX_READ_BYTES;

    let file = sftp
        .open(path.clone())
        .await
        .map_err(|e| format!("could not open {path}: {e}"))?;
    let mut reader = file.take(MAX_READ_BYTES);

    // Read just the first chunk and sniff it for NUL bytes. A binary file
    // returns here immediately, without downloading the rest.
    let mut buffer: Vec<u8> = Vec::with_capacity(BINARY_SNIFF);
    let mut chunk = [0u8; 4096];
    while buffer.len() < BINARY_SNIFF {
        let n = reader
            .read(&mut chunk)
            .await
            .map_err(|e| format!("could not read {path}: {e}"))?;
        if n == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..n]);
    }

    if buffer.contains(&0) {
        return Ok(FileContent {
            path,
            content: String::new(),
            is_binary: true,
            encoding: "binary".to_string(),
            size,
            modified,
            truncated,
        });
    }

    // Text file: read the remainder (up to the size cap).
    reader
        .read_to_end(&mut buffer)
        .await
        .map_err(|e| format!("could not read {path}: {e}"))?;

    Ok(FileContent {
        path,
        content: String::from_utf8_lossy(&buffer).into_owned(),
        is_binary: false,
        encoding: "utf-8".to_string(),
        size,
        modified,
        truncated,
    })
}

/// Stat a single path.
#[tauri::command]
pub async fn sftp_stat(
    state: State<'_, AppState>,
    conn_id: String,
    path: String,
) -> Result<FileStat, String> {
    let connection = get_connection(&state, &conn_id).await?;
    let guard = connection.sftp().await?;
    let sftp = guard.as_ref().expect("sftp session initialized above");

    let meta = sftp
        .metadata(path.clone())
        .await
        .map_err(|e| format!("could not stat {path}: {e}"))?;
    Ok(FileStat {
        path,
        size: meta.size.unwrap_or(0),
        is_dir: meta.is_dir(),
        modified: meta.mtime.map(|m| m as i64).unwrap_or(0),
        permissions: mode_to_rwx(meta.permissions.unwrap_or(0)),
    })
}
