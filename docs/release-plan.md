# Release plan — 0.9 test → 0.10 package → 1.0 public (Windows first)

The road from "runs from source" to "anyone on Windows can install it."
Decided 2026-07-09 (versions revised 2026-07-13): **Windows 10/11 only** for
now, **unsigned**, **no paid services**. Linux comes after Windows ships;
iOS/mobile is a separate post-1.0 discussion (remote-only rework).

## Phases

### Phase 1 — 0.9.x: test & fix, from source (current)

Run entirely from source (`npm run tauri dev`); every fix batch ships as a
**0.9.x** point release. Exit criteria: a clean manual test pass on the latest
0.9.x.

**Status (0.9.5):** 0.9.0 cut the audit-fixed app + the doc refresh; 0.9.1–0.9.5
then added jj view-first, the ◉ monitor, multi-WSL (1 + 3 + 3), and the
data-safety pass — staged remote saves, hot-exit drafts, and the conflict bar
([data-safety.md](data-safety.md)). `cargo test` (25/25) and `tsc` are clean.
**Now testing:** the data-safety plan (`docs/dev/data-safety-test-plan.md`)
plus the standing manual plan (`docs/dev/phase3-test-plan.md`, Parts A–G).

Point releases carry features freely — no feature gates the phase; the gate is
the test pass.

### Phase 2 — 0.10.0: package + self-install

Build on the dev PC (needs the Rust toolchain):

```bash
npm run tauri build
```

Installers land in `src-tauri/target/release/bundle/`:

- `nsis/Straylight_<version>_x64-setup.exe` — **the one to ship.** Per-user
  install: no admin rights, no UAC prompt.
- `msi/…​.msi` — WiX build, produced too; not the primary artifact.

Bundle config (already in `tauri.conf.json`): WebView2 `embedBootstrapper`
(installer carries the bootstrapper, so a machine without WebView2 still
installs — Win 11 and updated Win 10 already have it) and NSIS
`installMode: currentUser`.

Then install it on the second PC (no dev tools — a realistic end-user
machine) and walk the checklist:

- [ ] Download the setup.exe → SmartScreen shows "Windows protected your PC"
      **once** → More info → Run anyway → installs without admin prompt.
- [ ] App launches; window, theme, and Fira Code fonts correct (fonts are
      bundled, not fetched).
- [ ] **Measure and confirm the README's headline figures** on a **release**
      build (not `tauri dev`): idle RAM (README says ~30–50 MB) and the NSIS
      `setup.exe` size (README says ~10 MB). Replace the README numbers with
      the measured ones, or adjust the claim. Until this runs, treat both as
      **targets**, not verified.
- [ ] Local: browse folders, open/edit/save a file, terminal (pwsh or
      PowerShell 5.1 fallback).
- [ ] WSL: distro listed, sshd provisioning consent flow, browse + terminal.
- [ ] Remote: `~/.ssh/config` hosts listed, key + password connect, SFTP
      browse, edit + save, terminal, port forward.
- [ ] Source control: open a repo, status/diff/commit.
- [ ] settings.json / theme.json created in the app config dir; hand-edits
      apply live.
- [ ] Relaunch: session (layout, tabs, last server) restores.
- [ ] Uninstall from Settings → Apps: removes cleanly.

Iterate 0.10.x until the checklist passes clean.

### Phase 3 — 1.0.0: public on GitHub

- [ ] Audit [stability.md](stability.md) — every promise in it holds.
- [ ] Re-check the documented security limitations are still acceptable to
      publish: no ssh-agent, jump-host key not verified, single-hop ProxyJump.
      They stay documented limitations for 1.0 unless decided otherwise.
- [ ] `CHANGELOG.md` 1.0.0 entry; bump versions (see below); tag `v1.0.0`.
- [ ] Create a GitHub Release manually; attach the setup.exe (and .msi).
- [ ] README: add an **Install** section for non-developers — download link,
      "Windows 10/11", the one-time SmartScreen click, where settings live.
      Keep the from-source instructions for contributors.

After 1.0 is out (each optional, all free):

- [ ] **winget** submission (`winget-pkgs` PR) — installs skip SmartScreen
      entirely and `winget upgrade` becomes a free update channel.
- [ ] **CI release workflow** — GitHub Actions + `tauri-action` builds and
      attaches installers on every `v*` tag (draft already discussed; add it
      when manual builds get tedious).
- [ ] **SignPath** free open-source code signing — removes the SmartScreen
      warning for direct downloads.
- [ ] **Auto-update** — per [future-work.md](future-work.md), only worth it
      once people actually install releases; needs an updater keypair + CI.

## Why unsigned is fine (decision record)

Code signing ties the installer to a verified publisher identity; Windows
SmartScreen uses it to decide whether to warn on a downloaded executable's
**first run**. Unsigned means exactly one extra click ("More info → Run
anyway") **at install time** — the installed app runs normally forever after,
and a per-user install never shows a UAC prompt either. SmartScreen reputation
also accrues with download volume, so the warning fades on its own for popular
files. Paid certs (~$100–400/yr, or Azure Trusted Signing ~$10/mo) only buy
removing that one click sooner; winget and SignPath (both free) get most of
the same effect. Revisit only if users actually complain.

## Version bump mechanics

The version lives in **three files** that must stay in sync:
`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`
(plus `Cargo.lock`, synced by a `cargo` command). Then a `CHANGELOG.md` entry
and a simple `vX.Y.Z` commit, matching the existing history. Point releases
aren't tagged; **1.0.0** gets the tag + a GitHub Release.

## Platform notes

- **Windows 10/11 only.** Tauri v2 does not support Windows 7/8. x64 installer
  first; an ARM64 build is possible later if asked for.
- **Linux (after Windows):** code paths exist (Unix PTY, `$SHELL`, WSL module
  is `#[cfg]`-gated out); the gap is testing — WebKitGTK rendering pass,
  terminal/PTY runtime test (a known backlog item), then AppImage/deb via the
  same `tauri build`.
- **macOS / iOS:** macOS would be close to the Linux effort but needs the paid
  Apple developer account for notarization — parked. iOS would be a
  remote-only re-architecture (no local shells/processes on iOS) — a separate
  product decision, post-1.0.
