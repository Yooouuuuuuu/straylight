# Straylight

A lightweight, open-source desktop app that replaces VS Code for remote server
work: an SSH **file manager + terminal + code editor** built with Tauri v2 (Rust
backend) and React (frontend). The goal is the VS Code Remote-SSH experience at
~30–50 MB of memory instead of ~500 MB, in a ~10 MB installer.

**Status:** connect to a server, a **WSL distro**, or work locally; browse and
**edit + save** files in a tabbed Monaco editor (local *and* remote), manage files
(incl. cut/copy/paste and full keyboard navigation), and run **multiple
terminals** — all in one Dracula-themed window that can show local folders, a WSL
distro, and one remote at the same time. Dropped connections auto-reconnect, and
your workspace is restored on relaunch.

**License:** MIT OR Apache-2.0 (dual). See [LICENSE-MIT](LICENSE-MIT) and
[LICENSE-APACHE](LICENSE-APACHE).


---

## What works

- **Dracula theme everywhere** — embedded Fira Code with ligatures, themed Monaco
  editor and xterm.js terminal.
- **Local, WSL, and remote in one window** — a multi-root sidebar with pinned
  local folders, your WSL distros, and one attached SSH host, all browsable at
  once. Each section has its own toolbar (hidden-files, New File/Folder, refresh,
  "last refreshed").
- **WSL distros** — browse a distro's files and run its terminal at **native ext4
  speed**: Straylight auto-provisions an SSH server inside the distro (installing
  OpenSSH on first use, with consent) and attaches it as a `localhost` SSH host —
  no manual setup, no slow `\\wsl$` bridge. See
  [docs/wsl-connection.md](docs/wsl-connection.md).
- **Connections** — `~/.ssh/config` hosts are listed and connect in one click
  (key auth via `IdentityFile`, then the default `~/.ssh/id_*`); the dialog adds
  manual password connections, and a config host with no usable key falls back to
  password entry. `ProxyJump` bastions and a 10 s connect timeout. No ssh-agent.
- **Resilient sessions** — a dropped SSH connection auto-reconnects with backoff
  (keeping open tabs, the tree, and the terminal attached), and your panel layout,
  open files, and last server are restored on relaunch.
- **File tree (SFTP + local)** — lazy-loaded directories, file-type icons,
  permissions / owner / mtime tooltips, symlink indicators, a hidden-files toggle,
  and **full keyboard navigation** (arrows, Enter, Home/End, PageUp/PageDown to
  jump between roots).
- **File operations** — F2 inline rename, **cut / copy / paste** (`Ctrl+X/C/V`,
  in-tree), and a right-click menu: New File, New Folder, Cut, Copy, Paste,
  Rename, Delete, Copy Path.
- **Editing** — a tabbed Monaco editor; edit and **save** (`Ctrl+S`) local *and*
  remote files, with per-tab dirty state and save-conflict detection. Binary files
  show an info card; very large files open in a lightweight mode.
- **Terminals** — multiple, with a shell picker; see [Terminal](#terminal) below.
- **Status bar** — connection state, file path, language, encoding, line ending,
  and cursor position.

### Terminal

Real PTYs rendered by xterm.js (WebGL when available), with resize, focus-aware
`Ctrl+C` (SIGINT), and right-click copy / paste. **Open as many as you like** —
they're listed down the right of the panel (VS Code style): `Ctrl+Shift+\`` opens
one and `Ctrl+PageDown` / `Ctrl+PageUp` cycle them.

A **shell picker** (the `▾` beside `+`) lists local profiles — **PowerShell 7,
Windows PowerShell, Command Prompt, Git Bash, and each installed WSL distro** —
plus the remote and connected-WSL login shells. By default a new terminal opens on
the first active of **remote → WSL → local**; a "New opens" preference in that menu
pins it (`Auto` / `Remote` / `WSL` / `Local`).

The local shell it launches:

- **Windows** — **PowerShell 7 (`pwsh.exe`) when installed**, otherwise the
  built-in Windows PowerShell 5.1 (`powershell.exe`).
- **macOS / Linux** — your `$SHELL` (falling back to `/bin/bash`).
- **Remote / WSL** — the login shell, exactly as `ssh` would start it.

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
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>`</kbd> | New terminal |
| <kbd>Ctrl</kbd>+<kbd>PageDown</kbd> / <kbd>Ctrl</kbd>+<kbd>PageUp</kbd> | Next / previous terminal |
| <kbd>Ctrl</kbd>+<kbd>B</kbd> | Toggle the sidebar |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> | Focus the file explorer |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> | Refresh the file tree |
| <kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd> (explorer) | Navigate the tree (→ expand/in, ← collapse/parent) |
| <kbd>Enter</kbd> (explorer) | Open file / toggle folder |
| <kbd>PageUp</kbd> / <kbd>PageDown</kbd> (explorer) | Jump to the previous / next root |
| <kbd>Ctrl</kbd>+<kbd>X</kbd> / <kbd>C</kbd> / <kbd>V</kbd> (explorer) | Cut / copy / paste |
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
    ├── transport/         — FileTransport trait (list/read/write/rename/remove/copy/move)
    │   ├── mod.rs         — shared types + transport-agnostic fs_* commands
    │   └── local.rs       — local filesystem (std::fs / tokio::fs)
    ├── wsl.rs             — WSL: list distros, provision sshd, connect over localhost SSH
    └── ssh/
        ├── connection.rs  — connect, auth, ProxyJump, status events
        ├── config.rs      — ~/.ssh/config parser
        ├── sftp.rs        — SFTP as a FileTransport (read + write + copy/move)
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
│   ├── src/wsl.rs          # WSL distro discovery + sshd provisioning
│   ├── capabilities/       # Tauri v2 permission capabilities
│   ├── icons/              # generated app icons
│   ├── Cargo.toml
│   └── tauri.conf.json
├── public/fonts/           # Fira Code woff2
└── scripts/fetch-fonts.mjs
```
