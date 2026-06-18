# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Planned

- **Revisit where password entry lives** — the current centered connect modal vs.
  an inline field (e.g. on the "Connect to a server" button).
- **Auto-refresh** (optional): a filesystem watch for the local tree; SSH would
  poll (opt-in).
- **Re-evaluate the explorer / sidebar UX once git status lands** — fitting git
  state into the tree and the section bars may force a sizable rework.
- **Drag-and-drop transfers** between the local, remote, and WSL trees (and the OS).
- **Local draft backup of unsaved edits** — survive a connection drop / crash /
  accidental close by caching dirty buffers locally and restoring them on reopen
  (VS Code "hot exit"); doubles as a WSL/remote edit safeguard.
- **WSL session auto-recovery** — re-provision `sshd` if a connected distro's
  daemon dies (WSL file browsing itself now works via auto-provisioned SSH).
- Terminal tab reordering.
- **Phase 3:** git status / blame / log / diff, Podman containers, fuzzy finder,
  search-in-files, port forwarding, Markdown preview, and auto-update.

## [0.6.0] - 2026-06-18

WSL as a first-class connection: browse a distro and run its terminal at native
speed, with zero setup.

### Added

- **WSL distros as connections.** A new **WSL** sidebar section lists your
  installed distros (the default highlighted, container/system distros hidden);
  click one to connect. Under the hood Straylight **auto-provisions an SSH server
  inside the distro** — installing OpenSSH on first use (with consent) — and
  attaches it as a `localhost` SSH host, so files and the terminal run on the
  distro's **native ext4** filesystem rather than the slow `\\wsl$` bridge. WSL
  gets its own slot (Local + WSL + remote at once), a toolbar matching the other
  sections (hidden-files, New File / New Folder, refresh, "last refreshed"), a
  file tree, and a terminal opened on connect. See `docs/wsl-connection.md`.
- **Configurable new-terminal target.** `+` and `Ctrl+Shift+\`` open a terminal on
  the first active of **remote → WSL → local**; a "New opens" preference in the
  shell menu (`Auto` / `Remote` / `WSL` / `Local`) pins it, and the choice
  persists. The shell menu also lists the connected WSL distro's shell.

## [0.5.1] - 2026-06-17

A keyboard-driven explorer — full tree navigation, per-section toolbars, and
cut/copy/paste — plus a smoother no-key connect fallback.

### Added

- **File-tree keyboard navigation** — when the explorer has focus, arrow keys
  drive it: ↑/↓ move the selection (across roots), → expands a folder or steps
  into it, ← collapses it or jumps to the parent, **Enter** opens a file or
  toggles a folder, and **Home/End** jump to the first/last row. **PageUp /
  PageDown** hop to the previous / next root (each server's top). **Ctrl+Shift+E**
  focuses the tree.
- **New File / New Folder** buttons in each section's toolbar — they create in
  the selected folder (or the selected file's parent), falling back to the
  section root.
- **Cut / copy / paste** in the explorer — right-click or `Ctrl+X` / `Ctrl+C` /
  `Ctrl+V` while the tree has focus. Paste lands in the selected (or right-
  clicked) folder and auto-renames on a collision (`name copy`, `name copy 2`);
  same-connection for now. Backed by new recursive `fs_copy` / `fs_move`
  transport commands.
- **Per-section "last refreshed" stamp** (e.g. `5s ago`) beside each refresh
  button, coarsening on its own from seconds through minutes, hours, and days.

### Changed

- **Explorer controls are now per-section.** The hidden-files toggle and refresh
  live in the **Local** and **Remote** bars and act on only that section
  (`Ctrl+Shift+R` still refreshes both). The transient "Refreshed" toast is gone
  in favour of the per-section timestamp.
- **Local roots start collapsed** and load lazily — a collapsed root does no I/O
  until you open it (matters for slow network / WSL paths).
- **Single-click selects; double-click opens.** Clicking a file now only selects
  it (so you can set the keyboard cursor without opening a tab); it opens on
  double-click, Enter, or →. Folders still expand/collapse on single-click.
- The **password connect dialog auto-focuses** the field you need next — Host for
  a fresh connection, User for a config host that's missing one, Password when
  host and user are already known.
- **A config host with no usable key now falls back to password entry** — clicking
  it opens the connect dialog prefilled (with the password field focused and a
  short note) instead of dead-ending on a "no usable key" error.

### Fixed

- **Esc dismisses the delete confirmation** without deleting (same as Cancel).

## [0.5.0] - 2026-06-17

Terminals grow up: multiple terminals, a shell picker, and Windows scrollback
that finally behaves.

### Added

- **Multiple terminals** — open as many as you like, listed down the right side
  of the panel (VS Code style). `+` opens one on the current workspace;
  `Ctrl+PageDown` / `Ctrl+PageUp` cycle them; middle-click or × closes one. You
  can keep a local and a remote shell open at the same time.
- **Shell picker** — the `▾` beside `+` lists local profiles — **PowerShell 7,
  Command Prompt, Git Bash, and each installed WSL distro** — plus the remote
  login shell when connected. Picking a WSL distro opens a native `wsl.exe`
  terminal.
- A **remote terminal opens automatically** when you connect to a server (and on
  launch auto-reconnect).

### Changed

- **`Ctrl+\`` is now smart** (VS Code-style): reveals and focuses the terminal
  when it's hidden, focuses it when it's visible but unfocused, and only hides it
  when it already has focus. `Ctrl+Shift+\`` opens a new terminal.
- The terminal panel can be dragged up to **fully cover the editor**.

### Fixed

- **`Ctrl+Shift+\`` now works** — it had been matching the `~` that Shift
  produces instead of the backtick key.
- **Local / WSL terminal scrollback no longer wipes, duplicates, or drops lines**
  on hide/show or resize. Three Windows-ConPTY problems: hiding the panel no
  longer resizes the shell to one row; a fast drag is debounced to a single
  resize; and xterm is now told it's driving a ConPTY (`windowsPty`) so it
  reflows wrapped lines correctly. Remote SSH terminals are unaffected.

## [0.4.0] - 2026-06-16

Connections survive drops, and your workspace survives restarts: auto-reconnect
and session persistence.

### Added

- **Auto-reconnect** — a dropped SSH connection (sleep, Wi-Fi change, server
  blip) now recovers on its own. A per-connection supervisor detects the drop,
  shows **Reconnecting…**, and retries with backoff, swapping the transport in
  place so open tabs, the file tree, and the terminal stay attached. Key hosts
  re-authenticate silently; a password is reused from memory for the session and
  is never written to disk. After repeated failures the status bar offers a
  manual **Reconnect**.
- **Session persistence** — on relaunch Straylight restores your panel layout
  (sizes + sidebar/terminal visibility), reopens the files you had open, and
  brings back the last server: **key-based hosts reconnect automatically** and
  their tabs reopen; a **password host pre-fills the connect dialog** (its tabs
  reopen once you connect). Files are reloaded from disk — an explicit disconnect
  is remembered, so it won't reconnect next launch.

### Changed

- The terminal restarts cleanly after a reconnect, and the file tree refreshes
  to reflect any changes made while disconnected.

## [0.3.0] - 2026-06-15

Editing comes online: edit and save files (local and remote), a tabbed editor,
file-tree operations, and a local terminal.

### Added

- **File editing & save** — the Monaco editor is editable; save with `Ctrl+S` to
  local or remote files. Per-tab dirty state (which clears when you undo back to
  the saved content), and **save-conflict detection** — Overwrite / Reload /
  Cancel if the file changed on disk since you opened it.
- **Editor tabs** — open multiple files, each with its own content, undo history,
  cursor, and scroll. Middle-click or `Ctrl+W` to close (with an unsaved-changes
  prompt); `Ctrl+Tab` / `Ctrl+Shift+Tab` to cycle; clicking an open file focuses
  its tab.
- **File operations** — **F2** inline rename and a right-click menu: New File, New
  Folder, Rename, Delete (recursive, with confirmation), Copy Path. The **Delete**
  key acts on the selection. Open tabs follow renames and close on delete.
- **Local terminal** — the terminal now works without a remote, via a local PTY
  (ConPTY on Windows). It targets the remote shell when connected, otherwise a
  local shell: **PowerShell 7 (`pwsh`) when installed, else Windows PowerShell 5.1**
  on Windows, and `$SHELL` elsewhere.

### Changed

- README refreshed: current feature set, terminal / shell behavior, keyboard
  shortcuts, architecture, and a Windows **C++ build tools** prerequisite.

## [0.2.0] - 2026-06-12

Phase 2 begins: a transport abstraction with local-filesystem support, and a
multi-root sidebar that shows local folders and one remote at the same time.

### Added

- **Local filesystem support** — browse and view local files in the same UI as
  remote, via a new `FileTransport` abstraction (SFTP and `std::fs` behind one
  trait; transport-agnostic `fs_list_dir` / `fs_read_file` / `fs_stat`).
- **Multi-root sidebar** — a **Local** section (pinned folders, persisted across
  restarts) and a **Remote** section (one SSH host), shown at the same time. Pin
  a folder with **+ / Open folder**; remove it with the × on hover.
- **One local + one remote per window** — connecting a server attaches it as a
  root alongside the local folders; a second server replaces the first.
- **Edit `~/.ssh/config` in-app** — the **Edit** action opens the config in the
  editor instead of an external program.

### Changed

- The title bar now identifies the attached **remote host**, or shows **Local**
  with a neutral indicator distinct from the green "connected" state.
- The large-file truncation banner and toast appear only when a file is opened in
  the editor — never on the binary info card.
- Removed the fixed "This PC" entry in favor of user-pinned folders.

### Notes

- Still read-only; file **editing + save** (local and remote) is the next step.
- No local terminal yet — the terminal is bound to the remote connection.

## [0.1.0] - 2026-06-12

First milestone — Phase 1, the "walking skeleton": connect to an SSH server,
browse the remote filesystem, read code with syntax highlighting, and use a
terminal, in a Dracula-themed, VS Code-style window built on Tauri v2 and React.

### Added

#### Application & theming

- Tauri v2 + React 18 + Vite + TypeScript scaffold; dual MIT / Apache-2.0 license.
- Complete Dracula theme via CSS custom properties; embedded Fira Code (Light
  through Bold) with ligatures across editor, terminal, and UI.
- VS Code-style layout (`react-resizable-panels`): a decorationless custom title
  bar with window controls and a per-host workspace-color accent, collapsible
  sidebar / editor / terminal panels, and a status bar.

#### Connections (russh 0.46)

- `~/.ssh/config` parsing — every concrete `Host` (HostName, User, Port,
  IdentityFile, ProxyJump) is listed in the sidebar.
- One-click connect for config hosts using on-disk keys (IdentityFile, then the
  default `~/.ssh/id_ed25519` / `id_ecdsa` / `id_rsa`).
- Manual password connections via a dialog (host / port / user / password and an
  optional jump host, with an auto-generated `user@host` label).
- `ProxyJump` bastion support and a 10-second connect timeout.
- An "Edit" action opens `~/.ssh/config` in the system editor; the host list
  refreshes when the window regains focus.
- A disconnect control for switching hosts without restarting.

#### Files (SFTP, read-only)

- Lazy-loaded file tree with type icons, permissions / owner / mtime tooltips,
  symlink indicators (resolved so symlinked directories expand), a hidden-files
  toggle, and refresh.
- Monaco viewer with language-detected syntax highlighting.
- Fast binary detection (sniffs the first 8 KB and skips the download) shown as an
  information card.
- Large-file handling: files of 50 MB or more open in plaintext / lightweight mode
  with a truncation banner.

#### Terminal

- A real SSH PTY rendered by xterm.js (WebGL when available), streamed over Tauri
  events, with resize wired through to the remote shell.
- Focus-aware Ctrl+C (SIGINT) and right-click copy / paste.

#### Other

- Status bar: connection state, file path, language, encoding, line ending, and
  cursor position.
- Toast notifications and keyboard shortcuts (Ctrl+`, Ctrl+B, Ctrl+Shift+E,
  Ctrl+W, Ctrl+Shift+R).

### Notes

- Authentication uses on-disk keys (via `~/.ssh/config`) or a password; there is
  no ssh-agent integration.
- `~/.ssh/config` is parsed manually, as the `russh-config` crate has no published
  0.3.x and cannot enumerate `Host` blocks.
- Host keys are trusted on first use; `known_hosts` verification is planned.
- Verified with `tsc --noEmit` and `vite build` (frontend) and `cargo check` and
  `cargo test` (backend, 4 tests passing).

[Unreleased]: https://github.com/Yooouuuuuuu/straylight/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/Yooouuuuuuu/straylight/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/Yooouuuuuuu/straylight/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Yooouuuuuuu/straylight/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Yooouuuuuuu/straylight/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Yooouuuuuuu/straylight/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Yooouuuuuuu/straylight/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Yooouuuuuuu/straylight/releases/tag/v0.1.0
