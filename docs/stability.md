# Stability at 1.0

What Straylight promises not to break after 1.0.0 — and, just as deliberately,
what it does **not** promise. Additions are always fine; renames and removals of
anything below are breaking changes.

## Stable (the contracts)

- **Command ids and titles.** Every palette command's id (e.g. `search.inFiles`)
  and its `Area: Action` title. Keybinding overrides reference the ids.
- **Default keybindings.** The shipped defaults follow OS / VS Code conventions
  and stay put; muscle memory is the point.
- **`settings.json`** (app config dir) — THE hand-editable file, watched,
  live-applied, kept a complete template (missing keys are refilled with
  defaults at launch; your values always win). Behavior on top:
  - `zoom` (number 0.5–3)
  - `keybindings` (command id → `"ctrl+shift+f"`-style spec; single-stroke,
    no chords)
  - `terminalFont` (`{ "family": "Fira Code", "size": 13 }`, size 6–40) —
    never touched by theme picks.
  - `confirms` — ask-dialog flags (`{ "exit": false }` silences one). Every
    "don't ask again" checkbox writes here; set a key back to `true` to get
    the dialog back.
  - `autoConnect` — `{ "wsl": "ask" | "always" | "never", "remote": … }` —
    the startup reconnect-to-last-host behavior.
  - `drafts` — `{ "enabled": true }` — hot-exit caching of unsaved edits
    (off = nothing is cached; today's behavior).
  - `restore` — `{ "openFiles": "ask" | "always" }` — whether cached drafts
    load back into reopened files on launch.
  - `panels` — bottom-panel tool groups: per-tool visibility
    (`"ports": false` hides the chip), the two poll intervals (seconds,
    3–3600), the system-port filter, and ignored hosts.
  Live theme sections at the bottom (a quick-theme pick copies a library
  entry over them — pure data):
  - `colors` / `editor` — the full UI and Monaco color token sections. Key
    names mirror the CSS custom properties and Monaco token groups.
  - `terminalLocal` / `terminalWsl` / `terminalRemote` — one full xterm
    ITheme section per shell kind (pwsh / WSL / SSH), no inheritance.
- **The theme library** lives in a non-user-facing `theme.json` next to it
  (`themes`: name → full sections), seeded once with every built-in theme and
  managed via ⚙ → Manage themes (save current / apply / delete — deletions
  are permanent, built-ins included).
- Problems never fail silently: parse errors and invalid entries surface as a
  toast and a warning row in the command palette.
- **VCS semantics.** Straylight runs **your real `git` / `jj` on the host that
  owns the repo** — hooks, config, identity, signing behave exactly as in your
  terminal. There is no re-implementation to drift.
- **`~/.ssh/config` reading.** Standard OpenSSH host definitions (Host,
  HostName, User, Port, IdentityFile, ProxyJump first hop).
- **Search-in-files is literal** (fixed-string, case-sensitive), not regex.
  The in-editor find widget is Monaco's and supports its usual regex.
- **No repo pollution.** Straylight writes no *persistent* files into your
  repositories or working directories. The only files it ever places there are
  **transient staging temps** — `.straysave` while saving a file, `.straypart`
  while transferring one — removed on success and kept only when the operation
  fails (a kept temp is then *your* unsaved data, preserved for recovery).
- **Saving never tears a file.** A remote save stages, then commits in place
  (never a rename), so an interrupted save can't leave a half-written file and
  can't change the file's inode/ownership/links; and unsaved edits are cached
  locally so a crash can't lose them. The draft/staging *format and location*
  are internal (see below).
- **Editor behavior.** The editor is Monaco — VS Code's editor component —
  so indentation, multi-cursor, word boundaries, and find behavior are that
  component's, stable by construction.

## Internal (may change between any versions)

- localStorage state (session restore, tracked repos, pinned folders, colors
  cache, layout sizes) — migrated best-effort on upgrade, format unspecified.
- The data-safety cache — hot-exit draft files, pending-save records, and
  clean-tab stubs (location + format unspecified; cleared best-effort and via
  Settings → Drafts).
- The Dracula/Nord/Catppuccin preset values, UI layout, styling, and CSS class
  names.
- All Rust/TS internals, IPC command signatures, and event names.

## Deliberately absent (not promised, by design)

- **No plugin / extension API** — nothing external can build on internals.
- **No workspace files** in your projects, no snippets format, no user theme
  *files* (themes are the settings.json color sections).
- **No CLI flags** beyond launching the executable.
- **No LSP, no DAP** — language intelligence may arrive post-1.0 (LSP, opt-in,
  running on the host); debugging stays in the terminal.
- **No auto-update** until installers are distributed.
