# Straylight

A lightweight, open-source desktop app that replaces VS Code for remote server
work: an SSH **file manager + terminal + code viewer** built with Tauri v2 (Rust
backend) and React (frontend). The goal is the VS Code Remote-SSH experience at
~30–50 MB of memory instead of ~500 MB, in a ~10 MB installer.

**Status: Phase 1 — walking skeleton.** You can connect to a server, browse the
remote file system, read code with syntax highlighting, and use a full terminal,
all in one Dracula-themed window.

**License:** MIT OR Apache-2.0 (dual). See [LICENSE-MIT](LICENSE-MIT) and
[LICENSE-APACHE](LICENSE-APACHE).

---

## What works in Phase 1

- **Dracula theme everywhere** — CSS custom properties, embedded Fira Code with
  ligatures, themed Monaco editor and xterm.js terminal.
- **VS Code-style layout** — custom title bar with window controls + workspace
  color accent, resizable sidebar / editor / terminal panels
  (`react-resizable-panels`), and a status bar.
- **SSH config parsing** — `~/.ssh/config` is parsed on demand; every `Host`
  entry shows up in the connection list.
- **Connect dialog** — pick a config host or fill in a manual connection
  (host / port / user, optional jump host, and ssh-agent / key file / password
  auth).
- **SSH connection** (russh) — ssh-agent first, then key file, then password;
  `ProxyJump` bastions supported.
- **SFTP file tree** — lazy-loaded directories, file-type icons, permissions /
  owner / mtime in tooltips, symlink indicators (resolved so symlinked
  directories expand), and a hidden-files toggle.
- **Monaco editor** — click a file to view it with language-detected
  highlighting. Binary files (NUL byte in the first 8 KB) show an info card
  instead. Files ≥ 50 MB open in lightweight mode; large files raise a toast.
- **Terminal** — a real PTY over SSH, rendered by xterm.js (WebGL when
  available), with resize wired through to the remote shell.
- **Status bar** — connection state, file path, language, encoding, line ending,
  and cursor position.

> Phase 1 is **read-only** for files (viewing code). Editing/saving, tabs,
> drag-and-drop transfer, auto-reconnect, git, containers, and search arrive in
> Phases 2–3.

---

## Prerequisites

| Tool | Notes |
|------|-------|
| **Node.js** ≥ 18 | Frontend build (tested with Node 24). |
| **Rust** (stable, via [rustup](https://rustup.rs)) | Backend. `cargo`/`rustc` must be on PATH. |
| **Tauri v2 system deps** | Windows: WebView2 (preinstalled on Win 10/11). Linux: WebKitGTK 4.1, `libssl`, `librsvg`, build-essential — see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). |

The Tauri CLI is included as a dev dependency (`@tauri-apps/cli`), so you don't
need a global install.

---

## Getting started

```bash
# 1. Install frontend dependencies
npm install

# 2. Run in development (starts Vite + the Rust app with hot reload)
npm run tauri dev
```

The first `tauri dev` compiles the Rust backend and downloads its crates, so it
takes a few minutes. Subsequent runs are fast.

To produce installers:

```bash
npm run tauri build
```

### Fonts

The Fira Code weights are committed under `public/fonts/`. After a fresh
checkout you can refetch them with:

```bash
node scripts/fetch-fonts.mjs
```

If the fonts are missing the UI falls back to the system monospace stack.

---

## Useful commands

| Command | What it does |
|---------|--------------|
| `npm run dev` | Vite dev server only (frontend in a browser, no backend). |
| `npm run build` | Type-check (`tsc --noEmit`) + Vite production build. |
| `npm run typecheck` | Type-check only. |
| `npm run tauri dev` | Full app with hot reload. |
| `npm run tauri build` | Build native installers. |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Run the Rust unit tests (config parsing, permission formatting). |

---

## Keyboard shortcuts (Phase 1)

| Shortcut | Action |
|----------|--------|
| <kbd>Ctrl</kbd>+<kbd>`</kbd> | Toggle the terminal panel |
| <kbd>Ctrl</kbd>+<kbd>B</kbd> | Toggle the sidebar |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> | Focus the file explorer |
| <kbd>Ctrl</kbd>+<kbd>W</kbd> | Close the current file (not while the terminal is focused) |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> | Refresh the file tree |

The full VS Code shortcut set lands with the features it drives (fuzzy finder,
tabs, etc.) in later phases.

---

## Architecture

```
Tauri v2 shell (native window, custom title bar)
├── React + Vite frontend (src/)
│   ├── Monaco editor      — code viewing
│   ├── xterm.js           — terminal
│   ├── Zustand            — global state (store/appStore.ts)
│   └── Typed IPC wrappers — lib/ipc.ts
└── Rust backend (src-tauri/src/)
    └── ssh/
        ├── connection.rs  — connect, auth, ProxyJump, status events
        ├── config.rs      — ~/.ssh/config parser
        ├── sftp.rs        — list / read / stat (read-only in Phase 1)
        └── pty.rs         — PTY shell, streamed over the `pty-output` event
```

One SSH connection per server is multiplexed into channels: an SFTP subsystem
channel for file operations and one session channel per terminal. PTY output is
streamed to the frontend via Tauri events; input, resize, and close go back
through `pty_*` commands.

**IPC contract.** Rust structs serialize with `camelCase`; the typed wrappers in
`src/lib/ipc.ts` mirror them exactly. Command arguments are written in camelCase
on the JS side and Tauri maps them to the snake_case Rust parameters.

---

## Notes & behavior

Phase 1 is compile-verified end to end: the frontend (`tsc` + `vite build`), the
Rust backend (`cargo check`), and the Rust unit tests (`cargo test`) all pass.
A few behaviors worth knowing:

- **ssh-agent** is the default auth path and is platform-aware: the Unix socket
  (`$SSH_AUTH_SOCK`) on Linux/macOS, and the OpenSSH named pipe
  (`\\.\pipe\openssh-ssh-agent`) with a Pageant fallback on Windows. Run
  `ssh-add` if your key isn't loaded.
- **ProxyJump** connects through the bastion via a direct-tcpip channel; the jump
  host is authenticated with ssh-agent (the common bastion setup), and only the
  first hop of a chained `ProxyJump` is used in Phase 1.
- **Host keys** are currently trusted on first use (`check_server_key` returns
  `Ok(true)`). `known_hosts` verification is a Phase 2 item — see the comment in
  `connection.rs`.
- **Files are read-only** in Phase 1 (the editor is in view mode). Editing/saving
  is Phase 2.

The Monaco bundle is large (it ships every language). Trimming it to a language
subset is a deliberate later optimization, not required for Phase 1.

---

## Project layout

```
straylight/
├── src/                    # React frontend
│   ├── components/         # layout, connection, filetree, editor, terminal
│   ├── hooks/              # useSSH, useTerminal, useKeyboard
│   ├── lib/                # ipc, monaco, language, fileIcons, format, …
│   ├── store/appStore.ts   # Zustand global state
│   └── theme/, styles/     # Dracula variables, tokens, fonts, component CSS
├── src-tauri/              # Rust backend
│   ├── src/ssh/            # connection, config, sftp, pty
│   ├── capabilities/       # Tauri v2 permission capabilities
│   ├── icons/              # generated app icons
│   ├── Cargo.toml
│   └── tauri.conf.json
├── public/fonts/           # Fira Code woff2
└── scripts/fetch-fonts.mjs
```
