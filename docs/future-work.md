# Future work

The pool of "might do later" — everything *not* on the committed release path
(a maintainer working doc, unpublished). Rough priority, not commitments. What
already shipped is in CHANGELOG.md; the rationale for what exists is in the
[design docs](README.md).

---
- **CPU-incident plan B (2026-09-30)** — deferred deliberately, each trades
  behavior for speed. 0.16.3 shipped the zero-cost half (pinned-root guard,
  no-op ◉ polls free, self-describing diag); these remain if a report from
  the field says the workload is still too heavy:
  - *◉ polls without `--ignored`* — fetch the ignored set only on first load
    and explicit refresh; polls run plain status. Removes ~95 % of the poll
    payload on repos with pattern-ignored datasets (thousands of `!` records
    per poll). Cost: dimming of newly ignored files lags until a full status,
    and a file the poll reports as untracked must override a cached
    "ignored" mark or it stays dimmed after being un-ignored.
  - *Adaptive ◉ interval* — 5 s while a repo changes, slowing toward 30 s
    when it doesn't. Shrinks every poll workload, survives the next
    unexpected huge repo. Cost: an idle repo's change shows up in up to 30 s.
  - *Structural status compare* instead of the double `JSON.stringify`.
    Cost: a missed field means a stale card with no error — the shape is
    small (ref, ahead/behind, oid; per change: path, old path, kind, staged)
    but must be enumerated exactly.
  - *Memoize `RootTree` + narrow the sidebar's `remotes` subscription* so a
    "last refreshed" stamp can't re-render every tree. Cost: the classic
    memo stale-UI class; keep the memo on primitives only and test a pass.
  - *Native browser-accelerator switch* (WebView2 `AreBrowserAcceleratorKeys
    Enabled = false` via `with_webview` + `webview2-com`, release builds only)
    — stops a starved UI thread from leaking Ctrl+Shift+P into the browser's
    print dialog ("列印失敗"). Defense in depth once the starvation itself is
    fixed. Cost: any browser key we forgot to own goes dead instead of falling
    back; dev/release behavior differs (dev keeps DevTools); pins us to
    wry's `webview2-com` version across Tauri upgrades.
- **API client / Bruno-adjacent** (research first) — no Postman/Bruno clone. The
  differentiating candidate: a `.http` runner executed via curl on the host that
  owns the file, so requests originate inside the server's network. Post-1.0.
- **Run current file/command** — full debugging (DAP) is out of scope (debug in
  the terminal). The only candidate is a light "run this on the right host"
  that opens a terminal and types it. Only if it stays that light.
- **Non-UTF-8 files** (GBK, Shift-JIS, Big5, …) — today they open read-only
  with `�` replacements (saving is blocked so the original bytes can't be
  destroyed). If they turn out to be common in practice, add encoding
  detection and show the file read-only in its detected charset; editing and
  saving non-UTF-8 can follow on demand, case by case, as real files surface.
- **Soft-restore for session-lane terminals** — when a CHAT agent's session
  lane drops, keep its terminal + scrollback alive across the reconnect instead
  of remounting (which discards both), plus a one-click "Resume Claude"
  (`claude --continue`). Parked: drops are rare now, and the cwd restore it
  needs only works where the shell emits OSC 7.
- **Persistent sessions (tmux-backed)** — an explicit, opt-in persistent
  session that runs one terminal inside a Straylight-managed tmux so it
  survives drops and app restarts. Never auto-wraps normal terminals (want
  tmux? run tmux). May be unnecessary now that `claude --continue` recovers an
  agent from any fresh shell.
- **Linux version** — a full port pass, before macOS. First job: runtime-test
  the terminals (real Unix PTYs, a codepath never yet executed), then packaging.
- **macOS / iOS** — macOS needs the paid Apple account for notarization; iOS is
  a remote-only re-architecture. Post-1.0 (see release-plan platform notes).
- **Non-US-keyboard backtick chords** — on dead-key layouts (French, German…)
  `` Ctrl+` `` is permanently untypable. Rebindable in Preferences today; the
  real fix is matching the physical key position.

