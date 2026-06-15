# Straylight

A lightweight, open-source desktop app that replaces VS Code for remote server
work: an SSH **file manager + terminal + code editor** built with Tauri v2 (Rust
backend) and React (frontend). The goal is the VS Code Remote-SSH experience at
~30–50 MB of memory instead of ~500 MB, in a ~10 MB installer.

**Status:** connect to a server (or work locally), browse files, **edit and save**
in a tabbed Monaco editor, manage files, and use a terminal — all in one
Dracula-themed window that shows a **local** folder and **one remote** at the same
time.

**License:** MIT OR Apache-2.0 (dual). See [LICENSE-MIT](LICENSE-MIT) and
[LICENSE-APACHE](LICENSE-APACHE).

---

## What works

- **Dracula theme everywhere** — embedded Fira Code with ligatures, themed Monaco
  editor and xterm.js terminal.
- **Local + remote in one window** — a multi-root sidebar with pinned local
  folders and one attached SSH host, both browsable at once.
- **Connections** — `~/.ssh/config` hosts are listed and connect in one click
  (key auth via `IdentityFile`, then the default `~/.ssh/id_*`); the dialog adds
  manual password connections. `ProxyJump` bastions and a 10 s connect timeout.
  No ssh-agent dependency.
- **File tree (SFTP + local)** — lazy-loaded directories, file-type icons,
  permissions / owner / mtime tooltips, symlink indicators (resolved so symlinked
  directories expand), and a hidden-files toggle.
- **File operations** — F2 inline rename and a right-click menu: New File, New
  Folder, Rename, Delete, Copy Path.
- **Editing** — a tabbed Monaco editor; edit and **save** (`Ctrl+S`) local *and*
  remote files, with per-tab dirty state and save-conflict detection. Binary files
  show an info card; very large files open in a lightweight mode.
- **Terminal** — see [Terminal](#terminal) below.
- **Status bar** — connection state, file path, language, encoding, line ending,
  and cursor position.

### Terminal

A real PTY rendered by xterm.js (WebGL when available), with resize, focus-aware
`Ctrl+C` (SIGINT), and right-click copy / paste. The terminal **targets the remote
shell when you're connected to a server, and a local shell otherwise** — the
header reads `Terminal · <host>` or `Terminal · local`. It opens in your home
directory.

The local shell it launches:

- **Windows** — **PowerShell 7 (`pwsh.exe`) when installed**, otherwise the
  built-in Windows PowerShell 5.1 (`powershell.exe`). Install 7 with
  `winget install Microsoft.PowerShell` and Straylight picks it up automatically.
- **macOS / Linux** — your `$SHELL` (falling back to `/bin/bash`).
- **Remote** — the server's login shell, exactly as `ssh` would start it.

> A per-terminal shell picker (cmd / git-bash / a chosen shell) will arrive with
> multi-terminal support.

---

## Prerequisites

| Tool | Notes |
|------|-------|
| **Node.js** ≥ 18 | Frontend build (tested with Node 24). |
| **Rust** (stable, via [rustup](https://rustup.rs)) | Backend. `cargo`/`rustc` must be on PATH. |
| **C++ build tools** (Windows) | Rust's `msvc` toolchain links with `link.exe`. Install the **Visual Studio Build Tools** → "Desktop development with C++" (no full IDE needed) — e.g. `winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`. Without it you'll see `linker 'link.exe' not found`. |
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

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | Save the current file |
| <kbd>Ctrl</kbd>+<kbd>W</kbd> | Close the current tab |
| <kbd>Ctrl</kbd>+<kbd>Tab</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Tab</kbd> | Next / previous tab |
| <kbd>Ctrl</kbd>+<kbd>`</kbd> | Toggle the terminal panel |
| <kbd>Ctrl</kbd>+<kbd>B</kbd> | Toggle the sidebar |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> | Focus the file explorer |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> | Refresh the file tree |
| <kbd>F2</kbd> | Rename the selected file / folder |
| <kbd>Del</kbd> | Delete the selected file / folder |

When the terminal is focused, <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>Ctrl</kbd>+<kbd>S</kbd>
keep their shell meaning (SIGINT / flow control) and aren't intercepted.

---

## Architecture

```
Tauri v2 shell (native window, custom title bar)
├── React + Vite frontend (src/)
│   ├── Monaco editor      — tabbed code editor
│   ├── xterm.js           — terminal
│   ├── Zustand            — global state (store/appStore.ts)
│   └── Typed IPC wrappers — lib/ipc.ts
└── Rust backend (src-tauri/src/)
    ├── transport/         — FileTransport trait (list/read/write/rename/remove)
    │   ├── mod.rs         — shared types + transport-agnostic fs_* commands
    │   └── local.rs       — local filesystem (std::fs / tokio::fs)
    └── ssh/
        ├── connection.rs  — connect, auth, ProxyJump, status events
        ├── config.rs      — ~/.ssh/config parser
        ├── sftp.rs        — SFTP as a FileTransport (read + write)
        └── pty.rs         — PTY shell: SSH channel, or local ConPTY
```

File operations go through a transport-agnostic `FileTransport` (SFTP for SSH
sessions, `std::fs` for local). A connection is one SSH link multiplexed into
channels — an SFTP subsystem channel plus one session channel per terminal — or
a local session backed by the filesystem and a ConPTY shell. PTY output streams
to the frontend via Tauri events; input/resize/close go back through `pty_*`.

**IPC contract.** Rust structs serialize with `camelCase`; the typed wrappers in
`src/lib/ipc.ts` mirror them exactly. Command arguments are written in camelCase
on the JS side and Tauri maps them to the snake_case Rust parameters.

---

## Notes & behavior

- **Authentication** is key-based or password — there is **no ssh-agent**
  integration. Config hosts use the host's `IdentityFile`, then the default
  `~/.ssh/id_*` keys; the dialog offers a password. Passphrase-protected keys
  aren't prompted for yet — load an unencrypted key or use a password.
- **ProxyJump** connects through the bastion via a direct-tcpip channel
  (authenticated with the same on-disk key chain); only the first hop of a
  chained `ProxyJump` is used.
- **Host keys** are currently trusted on first use (`check_server_key` returns
  `Ok(true)`); `known_hosts` verification is planned.
- The Monaco bundle is large (it ships every language). Trimming it to a language
  subset is a deliberate later optimization.

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
