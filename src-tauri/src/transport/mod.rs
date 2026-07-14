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
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::AppState;

/// Hard cap on how much of a single file we read into memory.
pub const MAX_READ_BYTES: u64 = 50 * 1024 * 1024;
/// Buffer size for streaming cross-connection transfers (peak memory per file).
const TRANSFER_CHUNK: usize = 256 * 1024;
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

/// The file operations every transport (SFTP, local) implements.
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

    /// Open a file for streaming reads (cross-connection transfers).
    async fn open_read(&self, path: &str)
        -> Result<Pin<Box<dyn AsyncRead + Send>>, String>;

    /// Open `path` for streaming writes, creating it or truncating an existing one.
    async fn open_write(&self, path: &str)
        -> Result<Pin<Box<dyn AsyncWrite + Send>>, String>;

    /// Full metadata for a single path as a [`FileEntry`] — an lstat that detects
    /// a symlink and reports its target rather than silently following it (for the
    /// Properties dialog's single-item detail).
    async fn entry_meta(&self, path: &str) -> Result<FileEntry, String>;

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

/// Progress emitted to the frontend during a batch transfer (event
/// `transfer-progress`, throttled to ~100 ms plus one per file boundary).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferProgress {
    id: String,
    done_bytes: u64,
    total_bytes: u64,
    done_files: usize,
    total_files: usize,
    current: String,
}

/// What a finished (or cancelled) batch transfer copied.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferOutcome {
    files: usize,
    bytes: u64,
    cancelled: bool,
}

/// Shared progress + cancellation state threaded (by `&`) through the copy
/// recursion. Interior-mutable so the hot path doesn't lock beyond a throttle
/// timestamp.
struct Progress {
    app: AppHandle,
    id: String,
    cancel: Arc<AtomicBool>,
    total_bytes: u64,
    total_files: usize,
    done_bytes: AtomicU64,
    done_files: AtomicUsize,
    last_emit: std::sync::Mutex<Instant>,
}

impl Progress {
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    fn add_bytes(&self, n: u64, current: &str) {
        self.done_bytes.fetch_add(n, Ordering::Relaxed);
        self.emit(current, false);
    }

    fn file_done(&self, current: &str) {
        self.done_files.fetch_add(1, Ordering::Relaxed);
        self.emit(current, true);
    }

    /// Emit a progress event, throttled to ~100 ms unless `force` (a file
    /// boundary, or the initial/final frame).
    fn emit(&self, current: &str, force: bool) {
        {
            let mut last = self.last_emit.lock().unwrap();
            let now = Instant::now();
            if !force && now.duration_since(*last) < Duration::from_millis(100) {
                return;
            }
            *last = now;
        }
        let _ = self.app.emit(
            "transfer-progress",
            TransferProgress {
                id: self.id.clone(),
                done_bytes: self.done_bytes.load(Ordering::Relaxed),
                total_bytes: self.total_bytes,
                done_files: self.done_files.load(Ordering::Relaxed),
                total_files: self.total_files,
                current: current.to_string(),
            },
        );
    }
}

/// Recursively total the bytes and file count under `path`, for the progress bar.
fn measure<'a>(
    src: &'a dyn FileTransport,
    path: &'a str,
) -> Pin<Box<dyn Future<Output = Result<(u64, usize), String>> + Send + 'a>> {
    Box::pin(async move {
        let meta = src.stat(path).await?;
        if !meta.is_dir {
            return Ok((meta.size, 1));
        }
        let mut bytes = 0u64;
        let mut files = 0usize;
        for entry in src.list_dir(path).await?.entries {
            let (b, f) = measure(src, &entry.path).await?;
            bytes += b;
            files += f;
        }
        Ok((bytes, files))
    })
}

/// Copy a batch of entries from one connection into a directory on another,
/// streaming each file and emitting `transfer-progress`. Copy-only — never moves.
/// `rename_on_conflict` resolves a top-level name clash by appending "copy";
/// otherwise it overwrites a file / merges into an existing folder.
#[tauri::command]
pub async fn fs_transfer_batch(
    app: AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
    src_conn_id: String,
    src_paths: Vec<String>,
    dest_conn_id: String,
    dest_dir: String,
    rename_on_conflict: bool,
) -> Result<TransferOutcome, String> {
    let src = state.transport(&src_conn_id).await?;
    let dest = state.transport(&dest_conn_id).await?;

    // Register a cancellation flag the UI can trip via `fs_transfer_cancel`.
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .transfers
        .lock()
        .await
        .insert(transfer_id.clone(), cancel.clone());

    let result = run_transfer(
        &app,
        &transfer_id,
        cancel,
        src.as_ref(),
        &src_paths,
        dest.as_ref(),
        &dest_dir,
        rename_on_conflict,
    )
    .await;

    state.transfers.lock().await.remove(&transfer_id);
    result
}

/// Trip a transfer's cancellation flag; the copy loop stops at the next chunk.
#[tauri::command]
pub async fn fs_transfer_cancel(
    state: State<'_, AppState>,
    transfer_id: String,
) -> Result<(), String> {
    if let Some(flag) = state.transfers.lock().await.get(&transfer_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn run_transfer(
    app: &AppHandle,
    id: &str,
    cancel: Arc<AtomicBool>,
    src: &dyn FileTransport,
    src_paths: &[String],
    dest: &dyn FileTransport,
    dest_dir: &str,
    rename_on_conflict: bool,
) -> Result<TransferOutcome, String> {
    let mut total_bytes = 0u64;
    let mut total_files = 0usize;
    for p in src_paths {
        let (b, f) = measure(src, p).await?;
        total_bytes += b;
        total_files += f;
    }

    let prog = Progress {
        app: app.clone(),
        id: id.to_string(),
        cancel,
        total_bytes,
        total_files,
        done_bytes: AtomicU64::new(0),
        done_files: AtomicUsize::new(0),
        last_emit: std::sync::Mutex::new(Instant::now()),
    };
    prog.emit("", true); // 0% up front so the bar appears immediately

    for p in src_paths {
        if prog.cancelled() {
            break;
        }
        transfer_entry(src, p, dest, dest_dir, rename_on_conflict, true, &prog).await?;
    }

    let cancelled = prog.cancelled();
    prog.emit("", true); // final frame
    Ok(TransferOutcome {
        files: prog.done_files.load(Ordering::Relaxed),
        bytes: prog.done_bytes.load(Ordering::Relaxed),
        cancelled,
    })
}

/// Aggregate size + counts for the Properties dialog (recursive over a selection).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertiesInfo {
    files: usize,
    folders: usize,
    bytes: u64,
}

/// Full metadata for one path — for the Properties dialog's single-item detail.
#[tauri::command]
pub async fn fs_entry_meta(
    state: State<'_, AppState>,
    conn_id: String,
    path: String,
) -> Result<FileEntry, String> {
    state.transport(&conn_id).await?.entry_meta(&path).await
}

/// Recursively total files, folders, and bytes under `paths` (for Properties).
/// A directory's contents are counted; symlinks count as files and aren't
/// followed (so symlink cycles can't loop).
#[tauri::command]
pub async fn fs_measure(
    state: State<'_, AppState>,
    conn_id: String,
    paths: Vec<String>,
) -> Result<PropertiesInfo, String> {
    let t = state.transport(&conn_id).await?;
    let (mut files, mut folders, mut bytes) = (0usize, 0usize, 0u64);
    for p in &paths {
        let (f, d, b) = measure_props(t.as_ref(), p).await?;
        files += f;
        folders += d;
        bytes += b;
    }
    Ok(PropertiesInfo { files, folders, bytes })
}

/// `(files, folders, bytes)` for `path`: a file is `(1, 0, size)`; a directory is
/// its recursive contents (the directory itself is not counted).
fn measure_props<'a>(
    src: &'a dyn FileTransport,
    path: &'a str,
) -> Pin<Box<dyn Future<Output = Result<(usize, usize, u64), String>> + Send + 'a>> {
    Box::pin(async move {
        let meta = src.stat(path).await?;
        if !meta.is_dir {
            return Ok((1, 0, meta.size));
        }
        let (mut files, mut folders, mut bytes) = (0usize, 0usize, 0u64);
        for entry in src.list_dir(path).await?.entries {
            if entry.is_dir && !entry.is_symlink {
                folders += 1;
                let (f, d, b) = measure_props(src, &entry.path).await?;
                files += f;
                folders += d;
                bytes += b;
            } else {
                files += 1;
                bytes += entry.size;
            }
        }
        Ok((files, folders, bytes))
    })
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
    prog: &'a Progress,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        if prog.cancelled() {
            return Ok(());
        }
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
            for entry in src.list_dir(src_path).await?.entries {
                if prog.cancelled() {
                    break;
                }
                transfer_entry(src, &entry.path, dest, &dest_path, false, false, prog).await?;
            }
        } else {
            stream_file(src, src_path, dest, &dest_path, &name, prog).await?;
        }
        Ok(())
    })
}

/// Stream one file from `src` to `dest`, updating `prog`. The bytes go to a
/// temporary `.straypart` sibling first and are renamed over `dest_path` only
/// once fully written — so a cancel or mid-stream error never destroys a
/// pre-existing destination being overwritten, and never leaves a silently
/// truncated copy (the temp file is best-effort deleted instead).
async fn stream_file(
    src: &dyn FileTransport,
    src_path: &str,
    dest: &dyn FileTransport,
    dest_path: &str,
    name: &str,
    prog: &Progress,
) -> Result<(), String> {
    let part_path = format!("{dest_path}.straypart");
    let mut reader = src.open_read(src_path).await?;
    let mut writer = dest.open_write(&part_path).await?;
    let mut buf = vec![0u8; TRANSFER_CHUNK];

    let mut error: Option<String> = None;
    let mut completed = true;
    loop {
        if prog.cancelled() {
            completed = false;
            break;
        }
        let n = match reader.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                error = Some(format!("could not read {src_path}: {e}"));
                completed = false;
                break;
            }
        };
        if let Err(e) = writer.write_all(&buf[..n]).await {
            error = Some(format!("could not write {dest_path}: {e}"));
            completed = false;
            break;
        }
        prog.add_bytes(n as u64, name);
    }

    // A failed final flush means bytes never landed — that's an error, not a
    // completed copy.
    if completed {
        if let Err(e) = writer.flush().await {
            error = Some(format!("could not write {dest_path}: {e}"));
            completed = false;
        }
    }

    if completed {
        writer.shutdown().await.ok();
        drop(writer);
        // Commit: rename the temp file over the destination. Plain SFTP rename
        // refuses to replace an existing target on most servers, so on failure
        // remove the destination and retry once.
        if dest.rename(&part_path, name).await.is_err() {
            let _ = dest.remove(dest_path).await;
            if let Err(e) = dest.rename(&part_path, name).await {
                let _ = dest.remove(&part_path).await;
                return Err(format!("could not finish {dest_path}: {e}"));
            }
        }
        prog.file_done(name);
        Ok(())
    } else {
        drop(writer);
        let _ = dest.remove(&part_path).await;
        match error {
            Some(e) => Err(e),
            None => Ok(()), // cancelled — not an error
        }
    }
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

/// The local machine's filesystem roots, so the in-app folder browser can switch
/// between disks without the user typing a path. On Windows these are the present
/// drive letters (`C:\`, `D:\`, …); elsewhere it's just `/`.
#[cfg(windows)]
#[tauri::command]
pub fn list_drives() -> Vec<String> {
    // GetLogicalDrives returns a bitmask of present drives (bit 0 = A, 1 = B, …);
    // unlike probing each root it never touches removable media or stalls.
    #[link(name = "kernel32")]
    extern "system" {
        fn GetLogicalDrives() -> u32;
    }
    let mask = unsafe { GetLogicalDrives() };
    (0..26u32)
        .filter(|i| mask & (1u32 << i) != 0)
        .map(|i| format!("{}:\\", (b'A' + i as u8) as char))
        .collect()
}

#[cfg(not(windows))]
#[tauri::command]
pub fn list_drives() -> Vec<String> {
    vec!["/".to_string()]
}

/// Directory names skipped by the finder and search-in-files, at any depth.
/// Includes the big per-user tool/cache trees — a home-dir pin would otherwise
/// make `grep -r` read gigabytes of toolchain text ("search runs forever").
const IGNORE_DIRS: &[&str] = &[
    ".git",
    ".jj",
    "node_modules",
    "target",
    "dist",
    ".next",
    "build",
    ".svn",
    "vendor",
    ".cargo",
    ".rustup",
    ".cache",
    ".npm",
    ".venv",
    "venv",
    "__pycache__",
    ".m2",
    ".gradle",
];
/// Cap on how many file paths the finder returns per root.
const FIND_LIMIT: usize = 50_000;

/// List files under `root` (relative, forward-slash), for the fuzzy file finder.
/// Local walks the filesystem; SSH/WSL runs `find` (one round trip). Common build
/// / VCS directories are skipped.
#[tauri::command]
pub async fn fs_find(
    state: State<'_, AppState>,
    conn_id: String,
    root: String,
) -> Result<Vec<String>, String> {
    let is_local = {
        let sessions = state.sessions.lock().await;
        matches!(sessions.get(&conn_id), Some(crate::Session::Local))
    };
    if is_local {
        find_local(root).await
    } else {
        find_remote(&state, &conn_id, &root).await
    }
}

async fn find_local(root: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let base = std::path::PathBuf::from(&root);
        let mut out: Vec<String> = Vec::new();
        let mut stack = vec![base.clone()];
        while let Some(dir) = stack.pop() {
            if out.len() >= FIND_LIMIT {
                break;
            }
            let rd = match std::fs::read_dir(&dir) {
                Ok(r) => r,
                Err(_) => continue,
            };
            for entry in rd.flatten() {
                let ft = match entry.file_type() {
                    Ok(f) => f,
                    Err(_) => continue,
                };
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if ft.is_dir() {
                    if !IGNORE_DIRS.contains(&name.as_ref()) {
                        stack.push(entry.path());
                    }
                } else if ft.is_file() {
                    if let Ok(rel) = entry.path().strip_prefix(&base) {
                        out.push(rel.to_string_lossy().replace('\\', "/"));
                        if out.len() >= FIND_LIMIT {
                            break;
                        }
                    }
                }
            }
        }
        out
    })
    .await
    .map_err(|e| format!("could not list files: {e}"))
}

async fn find_remote(
    state: &AppState,
    conn_id: &str,
    root: &str,
) -> Result<Vec<String>, String> {
    let mut argv: Vec<&str> = vec!["find", ".", "("];
    let mut first = true;
    for &d in IGNORE_DIRS {
        if !first {
            argv.push("-o");
        }
        argv.push("-name");
        argv.push(d);
        first = false;
    }
    argv.extend(["-prune", ")", "-o", "-type", "f", "-print"]);
    let out = crate::exec::run_command(state, conn_id, root, &argv).await?;
    if out.code != 0 && out.stdout.is_empty() {
        let msg = out.stderr.trim();
        return Err(if msg.is_empty() {
            "could not list files".into()
        } else {
            msg.to_string()
        });
    }
    Ok(out
        .stdout
        .lines()
        .map(|l| l.strip_prefix("./").unwrap_or(l))
        .filter(|l| !l.is_empty())
        .take(FIND_LIMIT)
        .map(String::from)
        .collect())
}

/// One search hit.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    /// Path relative to the searched root (forward-slash).
    pub path: String,
    pub line: u32,
    pub text: String,
}

const SEARCH_LIMIT: usize = 2000;
const SEARCH_MAX_FILE: u64 = 2 * 1024 * 1024;

/// Literal, case-sensitive search for `query` under `root`. Local scans files in
/// Rust (portable); SSH/WSL runs `grep`. Skips the same dirs as the finder.
#[tauri::command]
pub async fn fs_search(
    state: State<'_, AppState>,
    conn_id: String,
    root: String,
    query: String,
) -> Result<Vec<SearchMatch>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let is_local = {
        let sessions = state.sessions.lock().await;
        matches!(sessions.get(&conn_id), Some(crate::Session::Local))
    };
    if is_local {
        search_local(root, query).await
    } else {
        search_remote(&state, &conn_id, &root, &query).await
    }
}

async fn search_local(root: String, query: String) -> Result<Vec<SearchMatch>, String> {
    tokio::task::spawn_blocking(move || {
        let base = std::path::PathBuf::from(&root);
        let mut matches: Vec<SearchMatch> = Vec::new();
        let mut stack = vec![base.clone()];
        while let Some(dir) = stack.pop() {
            if matches.len() >= SEARCH_LIMIT {
                break;
            }
            let rd = match std::fs::read_dir(&dir) {
                Ok(r) => r,
                Err(_) => continue,
            };
            for entry in rd.flatten() {
                let ft = match entry.file_type() {
                    Ok(f) => f,
                    Err(_) => continue,
                };
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if ft.is_dir() {
                    if !IGNORE_DIRS.contains(&name.as_ref()) {
                        stack.push(entry.path());
                    }
                    continue;
                }
                if !ft.is_file() {
                    continue;
                }
                let path = entry.path();
                if path.metadata().map(|m| m.len()).unwrap_or(0) > SEARCH_MAX_FILE {
                    continue;
                }
                let content = match std::fs::read(&path) {
                    Ok(b) => b,
                    Err(_) => continue,
                };
                if looks_binary(&content) {
                    continue;
                }
                let text = String::from_utf8_lossy(&content);
                let rel = match path.strip_prefix(&base) {
                    Ok(r) => r.to_string_lossy().replace('\\', "/"),
                    Err(_) => continue,
                };
                for (i, line) in text.lines().enumerate() {
                    if line.contains(&query) {
                        matches.push(SearchMatch {
                            path: rel.clone(),
                            line: (i + 1) as u32,
                            text: line.chars().take(300).collect(),
                        });
                        if matches.len() >= SEARCH_LIMIT {
                            break;
                        }
                    }
                }
            }
        }
        matches
    })
    .await
    .map_err(|e| format!("search failed: {e}"))
}

async fn search_remote(
    state: &AppState,
    conn_id: &str,
    root: &str,
    query: &str,
) -> Result<Vec<SearchMatch>, String> {
    // `-s` silences per-file "Permission denied" spam (it still exits 2 on such
    // errors, which is why matches-with-code-2 is accepted below).
    let mut owned: Vec<String> = vec!["grep".into(), "-rnIFs".into()];
    for &d in IGNORE_DIRS {
        owned.push(format!("--exclude-dir={d}"));
    }
    owned.push("-e".into());
    owned.push(query.to_string());
    owned.push(".".into());
    let argv: Vec<&str> = owned.iter().map(String::as_str).collect();

    let out = crate::exec::run_command(state, conn_id, root, &argv).await?;
    // grep: 0 = matches, 1 = none, >1 = error. BUT grep also exits 2 when it
    // merely *hit* an unreadable file while still finding matches — so only
    // treat >1 as failure when there's no output to show.
    if out.code > 1 && out.stdout.trim().is_empty() {
        let msg = out.stderr.trim();
        return Err(if msg.is_empty() {
            "search failed".into()
        } else {
            msg.to_string()
        });
    }
    let mut matches = Vec::new();
    for line in out.stdout.lines() {
        if matches.len() >= SEARCH_LIMIT {
            break;
        }
        let line = line.strip_prefix("./").unwrap_or(line);
        if let Some((path, rest)) = line.split_once(':') {
            if let Some((num, text)) = rest.split_once(':') {
                if let Ok(n) = num.parse::<u32>() {
                    matches.push(SearchMatch {
                        path: path.to_string(),
                        line: n,
                        text: text.chars().take(300).collect(),
                    });
                }
            }
        }
    }
    Ok(matches)
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
