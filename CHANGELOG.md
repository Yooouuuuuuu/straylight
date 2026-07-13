# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Planned

- **Tip tooltip rollout** — convert all ~139 native `title=` tooltips to the
  themed Tip component (texts reviewed surface by surface), then walk test
  plan Part H.
- **Revisit where password entry lives** — the current centered connect modal vs.
  an inline field (e.g. on the "Connect to a server" button).
- **Auto-refresh** (optional): a filesystem watch for the local tree; SSH would
  poll (opt-in).
- **Version control, later:** per-hunk staging, blame.
- **Auto-update** — deferred until installers are distributed (needs signing keys
  + hosted releases; the app currently runs from source).
- **Containers, later:** file browsing inside containers, logs, start/stop.
- **Transfer polish (later):** drag directly between the sidebar trees, OS
  drag-in/out, and multi cut/copy/paste in the explorer.
- **Local draft backup of unsaved edits** — survive a connection drop / crash /
  accidental close by caching dirty buffers locally and restoring them on reopen
  (VS Code "hot exit"); doubles as a WSL/remote edit safeguard.
- **WSL session auto-recovery** — re-provision `sshd` if a connected distro's
  daemon dies (WSL file browsing itself now works via auto-provisioned SSH).

## [0.9.2] - 2026-07-13

### Changed

- **New app icon set** — regenerated in every format (window/taskbar `.ico`,
  macOS `.icns`, the MSIX Square/Store logos, and the in-app logo), now with
  the vector source (`straylight-icon.svg`) committed alongside. The unused
  `64x64.png` and the old raster `icon-source.png` were dropped.

## [0.9.1] - 2026-07-13

The first 0.9.x batch out of the test pass (plan Parts A–B: git + jj).

### Added

- **The history panel says which lens it is.** Two-row header: **GIT
  HISTORY / JJ HISTORY** (live — follows the colocated badge toggle) over a
  host-colored repo row (tooltip = full root). The ⧉ pop-out's tab title is
  just "⎇ repo"; the lens shows in a one-line host-colored head inside the
  view ("JJ HISTORY · repo").

### Changed

- **jj is now view-first** (decision from the 0.9 test pass): Straylight
  visualizes jj — status, diffs, decorations, conflicts, live multi-lane
  history — and jj *mutations* are terminal-driven (the watcher updates the
  card/history as you type jj commands). The jj commit box (Commit /
  Describe / Fix last msg), Squash, Rebase, and ↑ push are gone from jj
  cards; what remains: **bookmark switch/create, ↩ discard, ⇣ fetch**. For
  buttons, drive a colocated repo as **git** via the badge toggle. Backend:
  `vcs_describe` / `vcs_squash` removed; `vcs_update`'s jj arm refuses with
  a terminal hint.

### Fixed

- **jj bookmarks were unclickable when they sat on `@` or `@-`.** "Current"
  detection marks the *nearest* bookmark, and the branch menu disabled
  current items — a git-ism (`git switch <current>` is a no-op) that could
  lock **every** bookmark (test plan B-I.5). jj items are never disabled now:
  `jj new <bookmark>` is always a valid move; the ● marking stays.

## [0.9.0] - 2026-07-13

The 0.9 series is the pre-release test pass, run from source (see
docs/release-plan.md): 0.9.0 = the 0.8.15 app + the 2026-07 audit fixes +
the doc/README refresh + the first test-pass UX changes; further findings
land as 0.9.x. Installers arrive at 0.10.

### Added

- **Branch menu: explicit ＋ create button** beside the new-branch/bookmark
  box (Enter still works; disabled while empty).
- **↑ Push on the branch line.** The branch line's buttons are now
  **✎ ↑ ⇣ ⋯**: Push is one click (still confirms), shows the ahead count
  ("↑2"), disables when there's nothing to push, and spins while pushing
  (⇣ spins during a fetch, ⋯ during a rebase). The ⋯ menu now holds only
  Stash & pop (git) / Rebase & squash (jj) and is named accordingly.
- **Refresh all in the Source Control header** (⟳ beside +) — refreshes every
  tracked repo on every host. The per-card refresh button is gone (a running
  refresh still shows its spinner — click to stop waiting — and the card
  stamp reads "updating…" instead of disappearing).
- **Themed tooltips** (first adopted across the Source Control panel):
  drawn above the button instead of at the OS pointer, so a large cursor
  can't cover them, and they follow the app theme.

### Changed

- **Local repo cards show ◉ locked on** — local repos are file-watched, so
  the live-updates toggle is now an always-on indicator there ("changes
  appear by themselves"); it stays a real toggle on WSL/remote cards.

- **Straylight themes: info toasts are green** (`#5ce626`, matching the
  `success` slot) instead of pink-red — success messages no longer read as
  errors. Dracula / Nord / Solarized keep their native cyan/blue info colors.

### Fixed

- **Cancelling a transfer that overwrites no longer deletes the destination.**
  Files now stream to a temporary `.straypart` sibling and are renamed into
  place only when fully written; cancel/error removes only the temp file. A
  failed final flush now reports as an error instead of a completed copy.
- **Concurrent remote VCS ops no longer cancel each other.** Fetch / push /
  update on a repo while another is running is refused (UI toast + backend
  guard) instead of spuriously cancelling the first op and breaking its
  Cancel button.
- **Settings live-reload survives closing a settings.json tab.** File watchers
  are now refcounted per owner, so the open-tab watcher letting go no longer
  tears down the watcher that applies hand-edits to settings.json/theme.json.

## [0.8.15] - 2026-07-09

### Added

- **Git history redesign.** The History panel takes the full explorer column
  (open-in-editor closes it); a **⇣ Fetch & review** button on the SCM panel
  opens it with an **Incoming** block (per-branch, git) offering
  **Merge / Dismiss** — shown at the top of the log tab too; remote branches
  list in the branch menu (click checks out, DWIM); a colocated repo's
  backend badge click-toggles git ⇄ jj; "Load older commits…"; commit detail
  loads on click.
- **Startup connect asks** — `autoConnect.wsl/remote`: ask / always / never.
  On launch a dialog offers the last WSL distro, then the last remote; the
  checkbox upgrades to "always" only on Connect; Skip also cleans the saved
  host so it isn't asked again.
- **Ctrl+Tab switcher**: a centered overlay (1.5x type) listing every editor
  tab across all splits — or, when a terminal is focused, every panel
  terminal grouped by host (group-bar order, then each host's tab order).
  Hold Ctrl, tap Tab to walk, release to land; works inside terminals.
- **Transfers docked** — the two-pane copier is now a tool group in the
  terminal panel (left pane defaults to Local; each host picker hides the
  other side's choice; picks last for the app session). The header ⇄ and the
  popup are gone.
- **Tool view frame**: Ports / Containers / Forwarding / Transfers sit inset
  in a green-outlined box that fuses with the picked chip (one block); wider
  scrollbars inside the box; tool chips carry icons.
- **Explorer host-tools line** under every host bar (host-color wash): pin,
  show-hidden, new file/folder on the left; updated-time + refresh flush
  right. Edit-ssh-config sits beside the remote connect (plug) button;
  connect menus hide already-connected hosts.
- **Download** (WSL/remote context menu) — straight to the Windows Downloads
  folder.
- **Pin badge** — pinned tabs mark the file icon with a ⌖ reticle (click the
  icon to unpin); new `pin` theme color.
- **EOL switcher**: the status bar LF/CRLF is clickable — converts the open
  file (undoable).
- **Root collapse/expand persistence** per host + folder, all hosts.

### Changed

- **Ctrl+Shift+`** opens the new terminal on the *focused terminal's* host,
  and only works while a terminal is focused (the palette command keeps the
  remote → WSL → local fallback).
- Editor tabs: the WSL/remote host stripe moved to the TOP edge — the bottom
  line now only ever means "picked tab".
- Context menus measure their real size and clamp to the screen.

## [0.8.14] - 2026-07-09

### Added

- **Terminal panel, group-bar edition.** A draggable top bar with one chip per
  connection (L/W/R letter in the host color, terminal count only when > 0);
  each group owns its terminals — + opens pwsh directly for Local (▾ for the
  shell menu) and the host's shell elsewhere. The terminal list shows the
  active group only, drag-reorders, and drag-resizes down to an icon-only
  rail; » (pointing down) collapses the panel.
- **Ports** (new tool group): listening TCP ports on monitored hosts — VS
  Code-style table (host in its color, port, address, process, PID), grouped
  by host then port. Backend runs `ss`/`netstat` (unix) or PowerShell
  (local), parsed in Rust with tests. Zero cost while closed; polls every
  `panels.portsInterval` s while open. In-panel controls (persisted to
  settings.json): per-host monitor toggles, the interval, and a
  hide-system-ports filter (<1024 + RDP/SSDP/NFS/mDNS…). Forward on a row
  prefills Forwarding.
- **Forwarding docked** — the port-forward popup now lives as a tool group in
  the panel, covering all remotes.
- **Chip digits**: Ports/Containers chips show one count per connection
  ("Ports - 4 2"), respecting the Ports ignore list; Forwarding shows its
  active count. Nothing shows until a tab has polled.
- **`panels` settings section**: hide any tool group, tune both poll
  intervals (containers default 30 s, was 5), system-port filter, ignored
  hosts.
- **New app icon** (regenerated set + in-app logo).

### Changed

- **Status bar**: left side is just EXPLORER · SC · TERMINAL — uniform
  icon+label buttons; connection state/Reconnect moved out entirely (host
  bars own them); the file path + details sit on the right.
- **Active-tab picked-marks now always use the HOST color** (local = the
  Local section color) — the green/magenta special cases are gone; the
  terminal list's active icon follows the group's color.
- **Remote default colors fixed**: the ramp starts at the Remote section
  color (was Local's red) and assigns by slot — three remotes get magenta /
  orange / chartreuse instead of all red.
- Containers covers all remotes (was primary-only).

## [0.8.13] - 2026-07-08

### Added

- **Settings & Themes as editor tabs** (⚙ menu / palette): Settings — zoom,
  terminal font, per-dialog confirmation checkboxes, and click-to-record
  keybindings; Themes — save/apply/delete library themes and edit every live
  color via swatch cards. All writes go through settings.json (UI, file, and
  hand-edits stay in sync).
- **Config architecture:** settings.json is the ONE user file — behavior keys
  on top, the live color sections at the bottom, kept a complete template
  (missing keys refill at launch; user values win). theme.json is a hidden
  library (`themes`: name → full sections) seeded once with all built-ins;
  quick-theme picks are pure data copies. Legacy/combined files migrate
  automatically.
- **Confirm dialogs got "don't ask again" checkboxes** (exit, unpin, track/
  remove repo, update, push, stash pop, squash, amend-pushed), persisted in
  settings.json `confirms`; applied only on confirm, never on cancel.
- **WSL section redesigned like Remote**: permanent WSL bar (+ swaps distros,
  properly disconnecting the old one); the connected distro is a `user@distro`
  host bar with its own right-click color (persisted per distro).
- **Draggable tabs**: reorder within a strip, drag onto another strip to move
  groups, drag onto the last group's right half (⧉ zone) to split. VC card
  drag-reorder shipped earlier now has company.
- **Breadcrumb bar** under the tab strip (`pin › folder › file`, per pinned
  root) hosting ¶ Preview; **sticky scroll** in the editor (function/block
  headers pin to the top).
- **Exit confirmation** on the window × (Enter closes / Esc stays), silenceable.
- Explorer/Source Control **panel minimize buttons** (« »), status-bar
  Explorer toggle, title-bar ⌘/⚙ spacing, themable title bar
  (`titlebar`/`titlebar-fg`, default #AF011C), pinned tabs show a magenta ⌖.

### Fixed

- **Ctrl+Z after Ctrl+S was dead**: saving triggered our own file watcher,
  whose reload reset Monaco's undo stack. Saves now sync the watcher's guard,
  and external reloads use undo-preserving edits.
- Tab-strip design system: chip tabs (no separators), a grey rail with green
  active-file marks (thicker in the focused group), an on-demand 12px scroll
  lane UNDER the rail (tabs never squeeze), always-visible pink group
  dividers, and stable handle ids for the 3-group overlap.

## [0.8.12] - 2026-07-06

### Added

- **Multi-remote: up to 3 SSH hosts in one window.** The Remote section's +
  attaches additional servers; each gets its own host bar (color, pins,
  hidden-files toggle, refresh stamp, state dot, per-host reconnect and
  disconnect) with its tree below. Terminals, version control, search/quick-
  open scopes, and tab color stripes are all per-host; sessions persist and
  restore every attached remote (key hosts auto-reconnect; the first password
  host gets the pre-filled dialog). The title/status bars show the primary
  (first) remote; transfers pair Local ⇄ the primary for now.

## [0.8.11] - 2026-07-06

### Added

- **Split editors.** Up to 3 side-by-side editor groups: tab context menu →
  Split Right / Move to Left/Right Group (also `Editor: Split Right` in the
  palette). Models are shared across groups, so a moved tab keeps its content,
  undo history, and dirty state. Per-group preview slot, pinned block, Ctrl+Tab
  ring, and bulk-close scope; the focused group carries an accent stripe;
  splits are restored on relaunch.
- **Terminals in the editor area.** ⇱ on a panel terminal moves it into an
  editor tab — the live xterm DOM is reparented, so the shell keeps running
  with scrollback intact. Closing the tab returns the terminal to the panel;
  killing the session (or disconnecting its host) closes the tab.
- **Host identity colors.** Local / WSL / Remote section bars have their own
  theme keys (`section-local/wsl/remote`); a connected remote gets a **host
  bar** (`user@host` + toolbar) under the permanent Remote bar, with a
  right-click color menu. The host's color shows on the host bar, title-bar
  tint, its VC card frames, and WSL/remote file-tab stripes; the native window
  title reads `user@host — Straylight` (taskbar / Alt+Tab). WSL's bar shows
  `user@distro`.
- **L / W / R section toggles** in the Explorer header hide/show each section
  without touching connections (persisted).
- **Draggable VC cards** — drag a card header onto another card to reorder;
  persisted.
- **⌘ Commands moved to the title bar** next to ⚙ (red while settings.json has
  problems); removed from the status bar.
- **New app icon** — full desktop icon set regenerated from the new source
  (`src-tauri/icons/icon-source.png`); used by the window/taskbar/installers
  and in-app (title-bar logo and the empty-editor screen).

### Changed

- Per-repo card colors removed: card frames now always follow the owning
  host's color; tracked-repo indicators in the tree stay green.

## [0.8.10] - 2026-07-06

### Added

- **Straylight is the built-in default theme.** The signature palette
  (`#AF011C` accent) is now what a fresh install boots with; the base CSS is
  `theme/straylight.css` and all built-in fallbacks (UI, editor, terminals,
  Monaco pre-settings theme) use it. "Theme: Straylight (default)" is the
  reset preset; Dracula stays as a normal explicit preset.
- **Solarized Light preset** — the classic light theme, with a light Monaco
  base picked by background luminance and file-icon tints that now reference
  theme palette slots (so light themes stay readable).
- **Per-shell-kind terminal theming.** settings.json now has one full xterm
  section per shell kind — `terminalLocal` (pwsh), `terminalWsl`, and
  `terminalRemote` (SSH) — with no inheritance between them. Presets write all
  three: local = WSL, remote darker (the Dracula preset ships the classic
  black Campbell console for SSH).
- **`terminalFont`** (`{ "family", "size" }`) — terminal font settings, applied
  live with a refit; deliberately never touched by theme presets.
- **Ctrl+= / Ctrl+- / Ctrl+0 in a terminal** now step/reset the terminal font
  size (persisted); outside a terminal they remain whole-app zoom.
- **Per-repo colors.** Tracked repos default to green; right-click a repo card
  in Source Control to pick its color. The card frame, explorer root label,
  repo-root folder, and ⑂ indicator all follow it.
- **Themable folder icons** — new `icon-folder` / `icon-folder-open` color
  keys (per-preset values included).

### Changed

- Explorer sections are ordered Local → WSL → Remote; all hosts share the
  theme accent (per-connection hashing removed); section bars use an accent
  gradient with the new `section-fg` contrast slot; pinned names and folder
  names are plain foreground (new `tree-root` / `tree-dir` keys), with repo
  colors reserved for tracked roots.
- "Edit ~/.ssh/config" moved from the connection panel to the Remote section
  header.
- Catppuccin Mocha preset removed (final theme roster to be decided before
  1.0.0).

## [0.8.9] - 2026-07-05

The 1.0 contracts: one settings file, a command palette, themes, zoom, and
VS Code's tab model. The promises are written down in
[docs/stability.md](docs/stability.md).

### Added

- **`settings.json`** (app config dir) — the one hand-editable preferences
  file, watched and re-applied live on save: `zoom`, `keybindings` (stable
  command id → `"ctrl+alt+f"`-style spec), and the **color sections**
  (`colors` / `editor` / `terminal`) which *are* the theme — every key
  individually editable, missing keys fall back to defaults. Problems never
  fail silently: toast + a warning row in the palette that opens the file.
- **Command palette** — `Ctrl+Shift+P` or the status-bar **⌘ Commands**: every
  command (~30, stable ids) with its effective keybinding; fuzzy search; Enter
  runs. The empty editor screen now shows the core shortcuts.
- **Themes** — a **⚙ appearance menu in the title bar**: Dracula (default),
  **Nord**, **Catppuccin Mocha**. A preset just overwrites the settings.json
  color sections; UI chrome, editor syntax colors, and live terminals restyle
  instantly.
- **Window zoom** — `Ctrl+=` / `Ctrl+-` / `Ctrl+0`, native WebView page-zoom
  (sharp, reflows, terminal/editor refit), persisted.
- **VS Code's tab model** — single-click opens an *italic preview* tab (the
  next single-click replaces it); double-click / editing / "Keep Open"
  promotes. **Pin** a tab (right-click) to keep it leftmost, spared from bulk
  closes and Ctrl+W. Tab **context menu**: Close / Others / to the Right /
  Saved / All / Pin / Copy Path — bulk closes use one "save all & close?"
  dialog. Pinned/preview state survives restarts.
- **New keys** — `Shift+Alt+C` copy path and `Alt+Enter` properties on the
  explorer selection; `Editor: Close All / Close Saved Tabs` in the palette.

### Fixed

- Creating any editor no longer resets the global Monaco theme.

## [0.8.8] - 2026-07-05

Explorer ⇄ Source Control, and ignored files dim.

### Added

- **Ignored-file dimming, VS Code-style.** Ignored files and folders (and
  everything inside an ignored folder) render dimmed in the explorer, with no
  badge, and never appear in the Source Control lists. Works for git repos and
  **colocated jj repos** (read via `git --no-optional-locks status --ignored` —
  guaranteed read-only, so jj can't desync).
- **⑂ on every explorer root.** Pinned folder headers get a source-control
  button: already tracked → reveals the panel (the ⑂ stays purple); untracked →
  a confirm, then it's validated and added like the panel's +.
- **Unpin asks first.** Removing a pinned folder from the sidebar now confirms
  (nothing on disk is touched), like the repo-card ×.

### Fixed

- **jj on Windows emits backslash paths**, which silently broke tree decorations
  for nested files in local jj repos (only top-level files got their M/A
  letters). All jj-parsed paths are now normalized to forward slashes.

## [0.8.7] - 2026-07-05

The backlog run: seven features and a cleanup sweep.

### Added

- **Multi-lane commit graph.** History renders real lanes — branches and merges
  fork and join with per-lane colors, and **all local branches** show without
  checking them out (git logs `--branches HEAD --topo-order`; jj's default
  revset was already multi-head).
- **3-way merge editor.** **⚔** on a conflicted file opens Current | Incoming
  panes (each side fully resolved) over an editable Result seeded with the
  markers — per-conflict Accept lenses, accept-all buttons, and **Complete
  merge** (save + stage) once nothing remains.
- **Containers tab.** **▣ Containers** in the terminal list shows running
  containers (podman preferred, else docker) across every connected host with
  image/ports/status — refreshed only while the tab is open. Click one to land
  in a shell inside it (a visible `… exec -it <id> /bin/sh`).
- **Markdown preview.** **¶ Preview** in the tab bar (or `Ctrl+Shift+V`) renders
  the active `.md` GitHub-style (marked + DOMPurify, bundled); shows unsaved
  edits; links can't navigate the app away.
- **Auto-reload open files.** Clean tabs reload themselves when the file changes
  on disk — local via a per-file watcher (instant log tailing; the view follows
  the tail when pinned to the bottom), remote/WSL via a 3 s mtime poll. Dirty
  tabs are never touched.
- **Remote jj detection.** `jj` is probed per SSH connection (PATH → common
  install dirs → login shell) and cached, so colocated repos on remotes/WSL stop
  silently falling back to git. (Repos opened as git before: remove + re-add.)
- **Remote-op cancel.** Fetch / push / update show a "running — Cancel" banner;
  Cancel kills the SSH channel or local process and frees the repo lock — the
  escape hatch for interactive-auth hangs on the no-TTY channel.
- **Per-connection colors.** Right-click a repo card → swatch row (+ Auto);
  the override persists and wins over the hash color.

### Fixed

- GNU grep exiting 2 on unreadable files no longer discards search results; big
  per-user toolchain dirs (`.cargo`, `.rustup`, `.cache`, …) are excluded from
  search and the finder.

### Internal

- Cleanup sweep: every registered Tauri command is invoked (59/59) and dead
  exports were removed (`ssh_get_status` end-to-end, `deleteEntry`,
  `isImageFile`, `isTerminalAction`).

## [0.8.6] - 2026-07-04

Scoped quick-open & search, and the last of the rework polish — batches 3–4.

### Added

- **Pick where to look, first.** `Ctrl+P` and `Ctrl+Shift+F` open with a host
  picker — `1 Local / 2 WSL / 3 Remote / 4 All`, chosen by number key, ↑↓ +
  Enter, or mouse (last choice remembered) — then show that host's **pinned
  folders as tabs**: `All pins` or one pin, switched with **Tab** or a click.
  Esc always closes. Both tools search pinned folders only.
- **Streaming results.** Every pin indexes/searches independently, with a
  per-pin status line ("straylight: 12 hits · notes: searching…") — one slow
  host can't block or hide the others.
- **Port forwarding polish.** Duplicate local ports are rejected; a failing
  tunnel (e.g. nothing listening on the remote port) turns the forward **red
  with the reason** and raises a toast; bind errors explain Windows'
  reserved-port ranges.
- **Tree roots that fail to list** show "Folder unavailable — may have been
  removed" with a **Retry** button (plus a 10 s timeout backstop) instead of
  loading forever.

### Fixed

- **WSL search ran "forever".** Two causes: search read *through*
  `.cargo` / `.rustup` / `.cache` / `.npm` / `.venv` / `__pycache__` … — those
  are now excluded (the finder skips them too); and GNU grep exits 2 when it
  merely hit an unreadable file *even with matches found* — those results were
  wrongly discarded.
- The native WebView right-click menu (重新整理/列印/檢查) no longer appears;
  text inputs keep native paste, and Monaco/xterm/tree menus are unaffected.

## [0.8.5] - 2026-07-04

Version control goes live-updating, learns to resolve conflicts, and gets a
calmer panel — the post-Phase-3 rework, batches 1–2.

### Added

- **Live status.** Local repos are **file-watched** (`.git`/`.jj` and the working
  tree) — the panel, tree decorations, and history update by themselves after
  terminal git/jj ops or external edits. Remote/WSL repos refresh on **window
  focus**; every repo populates once on startup/reconnect.
- **F5 / Ctrl+R = Refresh All.** Instead of reloading the app (WebView reload is
  now blocked), they refresh every explorer section and repo and reload **clean**
  open file tabs from disk — dirty tabs keep their edits. Ctrl+R still reaches the
  shell in a terminal.
- **Conflict resolution.** Conflicted files show in a red group; opening one
  highlights each conflict and offers **Accept Current / Incoming / Both** inline
  (git-style markers), with **Mark resolved** on the card. A conflicted stash pop
  shows a banner with **Drop stash**.
- **Update replaces Pull.** Fetch is always safe and silent; when behind, a
  contextual **Update** (git: merge upstream) / **Rebase** (jj) appears. Update,
  Rebase, Pop, and **Push** confirm first; amend confirms only when the last
  commit is already pushed.
- **jj parity.** The commit box has modes — git: `Commit | Amend`; jj:
  `Commit | Describe | Fix last msg` — plus **Squash into last** (`jj squash`).
  Amend now also works with staged changes and no message (keeps the message).
- **A calmer repo card.** Header: ⎇ history · ◉ live-update · ⟳ refresh · ×
  unpin (asks first). The branch line carries **✎** (commit box, opens right
  under it) and **⋯** (an actions dropdown: fetch / update / push / stash / pop —
  jj: fetch / rebase / push / squash). Cards are framed in their **connection's
  color**; full identity on hover.
- **History above the explorer.** Its own panel on top of the file tree (the
  editor stays free for comparing), opened/closed by the ⎇ toggle, always in sync
  with the repo — a "syncing…" line shows each live refresh.
- **Copyable toasts** — text is selectable, a copy button, and hovering pauses
  auto-dismiss.

### Fixed

- Native `<select>` dropdowns were white-on-white (dark-styled control, white
  native popup); form controls now follow the dark theme.
- The **Ports** button vanished without a remote/WSL connection — it's always in
  the status bar now.

## [0.8.4] - 2026-06-22

Round out version control, and add quick-open, search, and port forwarding.

### Added

- **Branch / bookmark switching.** Click the branch on a repo card to switch
  (`git switch` / `jj new <bookmark>`) or type a name to create + switch.
- **Amend** the last commit (git), and **stash / pop** (git).
- **Fuzzy file finder (Ctrl+P).** Index files across every pinned folder and
  fuzzy-open one. Local walks the filesystem; remote/WSL use `find`.
- **Search in files (Ctrl+Shift+F).** Literal search across pinned folders, grouped
  by file; click a hit to open the file at that line. Local scans in Rust;
  remote/WSL use `grep`.
- **Port forwarding.** A "Ports" status-bar control forwards a local 127.0.0.1
  port to a `host:port` reachable from the SSH server, over a `direct-tcpip`
  tunnel on the existing connection.

### Internal

- Extracted a reusable `exec` module (the host command-runner shared by VCS, the
  finder, and search).

## [0.8.3] - 2026-06-21

Sync with remotes, browse history, and undo changes.

### Added

- **Fetch / Pull / Push** per repo (jj: `jj git fetch` / `jj git push`). Note: these
  authenticate as the *host's* git identity; an interactive prompt (key passphrase,
  2FA, HTTPS password) will hang the in-app command — run those in the terminal.
- **Browse history.** Click a commit in the history view to expand its changed
  files; click a file to open a diff **for that commit** (commit vs its parent),
  for git and jj.
- **Discard changes** (↩ on a change row) — reverts a file to the last commit
  (git `restore` / jj `restore`) and deletes new/untracked files, behind a confirm.

## [0.8.2] - 2026-06-21

Commit history, and clearer staging.

### Added

- **Commit history.** The **⎇** button on a repo card opens a history panel
  appended to the left of the Source Control cards — a single-lane graph with each
  commit's refs/bookmarks, subject, author, and time — plus a **⧉** button to pop
  it out into a full-width editor tab. Works for git and jj.
- **A `git` / `jj` badge** on every repo card.

### Fixed

- **Staging status was ambiguous.** A file that's staged *and* re-modified now
  shows in **both** Staged and Changes; after `git add .` everything sits under a
  clear "✓ Staged Changes" group (previously a staged `M` was indistinguishable
  from an unstaged `M`).

## [0.8.1] - 2026-06-21

Diff and commit.

### Added

- **Diff viewer.** Click a changed file in Source Control → a read-only Monaco
  side-by-side diff (base — git `HEAD:` / jj `@-` — vs the working copy). Opens as
  a tab; added/untracked → empty old side, deleted → empty new side, renames diff
  against the old path, binaries are skipped.
- **Stage / unstage / commit.** git cards split into **Staged Changes** and
  **Changes** with per-file and "all" actions and a commit-message box (commits the
  staged set). jj uses **describe + commit** (`jj commit`) — no staging. Mutations
  serialize per repo so rapid clicks can't collide on `index.lock`.

## [0.8.0] - 2026-06-21

Phase 3 begins: see your repositories' status — for **git** and **Jujutsu (jj)**.

### Added

- **Source Control panel** (right-side, collapsible). Open a repository explicitly
  (validated as a real repo, else rejected) on any connection — local, WSL, or
  remote. Each repo shows its branch/bookmark, ahead/behind, and changed files,
  with a manual **refresh** and an **eager** toggle for live updates. Repos persist
  per connection identity, so they return on reconnect/relaunch with cached status.
- **File-tree decorations.** Changed files are colored with a status letter
  (M/A/D/R/U…); folders containing changes get a marker.
- **Status-bar branch hint** for the file you're editing.
- **git + jj backends.** VCS commands run on the host that owns the repo (an SSH
  exec channel for remote/WSL, a local process for local) — there's no local clone,
  so commits use the host's real identity, hooks, and config. A colocated repo is
  detected as jj. Design + the jj command spike: `docs/version-control.md`.
- Ignore `.jj/` in `.gitignore`.

### Notes

- This release is **read-only** (status, decorations, branch). Diff, stage/commit,
  and push/pull come next. jj on a *remote* needs `jj` on the exec PATH; detection
  falls back to git otherwise.

## [0.7.2] - 2026-06-20

Transfer files of any size, watch them move, and inspect what you're moving.

### Added

- **Streaming transfers — no size cap.** Cross-connection copies now stream a
  256 KB buffer between transports instead of buffering whole files in memory, so
  the old 512 MB limit (`MAX_TRANSFER_BYTES`) is gone and a multi-GB file copies
  with flat memory use. Design: [streaming-transfers.md](streaming-transfers.md).
- **Live progress + cancel.** A transfer shows a progress bar
  (`file 3/12 · 740 MB / 2.1 GB`) with a Cancel button. Progress is **global** —
  it stays visible in the **status bar** after you close the transfer panel, and
  Cancel rides along with it. Cancelling cleans up the partial file.
- **Properties** (right-click). Name, kind, location, size, contents, modified
  time, permissions, and owner · group for a file, folder, or multi-selection.
  Folder/selection size is computed recursively ("Calculating…"); owner · group is
  shown only where it's meaningful (remote/WSL, not local Windows).

### Changed

- A failed or cancelled transfer best-effort deletes the partial destination file,
  so a interrupted copy never leaves a silently truncated file behind.

## [0.7.1] - 2026-06-19

Target a working directory, not the home root: an in-app folder browser and
pinnable directories for every connection, reused in the transfer tab.

### Added

- **In-app folder browser** for local, WSL, and remote — replaces the OS folder
  dialog so every connection picks directories the same way. Includes a path bar,
  and on Windows a **drive bar** (`C:` `D:` …) to switch disks without typing
  (Linux/remote has a single `/` tree, so none is needed).
- **Pinnable working directories on WSL and remote**, like Local — pin the repos
  you actually work in (shown collapsed); the home dir is pinned automatically on
  connect, and every pin is removable. Pins **persist per connection**
  (`user@host:port` for remote, distro name for WSL) across reconnect and
  relaunch.
- **Spring-loaded folders** in the transfer tab — hover a collapsed folder during
  a drag and it expands after 0.5s, so you can drill in without dropping.

### Changed

- **WSL/remote roots start collapsed** instead of auto-expanding the cluttered
  home dir — you land on a tidy root and expand into your working dir.
- **Transfer tab reuses the pinned dirs** (collapsed, hidden files off) with a
  per-pane hidden-files toggle and a one-off **＋** button to open a folder for
  that panel session only (not pinned or remembered).
- Local "Open folder" now uses the in-app browser, not the Windows dialog.
- In the transfer tab, dropping onto a file copies into its parent folder (no
  dead rows mid-drag).

### Fixed

- **Transfer tab F2/Delete acted on the explorer's selection** — often a
  different host — so Delete could target the wrong machine ("session not open").
  The transfer panel now owns F2/Delete on its own selection while open, and
  pinned root rows are excluded from rename/delete.
- Forbidden drag cursor after a folder expanded mid-drag in the transfer tab.

### Removed

- Unused `tauri-plugin-dialog` and `tauri-plugin-fs` plugins (and their capability
  grants) — file operations go through our own transport commands, and the folder
  dialog is now in-app.

## [0.7.0] - 2026-06-18

Move files between machines, and act on many at once: cross-connection transfers
and multi-select.

### Added

- **Transfers between connections.** Three buttons in the Explorer header open a
  two-pane panel for a pair — **Local ⇄ Remote**, **Local ⇄ WSL**, **WSL ⇄
  Remote**. Drag a file/folder from one pane onto a folder in the other (or use
  copy/paste) to copy it across; folders go recursively, and a name clash prompts
  **Overwrite / Keep both / Cancel**. Each pane is a full file manager
  (right-click: New File/Folder, Copy, Paste, Rename, Delete, Copy Path — **Cut is
  locked**, since transfers are copy-only). Backed by a new `fs_transfer` relay
  over the transport layer (raw `read_bytes`/`write_bytes`). See
  `docs/drag-drop.md`.
- **Multi-select.** **Ctrl+click** toggles a node, **Shift+click** selects a range
  — in both the explorer and the transfer panel. Act on the batch at once:
  **delete** ("Delete N items") and **transfer** (drag or copy/paste many,
  resolving collisions in one prompt). Rename and Copy Path lock while more than
  one item is selected.

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

[Unreleased]: https://github.com/Yooouuuuuuu/straylight/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/Yooouuuuuuu/straylight/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Yooouuuuuuu/straylight/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/Yooouuuuuuu/straylight/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Yooouuuuuuu/straylight/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Yooouuuuuuu/straylight/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Yooouuuuuuu/straylight/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Yooouuuuuuu/straylight/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Yooouuuuuuu/straylight/releases/tag/v0.1.0
