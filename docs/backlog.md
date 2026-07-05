# Backlog

A running checklist of deferred work — known gaps, edge cases, and "later" items
gathered across the build so far. **Unchecked = not done.** Most of this is
*non-priority* (revisit when it matters); the few prioritized items are called out
under "Active roadmap."

## Active roadmap

- **0.7.1 — Explorer / transfer directory UX (git prep). _Done._** WSL/remote now
  target *working directories* via the in-app folder browser instead of dumping
  you in the home/root: every connection (local included) pins folders, shown
  collapsed. The transfer tab reuses those pins (collapsed, hidden files off, with
  a one-off "+" dir), and remote/WSL pins persist per connection
  (`user@host:port` / distro name) across reconnect and relaunch. (The transfer
  tab is intentionally independent of the explorer's expansion state, rather than
  shared, per the final UX.)
- **0.7.2 — Streaming transfers ⚠️. _Done._** Cross-connection transfers stream a
  256 KB buffer (the 512 MB cap is gone) with a global live progress bar (shown in
  the status bar too) + Cancel; partial files are cleaned up on failure/cancel.
  Shipped alongside a **Properties** right-click dialog. Design:
  [streaming-transfers.md](streaming-transfers.md).
- **0.8.5 — Post-Phase-3 rework, batches 1–2. _Done._** Live VC refresh (local
  `.git`/`.jj` filesystem watcher + focus refresh for remote/WSL + startup
  populate; **F5/Ctrl+R = app-wide refresh** instead of a WebView reload),
  redesigned repo cards (✎ commit box with a `Commit | Amend` mode switch —
  jj: `Commit | Describe | Fix last msg` — a ⋯ actions dropdown, colored
  connection frames, confirm tiers, **Update replaces Pull**), marker-based
  **conflict resolution** (Accept Current/Incoming/Both + drop-stash flow),
  jj squash, a live **history panel above the explorer**, copyable toasts, and
  the dark-theme fix for native form controls. Batches 3–4 (finder/search
  scoping + streaming, ports polish, context-menu suppression) are next.
- **0.8.x — Version control (Phase 3 core). _Done (git + jj)._** Status + tree
  decorations + branch/bookmark hint, Monaco diff (base vs working), stage/unstage
  + commit (jj: describe+commit), and a commit-history view (the ⎇ panel appended
  in the VC region, plus a pop-out editor tab). Repos are opened explicitly,
  eager-toggle + per-connection persistence, per-repo mutation lock. Runs the VCS
  binary on the host (no local clone). Design + spikes:
  [version-control.md](version-control.md).

## Non-priority backlog

### Version control (Phase 3, later)
- Fetch/pull/push UI, refresh-on-focus + a local `.git`/`.jj` watcher, and a
  marker-based conflict flow are **done or in the current rework** (see the
  post-Phase-3 rework plan in `docs/dev/`) — the items below are what remains.
- [x] **Multi-lane commit graph** — *done*: SVG lanes computed in
      `lib/commitGraph.ts` from parent edges; git logs `--branches HEAD
      --topo-order` so all local branches render; lanes cycle the palette,
      capped at 10 columns.
- [x] **3-way merge editor** — *done*: ⚔ on a conflict row opens a merge tab —
      read-only Current | Incoming panes (each side fully resolved), an editable
      Result seeded with the markers (per-conflict Accept lenses + highlights),
      accept-all buttons, and **Complete merge** = save + stage (git; jj just
      saves) + close. Git-marker conflicts only (jj's own format stays
      hand-edit).
- [x] **Ignored-file dimming** — *done for git* (`status --ignored` → `!`
      records; explorer dims the entry and everything inside an ignored dir,
      no badge, filtered out of the panel). jj repos don't dim yet (no cheap
      "list ignored" without touching git in a colocated repo).
- [ ] **Blame**, **per-hunk staging**.
- [x] **jj on a remote** — *done*: `jj` is probed once per SSH connection
      (default PATH → `~/.cargo/bin` / `~/.local/bin` / `/usr/local/bin` →
      login shell) and the absolute path is cached and substituted; a repo
      opened as git before the fix needs remove + re-add to re-detect as jj.
- [x] **Remote-op cancel** — *done*: fetch/push/update run cancellably; a
      "running — Cancel" banner on the card kills the SSH channel / local
      process (freeing the repo lock), so a no-TTY auth hang has an escape.
      True askpass-style prompting stays future work.

### Theming
- [x] **Per-connection color override** — *done*: right-click a repo card →
      swatch row; the picked color persists per connection identity and wins
      over the hash (`connectionColor.ts` overrides, localStorage).
- [ ] **Global color surface unification** — feed the *same* override into every
      surface that identifies a connection (title bar tint, tree roots, terminal
      list) — today only the VC cards consume it; the others still hash.

### Editor
- [x] **Auto-reload open files on external change** — *done*: clean (non-dirty)
      open tabs reload automatically — local files via a per-file `notify`
      watcher (instant log tailing), remote/WSL via a 3 s mtime poll; the view
      follows the tail if it was scrolled to the bottom. Dirty tabs are never
      touched (save-conflict flow covers them).

### Explorer & transfer
- [ ] Fold the transfer panel into the sidebar — drag directly between the trees;
      retire the three header buttons + the separate modal.
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
- [ ] Re-evaluate the explorer/sidebar UX once git lands (git bar placement; the
      "Explorer" title row may move).

### WSL
- [ ] Auto-recover a dropped WSL session (re-provision `sshd` in the supervisor)
      — today, if `sshd` dies mid-session you reconnect by hand.
- [ ] Surface WSL in the reconnect UI (`App.tsx` watches only the `remote` slot).
- [ ] Multiple WSL distros connected at once (currently one slot per window).
- [ ] Auto-install `openssh-server` on non-`apt` distros (Alpine/Arch/openSUSE).
- [ ] Remember a *declined* install so we don't re-prompt every click.

### Terminals
- [ ] Keyboard-in-terminal routing (which shortcuts xterm keeps vs. the app).
- [ ] Detect the real Windows build for `windowsPty` (Win11 native reflow instead
      of the hardcoded heuristic build number).
- [ ] Terminal tab reordering.
- [ ] Runtime-test terminals on Win11 and Linux (real PTY there, not ConPTY).
- [ ] Edge cases: WebGL context exhaustion at 16+ terminals; prune the ptys map on
      shell exit; non-US-keyboard backtick for Ctrl+Shift+`.

### Connections / auth
- [ ] Passphrase-protected keys (prompt for the passphrase; today: unencrypted or
      password only).
- [ ] `known_hosts` verification (currently trust-on-first-use).
- [ ] Chained `ProxyJump` (only the first hop is used).
- [ ] Decide where password entry lives — centered modal vs. an inline field on
      the "Connect to a server" button.

### Data safety
- [ ] Local "hot exit" backup of unsaved edits — cache dirty buffers locally and
      restore on reopen (survives drop / crash / accidental close). Fills the
      v0.4.0 gap where session restore reopens tabs by path but reloads from disk.
- [ ] Reconnect edges (v0.4.0): input typed during an outage is lost; unclean
      disconnect on window close; `reset_sftp` can block ~45 s on a hung op; host
      key not re-validated on restore.
- [ ] Session restore: a password host's active tab isn't restored; no toast for
      files that fail to reopen.

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
- README rewritten through **0.8.4** (transfers, version control, finder, search,
  port forwarding, the eager-repos guidance).
- Working docs (session handoff, the Phase-3 manual test script, the post-Phase-3
  rework plan) live in **`docs/dev/`, which is gitignored** — they're session
  material, not design docs, so they stay out of the repo.
- [`version-control.md`](version-control.md) still describes the *original* design —
  two of its runner "must-haves" (binary PATH resolution, the ~2 concurrency cap)
  were **deferred, not built**.

### Cleanup (deferred — one full sweep after Phase 3)
Rather than trimming piecemeal mid-feature, batch a single unused-code / dependency
audit once Phase 3 lands.
- `fuse.js` is now **used** (the Ctrl+P fuzzy finder) — no longer a candidate to drop.
- [ ] Sweep for unused npm deps, Tauri commands, capability permissions, and dead
      modules.
- Already removed in 0.7.1 (were verified dead, so kept out): the unused
  `tauri-plugin-dialog` + `tauri-plugin-fs` plugins and their capability grants.
