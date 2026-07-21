# Architecture (as built)

A lightweight, open-source SSH **file manager + terminal + code editor + source
control** built with Tauri v2 (Rust backend) and React (frontend). The VS Code
Remote-SSH experience without the weight: target ~30–50 MB memory, ~10 MB
installer.

This describes the system **as it exists** (current through 0.9.5). Feature
behavior lives in the README; per-release history in CHANGELOG.md; promises in
[stability.md](stability.md); deferred work in [future-work.md](future-work.md);
the docs map + design ledger in [README.md](README.md).

---

## Shape of the app

One process, one window. Multi-window was considered and dropped — instead one
window shows **local folders + up to three WSL distros + up to three SSH
remotes at once** (1 + 3 + 3):

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
│ Status bar: panel toggles · path/branch/lang/EOL/cursor · dots │
└───────────────────────────────────────────────────────────────┘
```

All layout columns are resizable/collapsible (react-resizable-panels) and the
sizes persist. Every UI color comes from CSS custom properties fed by
`settings.json` (see "Settings & themes").

## Tech stack

- **Backend:** Rust — `tauri` 2 (tray-icon feature), `russh`/`russh-sftp`/
  `russh-keys` (SSH; `zlib@openssh.com` compression preferred), `portable-pty`
  (local ConPTY), `notify` (file watching), `tokio`, `serde`, `keyring`,
  `directories`, `uuid`, `base64` (WSL key transport). No tauri plugins.
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
| `transport/mod.rs` | The `FileTransport` trait (list/stat/read/write/rename/remove/copy/move/create + streamed open_read/open_write) and every `fs_*` command: listing, read/write with conflict detection and UTF-8 checks, find/search, Properties (`fs_measure`), and the **streaming transfer engine** ([transfers.md](transfers.md)). |
| `transport/local.rs` | Local filesystem implementation (tokio::fs; drive listing on Windows). |
| `save.rs` | `save_commit` — the detached, hash-guarded server-side commit step of a **staged remote save** ([data-safety.md](data-safety.md)). |
| `ssh/connection.rs` | Connect, auth, ProxyJump (first hop), the reconnect supervisor (retries indefinitely, 30 s backoff cap), status events, `direct-tcpip` channels, compression preference. Host keys verify against `~/.ssh/known_hosts` (fingerprint prompt on first contact, refuse on a changed key, loopback/WSL skipped); auth = key files (passphrase-prompted if encrypted) then password — no ssh-agent yet (backlog). |
| `ssh/config.rs` | `~/.ssh/config` parser (Host/HostName/User/Port/IdentityFile/ProxyJump first hop). |
| `ssh/sftp.rs` | SFTP as a `FileTransport`. One SFTP subsystem channel per connection, serialized by a mutex. |
| `ssh/pty.rs` | PTY shells: an SSH session channel per remote terminal, ConPTY via portable-pty locally. Output streams as `pty-output` events; input/resize/close come back via `pty_*` commands. |
| `exec.rs` | **The host command-runner** (`run_command(state, connId, cwd, argv)`): SSH exec channel or local process, argv-quoted (`shell_quote`), no shell interpolation. Probes and caches an absolute `jj` path per SSH connection. Shared by vcs, save-commit, containers, ports, find/search. |
| `vcs.rs` | All `vcs_*` commands + the git/jj parsers. See [version-control.md](version-control.md). |
| `watch.rs` | `notify` watchers: recursive per-repo (`vcs-fs-change`, 300 ms debounce) and per-file (`file-fs-change`, parent-dir watch, **refcounted per owner** — settings live-reload and an open tab can share one file). |
| `wsl.rs` | WSL distro discovery + one-time `sshd` provisioning inside a distro (consent-gated; key carried out base64-encoded), then attached as a localhost SSH host. See [wsl-connection.md](wsl-connection.md). |
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
`FileTransport` (SFTP or local), so every `fs_*` command is transport-agnostic.
Because saves and VCS run over that same multiplexed connection (SFTP for
files, an exec channel for commands, side by side), the staged-save commit
needs no new transport — just the existing exec runner.

### Reconnect

A supervisor per SSH connection detects drops and reconnects with exponential
backoff (capped at 30 s), **retrying indefinitely** until it recovers or the
user explicitly disconnects — matching the house rule of no automatic timeouts.
It emits `ssh-status` events; the frontend keeps tabs/tree/terminals attached
and restarts each terminal's PTY via an epoch bump when the link returns. On
reconnect it also reopens pinned + drafted files and reconciles any pending
staged saves (see below); the host key re-verifies on both reconnect and
session restore, so a swapped server is refused. Honest limit (backlog): input
typed during an outage is lost (no buffering/replay).

### Saving

Local files are written directly. **Remote/WSL files use a staged save**: the
buffer uploads to a `.straysave` temp, then a detached, hash-guarded `cp`
commit swaps it into the target's inode and verifies it — a dropped connection
can't tear the file, and ownership/symlinks/hard links survive. Ctrl+S returns
at dispatch; the commit confirms in the background and reconciles on reconnect.
Full design (plus **hot-exit drafts** and the conflict bar):
[data-safety.md](data-safety.md).

### Streaming transfers

Cross-connection copies (`fs_transfer_batch`) stream 256 KB chunks reader →
writer with no size cap, emitting `transfer-progress`. Each file streams to a
temporary `.straypart` sibling and is renamed over the destination only when
fully written; symlinked directories are skipped (a link cycle would loop).
Design: [transfers.md](transfers.md).

## Frontend (src/)

### State

- `store/appStore.ts` — tabs (kinds: file / diff / log / merge / preview /
  terminal / settings / themes), connections (`localConnId`, `wsls[]`,
  `remotes[]` with legacy mirrors of the first of each), per-connection refresh
  tokens, editor groups/splits, transfers, dialogs, toasts. A tab carries its
  own `dirty`, `conflict`, and hot-exit draft flags.
- `store/vcsStore.ts` — tracked repos (persisted per connection identity),
  status/decoration state, history, per-repo `remoteBusy`, monotonic tokens
  that discard stale async results.

### IPC contract

Rust structs serialize **camelCase**; `lib/ipc.ts` mirrors every command and
event payload 1:1 (typed wrappers around `invoke`). JS argument names are
camelCase; Tauri maps them onto snake_case Rust parameters. Backend → frontend
events: `pty-output`, `ssh-status`, `transfer-progress`, `vcs-fs-change`,
`file-fs-change`, `port-forward-error`. (Staged-save acknowledgement uses
marker files polled over SFTP, not an event.)

### Key frontend libs

- `lib/saveFile.ts` — the save choke point (local direct vs remote staged) and
  the conflict-bar resolution actions; blocks Ctrl+S on a conflicted tab.
- `lib/stagedSave.ts` — the staged-save driver: per-file commit queue, hash
  guard, background ack, and reconcile. `lib/hash.ts` — WebCrypto SHA-256.
- `lib/drafts.ts` — hot-exit drafts (debounced local writes, restore, cleanup).
- `lib/pinnedTabs.ts` — per-host pinned files (reopen on every connect).
- `lib/session.ts` — session restore (below). `lib/fileWatch.ts` — clean-tab
  auto-reload (skips files with a pending save). `lib/settings.ts` —
  settings.json load/apply/watch. See [data-safety.md](data-safety.md) for how
  drafts/saves/pins interact.

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

Layout sizes, pinned folders, open tabs (by path per host — local / `wsl:<distro>`
/ `user@host:port`), the active tab, tracked repos, and the last WSL/remote
hosts live in localStorage. Reconnectable hosts restore their tabs when the
connection comes back (`autoConnect.wsl/remote`: ask / always / never). Unsaved
buffer *content* is not in the session file — it is covered separately by
hot-exit **drafts**; pinned and drafted files reopen on every connect.

### Auto-reload / tailing

Clean (non-dirty) file tabs follow external changes: local files via the
per-file watcher (instant log tailing), remote/WSL via a 3 s mtime poll. Dirty
tabs are never touched; a file with a pending staged save is skipped so its own
commit doesn't trigger a reload.

### Bottom panel (terminals + tools)

The panel's top bar is a **group bar**: one draggable chip per connection
(L/W/R letter in the host color + terminal count) plus tool chips. Each
connection group owns its terminals. Tool groups — **Ports**, **Containers**,
**Forwarding** (docked port forwards), **Transfers** (two-pane copier) — render
inside an outlined tool frame. Polling only runs while a tool is open;
intervals and per-tool visibility live under `panels` in settings.json.
Terminals can pop out into editor tabs (⇱) and return on close without
restarting the shell.

### Host identity

Every connection gets a stable color (hash-based ramp, per-host right-click
override, persisted): section bars, host bars, tab stripes, VC card frames,
terminal chips, and the title-bar tint all follow it.

## Resolved decisions (see the [ledger](README.md#design-decision-ledger))

- **Run the real binary on the host** for VCS / find / grep / containers /
  ports / the save-commit — no local clone, no reimplementation; output parsed
  only in stable machine formats.
- **No ssh-agent** (backlog). Key files from `IdentityFile` / `~/.ssh/id_*`
  (passphrase-prompted if encrypted) or password, held in memory. Host identity
  verifies against `known_hosts` — fingerprint prompt on first contact, refuse
  on a changed key.
- **One window, many hosts** (local + up to 3 WSL + up to 3 remotes).
- **Settings-as-theme:** no separate theme files; presets fill the settings.json
  color sections.
- **No automatic timeouts** on VCS/remote/save ops — a running indicator or a
  background reconcile; the user decides.
- **No remote agent.** SSH provides files/terminal/transfer/exec; a resident
  helper is rejected until remote-watching or LSP justify an opt-in one.
- **No plugin API, no LSP, no DAP** — see [stability.md](stability.md).
- **Working docs live in `docs/dev/`** (gitignored): session handoffs and the
  manual test plans.

## Platforms

Windows 10/11 first (WebView2; ConPTY; WSL integration). The Unix code paths
(PTY via `$SHELL`, local transport, `#[cfg]`-gated WSL module) exist but Linux
is untested/unpackaged — a Linux version is parked in
[future-work.md](future-work.md), ahead of macOS/iOS.
