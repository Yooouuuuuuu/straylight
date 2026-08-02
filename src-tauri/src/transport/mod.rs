//! Transport abstraction.
//!
//! A [`FileTransport`] performs directory/file operations, implemented over SFTP
//! (remote, [`crate::ssh::sftp::SftpTransport`]) and the local filesystem
//! ([`local::LocalTransport`]). The `fs_*` Tauri commands are transport-agnostic
//! and dispatch on the session behind a connection id. This is the foundation
//! for multi-transport support (Local + SSH + WSL).

pub mod local;
pub mod pipeline;

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, watch};

use crate::ssh::connection::{Connection, ConnectionState};
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
    /// The bytes weren't valid UTF-8 and were decoded with U+FFFD replacements
    /// — `content` is NOT a faithful copy, so the frontend blocks saving it
    /// (a write-back would destroy the original bytes).
    pub lossy: bool,
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

/// A source handle for a streamed transfer: read for the copy, plus AsyncWrite
/// purely so `shutdown()` can issue the close explicitly. russh-sftp's `File`
/// only fires a *no-wait* close on `Drop`, which falls behind under a many-file
/// copy and exhausts the server's SFTP handle table ("handle limit reached");
/// an awaited `shutdown()` per file keeps exactly one read handle open at a
/// time. (A no-op for local files, whose fd closes synchronously on drop.)
pub trait TransferSource: AsyncRead + AsyncWrite + Send {}
impl<T: AsyncRead + AsyncWrite + Send> TransferSource for T {}

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

    /// Remove several paths in one call. The default walks them one by one;
    /// transports with a cheaper bulk form (one server-side `rm` for the lot)
    /// override. Failures are collected, not short-circuited — every path gets
    /// its attempt, and the Err joins whatever went wrong.
    async fn remove_many(&self, paths: &[String]) -> Result<(), String> {
        let mut errs: Vec<String> = Vec::new();
        for p in paths {
            if let Err(e) = self.remove(p).await {
                errs.push(e);
            }
        }
        if errs.is_empty() {
            Ok(())
        } else {
            Err(errs.join("; "))
        }
    }

    /// Move `path` into `dest_dir` (same connection), keeping its basename.
    /// A no-op if it's already there; errors if the target name is taken.
    /// Returns the new absolute path.
    async fn move_to(&self, path: &str, dest_dir: &str) -> Result<String, String>;

    /// Copy `path` into `dest_dir` (recursively for directories), auto-renaming
    /// (`name copy`, `name copy 2`, …) on a name collision. Returns the new path.
    async fn copy_to(&self, path: &str, dest_dir: &str) -> Result<String, String>;

    /// Open a file for streaming reads (cross-connection transfers). The handle
    /// carries AsyncWrite too so the copy can `shutdown()` it — see
    /// [`TransferSource`] for why an awaited close matters.
    async fn open_read(&self, path: &str)
        -> Result<Pin<Box<dyn TransferSource>>, String>;

    /// Like [`open_read`](Self::open_read), but tuned for transfer throughput.
    /// The SFTP impl pipelines `depth` read requests for large files (serial
    /// requests cap a high-latency leg at chunk ÷ round-trip); local files and
    /// small files just use `open_read`.
    async fn open_read_fast(
        &self,
        path: &str,
        size_hint: u64,
        depth: usize,
    ) -> Result<Pin<Box<dyn TransferSource>>, String> {
        let _ = (size_hint, depth);
        self.open_read(path).await
    }

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

/// Decode file bytes as UTF-8 text. Invalid UTF-8 falls back to a lossy
/// conversion and is flagged (`true`) so callers can mark the content as not
/// faithful — e.g. a GBK/Big5/Latin-1 file whose bytes must never be
/// overwritten with the U+FFFD replacements shown in the editor.
pub fn decode_text(bytes: Vec<u8>) -> (String, bool) {
    match String::from_utf8(bytes) {
        Ok(text) => (text, false),
        Err(e) => (String::from_utf8_lossy(e.as_bytes()).into_owned(), true),
    }
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

/// Read a file's raw bytes as base64 — for images the Markdown preview embeds
/// as `data:` URLs (relative `<img>` paths can't resolve to the bundled webview
/// root). Capped so a stray huge file can't blow up memory.
#[tauri::command]
pub async fn fs_read_base64(
    state: State<'_, AppState>,
    conn_id: String,
    path: String,
) -> Result<String, String> {
    use base64::Engine;
    use tokio::io::AsyncReadExt;
    const MAX: usize = 16 * 1024 * 1024;
    let transport = state.transport(&conn_id).await?;
    let mut reader = transport.open_read(&path).await?;
    let mut buf = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        if buf.len() + n > MAX {
            return Err("file too large for inline preview (16 MB max)".into());
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(&buf))
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

/// Batched delete — a multi-select removal is ONE transport call (and on SSH
/// one server-side `rm`), not a round trip per item.
#[tauri::command]
pub async fn fs_remove_many(
    state: State<'_, AppState>,
    conn_id: String,
    paths: Vec<String>,
) -> Result<(), String> {
    state.transport(&conn_id).await?.remove_many(&paths).await
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
    /// A lane died mid-transfer; the copy is parked until it reconnects, then
    /// resumes from the incomplete file on its own (Phase 2).
    waiting: bool,
}

/// What a finished (or cancelled) batch transfer copied.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferOutcome {
    files: usize,
    bytes: u64,
    cancelled: bool,
    /// Symlinked directories skipped during the walk (never descended — a
    /// link cycle would recurse forever); surfaced in the completion toast.
    skipped_links: usize,
    /// Entries skipped because the source couldn't be stat'd or listed (a
    /// dangling symlink, a broken submodule gitlink, a vanished path). One bad
    /// entry no longer aborts the whole batch — it's skipped and reported here.
    skipped_errors: usize,
}

/// Interrupt plumbing for one transfer. Two signals share one watch channel
/// that every long await in the copy races via `subscribe()`:
///
/// - **cancel** (user — final): works even mid-hang on a dead socket, because
///   the raced await is *dropped* rather than waited out.
/// - **reset** (a lane reconnected — pause and retry): the epoch watcher trips
///   it the moment `reestablish` swaps the session, yanking the copy off the
///   corpse immediately; `run_transfer` then waits for the lane and resumes
///   from the incomplete file (docs/connections.md Phase 2).
pub struct TransferInterrupt {
    cancel: AtomicBool,
    reset: AtomicBool,
    tx: watch::Sender<u32>,
}

impl TransferInterrupt {
    fn new() -> Self {
        Self {
            cancel: AtomicBool::new(false),
            reset: AtomicBool::new(false),
            tx: watch::Sender::new(0),
        }
    }

    pub fn trip_cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        self.tx.send_modify(|v| *v = v.wrapping_add(1));
    }

    fn trip_reset(&self) {
        self.reset.store(true, Ordering::SeqCst);
        self.tx.send_modify(|v| *v = v.wrapping_add(1));
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    fn reset_pending(&self) -> bool {
        self.reset.load(Ordering::SeqCst)
    }

    fn clear_reset(&self) {
        self.reset.store(false, Ordering::SeqCst);
    }

    fn interrupted(&self) -> bool {
        self.cancelled() || self.reset_pending()
    }

    fn subscribe(&self) -> watch::Receiver<u32> {
        self.tx.subscribe()
    }
}

/// Race one transfer await against the interrupt channel. Subscribe-first
/// ordering makes it airtight: a trip before the subscribe is caught by the
/// flag check, a trip after it wakes `changed()` — there is no window where an
/// op can stay parked on a dead session with an interrupt pending.
enum Raced<T> {
    Done(T),
    Interrupted,
}

async fn race<T>(
    intr: &TransferInterrupt,
    fut: impl Future<Output = T>,
) -> Raced<T> {
    let mut rx = intr.subscribe();
    if intr.interrupted() {
        return Raced::Interrupted;
    }
    tokio::select! {
        r = fut => Raced::Done(r),
        _ = rx.changed() => Raced::Interrupted,
    }
}

/// Shared progress + interrupt state threaded (by `&`) through the copy
/// recursion. Interior-mutable so the hot path doesn't lock beyond a throttle
/// timestamp. Lives across retry rounds, so the bar keeps its progress and
/// completed files are never re-copied.
struct Progress {
    app: AppHandle,
    id: String,
    intr: Arc<TransferInterrupt>,
    /// Standing read-request count for the pipelined reader (Full 32 /
    /// Background 4).
    read_depth: usize,
    /// Background bandwidth cap in bytes/sec (0 = no cap). Enforced by pacing
    /// in the relay pump — one place, governs both legs of any relay.
    limit_bps: u64,
    /// Background pacing bucket, shared by every concurrent stream.
    pace: std::sync::Mutex<PaceBucket>,
    // Atomic so a measure running *alongside* the copy can fill the total in
    // mid-flight — when the copy starts before its size is known, the bar shows
    // "N copied · calculating…" until this lands.
    total_bytes: AtomicU64,
    total_files: AtomicUsize,
    done_bytes: AtomicU64,
    done_files: AtomicUsize,
    /// Symlinked directories skipped by the walk (reported in the outcome).
    skipped_links: AtomicUsize,
    /// Entries skipped because the source stat/list failed (reported too).
    skipped_errors: AtomicUsize,
    /// The copy is parked waiting for a lane to reconnect (shown in the bar).
    waiting: AtomicBool,
    /// Source paths fully copied this transfer — retry rounds skip them (their
    /// bytes/files stay counted; the bar never goes backwards).
    done_paths: std::sync::Mutex<HashSet<String>>,
    /// Top-level collision resolutions (source path → destination name), so a
    /// retry round continues into the SAME "name copy" it started, instead of
    /// minting "name copy 2" against its own first attempt.
    resolved: std::sync::Mutex<HashMap<String, String>>,
    last_emit: std::sync::Mutex<Instant>,
}

/// Token-bucket state for Background pacing (see [`Progress::pace_delay`]).
/// `tokens` is the spendable byte budget (may go negative — debt someone is
/// currently sleeping off); `last` is when it was last accrued.
struct PaceBucket {
    tokens: f64,
    last: Instant,
}

impl Progress {
    /// User cancel only — decides the final outcome.
    fn cancelled(&self) -> bool {
        self.intr.cancelled()
    }

    /// Cancel OR lane reset — the walk loops stop on either; `run_transfer`
    /// tells them apart at round end.
    fn interrupted(&self) -> bool {
        self.intr.interrupted()
    }

    fn skip_link(&self) {
        self.skipped_links.fetch_add(1, Ordering::Relaxed);
    }

    fn skip_error(&self) {
        self.skipped_errors.fetch_add(1, Ordering::Relaxed);
    }

    fn mark_done(&self, src_path: &str) {
        self.done_paths.lock().unwrap().insert(src_path.to_string());
    }

    fn is_done(&self, src_path: &str) -> bool {
        self.done_paths.lock().unwrap().contains(src_path)
    }

    fn resolved_name(&self, src_path: &str) -> Option<String> {
        self.resolved.lock().unwrap().get(src_path).cloned()
    }

    fn remember_resolved(&self, src_path: &str, name: &str) {
        self.resolved
            .lock()
            .unwrap()
            .insert(src_path.to_string(), name.to_string());
    }

    /// Publish the measured total (once known) and push a frame so the bar
    /// switches from "calculating…" to a real denominator right away.
    fn set_total(&self, bytes: u64, files: usize) {
        self.total_bytes.store(bytes, Ordering::Relaxed);
        self.total_files.store(files, Ordering::Relaxed);
        self.emit("", true);
    }

    fn total_unknown(&self) -> bool {
        self.total_bytes.load(Ordering::Relaxed) == 0
            && self.total_files.load(Ordering::Relaxed) == 0
    }

    fn set_waiting(&self, waiting: bool) {
        self.waiting.store(waiting, Ordering::Relaxed);
        self.emit("", true);
    }

    fn add_bytes(&self, n: u64, current: &str) {
        self.done_bytes.fetch_add(n, Ordering::Relaxed);
        self.emit(current, false);
    }

    /// Background pacing, a token bucket: budget accrues at `limit_bps` and
    /// carries over at most ONE chunk — so a stretch spent below the cap
    /// (latency-bound small files, a wait between rounds) banks no credit,
    /// and the wire rate can never burst past the cap on the strength of an
    /// earlier slow phase. (The first cut paced against the since-start
    /// AVERAGE, which is exactly that bug: set 2, crawl a while, watch 3.)
    /// Every stream drains the one bucket, so nine concurrent copies still
    /// share the single budget; whoever overdraws sleeps the debt off.
    fn pace_delay(&self, bytes: u64) -> Option<Duration> {
        if self.limit_bps == 0 {
            return None;
        }
        let rate = self.limit_bps as f64;
        let mut b = self.pace.lock().unwrap();
        let now = Instant::now();
        b.tokens = (b.tokens + now.duration_since(b.last).as_secs_f64() * rate)
            .min(TRANSFER_CHUNK as f64);
        b.last = now;
        b.tokens -= bytes as f64;
        if b.tokens < -1.0 {
            Some(Duration::from_secs_f64(-b.tokens / rate))
        } else {
            None
        }
    }

    /// Roll back bytes counted for a file that did NOT complete (interrupted /
    /// failed) — the retry round re-copies it from zero, so leaving the bytes
    /// counted would overshoot the total.
    fn unadd_bytes(&self, n: u64) {
        self.done_bytes.fetch_sub(n, Ordering::Relaxed);
    }

    fn file_done(&self, current: &str) {
        self.done_files.fetch_add(1, Ordering::Relaxed);
        // NOT a forced emit: between same-machine endpoints (WSL ⇄ local VM)
        // small files complete by the hundreds per second, and a forced IPC
        // event per boundary floods the webview — the prime suspect for a
        // renderer crash under exactly that load. The 100 ms throttle keeps
        // the "file x/N" counter fresh enough; the final frame is still forced.
        self.emit(current, false);
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
                total_bytes: self.total_bytes.load(Ordering::Relaxed),
                done_files: self.done_files.load(Ordering::Relaxed),
                total_files: self.total_files.load(Ordering::Relaxed),
                current: current.to_string(),
                waiting: self.waiting.load(Ordering::Relaxed),
            },
        );
    }
}

/// Recursively total the bytes and file count under `path`, for the progress bar.
/// Mirrors the copy walk (`walk_top`/`collect_dir`) exactly — symlinked
/// directories are never descended (a link cycle like `ln -s . self` would
/// recurse forever), so the totals match what actually gets copied.
fn measure<'a>(
    src: &'a dyn FileTransport,
    path: &'a str,
) -> Pin<Box<dyn Future<Output = Result<(u64, usize), String>> + Send + 'a>> {
    Box::pin(async move {
        // Tolerant: an unreadable path (dangling link, broken gitlink) counts
        // as nothing rather than aborting the batch — the copy walk skips and
        // reports it the same way, so the totals still match what's copied.
        let meta = match src.stat(path).await {
            Ok(m) => m,
            Err(_) => return Ok((0, 0)),
        };
        if !meta.is_dir {
            return Ok((meta.size, 1));
        }
        let entries = match src.list_dir(path).await {
            Ok(listing) => listing.entries,
            Err(_) => return Ok((0, 0)),
        };
        let mut bytes = 0u64;
        let mut files = 0usize;
        for entry in entries {
            if entry.is_symlink && entry.is_dir {
                continue; // skipped by the copy walk too
            }
            if entry.is_dir {
                let (b, f) = measure(src, &entry.path).await?;
                bytes += b;
                files += f;
            } else {
                bytes += entry.size;
                files += 1;
            }
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
    // Size already measured by the UI's pre-flight (the confirm sheet's
    // `fs_measure`). When present, the copy skips its own measure pass so a
    // deep tree isn't walked twice; when absent (or the user committed before
    // the scan finished) the copy measures itself as before.
    total_bytes: Option<u64>,
    total_files: Option<usize>,
    // Speed (docs/connections.md T4): "background" runs a shallow read
    // pipeline and honors `limit_bps` (0 / absent = no cap). Absent mode =
    // "full".
    mode: Option<String>,
    limit_bps: Option<u64>,
) -> Result<TransferOutcome, String> {
    // Register the interrupt handle the UI can trip via `fs_transfer_cancel`.
    let intr = Arc::new(TransferInterrupt::new());
    state
        .transfers
        .lock()
        .await
        .insert(transfer_id.clone(), intr.clone());

    let background = mode.as_deref() == Some("background");
    // The limit is the machine's TOTAL real-network budget — the golden rule
    // is "set 10, never exceed 10 on the wire". A relay carries the same
    // payload byte on EVERY leg, so the NIC sees payload × (legs that cross
    // it): remote⇄remote = 2, local⇄remote and wsl⇄remote = 1 (loopback legs
    // cost the NIC nothing). Pace payload at budget ÷ real legs, shaved 3%
    // for SSH framing/MAC overhead so the wire stays under the typed number.
    let effective_limit = match limit_bps {
        Some(limit) if background && limit > 0 => {
            let mut real_legs = 0u64;
            for id in [src_conn_id.as_str(), dest_conn_id.as_str()] {
                if let Some(crate::Session::Ssh(conn)) = state.sessions.lock().await.get(id) {
                    let host = conn.info.host.as_str();
                    if !(host == "127.0.0.1" || host == "::1" || host == "localhost") {
                        real_legs += 1;
                    }
                }
            }
            (limit / real_legs.max(1)).saturating_mul(97) / 100
        }
        _ => 0,
    };
    let result = run_transfer(
        &app,
        &state,
        &transfer_id,
        intr,
        &src_conn_id,
        &src_paths,
        &dest_conn_id,
        &dest_dir,
        rename_on_conflict,
        total_bytes.zip(total_files),
        if background { 4 } else { 32 },
        effective_limit,
    )
    .await;

    state.transfers.lock().await.remove(&transfer_id);
    result
}

/// Trip a transfer's cancel signal. Abortive: raced awaits drop immediately,
/// so cancel works even while a read is parked on a dead socket.
#[tauri::command]
pub async fn fs_transfer_cancel(
    state: State<'_, AppState>,
    transfer_id: String,
) -> Result<(), String> {
    if let Some(intr) = state.transfers.lock().await.get(&transfer_id) {
        intr.trip_cancel();
    }
    Ok(())
}

/// How one copy round ended — decided while the round's lanes are still up
/// (probes must run BEFORE the ephemeral lanes are hung up, or every genuine
/// filesystem error would look like a dead lane and retry forever).
enum RoundEnd {
    Done,
    Cancelled,
    Retry,
    Fatal(String),
}

#[allow(clippy::too_many_arguments)]
async fn run_transfer(
    app: &AppHandle,
    state: &AppState,
    id: &str,
    intr: Arc<TransferInterrupt>,
    src_conn_id: &str,
    src_paths: &[String],
    dest_conn_id: &str,
    dest_dir: &str,
    rename_on_conflict: bool,
    precomputed_total: Option<(u64, usize)>,
    read_depth: usize,
    limit_bps: u64,
) -> Result<TransferOutcome, String> {
    // Arc'd so the small-file pool can hand owned clones to its worker tasks.
    let prog = Arc::new(Progress {
        app: app.clone(),
        id: id.to_string(),
        intr: intr.clone(),
        read_depth,
        limit_bps,
        pace: std::sync::Mutex::new(PaceBucket {
            tokens: TRANSFER_CHUNK as f64,
            last: Instant::now(),
        }),
        total_bytes: AtomicU64::new(0),
        total_files: AtomicUsize::new(0),
        done_bytes: AtomicU64::new(0),
        done_files: AtomicUsize::new(0),
        skipped_links: AtomicUsize::new(0),
        skipped_errors: AtomicUsize::new(0),
        waiting: AtomicBool::new(false),
        done_paths: std::sync::Mutex::new(HashSet::new()),
        resolved: std::sync::Mutex::new(HashMap::new()),
        last_emit: std::sync::Mutex::new(Instant::now()),
    });

    // If the UI already measured (waited on the confirm sheet's scan), seed the
    // total so the bar shows a denominator from the first frame. Otherwise the
    // user committed early: the copy starts NOW and a measure runs ALONGSIDE,
    // so the bar reads "N copied · calculating…" until the total lands — never
    // a blocking pre-pass.
    if let Some((b, f)) = precomputed_total {
        prog.set_total(b, f);
    }
    prog.emit("", true); // show the bar immediately

    // Retry rounds: a lane death pauses the copy (never fails it) and the next
    // round redials fresh lanes and resumes from the incomplete file —
    // completed files are skipped via `done_paths`, partial files restart
    // cleanly through their `.straypart`. No self-imposed give-up: the user
    // cancels, not a timer (house rule).
    let mut round = 0u32;
    let mut delay = 1u64;
    let final_result: Result<(), String> = loop {
        round += 1;
        intr.clear_reset();

        // Fresh endpoints each round: each SSH side gets a DEDICATED transfer
        // lane (its own connection, throughput profile — docs/connections.md
        // Phase T), with data-lane fallback when the dial fails. Ephemeral
        // lanes are never nursed back — a retry round simply redials.
        let endpoints = async {
            let s = state.transfer_endpoint_dedicated(src_conn_id).await?;
            let d = state.transfer_endpoint_dedicated(dest_conn_id).await?;
            Ok::<_, String>((s, d))
        };
        let ((src, src_conn, src_lane), (dest, dest_conn, dest_lane)) =
            match race(&intr, endpoints).await {
                Raced::Interrupted => break Ok(()),
                Raced::Done(Ok(pair)) => pair,
                Raced::Done(Err(e)) => {
                    if round == 1 {
                        break Err(e); // the host is gone before we even started
                    }
                    log::info!(
                        "transfer {id}: endpoints unavailable ({e}) — retrying in {delay}s"
                    );
                    prog.set_waiting(true);
                    let cancelled = wait_backoff(&intr, delay).await;
                    prog.set_waiting(false);
                    if cancelled {
                        break Ok(());
                    }
                    delay = (delay * 2).min(30);
                    continue;
                }
            };

        // Epoch watchers cover data-lane FALLBACK endpoints (those reestablish
        // in place and bump their epoch); dedicated transfer lanes never do —
        // they are redialed instead. Fresh baselines each round.
        let lanes: Vec<Arc<Connection>> = [src_conn.clone(), dest_conn.clone()]
            .into_iter()
            .flatten()
            .collect();
        let mut watchers = Vec::new();
        for lane in &lanes {
            let mut epoch_rx = lane.subscribe_epoch();
            epoch_rx.borrow_and_update();
            let intr2 = intr.clone();
            watchers.push(tokio::spawn(async move {
                if epoch_rx.changed().await.is_ok() {
                    intr2.trip_reset();
                }
            }));
        }

        let before_bytes = prog.done_bytes.load(Ordering::Relaxed);
        let result = run_round(
            &prog,
            &intr,
            &src,
            src_paths,
            &dest,
            dest_dir,
            rename_on_conflict,
        )
        .await;

        for w in watchers {
            w.abort();
        }

        // Classify BEFORE hanging up the round's lanes: the probe below must
        // ask a lane that is still supposed to be alive.
        let end = if intr.cancelled() {
            RoundEnd::Cancelled
        } else {
            let mut retry =
                intr.reset_pending() || (result.is_err() && any_lane_down(&lanes).await);
            if result.is_err() && !retry && !lanes.is_empty() {
                // Direct liveness test: a lane that still answers a probe is
                // healthy, so the error was a genuine filesystem error and
                // stays fatal; one that doesn't answer gets redialed. (This
                // replaces the old wait-one-probe-interval grace — asking
                // directly is faster and also covers supervisorless transfer
                // lanes, whose `state` nobody updates.)
                retry = !all_lanes_answer(&lanes).await;
            }
            match (result, retry) {
                (_, true) => RoundEnd::Retry,
                (Ok(()), false) => RoundEnd::Done,
                (Err(e), false) => RoundEnd::Fatal(e),
            }
        };

        // Ephemeral lanes go down with their round; the next round dials fresh.
        for lane_id in [src_lane, dest_lane].into_iter().flatten() {
            crate::ssh::connection::drop_transfer_lane(state, app, &lane_id).await;
        }

        match end {
            RoundEnd::Done | RoundEnd::Cancelled => break Ok(()),
            RoundEnd::Fatal(e) => break Err(e),
            RoundEnd::Retry => {
                // A round that moved bytes earns a fresh backoff — creeping to
                // 30 s pauses is for consecutive failures, not a long transfer
                // with occasional drops.
                if prog.done_bytes.load(Ordering::Relaxed) > before_bytes {
                    delay = 1;
                }
                log::warn!(
                    "transfer {id}: round {round} interrupted by a connection drop — resuming in {delay}s"
                );
                prog.set_waiting(true);
                let cancelled = wait_backoff(&intr, delay).await;
                prog.set_waiting(false);
                if cancelled {
                    break Ok(());
                }
                delay = (delay * 2).min(30);
                log::info!("transfer {id}: redialing (round {})", round + 1);
                continue;
            }
        }
    };

    let cancelled = prog.cancelled();
    prog.emit("", true); // final frame
    final_result?;
    Ok(TransferOutcome {
        files: prog.done_files.load(Ordering::Relaxed),
        bytes: prog.done_bytes.load(Ordering::Relaxed),
        cancelled,
        skipped_links: prog.skipped_links.load(Ordering::Relaxed),
        skipped_errors: prog.skipped_errors.load(Ordering::Relaxed),
    })
}

/// One copy round over fixed endpoints: the copy walk, plus a parallel measure
/// when the total is still unknown.
async fn run_round(
    prog: &Arc<Progress>,
    intr: &Arc<TransferInterrupt>,
    src: &Arc<dyn FileTransport>,
    src_paths: &[String],
    dest: &Arc<dyn FileTransport>,
    dest_dir: &str,
    rename_on_conflict: bool,
) -> Result<(), String> {
    let copy = async {
        // Producer-consumer, never a blocking pre-pass: the WALKER streams
        // the tree — listing dirs, creating destination dirs, sorting files
        // into two bounded queues — while the dispatcher copies alongside.
        // The first file starts as soon as the first listing returns, and a
        // huge tree never sits in memory (backpressure parks the walk when
        // the queues fill).
        //
        // The dispatcher owns POOL_SLOTS fungible slots: any slot takes any
        // file, except at most ONE slot holds a BIG file at a time — one
        // pipelined stream fills the wire; a second would split it, not add
        // to it. Small files are latency-bound (per-file round-trip tolls),
        // so width is what makes a thousand tiny files move; the lone big
        // stream spends bandwidth, and the two barely compete.
        //
        // Any copy error sets `abort`: nothing NEW starts anywhere (walker
        // stops walking, dispatcher stops admitting), in-flight files drain,
        // and the round ends with that error for the usual retry-vs-fatal
        // classification.
        let abort_flag = AtomicBool::new(false);
        let abort = &abort_flag; // Copy — the `async move` walker captures the ref
        let (small_tx, mut small_rx) = mpsc::channel::<FileJob>(256);
        let (big_tx, mut big_rx) = mpsc::channel::<FileJob>(64);

        let walker = async move {
            // Owns the senders: when the walk ends (done, interrupted, or
            // aborted) they drop and the consumers see end-of-queue.
            for p in src_paths {
                if prog.interrupted() || abort.load(Ordering::Relaxed) {
                    break;
                }
                walk_top(
                    src.as_ref(),
                    p,
                    dest.as_ref(),
                    dest_dir,
                    rename_on_conflict,
                    prog,
                    abort,
                    &small_tx,
                    &big_tx,
                )
                .await?;
            }
            Ok::<(), String>(())
        };

        let dispatcher = async {
            let mut join: tokio::task::JoinSet<(bool, Result<(), String>)> =
                tokio::task::JoinSet::new();
            let mut first_err: Option<String> = None;
            let (mut small_open, mut big_open) = (true, true);
            let mut big_running = false;
            loop {
                let admit = first_err.is_none()
                    && !abort.load(Ordering::Relaxed)
                    && !prog.interrupted()
                    && join.len() < POOL_SLOTS;
                tokio::select! {
                    // `biased` polls in declaration order: a waiting big file
                    // takes a free slot ahead of queued smalls — start the
                    // long pole early, smalls fill in around it.
                    biased;
                    job = big_rx.recv(), if big_open && admit && !big_running => {
                        match job {
                            Some(job) => {
                                big_running = true;
                                spawn_stream(&mut join, src, dest, prog, job, true);
                            }
                            None => big_open = false,
                        }
                    }
                    job = small_rx.recv(), if small_open && admit => {
                        match job {
                            Some(job) => spawn_stream(&mut join, src, dest, prog, job, false),
                            None => small_open = false,
                        }
                    }
                    done = join.join_next(), if !join.is_empty() => {
                        match done {
                            Some(Ok((was_big, r))) => {
                                if was_big {
                                    big_running = false;
                                }
                                if let Err(e) = r {
                                    if first_err.is_none() {
                                        abort.store(true, Ordering::Relaxed);
                                        first_err = Some(e);
                                    }
                                }
                            }
                            Some(Err(e)) => {
                                // Panicked task: can't tell if it held the
                                // big slot, but abort stops all admission, so
                                // the stale flag never matters.
                                if first_err.is_none() {
                                    abort.store(true, Ordering::Relaxed);
                                    first_err = Some(format!("transfer worker panicked: {e}"));
                                }
                            }
                            None => {}
                        }
                    }
                    // Nothing to admit and nothing in flight — done (or
                    // stopped). Dropping the receivers unblocks a walker
                    // parked on a full queue; its send fails and it stops.
                    else => break,
                }
            }
            match first_err {
                Some(e) => Err(e),
                None => Ok(()),
            }
        };

        let (walked, copied) = tokio::join!(walker, dispatcher);
        // Copy errors outrank walker errors — after an abort the walker's
        // exit is a side effect, not the story.
        copied?;
        walked?;
        Ok::<(), String>(())
    };

    if prog.total_unknown() {
        let measure_total = async {
            let chain = async {
                let mut total_bytes = 0u64;
                let mut total_files = 0usize;
                for p in src_paths {
                    let (b, f) = measure(src.as_ref(), p).await?;
                    total_bytes += b;
                    total_files += f;
                }
                prog.set_total(total_bytes, total_files);
                Ok::<(), String>(())
            };
            // The whole measure races the interrupt in one select — a measure
            // parked on a dead lane is simply dropped; a later round
            // re-measures if the total is still unknown.
            match race(intr, chain).await {
                Raced::Done(r) => {
                    let _ = r; // non-fatal — the copy carries the run
                }
                Raced::Interrupted => {}
            }
        };
        // Single task, cooperatively scheduled: the two walks take turns on
        // the SFTP session lock (measure is metadata-only, so it settles
        // early in the copy).
        let (_, copied) = tokio::join!(measure_total, copy);
        copied
    } else {
        copy.await
    }
}

/// Whether any SSH lane is currently not `Connected` (degraded / reconnecting).
async fn any_lane_down(lanes: &[Arc<Connection>]) -> bool {
    for lane in lanes {
        if *lane.state.lock().await != ConnectionState::Connected {
            return true;
        }
    }
    false
}

/// Do all lanes still answer a liveness probe? (See the classification in
/// `run_transfer` — answers ⇒ real filesystem error; silence ⇒ redial.)
async fn all_lanes_answer(lanes: &[Arc<Connection>]) -> bool {
    for lane in lanes {
        if !lane.is_transport_alive().await {
            return false;
        }
    }
    true
}

/// Backoff sleep racing the interrupt channel; returns true if the user
/// cancelled while we slept.
async fn wait_backoff(intr: &TransferInterrupt, secs: u64) -> bool {
    let mut rx = intr.subscribe();
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_secs(secs)) => {}
        _ = rx.changed() => {}
    }
    intr.cancelled()
}

/// Size of a pending transfer, measured with the copy walk's *exact* rules, so
/// the confirm sheet's number and the progress bar's total agree — symlinked
/// dirs excluded (they're never descended), unreadable entries tolerated. The
/// UI hands this back to `fs_transfer_batch` as `total_*` so a deep tree isn't
/// walked twice. (Distinct from `fs_measure`/`PropertiesInfo`, which counts a
/// symlinked dir as one entry for the Properties tally.)
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSize {
    files: usize,
    bytes: u64,
}

#[tauri::command]
pub async fn fs_transfer_measure(
    state: State<'_, AppState>,
    conn_id: String,
    paths: Vec<String>,
) -> Result<TransferSize, String> {
    let src = state.transport(&conn_id).await?;
    let (mut bytes, mut files) = (0u64, 0usize);
    for p in &paths {
        let (b, f) = measure(src.as_ref(), p).await?;
        bytes += b;
        files += f;
    }
    Ok(TransferSize { files, bytes })
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
        // Tolerant like `measure`: an unreadable entry contributes nothing
        // rather than failing the whole tally (Properties + the transfer
        // pre-flight size both call this).
        let meta = match src.stat(path).await {
            Ok(m) => m,
            Err(_) => return Ok((0, 0, 0)),
        };
        if !meta.is_dir {
            return Ok((1, 0, meta.size));
        }
        let entries = match src.list_dir(path).await {
            Ok(listing) => listing.entries,
            Err(_) => return Ok((0, 0, 0)),
        };
        let (mut files, mut folders, mut bytes) = (0usize, 0usize, 0u64);
        for entry in entries {
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

/// One file the walk queued for the copy pools.
struct FileJob {
    src: String,
    dest: String,
    name: String,
    size: u64,
}

/// Files at/below this size are "small": their cost is per-file round-trip
/// tolls, so they copy through a concurrent pool. Bigger files stream one at
/// a time — the pipelined reader is their concurrency. Matches the reader's
/// own pipeline threshold in `SftpTransport::open_read_fast`.
const SMALL_FILE_MAX: u64 = 4 * 1024 * 1024;
/// Total concurrent file streams — fungible slots; at most ONE holds a big
/// file at a time (one pipelined stream fills the wire; a second would split
/// it, not add to it). Width is what hides small files' per-file round-trip
/// tolls: files/s ≈ slots ÷ (~4 RTTs × RTT). 32 covers high-RTT routes too;
/// on fast links sftp-server's single-threaded request loop becomes the
/// ceiling first, and the extra width just queues there harmlessly. The cost
/// of width is blast radius, not speed: more open handles and `.straypart`
/// partials in flight when a lane dies mid-round.
const POOL_SLOTS: usize = 32;

/// Queue a file job onto its size-class channel, racing the interrupt.
/// Returns false when the walk should stop: the user interrupted, or a
/// consumer hung up (a copy error is aborting the round). Sets `abort` so
/// the recursion above unwinds without issuing further round trips.
async fn push_job(
    small_tx: &mpsc::Sender<FileJob>,
    big_tx: &mpsc::Sender<FileJob>,
    prog: &Progress,
    abort: &AtomicBool,
    job: FileJob,
) -> bool {
    let tx = if job.size <= SMALL_FILE_MAX {
        small_tx
    } else {
        big_tx
    };
    match race(&prog.intr, tx.send(job)).await {
        Raced::Done(Ok(())) => true,
        Raced::Interrupted | Raced::Done(Err(_)) => {
            abort.store(true, Ordering::Relaxed);
            false
        }
    }
}

/// Launch one file copy into a dispatcher slot. The task's flag says whether
/// it held the big slot, so completion can free it.
fn spawn_stream(
    join: &mut tokio::task::JoinSet<(bool, Result<(), String>)>,
    src: &Arc<dyn FileTransport>,
    dest: &Arc<dyn FileTransport>,
    prog: &Arc<Progress>,
    job: FileJob,
    is_big: bool,
) {
    let src = src.clone();
    let dest = dest.clone();
    let prog = prog.clone();
    join.spawn(async move {
        let r = stream_file(
            src.as_ref(),
            &job.src,
            dest.as_ref(),
            &job.dest,
            &job.name,
            job.size,
            &prog,
        )
        .await;
        (is_big, r)
    });
}

/// Walk one TOP-LEVEL entry: tolerant stat, collision resolution (remembered
/// across retry rounds), destination dirs created in walk order — files are
/// STREAMED into the size-class queues, not copied here; the consumers in
/// `run_round` copy alongside the walk. Never a blocking pre-pass: the first
/// file starts as soon as the first listing returns.
async fn walk_top(
    src: &dyn FileTransport,
    src_path: &str,
    dest: &dyn FileTransport,
    dest_dir: &str,
    rename_on_conflict: bool,
    prog: &Progress,
    abort: &AtomicBool,
    small_tx: &mpsc::Sender<FileJob>,
    big_tx: &mpsc::Sender<FileJob>,
) -> Result<(), String> {
    if prog.interrupted() || abort.load(Ordering::Relaxed) {
        return Ok(());
    }
    // Tolerant: a source entry we can't stat (dangling link, broken gitlink)
    // is skipped and reported, not fatal — matches `measure`, so one bad
    // entry never aborts the batch. The stat races the interrupt so a hang on
    // a dead lane can't park the walk.
    let meta = match race(&prog.intr, src.stat(src_path)).await {
        Raced::Interrupted => return Ok(()),
        Raced::Done(Ok(m)) => m,
        Raced::Done(Err(e)) => {
            // The toast only reports a count (a folder of broken links could
            // be a wall of names); the paths land in the log for when you
            // need to know exactly what was skipped.
            log::warn!("transfer: skipping unreadable {src_path}: {e}");
            prog.skip_error();
            return Ok(());
        }
    };
    let base = any_basename(src_path);
    let mut name = base.to_string();
    let mut dest_path = dest.join(dest_dir, &name);
    // Resolve a top-level collision; nested entries just overwrite/merge. The
    // resolution is remembered across retry rounds, so a resumed transfer
    // continues into the SAME "name copy" instead of minting a fresh one
    // against its own first attempt.
    if let Some(cached) = prog.resolved_name(src_path) {
        name = cached;
        dest_path = dest.join(dest_dir, &name);
    } else {
        let mut n = 1;
        loop {
            match race(&prog.intr, dest.stat(&dest_path)).await {
                Raced::Interrupted => return Ok(()),
                Raced::Done(Ok(_)) => {
                    if !rename_on_conflict {
                        break;
                    }
                    name = copy_variant(base, n);
                    dest_path = dest.join(dest_dir, &name);
                    n += 1;
                }
                Raced::Done(Err(_)) => break, // free slot
            }
        }
        prog.remember_resolved(src_path, &name);
    }
    if meta.is_dir {
        match race(&prog.intr, dest.create_entry(dest_dir, &name, true)).await {
            Raced::Interrupted => return Ok(()),
            Raced::Done(_) => {} // exists-already errors are fine (merge)
        }
        collect_dir(src, src_path, dest, &dest_path, prog, abort, small_tx, big_tx).await
    } else {
        push_job(
            small_tx,
            big_tx,
            prog,
            abort,
            FileJob {
                src: src_path.to_string(),
                dest: dest_path,
                name,
                size: meta.size,
            },
        )
        .await;
        Ok(())
    }
}

/// Recursively stream a directory's files into the queues, creating
/// destination dirs on the way (a file is only queued after its parent dir
/// exists). Children trust the LISTING's metadata — the old walk re-stat'd
/// every child, one extra round trip per file for data the listing already
/// carried.
fn collect_dir<'a>(
    src: &'a dyn FileTransport,
    src_dir: &'a str,
    dest: &'a dyn FileTransport,
    dest_dir: &'a str,
    prog: &'a Progress,
    abort: &'a AtomicBool,
    small_tx: &'a mpsc::Sender<FileJob>,
    big_tx: &'a mpsc::Sender<FileJob>,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        if prog.interrupted() || abort.load(Ordering::Relaxed) {
            return Ok(());
        }
        let entries = match race(&prog.intr, src.list_dir(src_dir)).await {
            Raced::Interrupted => return Ok(()),
            Raced::Done(Ok(listing)) => listing.entries,
            Raced::Done(Err(e)) => {
                log::warn!("transfer: skipping unlistable {src_dir}: {e}");
                prog.skip_error();
                return Ok(());
            }
        };
        for entry in entries {
            if prog.interrupted() || abort.load(Ordering::Relaxed) {
                break;
            }
            // Never descend a symlinked directory — a link cycle
            // (`ln -s . self`) would recurse forever. Symlinks to files still
            // copy as regular files, like same-connection copies.
            if entry.is_symlink && entry.is_dir {
                log::info!("transfer: skipping symlinked dir {}", entry.path);
                prog.skip_link();
                continue;
            }
            if entry.is_dir {
                let child_dest = dest.join(dest_dir, &entry.name);
                match race(&prog.intr, dest.create_entry(dest_dir, &entry.name, true)).await {
                    Raced::Interrupted => return Ok(()),
                    Raced::Done(_) => {}
                }
                collect_dir(src, &entry.path, dest, &child_dest, prog, abort, small_tx, big_tx)
                    .await?;
            } else {
                // Symlinked files copy as their TARGET, but the listing only
                // carries the link's own metadata — stat through the link for
                // the real size, and skip-and-report dangling ones instead of
                // failing the round at open time.
                let size = if entry.is_symlink {
                    match race(&prog.intr, src.stat(&entry.path)).await {
                        Raced::Interrupted => return Ok(()),
                        Raced::Done(Ok(m)) => m.size,
                        Raced::Done(Err(e)) => {
                            log::warn!("transfer: skipping unreadable {}: {e}", entry.path);
                            prog.skip_error();
                            continue;
                        }
                    }
                } else {
                    entry.size
                };
                let job = FileJob {
                    src: entry.path.clone(),
                    dest: dest.join(dest_dir, &entry.name),
                    name: entry.name.clone(),
                    size,
                };
                if !push_job(small_tx, big_tx, prog, abort, job).await {
                    return Ok(());
                }
            }
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
    size: u64,
    prog: &Progress,
) -> Result<(), String> {
    // Completed in an earlier round of this transfer — never re-copy (its
    // bytes/files are already counted; the bar never moves backwards).
    if prog.is_done(src_path) {
        return Ok(());
    }
    let intr = &prog.intr;
    let part_path = format!("{dest_path}.straypart");
    let mut reader = match race(intr, src.open_read_fast(src_path, size, prog.read_depth)).await {
        Raced::Interrupted => return Ok(()),
        Raced::Done(r) => r?,
    };
    let mut writer = match race(intr, dest.open_write(&part_path)).await {
        Raced::Interrupted => {
            let _ = tokio::time::timeout(Duration::from_secs(3), reader.shutdown()).await;
            return Ok(());
        }
        Raced::Done(w) => w?,
    };
    // Double-buffered relay: write the chunk we HAVE while reading the NEXT
    // one. The old serial loop (read, then write, then read…) left each leg
    // idle while the other worked — on a relay both legs cost real time, so
    // overlapping them is worth up to ~2×.
    let mut front = vec![0u8; TRANSFER_CHUNK];
    let mut back = vec![0u8; TRANSFER_CHUNK];

    let mut error: Option<String> = None;
    let mut completed = true;
    // Bytes this file added to the bar — rolled back if it doesn't complete
    // (the retry round restarts the file from zero).
    let mut counted = 0u64;

    // Prime the pipeline with the first chunk.
    let mut pending = match race(intr, reader.read(&mut front)).await {
        Raced::Interrupted => {
            completed = false;
            0
        }
        Raced::Done(Ok(n)) => n,
        Raced::Done(Err(e)) => {
            error = Some(format!("could not read {src_path}: {e}"));
            completed = false;
            0
        }
    };

    while completed && pending > 0 {
        if prog.interrupted() {
            completed = false;
            break;
        }
        let just_wrote = pending as u64; // the chunk going out this iteration
        let write_front = writer.write_all(&front[..pending]);
        let read_back = reader.read(&mut back);
        match race(intr, async { tokio::join!(write_front, read_back) }).await {
            Raced::Interrupted => {
                completed = false;
                break;
            }
            Raced::Done((wrote, read)) => {
                if let Err(e) = wrote {
                    error = Some(format!("could not write {dest_path}: {e}"));
                    completed = false;
                    break;
                }
                counted += pending as u64;
                prog.add_bytes(pending as u64, name);
                match read {
                    Ok(n) => pending = n, // 0 = EOF, and its write just landed
                    Err(e) => {
                        error = Some(format!("could not read {src_path}: {e}"));
                        completed = false;
                        break;
                    }
                }
            }
        }
        // Background mode: repay the chunk just written at the bucket's rate
        // (racing the interrupt so cancel stays instant).
        if let Some(delay) = prog.pace_delay(just_wrote) {
            if let Raced::Interrupted = race(intr, tokio::time::sleep(delay)).await {
                completed = false;
                break;
            }
        }
        std::mem::swap(&mut front, &mut back);
    }

    // Close the read handle explicitly (awaited) in every exit path — success,
    // cancel, or error. russh-sftp's `Drop` only fires a no-wait close, which
    // lags a many-file copy until the server's handle table fills. Bounded: on
    // a dead lane the close handshake would otherwise park us forever.
    let _ = tokio::time::timeout(Duration::from_secs(3), reader.shutdown()).await;
    drop(reader);

    // A failed final flush means bytes never landed — that's an error, not a
    // completed copy.
    if completed {
        match race(intr, writer.flush()).await {
            Raced::Interrupted => completed = false,
            Raced::Done(Ok(())) => {}
            Raced::Done(Err(e)) => {
                error = Some(format!("could not write {dest_path}: {e}"));
                completed = false;
            }
        }
    }

    if completed {
        let _ = tokio::time::timeout(Duration::from_secs(3), writer.shutdown()).await;
        drop(writer);
        // Commit: rename the temp file over the destination. Plain SFTP rename
        // refuses to replace an existing target on most servers, so on failure
        // remove the destination and retry once. Raced: an interrupt mid-commit
        // just retries the file next round.
        let renamed = match race(intr, dest.rename(&part_path, name)).await {
            Raced::Interrupted => {
                prog.unadd_bytes(counted);
                return Ok(());
            }
            Raced::Done(r) => r,
        };
        if renamed.is_err() {
            match race(intr, async {
                let _ = dest.remove(dest_path).await;
                dest.rename(&part_path, name).await
            })
            .await
            {
                Raced::Interrupted => {
                    prog.unadd_bytes(counted);
                    return Ok(());
                }
                Raced::Done(Ok(_)) => {}
                Raced::Done(Err(e)) => {
                    // The destination is already gone, so the part file is now
                    // the ONLY copy of the data — keep it for manual recovery
                    // rather than deleting both.
                    return Err(format!(
                        "could not finish {dest_path}: {e} — the copied data was kept as {part_path}; rename it by hand"
                    ));
                }
            }
        }
        prog.mark_done(src_path);
        prog.file_done(name);
        Ok(())
    } else {
        drop(writer);
        prog.unadd_bytes(counted);
        if prog.interrupted() {
            if prog.intr.cancelled() {
                // Manual cancel: tidy the temp. Bounded — on a user cancel the
                // lane is usually healthy; if it's actually dead we stop
                // waiting rather than hang the cancel.
                let _ =
                    tokio::time::timeout(Duration::from_secs(3), dest.remove(&part_path)).await;
            }
            // Lane reset: leave the temp — the retry round overwrites it
            // (open_write truncates) and finishes the file.
            return Ok(());
        }
        let _ = dest.remove(&part_path).await;
        match error {
            Some(e) => Err(e),
            None => Ok(()),
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
    fn text_decoding() {
        // Valid UTF-8 (including multibyte) passes through unflagged.
        let (s, lossy) = decode_text("hello 你好".as_bytes().to_vec());
        assert_eq!(s, "hello 你好");
        assert!(!lossy);
        // GBK-encoded "你好" is not valid UTF-8 — decoded lossily and flagged
        // so the frontend blocks writing the damage back.
        let (s, lossy) = decode_text(vec![0xC4, 0xE3, 0xBA, 0xC3]);
        assert!(lossy);
        assert!(s.contains('\u{FFFD}'));
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
