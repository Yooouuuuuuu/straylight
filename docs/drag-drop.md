# Transfers (drag-and-drop) design

Copy files and folders **between connections** — local ↔ remote, local ↔ WSL,
WSL ↔ remote — through a simple two-pane panel.

**Status:** Design agreed (2026-06-18). Building.
**Depends on:** the `FileTransport` trait (local + SFTP) and the WSL connection
(a WSL distro is just an SSH connection, so it's a transfer endpoint like any
other).

---

## Goal

Move bytes between any two of the app's connections. Same-connection copy/move
already exists (`fs_copy` / `fs_move`); this adds the **cross-connection** case,
which has no direct path and must be **relayed through the app** (read from the
source transport, write to the destination transport).

## UX (intentionally simple first cut)

A deliberately plain **two-pane transfer panel** — an in-app overlay, not a
separate OS window (so it shares the store and can mirror the explorer). Three
buttons in the **Explorer header** open it for a connection pair, each shown only
when both sides are connected:

- **Local ⇄ Remote**
- **Local ⇄ WSL**
- **WSL ⇄ Remote**

Left pane = one connection's tree, right pane = the other. **Copy only** — drag a
file/folder from one pane onto a folder in the other, *or* select + copy/paste
between panes. **There is no cut/move across connections** (a failed cross-host
move can lose data — it must never exist here).

- **Collision** (destination already has that name) → prompt: **Overwrite / Keep
  both / Cancel**.
- **Progress** → a toast for now (moves into the panel later).

This is an admitted scaffold: it gets the transfer engine fully wired with minimal
UI. A nicer integrated affordance (and OS drag-in/out) comes later.

---

## The transfer engine (backend)

A new transport method pair carries raw bytes (the existing `read_file` /
`write_file` are text-oriented and binary-sniffing, so they can't move arbitrary
files):

- `read_bytes(path) -> Vec<u8>` and `write_bytes(path, &[u8])` on `FileTransport`
  (SFTP via `open`/`create`; local via `tokio::fs`).

A transport-agnostic command relays between two connections:

```
fs_transfer(srcConnId, srcPath, destConnId, destDir, renameOnConflict) -> newPath
```

- Resolves `destPath = destDir / basename(srcPath)`.
- **File:** `dest.write_bytes(destPath, src.read_bytes(srcPath))`.
- **Folder:** create `destPath`, list the source dir, recurse each child.
- `renameOnConflict`: the frontend pre-checks the top-level name (via `fs_stat`)
  and prompts; **Keep both** → uniquify (`name copy`), **Overwrite** → write in
  place / merge into an existing dir, **Cancel** → never calls. Nested collisions
  overwrite.

### MVP limitation — whole-file in memory

The first cut reads each file fully into memory before writing it, with a size cap
(rejects very large files with a clear error). **Streaming** (chunked relay, no
cap) is the first follow-up — it needs an `AsyncRead`/`AsyncWrite` abstraction
across transports, which is fiddly with SFTP file lifetimes, so it's deferred.

---

## Panel UI (frontend)

- Three header buttons (enabled by which pairs are connectable) open the overlay
  with the two panes wired to the chosen connections.
- Each pane is a file tree for its connection (reusing the explorer tree, but with
  the editor-open action replaced by select/drag — files don't open here).
- Drag a node onto a destination folder (or the other pane's root) → `fs_transfer`.
  Copy/paste: select in one pane, copy, focus a folder in the other, paste.
- Files **stream** with no size cap, behind a live progress bar and a Cancel
  button; a collision prompt precedes the transfer and the destination tree
  refreshes on completion. See [streaming-transfers.md](streaming-transfers.md).

---

## Future work

- **Integrate into the sidebar** — drag directly between sidebar trees, collapsing
  the three buttons into one affordance.
- **OS integration** — drop Explorer files onto a tree (upload); drag a remote file
  out to the desktop (download).
- **Multi-select** transfers (today the app has single selection).
- A **WSL ↔ Windows** fast path via `wsl.exe` (same machine, skip the SSH relay).
