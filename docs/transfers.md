# Transfers — cross-connection file copies

Copy files and folders **between connections** — local ⇄ WSL ⇄ remote — that
have no direct path and must be relayed through the app. Same-connection
copy/move already exists (`fs_copy` / `fs_move`); this is the cross-connection
case.

---

## The tool

A two-pane copier, docked as a **Transfers tool group** in the bottom panel.
Each pane has a host picker (offering every connected local / WSL / remote), a
file tree for that host, and hidden-files toggle. Left pane defaults to Local.

- **Copy only.** Drag a file/folder from one pane onto a folder in the other,
  or select + copy/paste between panes. There is deliberately **no cut/move
  across connections** — a failed cross-host move can lose data, so it must
  never exist here.
- **Confirm before it goes.** Dropping/pasting opens a small sheet — source →
  destination, the items, and a size that fills in while the source is scanned
  (`fs_transfer_measure`, the copy walk's exact rules). Copy is enabled from the
  first frame, so a deep tree never blocks the decision. **The copy never waits
  on a blocking size pre-pass:** wait for the scan and its size is handed to
  `fs_transfer_batch`, which skips its own walk (bar shows the total at once);
  commit early and the copy starts immediately while a lightweight measure runs
  *alongside* it (`tokio::join!`), so the bar reads `N copied · calculating…`
  until the total lands. The measure is metadata-only, so it settles early in
  the copy.
- **Collisions** prompt once: **Overwrite / Keep both / Cancel**. "Keep both"
  uniquifies (`name copy`); "Overwrite" writes in place / merges into an
  existing folder; nested collisions overwrite/merge.
- **Progress** shows a live bar (`file 3/12 · 740 MB / 2.1 GB`) with Cancel; it
  rides along in the status bar after the panel is closed, and the destination
  tree refreshes on completion.

---

## The engine

Transfers are **streamed, transport-to-transport**. `fs_transfer_batch` relays
each file through a 256 KB buffer from the source transport's `open_read` to
the destination's `open_write` — so peak memory is one buffer regardless of
file size, and there is **no size cap**.

- **Pre-pass.** `measure` recursively totals bytes + file count for an accurate
  overall progress bar before the copy starts.
- **Progress events.** `transfer-progress` is emitted throttled to ~100 ms plus
  one per file boundary.
- **Cancellation.** `AppState` holds an `AtomicBool` per `transfer_id`;
  `fs_transfer_cancel` trips it, and the copy loop checks it every chunk and
  before each entry — cooperative, no forced task abort.
- **Partial-file safety.** Each file streams to a temporary `.straypart`
  sibling and is renamed over the destination **only once fully written** (a
  plain SFTP rename won't replace an existing target on most servers, so the
  commit falls back to remove-then-rename, keeping the temp if both fail). A
  cancel or mid-stream error best-effort deletes the temp; a pre-existing
  destination being overwritten is never touched, and no silently truncated
  copy is left behind.
- **Symlinked directories are skipped** — a link cycle (`ln -s . self`) would
  otherwise recurse forever; symlinks to files still copy as regular files, and
  the count of skipped links is reported in the completion toast. (The measure
  and copy walks apply the same skip, so totals match.)
- **Unreadable entries are skipped, not fatal.** A source entry that can't be
  stat'd or listed — a dangling symlink, a broken submodule gitlink, a vanished
  path — is skipped and counted (reported next to skipped links) instead of
  aborting the batch. Both the measure and copy walks tolerate it, so one bad
  entry no longer takes the rest of the selection down with it.
- **Files copy concurrently — 32 fungible slots, at most one big.** A file's
  cost is bytes plus per-file round trips (open, write, commit-rename,
  close); under ~4 MiB the round trips dominate, which is why a folder of
  thousands of tiny files used to crawl at KB/s on a link that moves
  hundreds of MB/s. A walker streams the tree into bounded queues as it
  discovers it — trusting the directory listing's metadata instead of
  re-stat'ing each child, one round trip saved per file — while a dispatcher
  copies alongside: 32 slots, any slot takes any file, but at most ONE holds
  a big (> 4 MiB) file at a time, because one 32-deep pipelined stream fills
  the wire and a second would split it, not add to it. A waiting big file
  takes a free slot ahead of queued smalls (start the long pole early;
  smalls fill in around it). The first file starts as soon as the first
  listing returns — never a blocking pre-pass — and backpressure keeps a
  million-file tree from ever sitting in memory. Making the width worth
  anything required letting SFTP requests overlap at all: the session used
  to sit behind a lock held across each whole operation, serializing every
  request. Background's cap is a token bucket shared by every stream —
  budget accrues at the cap and carries over at most one chunk, so all 32
  slots draw on the one budget and a slow stretch never banks credit to
  burst past the limit later.

WSL is its own transport, so a WSL ⇄ remote copy is relayed through the app
(read one SSH endpoint, write the other). The relay is **double-buffered**:
the chunk in hand is written while the next one is read, so neither leg idles
waiting on the other. Transfers ride a **dedicated transfer lane** per SSH
endpoint ([docs/connections.md](connections.md)) — an ephemeral connection with
**no SSH compression** (bulk payloads are often incompressible; single-threaded
zlib capped same-machine links at a few dozen MB/s) and a **16 MiB receive
window**, dialed at transfer start and hung up at the end, falling back to
the shared data lane if the dial fails. Retry rounds redial fresh lanes.

## Why not rsync

rsync needs an rsync binary on **both** ends (Windows ships none; minimal
hosts may lack it) and wants its **own** ssh connection rather than the single
multiplexed session we already hold. It also doesn't fit the remote ⇄ WSL /
remote ⇄ remote relay, and its delta advantage only helps re-syncs, not a
first-time drag-to-copy. So we stream over the SFTP session we already own, and
can add rsync's good ideas (resume, delta) natively later if wanted.

## Deliberately not done (yet)

- **Resume** an interrupted transfer (SFTP positioned writes make it possible
  later; for now a dropped file restarts).
- **Delta** transfer (rsync-style); rarely useful for drag-to-copy.
- **Metadata preservation** beyond content (perms/mtime/symlink recreation).
- **OS drag-in/out** (Explorer ⇄ tree). A one-off **Download** to the Windows
  Downloads folder ships via the file context menu.
- **Sidebar-to-sidebar drag** — cross-host drag lives only in this tool, not
  the explorer trees.
- A **WSL ⇄ Windows fast path** via `wsl.exe` (same machine, skip the SSH
  relay).
