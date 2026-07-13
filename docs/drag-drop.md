# Transfers (drag-and-drop) design

Copy files and folders **between connections** — local ↔ remote, local ↔ WSL,
WSL ↔ remote — through a simple two-pane panel.

**Status:** Shipped, then evolved. The original overlay (below) was built
2026-06, streaming replaced the in-memory engine in 0.7.2
([streaming-transfers.md](streaming-transfers.md)), and 0.8.15 **docked the
two-pane copier as a "Transfers" tool group in the terminal panel** (the three
explorer-header buttons and the popup are gone; each pane has a host picker
that hides the other side's choice, left pane defaults to Local).
**Depends on:** the `FileTransport` trait (local + SFTP) and the WSL connection
(a WSL distro is just an SSH connection, so it's a transfer endpoint like any
other).

---

## Goal

Move bytes between any two of the app's connections. Same-connection copy/move
already exists (`fs_copy` / `fs_move`); this adds the **cross-connection** case,
which has no direct path and must be **relayed through the app** (read from the
source transport, write to the destination transport).

## UX (original first cut — since docked, see Status)

A deliberately plain **two-pane transfer panel**. Originally an in-app overlay
opened by three explorer-header buttons (Local ⇄ Remote / Local ⇄ WSL /
WSL ⇄ Remote); now a **Transfers tool group in the terminal panel** with a
host picker per pane.

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

## The transfer engine (backend) — as shipped

The engine is **streamed**, transport-to-transport: `fs_transfer_batch` relays
each file through a 256 KB buffer from the source transport's `open_read` to
the destination's `open_write` — no size cap, one shared progress total,
cancellable, with each file committed via a temp-file rename so a cancel never
destroys an overwritten destination. Full design:
[streaming-transfers.md](streaming-transfers.md).

Collision handling is unchanged from the original design: the frontend
pre-checks the top-level name and prompts — **Keep both** → uniquify
(`name copy`), **Overwrite** → write in place / merge into an existing dir,
**Cancel** → never calls. Nested collisions overwrite/merge.

*(Historical: the first cut buffered whole files in memory behind a 512 MB
cap via `read_bytes`/`write_bytes`; 0.7.2 deleted that.)*

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

- **Integrate into the sidebar** — drag directly between sidebar trees,
  retiring the separate two-pane tool.
- **OS integration** — drop Explorer files onto a tree (upload); drag a remote file
  out to the desktop (download). (A one-off **Download** to the Windows
  Downloads folder shipped in 0.8.15 via the context menu.)
- Panes beyond the **primary** remote — with 2–3 remotes attached, the
  transfer pane pair only offers the primary (known limitation).
- A **WSL ↔ Windows** fast path via `wsl.exe` (same machine, skip the SSH relay).
