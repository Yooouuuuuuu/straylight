# Future work

The prioritized pool of "might do later" — everything *not* on the committed
path in [release-plan.md](release-plan.md). Tiers are rough priority/order, not
commitments. What already shipped is in CHANGELOG.md; the rationale for what
exists is in the [design docs](README.md).

---

## Next — small, clear, likely in an upcoming 0.9.x

- **Minor code defects** (2026-07-09 audit, low severity):
  - `vcs_file_at` / `vcs_file_base` load whole `git show` output into memory
    (no size cap, unlike `fs_read_file`) — a diff on a huge committed file
    spikes RAM.
  - `parse_jj_summary` byte-slices at index 1 — a non-ASCII-leading stdout line
    would panic (unreachable with normal jj output; latent).
  - `initSettings` registers a `file-fs-change` listener it never unlistens — a
    re-init (dev hot-reload / self-heal) stacks duplicates.
  - Local PTY child isn't reaped when the shell exits on its own (zombie on
    Unix until close); the `ptys` map entry lingers until `pty_close`.
- **Drop 3 unused window capabilities** (`allow-maximize` / `-unmaximize` /
  `-is-maximized` in `capabilities/default.json` — only `toggle-maximize` has a
  caller); smoke-test the maximize button + drag-region double-click after.
- **Surface a hung monitor check** — with no timeouts by design, a hung silent
  ◉ poll leaves the repo stuck in "polling" with no UI; after ~30 s show the
  spinner/cancel as if it were a loud refresh.
- **Session restore: no toast** for files that fail to reopen.
- **Multi-remote:** the global status indicator briefly mirrors a *secondary*
  remote's connect progress onto the primary.

## Later — valuable, not yet scheduled

### Version control
- **git worktree / jj workspace support** (space reserved): multiple working
  dirs per repo. Per-workspace cards already work by pinning the folder; the
  real work is sibling-awareness (shared history/bookmarks, one card + a
  workspace switcher). The card's ⋯ menu is the reserved overflow — don't bake
  "one root = one repo" deeper.
- True **askpass-style prompting** for remote-op auth (today: no-TTY hang with a
  Cancel escape; use the terminal for interactive auth).
- Global **~2 concurrency cap** on VCS status calls (designed, never built).
- **jj ignored-file dimming** (git repos dim; jj has no cheap "list ignored"
  without touching git in a colocated repo).

### Explorer & transfers
- Drag files directly **between the sidebar trees** (cross-host drag lives only
  in the Transfers tool today).
- Unify the two tree implementations (`RootTree` + `TransferPane`); replace the
  per-tree expand/load state + `treeNav` registry with one tree model.
- Multi cut/copy/paste in the explorer (its clipboard is single-anchor; delete
  + transfer already honor multi-select).
- Type-ahead (jump to a typed name) and `*` expand-siblings in the tree.
- A transfer pane's selection can go stale right after a delete.
- **WSL ⇄ Windows fast path** via `wsl.exe` (same machine, skip the SSH relay)
  — and other remote-throughput optimizations (per-save gzip, etc.). **Gate:**
  pursue only if real usage actually feels slow. SFTP-over-loopback + `zlib`
  may already be fast enough; measure the felt experience before adding
  machinery.

### Connections / auth
- **Passphrase-protected keys** (today: unencrypted keys or password only).
- **`known_hosts` verification** (currently trust-on-first-use).
- **Chained `ProxyJump`** (only the first hop is used); IPv6 bastion specs
  (`[::1]:22`) mis-parse in `parse_jump`.
- **Port forwards aren't torn down on disconnect** — the listener keeps the
  `Connection` alive (and the local port bound) until stopped by hand.

### WSL
- **Auto-install `openssh-server` on non-`apt` distros** (Alpine/Arch/openSUSE).
- **Remember a declined install** so we don't re-prompt every click.

### Terminals
- Detect the real Windows build for `windowsPty` (Win11 native reflow instead of
  the hardcoded `buildNumber: 19045`).
- Runtime-test terminals on **Linux** (real PTY, not ConPTY).
- Non-US-keyboard backtick for Ctrl+Shift+`.

### Data safety (follow-ups to the 0.9.5 pass — [data-safety.md](data-safety.md))
- **Strict save mode** — fsync before "ok" (today: page-cache durability, as
  most editors).
- **Phase-2 draft mirroring** — cache clean-file content too (enables a
  changed-while-away diff for clean tabs, and background-tab model eviction);
  measure disk cost first, alongside whether the 50 MB editor cap can rise.
- Promote the reconcile **moved-baseline** warning to a full
  Compare / Commit / Discard dialog (v1 is a toast).
- **Reconnect edges** (v0.4.0): input typed during an outage is lost; unclean
  disconnect on window close; `reset_sftp` can block ~45 s on a hung op; host
  key not re-validated on restore.
- Save-conflict is still **mtime-second-granular** on the *local* direct-write
  path (the remote path is now hash-guarded).

### UI polish
- Roll the themed **`Tip` tooltip** out to the rest of the app's `title=`
  attributes (host bars, tab strips, terminal chips, status bar). Disabled
  buttons fire no mouse events, so they show no tip — decide per case.
- **Color/contrast sweep** — every themed control against a contrast rule
  (interactive text ≥ ~4.5:1), reusing existing theme slots first. Include the
  multi-WSL host bars / dots / chips (flagged during 1+3+3 verification).

### Misc
- Trim the **Monaco bundle** to a language subset (it ships every language).

## Needs a decision (discuss / research first)

- **WSL session auto-recovery** — re-provision `sshd` on a connection drop. A
  drop already SHOWS (red status dot), but recovery needs a live sshd;
  re-provisioning on reconnect is the missing piece. Flagged "might be weird —
  discuss".
- **Run tasks / "debug run"** (not committed to). Full debugging (DAP) is out of
  scope — debug in the real terminal. The only candidate is a light "run current
  file / command" that opens a terminal on the right host and types it (the
  Containers-tab `initialInput` mechanism). Do it only if it stays this light.
- **API client / Bruno-adjacent** (research first). No Postman/Bruno clone.
  Evaluate the Bruno app + VS Code extension first. The differentiating
  candidate: a `.http` runner executed **via curl on the host that owns the
  file** (requests originate inside the server's network — reaches
  localhost/internal DNS a desktop client can't). Post-1.0.
- **Containers, deeper** — file browsing inside a container (a new transport),
  logs view, start/stop. Today the tab lists running containers + opens shells.
- **Password entry location** — centered connect modal vs. an inline field on
  the "Connect to a server" button.

## Parked (until a trigger)

- **Auto-update** — needs a signing keypair + hosted releases; only pays off
  once installers reach other people (the app runs from source today).
- **Remote agent** — rejected until remote file-watching or LSP-on-host makes it
  an opt-in *accelerator* (see the [ledger](README.md#design-decision-ledger));
  SSH covers files/terminal/transfer/exec today.
- **macOS / iOS** — macOS needs the paid Apple account for notarization; iOS is a
  remote-only re-architecture. Post-1.0 (see release-plan Platform notes).
