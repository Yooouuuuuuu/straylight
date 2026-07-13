# Straylight

A lightweight, open-source desktop app that replaces VS Code for remote server
work: an SSH **file manager + terminal + code editor + source control** built
with Tauri v2 (Rust backend) and React (frontend). The goal is the VS Code
Remote-SSH experience at ~30–50 MB of memory instead of ~500 MB, in a ~10 MB
installer.

**Status (0.9.0):** one window shows **local folders, a WSL distro, and up to
three SSH remotes** side by side. Browse and **edit + save** files in a tabbed,
splittable Monaco editor; manage files (cut/copy/paste, streamed transfers
between machines, full keyboard navigation); drive **source control for git
*and* Jujutsu (jj)** — status, diffs, commits, a live multi-lane history with
incoming-commit review, branches, stashes, conflicts and a 3-way merge editor;
**quick-open** and **search across files**; watch **listening ports**, forward
them, and shell into **containers**; and run **multiple terminals** grouped by
host. Dropped connections auto-reconnect, and your workspace — layout, tabs,
splits, pins, last hosts — is restored on relaunch. 0.9.x is the tested-from-
source series; installers arrive at 0.10 (see
[docs/release-plan.md](docs/release-plan.md)).

**License:** MIT OR Apache-2.0 (dual). See [LICENSE-MIT](LICENSE-MIT) and
[LICENSE-APACHE](LICENSE-APACHE).

---

## What works

- **Themed everywhere** — the signature Straylight theme by default, plus
  Straylight Crimson / Straylight Neon / Dracula / Nord / Solarized Light;
  embedded Fira Code with ligatures; themed Monaco, xterm, and every control.
  Themes are pure data in `settings.json` (see below) — every color is
  individually editable, live.
- **Local, WSL, and up to three remotes in one window** — a multi-root sidebar
  with pinned local folders, your WSL distros, and per-remote **host bars**
  (`user@host` + its own toolbar, state dot, reconnect and disconnect). Every
  host carries a stable **identity color** (right-click the host bar to pick):
  host bar, title-bar tint, editor-tab stripes, terminal chips, and Source
  Control card frames all follow it. L / W / R header toggles hide a section
  without disconnecting it.
- **WSL distros** — browse a distro's files and run its terminal at **native
  ext4 speed**: Straylight auto-provisions an SSH server inside the distro
  (installing OpenSSH on first use, with consent) and attaches it as a
  `localhost` SSH host — no slow `\\wsl$` bridge. See
  [docs/wsl-connection.md](docs/wsl-connection.md).
- **Connections** — `~/.ssh/config` hosts connect in one click (key auth via
  `IdentityFile`, then the default `~/.ssh/id_*`); the dialog adds manual
  password connections, and a config host with no usable key falls back to
  password entry. `ProxyJump` bastions (first hop) and a 10 s connect timeout.
  On launch, a dialog offers to reconnect the **last WSL distro and remote**
  (`autoConnect`: ask / always / never).
- **Resilient sessions** — a dropped SSH connection auto-reconnects with
  backoff (keeping open tabs, the tree, and terminals attached); panel layout,
  editor splits, pinned/preview tabs, open files, and hosts restore on
  relaunch.
- **File tree (SFTP + local)** — lazy-loaded, file-type icons, permission /
  owner / mtime tooltips, symlink indicators, per-host hidden-files toggle and
  refresh stamp, **full keyboard navigation** (arrows, Enter, Home/End,
  PageUp/PageDown between roots), and collapse/expand state persisted per
  host + folder.
- **File operations** — F2 inline rename, **cut / copy / paste**
  (`Ctrl+X/C/V`, in-tree), multi-select delete, a **Properties** dialog
  (recursive size, counts, permissions, owner/group), **Download** straight to
  the Windows Downloads folder (WSL/remote), and a right-click menu: New File,
  New Folder, Cut, Copy, Paste, Rename, Delete, Copy Path, Download,
  Properties.
- **Transfers between machines** — a **Transfers** tool in the bottom panel: a
  two-pane copier between any two hosts (local ⇄ WSL ⇄ remote), drag or
  copy/paste across panes. **Streamed** with no size cap, a live progress bar
  (also in the status bar) and Cancel; each file is written to a temp name and
  renamed into place, so a cancel never destroys an existing destination. See
  [docs/streaming-transfers.md](docs/streaming-transfers.md).
- **Version control — git and Jujutsu (jj)** — open repos into the right-side
  Source Control panel: **live status** (local repos are file-watched;
  remote/WSL refresh on window focus) with **tree decorations** and
  ignored-file dimming, side-by-side **diffs**, **stage / commit / amend**
  (jj: commit / describe / fix-last-message, squash), **branch/bookmark
  switching** with **remote branches** (click to check out), **stash** (git),
  **discard**, **conflict resolution** — inline Accept actions or a full
  **3-way merge editor** — and **fetch / update / push** with a **Cancel** for
  hung auth. **⇣ Fetch & review** opens the history with an **Incoming** block
  (fetched commits per branch, git) offering **Merge / Dismiss**. The
  **History** panel takes the sidebar column: a live **multi-lane commit
  graph** (all local branches), click a commit to browse its files and diffs,
  "Load older commits…", and a pop-out editor tab. A colocated repo's badge
  **click-toggles git ⇄ jj**. Fetch is always safe; anything that mutates the
  tree or publishes asks first (every confirm is silenceable). The VCS binary
  runs *on the host that owns the repo* — no local clone — so commits use the
  host's real identity, config, and hooks (jj is auto-located even when it's
  only in `~/.cargo/bin` on the remote). See
  [docs/version-control.md](docs/version-control.md).
- **Quick-open & search** — `Ctrl+P` fuzzy-opens a file by name;
  `Ctrl+Shift+F` searches file contents (grouped by file) and jumps to the
  line. Both start with a host picker (Local / WSL / Remote / All) and look in
  that host's **pinned folders** — Tab switches between pins, and results
  stream in per pin.
- **Command palette & settings** — `Ctrl+Shift+P` lists every command with its
  keybinding. **Settings** and **Themes** open as editor tabs (⚙ menu): zoom,
  terminal font, per-dialog confirmation checkboxes, click-to-record
  keybindings; save/apply/delete named themes and edit any color via swatch
  cards. Everything round-trips through one hand-editable `settings.json`
  (app config dir) — watched and applied live; `theme.json` holds the saved
  theme library. The stability promises are written down in
  [docs/stability.md](docs/stability.md).
- **Editor** — a tabbed Monaco editor with **up to three split groups** (tab
  context menu or drag a tab to the right edge; drag tabs between groups —
  dirty state, undo history, and content survive). Single-click opens an
  *italic preview* tab; **pin** a tab (⌖ badge, click the icon to unpin) to
  keep it leftmost and spared from bulk closes. Edit and **save** (`Ctrl+S`)
  local *and* remote files with per-tab dirty state and save-conflict
  detection; clean tabs **auto-reload** when the file changes on disk (watch a
  growing log — the view follows the tail). Breadcrumb bar, sticky scroll,
  rendered **Markdown preview** (`Ctrl+Shift+V`), a clickable **LF/CRLF**
  switcher in the status bar (converts the file, undoable), binary-file info
  cards, and a lightweight mode for very large files.
- **Terminals** — multiple, grouped by host; see [Terminal](#terminal) below.
- **Bottom-panel tools** — chips next to the terminal groups open inset tool
  views: **Ports** (listening TCP ports on every monitored host — process,
  PID, address; a Forward button prefills Forwarding; system-port filter and
  per-host toggles), **▣ Containers** (running podman/docker containers on
  every connected host — click to shell inside), **Forwarding** (local port
  forwards over the existing SSH connections, per-forward errors surfaced),
  and **Transfers**. Chips show live counts; polling runs only while a tool is
  open (`panels` in settings.json tunes intervals and visibility).
- **Status bar** — panel toggles (Explorer · Source Control · Terminal) on the
  left; file path, branch, language, encoding, line ending, and cursor
  position on the right.

### Terminal

Real PTYs rendered by xterm.js (WebGL when available, canvas fallback), with
resize, focus-aware `Ctrl+C` (SIGINT), and right-click copy / paste. The
panel's **group bar** shows one chip per connection (L/W/R letter in the host
color + terminal count); each group owns its terminals, the list drag-reorders
and collapses to an icon rail, and **⇱ pops a terminal out into an editor
tab** — the shell keeps running; closing the tab returns it to the panel.

The **+** opens the group's default shell directly; Local's **▾** lists
profiles — **PowerShell 7, Windows PowerShell, Command Prompt, Git Bash, and
each installed WSL distro** — plus the remote and connected-WSL login shells.
A "New opens" preference pins where the palette's new-terminal lands
(`Auto` / `Remote` / `WSL` / `Local`). `Ctrl+Shift+`` opens a new terminal on
the **focused terminal's host**; `Ctrl+PageDown` / `Ctrl+PageUp` cycle the
panel; **Ctrl+Tab** (while a terminal is focused) opens the switcher overlay
listing every terminal grouped by host.

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
| `cargo test --manifest-path src-tauri/Cargo.toml` | Run the Rust unit tests (config parsing, permission formatting, git/jj status parsers, port parsers). |

---

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> | Command palette (all commands) |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | Save the current file |
| <kbd>Ctrl</kbd>+<kbd>P</kbd> | Quick-open a file by name (fuzzy) |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> | Search across files |
| <kbd>F5</kbd> / <kbd>Ctrl</kbd>+<kbd>R</kbd> | Refresh everything (explorer, repos, open files — dirty tabs untouched) |
| <kbd>Ctrl</kbd>+<kbd>Tab</kbd> | Tab switcher overlay — hold Ctrl, tap Tab to walk (editor tabs across all splits; terminals when a terminal is focused) |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> | Markdown preview for the current file |
| <kbd>Ctrl</kbd>+<kbd>=</kbd> / <kbd>Ctrl</kbd>+<kbd>-</kbd> / <kbd>Ctrl</kbd>+<kbd>0</kbd> | Zoom in / out / reset (in a terminal: terminal font size) |
| <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>C</kbd> | Copy path of the explorer selection |
| <kbd>Alt</kbd>+<kbd>Enter</kbd> | Properties of the explorer selection |
| <kbd>Ctrl</kbd>+<kbd>W</kbd> | Close the current tab (pinned tabs are spared) |
| <kbd>Ctrl</kbd>+<kbd>`</kbd> | Toggle the terminal panel |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>`</kbd> | New terminal on the focused terminal's host |
| <kbd>Ctrl</kbd>+<kbd>PageDown</kbd> / <kbd>Ctrl</kbd>+<kbd>PageUp</kbd> | Next / previous panel terminal |
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
keep their shell meaning (SIGINT / flow control) and aren't intercepted;
keybindings are remappable via `settings.json` → `keybindings` (or the
Settings tab's click-to-record).

---

## Architecture

```
Tauri v2 shell (native window, custom title bar)
├── React + Vite frontend (src/)
│   ├── Monaco editor      — tabbed, splittable code editor
│   ├── xterm.js           — terminals (panel + editor tabs)
│   ├── Zustand            — appStore.ts (app) + vcsStore.ts (source control)
│   └── Typed IPC wrappers — lib/ipc.ts
└── Rust backend (src-tauri/src/)
    ├── transport/         — FileTransport trait (list/read/write/rename/remove/copy/move)
    │   ├── mod.rs         — shared types + fs_* commands (incl. fs_find / fs_search,
    │   │                    streaming transfers, Properties)
    │   └── local.rs       — local filesystem (std::fs / tokio::fs)
    ├── exec.rs            — host command-runner (SSH exec channel / local process),
    │                        shared by VCS, the file finder, search, ports, containers
    ├── vcs.rs             — git + jj: status, diff, commit, log, branch, stash, …
    ├── watch.rs           — notify watchers: repo roots (live VC) + open files
    │                        (auto-reload), refcounted
    ├── forward.rs         — local SSH port forwarding (direct-tcpip tunnels)
    ├── ports.rs           — listening-port listing (ss / netstat / PowerShell)
    ├── containers.rs      — podman/docker container listing
    ├── wsl.rs             — WSL: list distros, provision sshd, connect over localhost SSH
    └── ssh/
        ├── connection.rs  — connect, auth, ProxyJump, reconnect, status events
        ├── config.rs      — ~/.ssh/config parser
        ├── sftp.rs        — SFTP as a FileTransport (read + write + copy/move)
        └── pty.rs         — PTY shell: SSH channel, or local ConPTY
```

File operations go through a transport-agnostic `FileTransport` (SFTP for SSH
sessions, `std::fs` for local). **Version control, file finding, search, port
and container listing run the real binary (`git` / `jj` / `find` / `grep` /
`ss` / `podman`) on the host** via the `exec` runner — there is no local
clone, so commits use the host's identity and config. A connection is one SSH
link multiplexed into channels — an SFTP subsystem channel, one session
channel per terminal, an exec channel per command, and a direct-tcpip channel
per forwarded connection — or a local session backed by the filesystem and a
ConPTY shell. PTY output streams to the frontend via Tauri events;
input/resize/close go back through `pty_*`.

**IPC contract.** Rust structs serialize with `camelCase`; the typed wrappers
in `src/lib/ipc.ts` mirror them exactly. Command arguments are written in
camelCase on the JS side and Tauri maps them to the snake_case Rust
parameters. Deeper dive: [docs/architecture.md](docs/architecture.md).

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
- **Version control** runs the host's `git`/`jj`. A colocated repo
  (`.jj` + `.git`) is driven as jj by default — the card's backend badge
  toggles it. Repos are opened explicitly; **local** repos then live-update
  via a filesystem watcher, while **remote/WSL** repos refresh on window
  focus, manual refresh, or F5 (keep **fewer than ~5 eager** for snappy
  updates over SSH). **fetch / update / push** use the host's credentials
  over a no-TTY channel, so an interactive prompt (key passphrase, 2FA, HTTPS
  password) will hang — the Cancel banner is the escape; run those in the
  terminal. On a *remote*, `jj` is probed even in `~/.cargo/bin` (it falls
  back to git if genuinely absent).
- **Multi-remote**: the title/status bars show the primary (first) remote, and
  the Transfers tool pairs with the primary for now — everything else
  (terminals, repos, search scopes, colors) is per-host.
- The Monaco bundle is large (it ships every language). Trimming it to a
  language subset is a deliberate later optimization.

---

## Project layout

```
straylight/
├── src/                    # React frontend
│   ├── components/         # layout, connection, filetree, editor, transfer, vcs,
│   │                       #   settings, Finder / SearchInFiles / TabSwitcher /
│   │                       #   CommandPalette overlays
│   ├── hooks/              # useSSH, useTerminal, useKeyboard
│   ├── lib/                # ipc, monaco, settings, themes, session, commands,
│   │                       #   fileWatch, commitGraph, connectionColor, …
│   ├── store/              # appStore.ts + vcsStore.ts (Zustand)
│   └── theme/, styles/     # theme variables, tokens, fonts, component CSS
├── src-tauri/              # Rust backend
│   ├── src/ssh/            # connection, config, sftp, pty
│   ├── src/exec.rs         # host command-runner (shared)
│   ├── src/vcs.rs          # git + jj source control
│   ├── src/watch.rs        # repo + file watchers
│   ├── src/forward.rs      # port forwarding
│   ├── src/ports.rs        # listening-port listing
│   ├── src/containers.rs   # container listing
│   ├── src/transport/      # FileTransport (mod.rs, local.rs) + fs_* commands
│   ├── src/wsl.rs          # WSL distro discovery + sshd provisioning
│   ├── capabilities/       # Tauri v2 permission capabilities
│   ├── icons/              # generated app icons
│   ├── Cargo.toml
│   └── tauri.conf.json
├── docs/                   # architecture, version control, stability, release plan, …
├── public/fonts/           # Fira Code woff2
└── scripts/fetch-fonts.mjs
```
