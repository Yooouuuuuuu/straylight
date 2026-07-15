# Staged remote saves (decided 2026-07-14; implemented 2026-07-14 — see Rollout)

Make saving over SSH safe against connection drops: today a save **truncates
the remote file in place and streams the new bytes into it**, so a drop (or a
crash) mid-save leaves a torn file on the server, with the only full copy
sitting silently in Monaco's memory. This doc records the decided design: a
**prepare / commit / acknowledge protocol** where the network can die at any
step without harming the file, plus the recovery rules that make "saved" mean
*confirmed byte-identical on the server*.

Companions: the **hot-exit draft cache** ([hot-exit.md](hot-exit.md) —
**ships first**; after this design its scope is edits *never saved*:
keystrokes since the last Ctrl+S, local files, and deaths mid-upload) and the
**dirty-tab conflict warnings** decided here (§ Concurrent editors, built in
the hot-exit phase and reused here). Related precedent: transfers already
stage to a `.straypart` and commit
([streaming-transfers.md](streaming-transfers.md)).

---

## The problem

`write_file` (both transports) opens the target with create+truncate and
streams. The torn-file window is *file size ÷ link speed* — milliseconds
locally, whole seconds for a big file over a slow link, and saving over shaky
links is Straylight's core use case. Three failure modes:

1. **Drop mid-save** — error toast, but the file on disk is already torn;
   nothing says so, and closing the tab loses the only good copy.
2. **App crash mid-save** — no toast, torn file, nothing to recover.
3. **A remote process reads mid-save** — a service re-reading its config sees
   a half-written file, even when the save eventually succeeds.

Also honest: today "saved" only means "bytes were sent" — there is no
confirmation that they all landed.

## What we already have (no new infrastructure)

This design is assembled from parts that already exist and are battle-tested:

- **One multiplexed SSH connection already carries parallel channels** — the
  SFTP subsystem channel *and* an exec channel per command, side by side
  (`exec.rs` `run_command`: the same runner behind git/jj, find, grep, ports,
  containers). "SFTP can't run commands" is not a constraint here; any host
  where the Source Control panel works can run the commit step.
- `shell_quote` / argv discipline — commands are quoted, never interpolated.
- The **3 s mtime poll** on remote/WSL tabs, the save-conflict flow
  (Overwrite / Reload), and the diff view.
- The `.straypart` stage-then-commit precedent, including its rule: *on a
  failed commit, keep the temp — it may be the only good copy.*
- The reconnect supervisor with stable `connId`s — tabs survive reconnects,
  which is what recovery (S5a) hooks onto.

And one **constraint** the design must respect (verified in `session.ts`):
session restore reopens tabs **by path only — unsaved buffers are not
cached**. A dirty buffer survives a *disconnect* (it lives in the Monaco
model; the app is still running) but not an *app close or crash*. So any
recovery step that runs after a relaunch cannot count on Monaco holding the
content — which is exactly why the uploaded temp doubles as a backup (below).

WSL distros are SSH hosts, so they get this protocol unchanged.

## Decisions

1. **Commit in place with `cp`, never `rename`.** Rename is the only truly
   atomic replace, but it swaps the inode: ownership resets (and a non-root
   user cannot chown it back), symlinks are destroyed, hard links sever, and
   it needs directory write permission. `cp tmp orig` pours the bytes into
   the *existing* inode — owner, group, mode, ACLs, xattrs, hard links, and
   symlink-following are preserved by construction. We trade "atomic against
   server power loss" for "correct against server reality"; the recovery loop
   heals the rare power-loss tear (§ States, S5).
2. **The commit runs server-side, detached.** sshd kills a plain exec command
   when the connection drops, so the commit is dispatched as
   `sh -c 'nohup sh -c "<commit script>" >/dev/null 2>&1 &'` — the outer
   login shell parses only `sh -c '<one quoted arg>'` (csh-proof,
   noclobber-proof); `nohup` is POSIX and present in busybox (`setsid` is
   not on BSD/macOS). Once dispatched, the job finishes even if the link dies.
3. **Acknowledgement via marker files, not a channel.** The job's *last act
   before cleanup* is writing `.straysave.<id>.ok` (or `.err`); Straylight
   reads markers over SFTP — which also works after a reconnect. No agent.
4. **Verified commit.** `cmp` runs server-side before the ok marker: "saved"
   = byte-identical, checked at local-disk speed.
5. **Dirty until confirmed.** The dirty dot clears only on the ok marker.
6. **No agent, no planted binaries** (decision record; echoes
   [wsl-connection.md](wsl-connection.md)'s founding reasoning). A resident
   helper would add a build matrix (x86-64/arm64 × glibc/musl), die on
   `noexec` mounts, change the security posture ("executes its own binary on
   your server"), and introduce version skew — for one verb that a `cp`
   one-liner delivers. Reopen only if remote file-watching or LSP-on-host
   later justify an *opt-in* helper.
7. **No presence detection** ("someone is editing right now" — dropped
   2026-07-14). Without root, other users' open file handles are invisible
   (`lsof`/`fuser`/`/proc` show only your own processes — a kernel rule, not
   a missing tool). Editor artifacts (vim `.swp`, emacs `.#file`) cover only
   some editors and **VS Code Remote leaves nothing at all**, so detection
   would give false confidence exactly when it matters. The mtime poll is the
   honest mechanism: we detect *edits*, not *editors* (§ Concurrent editors).
8. **The temp doubles as a backup, so pending saves are persisted.** Because
   the complete buffer reaches the server *before* anything destructive
   happens, the temp is a durable copy that survives an app crash — the one
   case session restore cannot cover (unsaved buffers aren't cached). To use
   it, each dispatched save writes a small **pending record** to
   localStorage: `{ connKey, path, id, byteSize, baselineMtime, at }`. The
   record is deleted when the ok marker is consumed. After a relaunch, S5b
   recovers from the server-side temp using this record — Monaco's buffer is
   gone, but the save the user asked for still completes.

### Revision 2026-07-15 — background ack (decided in test round 2)

Testing showed the S4 wait is a UX choice, not a safety requirement — safety
lives in drafts + pending records + markers, and the ack was always designed
to be consumable later (that's what reconcile does). Decisions:

9. **Optimistic finalize.** Ctrl+S returns (and the dirty dot clears) once
   the upload lands and the dispatch is accepted. Confirmation happens in the
   background; a failure re-dirties the tab loudly. The dot now means
   "handed off, ordered, guarded" — the draft keeps the content until the ok
   is truly confirmed, so nothing rests on the softer signal. The `saving`
   tab state and the close-dialog hint are removed: closing or quitting with
   a pending save is safe by construction (records + drafts persist).
10. **Per-file dispatch queue with collapse** (the "buffer"). Commits for one
   file go out strictly one at a time — two concurrent `cp`s on one inode
   could interleave — while uploads may run in parallel (distinct temps).
   One pending slot per file holds only the NEWEST undispatched save;
   superseded versions are never sent (cheaper and safer than interrupting a
   running job). Expected hashes chain: save N's guard value is save N−1's
   content hash. This deletes the earlier serialize-wait patch.
11. **Hash guard in the commit job.** The job computes `sha256sum` of the
   target and refuses to commit unless it matches the expected hash from the
   client ("-" = skip, for the conflict dialog's Overwrite). Atomic with the
   commit, so nothing can be silently overwritten by an edit from elsewhere
   mid-process; also retires the same-second-mtime blindness (the old S2
   stat survives only as a cheap pre-upload fast-fail). A guard refusal
   writes a `changed` marker — target untouched, temp kept — and surfaces as
   the normal save conflict. Note: a hash cannot shrink the upload (the
   server can't reconstruct content from a fingerprint); transfer time is
   addressed by compression instead (below).
12. **Draft check-in by the LAST commit, with a grace re-check.** A draft is
   deleted only when the ok belongs to the file's newest save AND, ~500 ms
   later, the buffer is still clean (closed tabs compare content hashes).
   Costs nothing — the user saw "saved" long before — and closes the race
   where edits typed during the ack window could lose their draft for one
   debounce cycle (a bug the old synchronous flow technically had too).
13. **Background ack schedule.** Poll fast (~250 ms) for ~2 s, then 1 s steps
   to ~30 s, then PARK: the record persists, a lazy ~60 s sweep re-checks
   parked records on connected hosts, and reconcile covers reconnects and
   relaunches. Bookkeeping hygiene, not a user-facing timeout — nothing is
   abandoned and a late `fail` still surfaces loudly.
14. **SSH-level compression (experiment).** Prefer `zlib@openssh.com` on the
   connection (russh ships flate2 by default; servers that refuse fall back
   to `none`). Compresses saves, transfers, and terminals alike — measure
   before considering per-save gzip; true delta sync stays parked with the
   agent decision.
15. **Conflicts are per-tab bars, and Ctrl+S is blocked while one shows**
   (test round 3). A guard refusal (`changed`) sets `tab.conflict`; the tab
   re-dirties and shows the conflict bar (Compare / Overwrite / Discard, each
   destructive action confirmed). While `tab.conflict` is set, `saveTab`
   refuses with a toast — the earlier "press Ctrl+S again to save through the
   dialog" hole is closed; resolution is only via the bar. The modal
   ConflictDialog is retired (shared with hot-exit.md decision 5). Local
   direct-write conflicts (`WriteResult.conflict`) flow through the same
   per-tab flag.

## The protocol, state by state

Per save: `id` = a per-tab monotonic save token; `tmp` =
`.<name>.straysave.<id>` sibling of the target; markers =
`.straysave.<id>.ok` / `.err` beside it. One in-flight save per tab; a new
Ctrl+S supersedes the pending one (new id; the old id's record is dropped and
its markers/temp fall to the sweep — § Honest limits).

**S0 — dirty.** Buffer edited in Monaco; server holds the old file.
*At risk:* only unsaved edits (the drafts backlog item covers app-crash here).

**S1 — upload.** Stream the buffer to `tmp` over SFTP. UI: tab shows
"saving…" (still dirty; the close-tab dialog must recognize this state).
*Drop here:* `tmp` is partial garbage with a known name; the original is
untouched. Recovery: S1 again (re-upload truncates the same temp). Cost: none.
*Temp can't be created* (directory not writable) → **L** (legacy fallback).

**S2 — conflict check.** SFTP-stat the original; compare mtime with the
tab's. Changed → the existing conflict dialog (Compare / Overwrite / Reload);
never auto-commit over someone's edit. Unchanged → S3. (The same-second
granularity caveat is unchanged — see backlog.)

**S3 — dispatch.** One exec-channel command starts the detached commit job
and returns immediately:

```sh
if cp -- tmp orig && cmp -s -- tmp orig; then
    printf ok > .straysave.<id>.ok && rm -f -- tmp
else
    printf fail > .straysave.<id>.err          # tmp is KEPT — it may be
fi                                             # the only good copy
```

(All paths shell-quoted literals baked in by Rust; marker-before-`rm` order
means "marker present" is always trustworthy and "no marker" always means
"not committed" — no ambiguous middle state. The `.err` marker can carry a
short reason.) Dispatch also writes the **pending record** to localStorage
(decision 8) — from this moment the save can complete and be reconciled even
if the app never sees the ack. *Drop here:* the job runs to completion
anyway — that is the point of the detachment.

**S4 — await ack.** Poll the marker over SFTP (~250 ms). `.ok` → mark the
tab saved (clear dirty), delete the marker and the pending record, stat for
the new mtime. `.err` → error toast naming the kept temp; stay dirty. No
hard timeout (house rule: no automatic timeouts) — the tab stays visibly
"saving…", a passive hint appears after ~10 s ("still waiting for the server
to confirm"), and a fresh Ctrl+S supersedes.

**S5a — reconcile on reconnect (app still running).** Also the moment every
open tab is re-checked against the server, which is needed regardless —
others may have edited while we were away. Per pending save:

- `.ok` exists → the save landed while offline: clear dirty, delete marker +
  record. If the file moved on *after* our save (someone else edited), the
  normal changed-on-disk flow takes over from here.
- `.err` exists → failed server-side: stay dirty, surface it, temp kept.
- no marker → unconfirmed (job never ran, died mid-commit, or the temp is
  partial): **re-save from S1** — the buffer is still in Monaco, so this is
  always possible while the app lives. Idempotent; worst case rewrites
  identical bytes.

**S5b — reconcile on relaunch (app died with a pending record).** Monaco's
buffer is gone — session restore reopens tabs by path only — so recovery
uses the **server-side temp** via the pending record, once the host
reconnects. With hot exit shipped ([hot-exit.md](hot-exit.md)), the local
draft is checked **first** and usually wins (restore it, mark dirty, let the
user save); S5b is the fallback when no draft covers the file — drafts
disabled, or the pending save came from the *other* machine (drafts are
per-machine; the server temp is the shared copy):

- `.ok` marker → the save completed before/despite the death: nothing to
  restore; delete marker + record.
- no marker, temp exists and matches the record's `byteSize` (upload was
  complete): the temp holds exactly what the user pressed Ctrl+S for.
  If the file's mtime still equals the record's `baselineMtime` → dispatch
  the commit (S3) and toast "finished an interrupted save". If the mtime
  moved → someone (or a torn write) touched the file since: show the
  conflict dialog with **Compare** (the temp is readable — diff temp vs
  file) / **Commit the saved version** / **Discard**.
- no marker, temp missing or size-mismatched (death mid-upload) → nothing
  recoverable here; delete the record. This residue — plus edits never
  saved at all — is exactly the hot-exit drafts' job.

**Self-healing property:** if the server lost power mid-`cp` (the one window
no SSH-side protocol can close without `rename`), the original may be torn —
but no marker exists and dirty was never cleared, so S5a re-saves (app
alive) or S5b re-commits the temp (after a relaunch), repairing the file
without user action. After this design, permanent loss requires edits that
were **never saved** (or a death mid-upload) — the hot-exit drafts' shrunken,
purely local scope.

**L — legacy fallback.** If the temp can't be created or the exec channel is
unavailable (SFTP-only jailed hosts, Windows sshd), fall back to today's
direct in-place write — a documented degraded mode; saving must never be
impossible. Fall back **only when the commit never started**; once S3
dispatched, never double-write — wait and reconcile instead.

## Concurrent editors (instead of presence)

Continuous checking, warning-only, built on what exists:

- The 3 s mtime poll extends to **dirty** tabs (today it only serves clean
  tabs' auto-reload). A change on the server while a tab is dirty raises a
  banner — "changed on the server since you opened it" — with **Compare**
  (the diff view) and **Save anyway**; the tab's content is never touched.
- The same check runs for every open tab at every reconnect (part of S5).
- Clean tabs keep auto-reloading exactly as today.

This detects *edits within ≤3 s*, from any tool — vim, `echo >`, VS Code
Remote, a deploy script — which presence detection never could.

## Honest limits

- A reader on the server can still see a mid-`cp` file for milliseconds
  (in-place by design; only `rename` avoids it, and we rejected rename).
- Server power loss during `cp` tears until the next reconcile re-save.
- "ok" means written to the page cache — the same durability class as other
  editors (no fsync; a sync-based strict mode is possible later if wanted).
- Same-second mtime conflicts remain invisible (existing backlog item).
- Crash debris vs. recoverable data — the sweep must tell them apart. A
  `.straysave.*` temp whose id is in **this machine's** pending records is
  recoverable data (S5b), never swept. Everything else is swept only by
  generous age (days, not minutes): with two PCs editing the same hosts, a
  temp that looks orphaned here may be the *other* machine's pending save —
  its records live in that machine's localStorage.
- Local files keep the direct write for now — there is no network to tear,
  and drafts cover the crash case; the same staging can come later for
  symmetry. (Relatedly: WSL **tabs** aren't session-restored at all today —
  `session.ts` persists only local/remote scopes — worth fixing with the
  multi-WSL work, since S5b needs the tab to reopen to offer recovery.)

## As built (implemented 2026-07-14)

- **Backend** — `save.rs`: one command, `save_commit`, composing the commit
  script (unit-tested: hostile-path quoting, marker-before-rm order, the
  detachment shape) and dispatching it through the existing exec runner. The
  stage upload, conflict stat, marker reads, and cleanup all ride existing
  `fs_*` commands — no other new surface.
- **Frontend** — `lib/stagedSave.ts` drives S1–S4 (250 ms marker poll, 10 s
  passive hint, per-tab supersede token) and S5 (`reconcilePendingSaves`,
  called from both consume-on-connect paths, after tabs and pins reopen);
  `saveFile.ts` routes WSL/remote tabs through it — including the conflict
  dialog's Overwrite — and local tabs unchanged. Pending records live in
  localStorage (`straylight.pendingSaves`).
- **Marker mechanics, refined at build time:** markers land via a sidecar +
  in-directory `mv` (an atomic rename), so a poller can never read a
  half-written marker; `cp`'s stderr is captured into the err marker as the
  failure reason.
- **The L fallback** is a `"fallback"` outcome: stage-upload refused or
  dispatch failed *before the commit started* → the caller degrades to the
  legacy direct write. Once dispatched, there is no silent fallback.

v1 simplifications (deliberate, revisit with test feedback):

- Reconcile's **moved-baseline** case (file edited by someone else after an
  interrupted save) surfaces a warning naming the kept temp, instead of the
  full Compare / Commit / Discard dialog.
- Reconcile skips records younger than **30 s** — their job may still be
  running (or this session's own poll loop owns them).
- The "saving…" state is the tab flag + the close-dialog hint + the 10 s
  toast; no tab-strip spinner yet.

Verification and the remaining work live in the working doc:
`docs/dev/data-safety-test-plan.md` (gitignored, session material).
