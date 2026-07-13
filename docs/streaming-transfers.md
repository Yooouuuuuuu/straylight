# Streaming transfers (0.7.2)

## Problem

Cross-connection transfers buffered the **whole file in RAM**: `transfer_entry`
read the entire file into a `Vec<u8>` (`read_bytes`) and then wrote it
(`write_bytes`). A hard cap (`MAX_TRANSFER_BYTES = 512 MB`) rejected anything
bigger, and even under the cap a large transfer spiked memory and showed only an
indeterminate "Transferring…" spinner.

## Why not rsync

Briefly (see the discussion that led here): rsync needs an rsync binary on **both**
ends — Windows ships none, minimal remotes / WSL may lack it — and wants its **own**
ssh connection rather than the single multiplexed russh session we already hold. It
also doesn't fit our **remote↔WSL / remote↔remote** transfers (relayed through the
local app), and its delta advantage only helps re-syncs, not first-time
drag-to-copy. So we stream over the SFTP session we already own, and can add
rsync's good ideas (resume, compression) natively later.

## Design

### Streaming, not buffering

Two new `FileTransport` methods return open stream handles instead of whole-file
byte vectors:

```rust
async fn open_read(&self, path: &str)  -> Result<Pin<Box<dyn AsyncRead  + Send>>, String>;
async fn open_write(&self, path: &str) -> Result<Pin<Box<dyn AsyncWrite + Send>>, String>;
```

- **SFTP** (`SftpTransport`): `sftp.open(path)` / `sftp.create(path)` — those handles
  already implement tokio's `AsyncRead`/`AsyncWrite` (this is exactly what the
  existing same-host `copy_recursive` uses, so it's proven).
- **Local** (`LocalTransport`): `tokio::fs::File::open` / `::create`.

The file leaf of `transfer_entry` then pumps a fixed **256 KB** buffer from reader
to writer. Peak memory is one buffer, independent of file size, so
`MAX_TRANSFER_BYTES`, `read_bytes`, and `write_bytes` are deleted.

### Progress

Transfers run as **one batch command** so the progress bar can show an accurate
overall total, not per-file guesses:

```rust
#[tauri::command]
async fn fs_transfer_batch(
    app, state,
    transfer_id: String,
    src_conn_id: String,
    src_paths: Vec<String>,     // all from the one source pane
    dest_conn_id: String,
    dest_dir: String,
    rename_on_conflict: bool,
) -> Result<TransferOutcome, String>
```

1. **Pre-pass** (`measure`): recursively sum total bytes + file count across all
   items (a file is one `stat`; a dir walks `list_dir`). This is a second walk of
   the tree on top of the copy walk — acceptable for now; could be fused later.
2. **Stream** each file, incrementing a shared `done_bytes` / `done_files`.
3. **Emit** `transfer-progress` events, throttled to ~100 ms (plus one on every file
   boundary), with `{ id, doneBytes, totalBytes, doneFiles, totalFiles, current }`.

The frontend orchestrates the batch: it still runs the existing **collision check +
single Overwrite / Keep both / Cancel prompt**, then calls `fsTransferBatch` once,
listens for `transfer-progress` filtered by its `transfer_id`, and renders a bar
(`file 3/12 · 740 MB / 2.1 GB`). On completion it refreshes the destination and
toasts.

### Cancellation

A long transfer must be cancellable. `AppState` holds
`transfers: Mutex<HashMap<String, Arc<AtomicBool>>>`. The batch command registers a
flag under its `transfer_id` on start and removes it on exit; `fs_transfer_cancel`
sets it. The copy loop checks the flag every chunk and before each entry —
cooperative cancellation, no forced task abort.

### Partial-file safety

Each file streams to a temporary sibling (`<dest>.straypart`) and is **renamed
over the destination only once fully written** (plain SFTP rename won't replace
an existing target on most servers, so the commit falls back to remove + retry).
On cancel or a mid-stream error the temp file is best-effort deleted — a
pre-existing destination being overwritten is never touched, and no silently
truncated copy is ever left. A failed final flush counts as an error, not a
completed copy. (A hard crash can leave `.straypart` debris; a re-run of the
same transfer overwrites it.)

## What we deliberately don't do (yet)

- **Resume** an interrupted transfer (SFTP positioned writes make this possible
  later; for now a dropped file restarts).
- **Delta** transfer (rsync-style); rarely useful for drag-to-copy.
- **Wire compression**; could be enabled at the SSH layer later.
- **Throughput tuning** (pipelining concurrent SFTP reads on high-latency links).
- **Metadata preservation** beyond content (perms/mtime/symlinks).
