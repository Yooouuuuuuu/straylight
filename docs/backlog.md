# Backlog

A running checklist of deferred work — known gaps, edge cases, and "later" items
gathered across the build so far. **Every unchecked item below is verified
not-done** (deep cross-check against CHANGELOG, the test plan, and the code on
2026-07-13); done items are removed and tagged *(ex-backlog)* in the manual
test plan instead. Prioritized work lives in the release plan.

## Active roadmap

The current roadmap lives in [release-plan.md](release-plan.md) (0.9.0
self-package → 1.0.0 public). Shipped milestones are recorded in CHANGELOG.md;
completed backlog items get an *(ex-backlog)* tag in the manual test plan
(`docs/dev/phase3-test-plan.md`) when they're removed here (cross-checked
2026-07-13).

## Non-priority backlog

### Version control (Phase 3, later)
- [ ] **git worktree / jj workspace support** (future work — space reserved):
      multiple working directories per repo. Design notes 2026-07-13: each jj
      workspace has its own `@`, so per-workspace cards already work by
      pinning the folder; the future work is sibling-awareness (shared
      history/bookmarks, one card + workspace switcher). The card's ⋯ menu is
      the reserved overflow for workspace ops (git: joins Stash/Pop; jj: the
      menu returns when these land); don't bake "one root = one repo" deeper.
- [ ] **Blame**, **per-hunk staging** (git).
- [ ] True askpass-style prompting for remote-op auth (today: no-TTY hang with
      a Cancel escape; use the terminal for interactive auth).
- [ ] Global ~2 concurrency cap on VCS status calls (designed, never built —
      revisit if many live repos storm one host).
- [ ] jj ignored-file dimming (git repos dim; jj has no cheap "list ignored"
      without touching git in a colocated repo).

### Explorer & transfer
- [ ] Drag files directly **between the sidebar trees** (the old header
      buttons + popup are gone — 0.8.15 docked the two-pane Transfers tool —
      but cross-host drag still lives only in that tool, not the explorer).
- [ ] Unify the two tree implementations (`RootTree` + `TransferPane`) into one
      reusable component.
- [ ] Replace the per-`RootTree` expand/load state + the `treeNav` registry
      workaround with a single source-of-truth tree model.
- [ ] Multi cut/copy/paste in the explorer (its in-tree clipboard is still
      single-anchor; delete + transfer already honor multi-select).
- [ ] Auto-refresh — filesystem watch for local, opt-in polling for SSH.
- [ ] Type-ahead (jump to a typed name) and `*` expand-siblings in the tree.
- [ ] Creating a file in the transfer panel also opens it in the editor — decide
      if it should.
- [ ] A transfer pane's selection can go stale right after a delete.

### WSL
- [ ] Auto-recover a dropped WSL session (re-provision `sshd` in the
      supervisor) — since 2026-07-14 a drop at least SHOWS (red status-bar
      dot; state events wired), but recovery still needs a live sshd;
      re-provisioning on reconnect failure is the remaining piece. Decision
      pending ("might be weird to do — discuss after 1+3+3").
- [ ] Auto-install `openssh-server` on non-`apt` distros (Alpine/Arch/openSUSE).
- [ ] Remember a *declined* install so we don't re-prompt every click.

### Terminals
- [ ] Detect the real Windows build for `windowsPty` (Win11 native reflow instead
      of the hardcoded `buildNumber: 19045` in `useTerminal.ts`).
- [ ] Runtime-test terminals on **Linux** (real PTY there, not ConPTY). Win11 is
      covered by daily dev use on a Win11 machine since 2026-07-10.
- [ ] Non-US-keyboard backtick for Ctrl+Shift+`.

### Connections / auth
- [ ] Passphrase-protected keys (prompt for the passphrase; today: unencrypted or
      password only).
- [ ] `known_hosts` verification (currently trust-on-first-use).
- [ ] Chained `ProxyJump` (only the first hop is used); IPv6 bastion specs
      (`[::1]:22`) mis-parse in `parse_jump`.
- [ ] Port forwards aren't torn down on disconnect — the listener task keeps
      the `Connection` alive (and the local port bound) until stopped by hand.
- [ ] Decide where password entry lives — centered modal vs. an inline field on
      the "Connect to a server" button.

### Data safety
- [ ] Local "hot exit" backup of unsaved edits — cache dirty buffers locally and
      restore on reopen (survives drop / crash / accidental close). Fills the
      v0.4.0 gap where session restore reopens tabs by path but reloads from disk.
- [ ] Reconnect edges (v0.4.0): input typed during an outage is lost; unclean
      disconnect on window close; `reset_sftp` can block ~45 s on a hung op; host
      key not re-validated on restore.
- [ ] Session restore: no toast for files that fail to reopen. (A password
      host's active tab IS restored — verified 2026-07-09; an earlier version
      of this line said otherwise.)
- [ ] Save-conflict detection is mtime-second-granular — an external write in
      the same wall-clock second as the tab's last read/save is silently
      overwritten (the write path has no content check).

### Version control, small
- [ ] Surface a silently hung background monitor check: with no timeouts (by
      design), a hung silent poll leaves the repo stuck in "polling" with no
      UI — after ~30 s show the spinner/cancel as if it were a loud refresh.

### Multi-remote (2+ attached remotes)
- [ ] The global `connState` / status indicator briefly mirrors a *secondary*
      remote's connect progress onto the primary. (The other two items here —
      transfer panes and the SCM picker primary-only — were fixed in the
      1+3+3 refactor, 2026-07-14.)

### Minor code defects (2026-07-09 audit — low severity)
- [ ] `vcs_file_at` / `vcs_file_base` load whole `git show` output into memory
      (no size cap, unlike `fs_read_file`) — a diff on a huge committed file
      spikes RAM.
- [ ] `parse_jj_summary` byte-slices at index 1 — a non-ASCII-leading stdout
      line would panic (unreachable with normal jj output; latent).
- [ ] `initSettings` registers a `file-fs-change` listener it never unlistens —
      a re-init (dev hot-reload / not-ready self-heal) stacks duplicates.
- [ ] Local PTY child isn't reaped when the shell exits on its own (zombie on
      Unix until close), and the `ptys`-map entry lingers until `pty_close` —
      handles accumulate if the UI relies on shell exit alone.

### UI polish
- [ ] Roll the themed `Tip` tooltip (`components/Tooltip.tsx`, adopted in the
      Source Control panel 2026-07-13) out to the rest of the app's `title=`
      attributes — host bars, tab strips, terminal panel chips, status bar.
      Note: disabled buttons fire no mouse events, so they show no tip —
      decide per case whether that matters.
- [ ] **Color/contrast sweep after the test pass** (user, 2026-07-14): go
      through every themed control with a contrast rule (interactive text
      ≥ ~4.5:1) — reuse existing theme slots first before inventing keys
      (`.btn--primary` → accent + section-fg was the pattern; the
      mode-switch active state and the dim per-row action icons are next
      candidates). Also: the 1+3+3 connection surfaces showed color issues
      during verification (user, 2026-07-14) — include the multi-WSL host
      bars / dots / chips in the sweep.

### Misc
- [ ] Trim the Monaco bundle to a language subset (it currently ships every
      language).
- [ ] **Auto-update** — deferred (user decision 2026-07-05): needs a signing
      keypair + hosted releases (GitHub Releases), which only pays off once
      installers are distributed to other people; today the app runs from source.
- [ ] **Run tasks / "debug run" (OPTIONAL — not committed to).** Full debugging
      (DAP: breakpoints, stepping, variables) is explicitly out of scope — debug
      via the real terminal (`pdb`/`gdb`/`dlv`…). The only candidate is a light
      "run command / run current file" that opens a terminal on the right host
      and types the command (the Containers-tab `initialInput` mechanism).
      **Discuss first; do it only if it stays this light, otherwise ignore.**
- [ ] **API client / Bruno-adjacent (RESEARCH FIRST).** No Postman/Bruno clone —
      off-the-shelf Bruno + our port forwarding already covers local use. Before
      deciding anything: **evaluate the Bruno app and the Bruno VS Code extension**
      to see what (if anything) belongs in Straylight. The differentiating
      candidate: a `.http`-file runner executed **via curl on the host that owns
      the file** (requests originate inside the server's network — hits
      localhost/internal DNS that desktop clients can't reach). Post-1.0.
- [ ] Containers, later ideas: container **file browsing** (a new transport),
      logs view, start/stop actions — the Containers tab currently lists running
      containers and opens exec shells.

### Docs
- [ ] Update `handoff.md` (docs/dev — still describes v0.8.4). The README was
      rewritten for 0.9.0 on 2026-07-13.
- Working docs (session handoff, the manual test plan) live in **`docs/dev/`,
  which is gitignored** — session material, not design docs. Design docs were
  all verified/rewritten as-built 2026-07-13.

### Cleanup
The full unused-code sweep ran twice — 0.8.7 (all commands invoked, dead
exports removed) and the 2026-07-09 audit (npm deps: all used; Tauri commands:
61/61 wired — 59 remain since 0.9.1 removed `vcs_describe` / `vcs_squash`;
no dead modules). One candidate remains:
- [ ] Drop the 3 likely-unused window capability permissions
      (`core:window:allow-maximize` / `allow-unmaximize` / `allow-is-maximized`
      in `src-tauri/capabilities/default.json` — only `toggle-maximize` has a
      caller); smoke-test the maximize button + drag-region double-click after.
