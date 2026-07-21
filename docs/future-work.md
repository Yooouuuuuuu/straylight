# Future work

The prioritized pool of "might do later" — everything *not* on the committed
release path (a maintainer working doc, unpublished). Tiers are rough
priority/order, not commitments. What already shipped is in CHANGELOG.md; the
rationale for what exists is in the [design docs](README.md).

---

## Parked
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
