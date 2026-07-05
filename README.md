# Straylight

A lightweight, open-source desktop app that replaces VS Code for remote server
work: an SSH **file manager + terminal + code editor** built with Tauri v2 (Rust
backend) and React (frontend). The goal is the VS Code Remote-SSH experience at
~30–50 MB of memory instead of ~500 MB, in a ~10 MB installer.

**Status:** connect to a server, a **WSL distro**, or work locally; browse and
**edit + save** files in a tabbed Monaco editor (local *and* remote), manage files
(cut/copy/paste, transfers between machines, full keyboard navigation), use
**source control for git *and* Jujutsu (jj)**, **quick-open** and **search across
files**, **forward ports**, and run **multiple terminals** — all in one
Dracula-themed window that can show local folders, a WSL distro, and one remote at
the same time. Dropped connections auto-reconnect, and your workspace is restored on
relaunch.

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
  in-tree), multi-select delete, a **Properties** dialog (recursive size, counts,
  permissions, owner/group), and a right-click menu: New File, New Folder, Cut,
  Copy, Paste, Rename, Delete, Copy Path, Properties.
- **Transfers between machines** — drag (or copy/paste) files and folders across
  connections (local ⇄ WSL ⇄ remote). **Streamed** with no size cap, a live progress
  bar (shown in the status bar too) and Cancel.
- **Version control — git and Jujutsu (jj)** — open repos into a right-side Source
  Control panel: **live status** (local repos are file-watched; remote/WSL refresh
  on window focus) with **tree decorations**, side-by-side **diffs**, **stage /
  commit / amend** (jj: describe + commit, fix-last-message, squash), a **live
  multi-lane commit graph** above the explorer (all local branches; click a
  commit to browse its files), **branch/bookmark switching**, **stash** (git),
  **discard**, **conflict resolution** — inline Accept actions or a full **3-way
  merge editor** — and **fetch / update / push** with a **Cancel** for hung auth;
  fetch is always safe, anything that mutates the tree or publishes asks first.
  The VCS binary runs *on the host that owns the repo* — no local clone — so
  commits use the host's real identity, config, and hooks (jj is auto-located
  even when it's only in `~/.cargo/bin` on the remote). See
  [docs/version-control.md](docs/version-control.md).
- **Quick-open & search** — `Ctrl+P` fuzzy-opens a file by name; `Ctrl+Shift+F`
  searches file contents (grouped by file) and jumps to the line. Both start with
  a host picker (Local / WSL / Remote / All) and look in that host's **pinned
  folders** — Tab switches between pins, and results stream in per pin.
- **Command palette & settings** — `Ctrl+Shift+P` lists every command with its
  keybinding. One `settings.json` (app config dir) holds zoom, **keybinding
  overrides** (by command id), and the full **color sections** — the file *is*
  the theme; presets (Dracula / Nord / Catppuccin Mocha) just fill them in, and
  every color is individually editable, applied live (UI, editor, terminals).
  The stability promises are written down in [docs/stability.md](docs/stability.md).
- **Port forwarding** — forward a local `127.0.0.1` port to a service reachable from
  the SSH server, over a tunnel on the existing connection.
- **Editing** — a tabbed Monaco editor; edit and **save** (`Ctrl+S`) local *and*
  remote files, with per-tab dirty state and save-conflict detection. Binary files
  show an info card; very large files open in a lightweight mode. Clean tabs
  **auto-reload** when the file changes on disk (watch a growing log — the view
  follows the tail), and `.md` files get a rendered **Markdown preview**
  (`Ctrl+Shift+V`).
- **Terminals** — multiple, with a shell picker; see [Terminal](#terminal) below.
  A **▣ Containers** tab lists running containers (podman/docker) on every
  connected host — click one to open a shell inside it.
- **Status bar** — connection state, file path, git branch, language, encoding, line
  ending, and cursor position, plus Source Control / Ports / terminal toggles.

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
| `cargo test --manifest-path src-tauri/Cargo.toml` | Run the Rust unit tests (config parsing, permission formatting, git/jj status parsers). |

---

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> | Command palette (all commands) |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | Save the current file |
| <kbd>Ctrl</kbd>+<kbd>P</kbd> | Quick-open a file by name (fuzzy) |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> | Search across files |
| <kbd>F5</kbd> / <kbd>Ctrl</kbd>+<kbd>R</kbd> | Refresh everything (explorer, repos, open files — dirty tabs untouched) |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> | Markdown preview for the current file |
| <kbd>Ctrl</kbd>+<kbd>=</kbd> / <kbd>Ctrl</kbd>+<kbd>-</kbd> / <kbd>Ctrl</kbd>+<kbd>0</kbd> | Zoom in / out / reset |
| <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>C</kbd> | Copy path of the explorer selection |
| <kbd>Alt</kbd>+<kbd>Enter</kbd> | Properties of the explorer selection |
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
    │   ├── mod.rs         — shared types + fs_* commands (incl. fs_find / fs_search,
    │   │                    streaming transfers, Properties)
    │   └── local.rs       — local filesystem (std::fs / tokio::fs)
    ├── exec.rs            — host command-runner (SSH exec channel / local process),
    │                        shared by VCS, the file finder, and search
    ├── vcs.rs             — git + jj: status, diff, commit, log, branch, stash, …
    ├── forward.rs         — local SSH port forwarding (direct-tcpip tunnels)
    ├── wsl.rs             — WSL: list distros, provision sshd, connect over localhost SSH
    └── ssh/
        ├── connection.rs  — connect, auth, ProxyJump, status events, direct-tcpip
        ├── config.rs      — ~/.ssh/config parser
        ├── sftp.rs        — SFTP as a FileTransport (read + write + copy/move)
        └── pty.rs         — PTY shell: SSH channel, or local ConPTY
```

File operations go through a transport-agnostic `FileTransport` (SFTP for SSH
sessions, `std::fs` for local). **Version control, file finding, and search run the
real binary (`git` / `jj` / `find` / `grep`) on the host** via the `exec` runner —
there is no local clone, so commits use the host's identity and config. A connection
is one SSH link multiplexed into channels — an SFTP subsystem channel, one session
channel per terminal, an exec channel per command, and a direct-tcpip channel per
forwarded connection — or a local session backed by the filesystem and a ConPTY
shell. PTY output streams to the frontend via Tauri events; input/resize/close go
back through `pty_*`.

The frontend keeps two Zustand stores: `store/appStore.ts` (tabs, connections,
files, transfers, dialogs) and `store/vcsStore.ts` (tracked repos, decorations,
history) — the Source Control panel and its history live in a collapsible right-side
"VC region".

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
- **Version control** runs the host's `git`/`jj`. A colocated repo (`.jj` + `.git`)
  is driven as jj. Repos are opened explicitly; **local** repos then live-update via
  a filesystem watcher, while **remote/WSL** repos refresh on window focus, manual
  refresh, or F5 (keep **fewer than ~5 eager** for snappy updates over SSH).
  **fetch/update/push** use the host's credentials over a no-TTY channel, so an
  interactive prompt (key passphrase, 2FA, HTTPS password) will hang — run those in
  the terminal. On a *remote*, `jj` must be on the exec PATH (it works locally;
  otherwise it falls back to git).
- The Monaco bundle is large (it ships every language). Trimming it to a language
  subset is a deliberate later optimization.

---

## Project layout

```
straylight/
├── src/                    # React frontend
│   ├── components/         # layout, connection, filetree, editor, transfer, vcs,
│   │                       #   Finder / SearchInFiles / PortForwards overlays
│   ├── hooks/              # useSSH, useTerminal, useKeyboard
│   ├── lib/                # ipc, monaco, language, openDiff, vcsDecorations, …
│   ├── store/              # appStore.ts + vcsStore.ts (Zustand)
│   └── theme/, styles/     # Dracula variables, tokens, fonts, component CSS
├── src-tauri/              # Rust backend
│   ├── src/ssh/            # connection, config, sftp, pty
│   ├── src/exec.rs         # host command-runner (shared)
│   ├── src/vcs.rs          # git + jj source control
│   ├── src/forward.rs      # port forwarding
│   ├── src/transport/      # FileTransport (mod.rs, local.rs) + fs_* commands
│   ├── src/wsl.rs          # WSL distro discovery + sshd provisioning
│   ├── capabilities/       # Tauri v2 permission capabilities
│   ├── icons/              # generated app icons
│   ├── Cargo.toml
│   └── tauri.conf.json
├── docs/                   # architecture, version-control, handoff, test plan, …
├── public/fonts/           # Fira Code woff2
└── scripts/fetch-fonts.mjs
```
