# Stability at 1.0

What Straylight promises not to break after 1.0.0 — and, just as deliberately,
what it does **not** promise. Additions are always fine; renames and removals of
anything below are breaking changes.

## Stable (the contracts)

- **Command ids and titles.** Every palette command's id (e.g. `search.inFiles`)
  and its `Area: Action` title. Keybinding overrides reference the ids.
- **Default keybindings.** The shipped defaults follow OS / VS Code conventions
  and stay put; muscle memory is the point.
- **`settings.json`** (app config dir) — the only hand-editable file:
  - `zoom` (number 0.5–3)
  - `keybindings` (command id → `"ctrl+shift+f"`-style spec; single-stroke, no
    chords)
  - `colors` / `editor` / `terminal` — the full color token sections. The key
    names are stable; they mirror the CSS custom properties, Monaco token
    groups, and xterm's ITheme names. Missing keys fall back to the built-in
    (Dracula) defaults; theme presets just overwrite these sections.
  - Problems never fail silently: parse errors and invalid entries surface as a
    toast and a warning row in the command palette.
- **VCS semantics.** Straylight runs **your real `git` / `jj` on the host that
  owns the repo** — hooks, config, identity, signing behave exactly as in your
  terminal. There is no re-implementation to drift.
- **`~/.ssh/config` reading.** Standard OpenSSH host definitions (Host,
  HostName, User, Port, IdentityFile, ProxyJump first hop).
- **Search-in-files is literal** (fixed-string, case-sensitive), not regex.
  The in-editor find widget is Monaco's and supports its usual regex.
- **No repo pollution.** Straylight never writes its own files into your
  repositories or working directories.
- **Editor behavior.** The editor is Monaco — VS Code's editor component —
  so indentation, multi-cursor, word boundaries, and find behavior are that
  component's, stable by construction.

## Internal (may change between any versions)

- localStorage state (session restore, tracked repos, pinned folders, colors
  cache, layout sizes) — migrated best-effort on upgrade, format unspecified.
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
