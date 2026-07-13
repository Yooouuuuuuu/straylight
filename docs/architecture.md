# Architecture (as built)

A lightweight, open-source SSH **file manager + terminal + code editor + source
control** built with Tauri v2 (Rust backend) and React (frontend). The VS Code
Remote-SSH experience without the weight: target ~30–50 MB memory, ~10 MB
installer.

This doc describes the system **as it exists** (rewritten 2026-07-13, accurate
through v0.8.15 + the unreleased fixes). Feature-level behavior lives in the
README; per-release detail in CHANGELOG.md; promises in
[stability.md](stability.md); deferred work in [backlog.md](backlog.md).

---

## Shape of the app

One process, one window (multi-window was considered and dropped — instead one
window shows **local folders + one WSL distro + up to three SSH remotes at
once**):

```
┌───────────────────────────────────────────────────────────────┐
│ Title bar (custom): logo · menu (⌘ palette, ⚙ settings/themes) │
├───────────┬──────────────────────────────────┬────────────────┤
│ Sidebar   │ Editor area                      │ VC region      │
│ Explorer  │  up to 3 split groups of tabs    │  Source Control│
│ (or the   │  (file / diff / log / merge /    │  repo cards    │
│  History  │   preview / settings / themes /  │                │
│  panel,   │   terminal tabs)                 │                │
│  full-    ├──────────────────────────────────┤                │
│  column)  │ Bottom panel: terminal groups +  │                │
│           │  tool groups (Ports, Containers, │                │
│           │  Forwarding, Transfers)          │                │
├───────────┴──────────────────────────────────┴────────────────┤
│ Status bar: panel toggles · file path/branch/lang/EOL/cursor  │
└───────────────────────────────────────────────────────────────┘
```

All layout columns are resizable/collapsible (react-resizable-panels) and the
sizes persist. Every UI color comes from CSS custom properties fed by
`settings.json` (see "Settings & themes").

## Tech stack (actual)

- **Backend:** Rust — `tauri` 2 (tray-icon feature), `russh`/`russh-sftp`/
  `russh-keys` (SSH), `portable-pty` (local ConPTY), `notify` (file watching),
  `tokio`, `serde`, `keyring`, `directories`, `uuid`, `base64` (WSL key
  transport). No tauri plugins.
- **Frontend:** React 18 + Vite + TypeScript, Zustand (two stores),
  `monaco-editor`, `@xterm/xterm` (+fit, +webgl), `fuse.js` (fuzzy finder +
  palette), `marked` + `dompurify` (Markdown preview), react-resizable-panels.
- `~/.ssh/config` is parsed by **our own parser** (`ssh/config.rs`) — the
  russh-config crate can only resolve one named host, not enumerate every
  `Host` block.

## Backend modules (src-tauri/src/)

| Module | What it owns |
|---|---|
| `lib.rs` | `AppState` (sessions, ptys, transfers, vcs locks/ops, forwards, watchers, jj paths) + the full `invoke_handler` command list. **Start here to see every command.** |
| `transport/mod.rs` | The `FileTransport` trait (list/stat/read/write/rename/remove/copy/move/create + streamed open_read/open_write) and every `fs_*` command: listing, read/write with conflict detection, find/search, Properties (`fs_measure`), and the **streaming transfer engine** (below). |
| `transport/local.rs` | Local filesystem implementation (tokio::fs; drive listing on Windows). |
| `ssh/connection.rs` | Connect, auth, ProxyJump (first hop), the reconnect supervisor, status events, `direct-tcpip` channels. Host keys are **trust-on-first-use** (`check_server_key` → `Ok(true)`; known_hosts verification is backlog). Auth = key files then password — **no ssh-agent, no passphrase prompt** (backlog). |
| `ssh/config.rs` | `~/.ssh/config` parser (Host/HostName/User/Port/IdentityFile/ProxyJump first hop). |
| `ssh/sftp.rs` | SFTP as a `FileTransport`. One SFTP subsystem channel per connection, serialized by a mutex (a hung op can block `reset_sftp` — backlog). |
| `ssh/pty.rs` | PTY shells: an SSH session channel per remote terminal, ConPTY via portable-pty locally. Output streams to the frontend as `pty-output` events; input/resize/close come back via `pty_*` commands. |
| `exec.rs` | **The host command-runner** (`run_command(state, connId, cwd, argv)`): SSH exec channel or local process, argv-quoted (`shell_quote`), no shell interpolation. Probes and caches an absolute `jj` path per SSH connection (exec shells are non-login; `~/.cargo/bin` is off PATH). Shared by vcs, containers, ports, find/search. |
| `vcs.rs` | All `vcs_*` commands + the git/jj parsers. See [version-control.md](version-control.md). |
| `watch.rs` | `notify` watchers: recursive per-repo (`vcs-fs-change`, 300 ms debounce) and per-file (`file-fs-change`, parent-dir watch, **refcounted per owner** — settings live-reload and an open tab can share one file). |
| `wsl.rs` | WSL distro discovery + one-time sshd provisioning inside the distro (consent-gated; key carried out base64-encoded), then attached as a localhost SSH host. See [wsl-connection.md](wsl-connection.md). |
| `forward.rs` | Local port forwarding: a listener task per forward, `direct-tcpip` channel per accepted connection. |
| `ports.rs` | Listening-port listing: `ss`/`netstat` on unix hosts, PowerShell locally, parsed in Rust (unit-tested). Polled only while the Ports tool is open. |
| `containers.rs` | Running-container listing (podman/docker) via the exec runner; the UI opens exec shells into them. |
| `prefs.rs` | Resolves the settings file path in the app config dir. |

### Sessions and channels

A **session** is one workspace the UI holds a `connId` for: an SSH remote, a
WSL distro (also SSH, to localhost), or the local filesystem. One SSH
connection is multiplexed into channels — an SFTP subsystem channel, a session
channel per terminal, an exec channel per command, a direct-tcpip channel per
forwarded connection. `AppState.transport(connId)` resolves a session to a
`FileTransport` (SFTP or local), so every `fs_*` command is
transport-agnostic.

### Reconnect

A supervisor per SSH connection detects drops and reconnects with exponential
backoff, emitting `ssh-status` events. The frontend keeps tabs/tree/terminals
attached; terminals restart their PTY via an epoch bump when the link returns.
Honest limits (backlog): input typed during an outage is lost (no buffering /
replay), and the host key isn't re-verified on restore.

### Streaming transfers

Cross-connection copies (`fs_transfer_batch`) stream 256 KB chunks reader →
writer with no size cap, emitting `transfer-progress` (global progress bar +
Cancel). Each file streams to a **temporary `<dest>.straypart` sibling and is
renamed over the destination only when fully written** — cancel or error never
destroys a pre-existing destination and never leaves a truncated copy. Design:
[streaming-transfers.md](streaming-transfers.md).

## Frontend (src/)

### State

- `store/appStore.ts` — tabs (kinds: file / diff / log / merge / preview /
  terminal / settings / themes), connections (`localConnId`, `wsl`, `remotes[]`
  with `remote` mirroring the primary), per-connection refresh tokens, editor
  groups/splits, transfers, dialogs, toasts.
- `store/vcsStore.ts` — tracked repos (persisted per connection identity),
  status/decoration state, history, per-repo `remoteBusy` (one remote op at a
  time), monotonic tokens that discard stale async results.

### IPC contract

Rust structs serialize **camelCase**; `lib/ipc.ts` mirrors every command and
event payload 1:1 (typed wrappers around `invoke`). JS argument names are
camelCase; Tauri maps them onto snake_case Rust parameters. Backend → frontend
events: `pty-output`, `ssh-status`, `transfer-progress`, `vcs-fs-change`,
`file-fs-change`, `port-forward-error`.

### Settings & themes

One hand-editable **`settings.json`** in the app config dir (behavior keys on
top; the full color sections at the bottom — the file *is* the theme), plus a
non-user-facing `theme.json` holding the saved-themes library. Both are watched
(via the refcounted file watcher) and live-applied; UI edits go through
`updateSettings()` which writes and re-applies directly. Missing keys are
refilled from the template at launch; user values always win; parse errors
surface as a toast + a palette warning row. The contract is written down in
[stability.md](stability.md).

### Session restore

Layout sizes, pinned folders, open tabs (by path — **unsaved content is not
cached**; local "hot exit" is the top data-safety backlog item), the active
tab, tracked repos, and the last WSL/remote host live in localStorage.
Reconnectable hosts restore their tabs when the connection comes back
(`autoConnect.wsl/remote`: ask / always / never).

### Auto-reload / tailing

Clean (non-dirty) file tabs follow external changes: local files via the
per-file watcher (instant log tailing — the view follows the tail if it was at
the bottom), remote/WSL via a 3 s mtime poll. Dirty tabs are never touched;
saving checks the on-disk mtime and runs the save-conflict flow instead.

### Bottom panel (terminals + tools)

The panel's top bar is a **group bar**: one draggable chip per connection
(L/W/R letter in the host color + terminal count) plus tool chips. Each
connection group owns its terminals (+ opens the host's shell; Local's ▾
offers pwsh / PowerShell 5.1 / cmd / Git Bash / each WSL distro). The terminal
list on the right drag-reorders and collapses to an icon rail. Tool groups —
**Ports** (listening-port table), **Containers**, **Forwarding** (docked port
forwards), **Transfers** (two-pane copier) — render inside an outlined tool
frame fused with the picked chip. Polling only runs while a tool is open;
intervals and per-tool visibility live under `panels` in settings.json.
Terminals can pop out into editor tabs (⇱) and return on close **without
restarting the shell**.

### Host identity

Every connection gets a stable color (hash-based ramp, per-host right-click
override, persisted): section bars, host bars, tab stripes, VC card frames,
terminal chips, and the title-bar tint all follow it.

## Resolved decisions (as they actually stand)

- **Run the real binary on the host** for VCS / find / grep / containers /
  ports — no local clone, no reimplementation; output parsed only in stable
  machine formats. ([version-control.md](version-control.md))
- **No ssh-agent.** Key files from `IdentityFile` / `~/.ssh/id_*` (unencrypted
  only) or password, held in memory. Passphrase prompting and known_hosts are
  backlog; TOFU until then.
- **One window, many hosts** (local + WSL + up to 3 remotes) instead of
  one-window-per-host.
- **Settings-as-theme:** no separate theme files; presets just fill the
  settings.json color sections.
- **No plugin API, no LSP, no DAP** — see [stability.md](stability.md)
  ("deliberately absent").
- **No automatic timeouts** on VCS/remote ops — a running indicator + manual
  Cancel; the user decides.
- **Working docs live in `docs/dev/`** (gitignored): session handoffs and the
  manual test plan (`phase3-test-plan.md`) — session material, not design docs.

## Platforms

Windows 10/11 first (WebView2; ConPTY; WSL integration). The Unix code paths
(PTY via `$SHELL`, local transport, `#[cfg]`-gated WSL module) exist but Linux
is untested/unpackaged — see [release-plan.md](release-plan.md). macOS/iOS:
parked (release-plan "Platform notes").
