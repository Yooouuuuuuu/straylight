# Future work

The prioritized pool of "might do later" — everything *not* on the committed
release path (a maintainer working doc, unpublished). Tiers are rough
priority/order, not commitments. What already shipped is in CHANGELOG.md; the
rationale for what exists is in the [design docs](README.md).

---

## Later
- **Richer editor right-click menu** — the file editor shares the simple
  six-entry text menu (Undo/Redo/Cut/Copy/Paste/Select All) for now. Grow it
  toward VS Code's: Go to Definition/References, Change All Occurrences,
  Format Document, Command Palette… (the Monaco actions already exist — this
  is menu wiring and ordering in `TextContextMenu`).

## Parked
- **Soft-restore for session-lane terminals** — when a CHAT agent's session
  lane (`::session-<k>`) really drops, keep its xterm + scrollback alive
  instead of the current remount (which discards both). Mechanism, all
  frontend (backend needs nothing — a lane death already reaches the terminal
  as the same empty "PTY closed" chunk a shell exit does, and session lanes
  already run their own reconnect supervisor): decouple restart from remount
  by dropping `epoch` from the `<Terminal>` key and splitting `useTerminal`
  into an xterm-lifecycle effect (stable) and a PTY-lifecycle effect (re-runs
  on reconnect); on drop write a dim `──── connection lost ────` divider, on
  reconnect write `──── reconnected ────` and reopen the PTY in place below
  it. Resume layer: track cwd from **OSC 7** while the shell emits it (the
  last one before `claude` launched is the project dir — the shell is blocked
  during claude, so it never gets overwritten), `cd` there on reconnect, and
  offer a one-click "Resume Claude" that types `claude --continue` (resumes
  per-cwd, hence the cwd restore). Session-lane only — general main-lane
  terminals keep the plain restart. Parked because drops are now rare and the
  resume only fully works where the host shell emits OSC 7 (default remote
  bash/pwsh usually don't), so it degrades to `$HOME` + button there. Written
  down so the mechanism isn't re-derived if we want it later.
- **Persistent sessions button (tmux-backed)** — a dedicated "＋ persistent
  session" in SESSIONS/F11: that one terminal — and only that one — runs
  inside a Straylight-managed tmux (`-L straylight`, `-f /dev/null`, prefix
  None, status off, no-alt-screen, `capture-pane` replay on reattach), wears a
  badge, reattaches across drops and app restarts, and is killed on explicit
  tab close (leftovers surfaced on connect: reattach/kill). It survives the one
  thing SSH physics can't give a plain shell. If tmux isn't on the host, the
  button says so — no auto-install, no wrapping of normal terminals, ever.
  Explicit and per-terminal by design: normal terminals stay a pure mirror of
  ssh (want tmux? run tmux), and this exists only for sessions that must
  outlive the link. Might never be needed now that drops are rare and
  `claude --continue` recovers an agent conversation from any fresh shell —
  written down so the thinking isn't lost.
- **Linux version** — a full port pass, before macOS. First job when it starts:
  runtime-test the terminals (real Unix PTYs there, not ConPTY — a codepath
  that has never been executed); then packaging/bundle checks.
- **macOS / iOS** — macOS needs the paid Apple account for notarization; iOS is a
  remote-only re-architecture. Post-1.0 (see release-plan Platform notes).
- **Non-US-keyboard backtick chords** — on dead-key layouts (French, German…)
  `Ctrl+`` is permanently untypable, not flaky. Rebindable in Preferences
  today; the real fix is matching the physical key position.
- **Run tasks / "debug run"** (not committed to). Full debugging (DAP) is out of
  scope — debug in the real terminal. The only candidate is a light "run current
  file / command" that opens a terminal on the right host and types it (the
  Containers-tab `initialInput` mechanism). Do it only if it stays this light.
- **API client / Bruno-adjacent** (research first). No Postman/Bruno clone.
  Evaluate the Bruno app + VS Code extension first. The differentiating
  candidate: a `.http` runner executed **via curl on the host that owns the
  file** (requests originate inside the server's network — reaches
  localhost/internal DNS a desktop client can't). Post-1.0.
