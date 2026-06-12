# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Planned

- **Editing + save** (local and remote): `write_file` on the transport, dirty
  state, Ctrl+S, and save-conflict detection.
- **Local terminal** (ConPTY) and a **WSL** transport.
- Tabs, drag-and-drop transfers, auto-reconnect, and session persistence.
- **Phase 3:** git status / blame / log / diff, Podman containers, fuzzy finder,
  search-in-files, port forwarding, Markdown preview, and auto-update.

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

[Unreleased]: https://github.com/Yooouuuuuuu/straylight/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Yooouuuuuuu/straylight/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Yooouuuuuuu/straylight/releases/tag/v0.1.0
