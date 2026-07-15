# Data safety — saving, drafts, and conflicts

How Straylight keeps you from ever losing an edit, over a flaky SSH link or a
crash. Three mechanisms that compose:

- **Staged remote saves** protect the *save itself* — a dropped connection
  can't tear the file.
- **Hot-exit drafts** protect *unsaved edits* — a crash or accidental close
  can't take the buffer.
- **The conflict bar** handles *divergence* — when the file changed under you,
  you resolve it deliberately, and saving is blocked until you do.

Local files, WSL distros, and SSH remotes are all covered; a WSL distro is an
SSH host, so it behaves like a remote throughout.

---

## The problem

A dirty buffer lives in the Monaco model in RAM, and the classic remote save
truncates the file in place and streams the new bytes into it. That leaves two
distinct ways to lose data:

- **The save can tear.** The truncate-then-stream window is *file size ÷ link
  speed* — seconds for a big file on a slow link. A drop or crash mid-save
  leaves a half-written file on the server, and closing the tab loses the only
  full copy. And "saved" only ever meant "bytes were sent", never confirmed.
- **The buffer can vanish.** Unsaved edits die with an app close, crash, or
  power loss — session restore reopens tabs by path but reloads from disk, so
  the edits are gone.

Both are solved without any new infrastructure: SSH already carries an SFTP
channel and an exec channel side by side (the same runner behind git/jj), so
the server can run a commit step; and the local filesystem commands already
exist to cache drafts.

---

## Staged remote saves

A remote save is a **prepare / commit / acknowledge** protocol where the
network can die at any step without harming the file.

1. **Stage.** Upload the buffer over SFTP to a `.straysave.<id>` temp beside
   the target. The original is untouched, so a drop here costs nothing — retry
   is free.
2. **Commit (detached, server-side).** Dispatch one exec-channel command that
   runs a small POSIX-sh job in the background (`nohup sh -c …`), so sshd
   killing the session on a drop can't kill it. The job:
   - hashes the current target (`sha256sum`) and refuses unless it matches the
     expected hash — the **hash guard** (below);
   - copies the temp into the target with **`cp`, not `rename`**;
   - verifies byte-equality (`cmp`);
   - writes an `ok` marker, then removes the temp — *marker before cleanup*, so
     "marker present" is always trustworthy and "no marker" always means "not
     committed".
   On a guard refusal it writes a `changed` marker (target untouched); on any
   other failure a `fail` marker — and in both failure cases the **temp is
   kept**, because it may be the only complete copy of your data.
3. **Acknowledge.** Ctrl+S returns the moment the upload lands and the commit
   is dispatched — the dirty dot clears **optimistically**. Confirmation runs
   in the background: poll the marker over SFTP, fast then slow, then *park*.
   An `ok` finalizes bookkeeping; a `changed`/`fail` **re-dirties the tab
   loudly** into the conflict bar. A dropped connection is fine — the job
   finishes alone and the marker is consumed on reconnect.

### Why `cp`, not `rename`

`rename` is the only truly atomic replace, but it swaps the file's **inode**:
ownership resets (and a non-root user can't `chown` it back), symlinks are
destroyed, hard links sever, and it needs directory-write permission. `cp`
pours bytes into the *existing* inode, so owner, group, mode, ACLs, xattrs,
hard links, and symlink-following all survive by construction. The trade is
"atomic against server power loss" for "correct against server reality" — and
the rare power-loss tear self-heals (see Reconcile). For a tool that edits
other people's config files on multi-user servers, correctness wins.

### The hash guard

The commit refuses unless the target's current hash matches what the client
expected (the previous content). This is atomic with the copy, so **an edit
from elsewhere mid-save is never silently overwritten** — the guard writes a
`changed` marker and the tab surfaces a conflict. It also retires the old
same-second-mtime blind spot. (A hash can't shrink the upload — the server
can't rebuild content from a fingerprint — so transfer time is addressed by
SSH-level `zlib` compression instead.) The conflict bar's **Overwrite** skips
the guard deliberately.

### The per-file queue

Saves for one file are serialized through a queue that **collapses to the
newest** pending content: two `cp`s can't interleave on one inode, superseded
saves are simply never dispatched, and expected-hashes chain (save N guards
against save N−1's content). Uploads for *different* files still run in
parallel. This is why rapid Ctrl+S never self-conflicts.

### Reconcile

On every host connect (reconnect or relaunch), each pending save is resolved:

- **`ok` marker** → the save landed while away; finalize and clean up.
- **`changed`/`fail` marker** → surface it; the kept temp is named.
- **no marker** → the commit didn't finish. If a **draft** covers the file
  (the usual case), the draft is the recovery and the temp is discarded.
  Otherwise, if the temp is complete and the target hasn't moved, **re-dispatch
  the commit** ("finished an interrupted save") — this is also what heals a
  power-loss tear. If the target moved, keep the temp and warn.

A pending save is recorded in localStorage at dispatch, so recovery works even
if the app never sees the ack. Records younger than ~30 s are left alone (their
job may still be running).

### Fallback

If the stage upload is refused or the commit can't start (a jailed SFTP-only
host, Windows `sshd`), saving degrades to the legacy direct in-place write — a
documented degraded mode, so saving is never impossible. The fallback only
triggers *before the commit starts*; once dispatched there is no silent
double-write.

---

## Hot-exit drafts

Drafts make unsaved edits survive the app itself.

- **What's cached.** Two tiers. A **dirty** tab's full content is written to a
  local draft, debounced (~1.5 s of idle) as you type. A **clean** tab records
  only a metadata stub (`{ mtime, size }`) — enough to answer "changed while
  away?" without storing content. Dirty sets are small, so the disk cost is
  trivial. (Drafts are a *durability* feature, not a memory optimization — an
  open tab's model is in RAM regardless.)
- **Where.** The app data dir's `drafts/` folder (never inside your
  repositories — the no-repo-pollution promise holds), content plus a sidecar
  record carrying the file's baseline mtime and a content hash.
- **Restore, per host.** On relaunch, `restore.openFiles` governs whether
  drafts load back: **`always`** restores silently as each host connects;
  **`ask`** asks each host separately — a checkbox on that host's connect popup
  ("Also restore N unsaved drafts", default checked), or a standalone popup for
  Local and auto-connected hosts. A restored draft opens the tab **dirty**, and
  is applied as one undoable edit over the disk content, so **Ctrl+Z reaches
  the original** and clears the dirty flag exactly there.
- **Reopen on connect.** A file with an unresolved draft reopens on **every**
  connect (launch, manual, mid-session reconnect) — like a pinned file — so
  unsaved work always comes back with its host instead of only surfacing if you
  happen to reopen the file.
- **Resolution.** A draft is deleted only when *resolved*: the file is saved
  (the confirming save checks the draft in after a short grace, so edits typed
  during the ack window keep their draft), explicitly discarded, or found
  identical to disk. Declining to reopen a tab never deletes a draft — safety
  is not answered by omission.
- **Cleanup & privacy.** Drafts are plaintext copies of file content on the
  local disk. A global `drafts.enabled` toggle turns the whole feature off for
  sensitive hosts (reverting to today's behavior). **Settings → Drafts** lists
  drafts per host with per-host and confirm-gated Clear-all buttons; resolved
  drafts delete immediately, orphaned ones wait for you.

---

## The conflict bar

Every buffer-vs-disk divergence is a **non-modal bar on the tab**, never a
modal you can dismiss by pressing save again. Two forms, one vocabulary:

- **Draft available** (an unresolved draft exists but isn't loaded; the buffer
  is the disk content): **Compare · Restore · Discard**. Not a conflict —
  Ctrl+S isn't blocked. Discard confirms (it destroys the only copy of unsaved
  edits).
- **Conflict** (the file changed under you — a background guard refusal, a
  restored draft whose file moved, or a local save-time conflict):
  **Compare · Overwrite · Discard**, and **Ctrl+S is BLOCKED** until you
  resolve it. Overwrite (your version wins, guard skipped) and Discard (drop
  your changes, load the server's) each **confirm**. Compare opens a read-only
  diff of your version against the file on disk.

Blocking Ctrl+S on a conflicted tab is the safety point: the only way out is a
deliberate, confirmed choice — you can't accidentally clobber someone else's
change by mashing save.

### Detecting divergence (not presence)

Straylight detects *edits*, not *editors*. There is no "someone is editing
this right now" — without root, other users' open file handles are invisible,
and the artifacts that do exist (vim `.swp`, emacs `.#file`) miss most editors,
VS Code Remote included, so they'd give false confidence. Instead: the hash
guard catches an external edit at commit time, and the 3 s mtime poll (plus the
reconnect re-check of every open tab) catches edits from any tool within a few
seconds.

---

## Pinned files

A pinned (⌖) tab means "this file is part of my workspace on this host." Pinned
files reopen — pinned — on **every** connect (launch, manual, mid-session
reconnect), persisted per connection identity. Closing a pinned tab doesn't
unpin it; only unpinning removes it. There is deliberately no setting for
whether pins reopen — a pin *is* the opt-in. **Settings → Pinned files** manages
the lists (per-file, per-host, clear-all) and is the only way to unpin a file
on a host you're not currently connected to.

Plain (unpinned + clean) tabs are session-scoped: they survive a relaunch and a
connection *drop*, but an explicit disconnect closes them for good. The rule:
**want it back? pin it.** Nothing of value is lost — dirty content is held by
drafts, and pins persist, both independently of the plain-tab list.

---

## How the three compose

- **Drop mid-save** → the staged temp + detached commit finish or reconcile;
  the file is never torn.
- **Crash with unsaved edits** → the draft restores the buffer on relaunch.
- **Crash mid-save** → on relaunch the draft is the primary recovery; the
  on-server temp is the fallback when drafts are disabled, and the only
  **cross-machine** copy (drafts are per-machine; the temp is on the server
  both PCs share).
- **Someone else edited** → the hash guard / mtime poll surfaces it in the
  conflict bar; Ctrl+S is blocked until you choose.

Permanent loss now requires edits that were **never saved at all** *and* a hard
crash within the last debounce interval — the residual window drafts can't
close.

---

## Honest limits

- A reader on the server can see a mid-`cp` file for milliseconds (in-place by
  design; only `rename` avoids it, and that breaks inodes).
- "ok" means written to the page cache — the same durability class as other
  editors (no fsync; a strict sync mode is possible later).
- Drafts are plaintext at rest locally (mitigation: the disable toggle).
- Drafts are per-machine; cross-machine recovery is the on-server temp only.
- The last debounce interval of typing can be lost in a hard crash.
- Local files use the direct write for now (no network to tear; drafts cover
  the crash case) — the same staging could extend to local later for symmetry.

---

## As built

- **Backend:** `save.rs` (`save_commit`) composes and dispatches the guarded
  commit script through the exec runner; unit-tested for hostile-path quoting,
  the marker-before-cleanup order, the hash-guard placement, and the detachment
  shape. Everything else rides existing `fs_*` commands.
- **Frontend:** `lib/stagedSave.ts` (queue, guard, background ack, reconcile),
  `lib/drafts.ts` (draft store, restore, cleanup), `lib/pinnedTabs.ts`,
  `lib/hash.ts` (WebCrypto SHA-256), and `lib/saveFile.ts` (the save choke point
  + conflict-bar actions + Ctrl+S block). Pending saves and stubs live in
  localStorage; per-tab `conflict` / draft flags live on the tab.

The manual verification checklist is the working doc
`docs/dev/data-safety-test-plan.md` (gitignored).
