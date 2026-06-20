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

## Non-priority backlog

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

### Cleanup (deferred — one full sweep after Phase 3)
Rather than trimming piecemeal mid-feature, batch a single unused-code / dependency
audit once Phase 3 lands.
- [ ] `fuse.js` — npm dep reserved for the Phase-3 fuzzy finder; drop it if that
      feature never ships.
- [ ] Sweep for other unused npm deps, Tauri commands, capability permissions, and
      dead modules.
- Already removed in 0.7.1 (were verified dead, so kept out): the unused
  `tauri-plugin-dialog` + `tauri-plugin-fs` plugins and their capability grants.
