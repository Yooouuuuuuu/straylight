# Hot exit — local drafts of open files (design — decided 2026-07-14, not yet built)

Make edits survive the app itself: today a dirty buffer lives **only in the
Monaco model in RAM**. It survives a *disconnect* (the app is still running)
but dies with an app close, a crash, or power loss — session restore reopens
tabs **by path only** ("unsaved buffers are not cached", `session.ts`'s own
words, verified 2026-07-14). This fills the v0.4.0 gap and is the top
data-safety backlog item.

Build order (decided): **hot exit ships first**, then staged saves
([atomic-save.md](atomic-save.md)) — drafts become the primary relaunch
recovery, demoting staged saves' S5b (server-temp recovery) to a fallback,
and staged saves reuse the warning bar / compare flow built here.

---

## The problem

- Dirty edits are lost on app close/crash/power loss — for **local, WSL, and
  remote** tabs alike (a local *file* is on disk; its unsaved *edits* are not).
- On relaunch there is no memory of what the server looked like when you left,
  so "did someone change this while I was away?" is unanswerable until a save
  collides.

## Decisions

1. **Two tiers — dirty content, clean stubs. No full mirroring.**
   - **Dirty tabs → full content drafts** on the local disk, debounced
     (~1–2 s of idle) as you type. Dirty sets are naturally small, so the
     disk cost is trivial.
   - **Clean tabs → a metadata stub** only: `{ connKey, path, mtime, size }`
     at last sight. That answers "changed while away?" with one `stat` on
     reopen — no content stored.
   - What phase 1 gives up: a content-diff for *clean* files ("show exactly
     what changed while I was gone"). Full clean-content mirroring is a
     measured **phase 2** (see Tests) — as is background-tab **model
     eviction** (rehydrate from draft on focus), the point at which
     disk-backing starts genuinely saving RAM.
   - RAM honesty: while a tab is open its model must be in RAM regardless —
     drafts are a *durability* feature, not a memory optimization (until
     eviction exists).
2. **Storage:** the app **data dir** (never inside user folders — the
   no-repo-pollution promise holds): `drafts/<hash(connKey)>/<hash(path)>`
   holding the content, with a sidecar record
   `{ connKey, path, baselineMtime, draftedAt, size }`. `baselineMtime` = the
   file's mtime the tab last loaded/saved — the reopen comparison anchor.
3. **Restore is decided PER HOST, two modes** (revised 2026-07-14 after the
   first test pass). `restore.openFiles: "ask" | "always"`:
   - **ask** — each host answers separately, at its natural moment. A host
     with a connect popup carries the question as a **default-checked
     checkbox** ("Also restore N unsaved drafts"); Local (no popup) and
     silently auto-connected hosts get a **standalone popup** of their own,
     after they're up. The standalone popup's "always" checkbox flips the
     setting (applied only on Restore, never on Skip).
   - **always** — drafts restore silently as each host connects.
   Tab reopening itself stays exactly as today in both modes; a declined
   host's tabs open clean from disk, with the banner (decision 5) keeping
   per-file recovery one click away. There is no "never" — turning drafts
   off entirely is `drafts.enabled` (decision 6).
4a. **The undo stack reaches the original** (fix from the first test pass):
   a restored draft is applied as ONE undoable edit over a buffer seeded with
   the **disk content**, and the disk seed is the saved baseline — so the tab
   opens dirty, Ctrl+Z steps back to the original file, and the dirty flag
   clears exactly there (standard undo-to-saved behavior; Ctrl+Y brings the
   draft back).
4. **Convenience and safety are separate questions.** "Reopen the tabs?" is
   convenience and may be asked. "Keep the drafts?" is safety and is never
   answered by omission: **declining to reopen does not delete drafts.** A
   draft is deleted only when *resolved* — restored and then saved, explicitly
   discarded, or found byte-identical to the file on disk (obsolete).
5. **Bars, not modals** (revised 2026-07-15 test round 3). Every buffer-vs-
   disk divergence is a non-modal bar on the tab, with one vocabulary —
   **Compare / Overwrite / Discard** (Restore replaces Overwrite where the
   draft isn't loaded yet):
   - **Draft available** (not loaded, buffer = disk): *Compare · Restore ·
     Discard*. Not a conflict — Ctrl+S isn't blocked (nothing's dirty).
     Discard confirms (it destroys the only copy of unsaved edits).
   - **Conflict** — a restored draft whose file MOVED on the server, a
     save-time conflict, or a background guard refusal: *Compare · Overwrite ·
     Discard*, and **Ctrl+S is BLOCKED** while it shows (see atomic-save.md;
     the old "press Ctrl+S again to save through the bar" hole is closed).
     Overwrite (your version wins) and Discard (take the server's) each
     **confirm**. This retires the modal ConflictDialog — all divergence,
     draft or save, now shares this surface.
   A clean stub whose mtime moved just reloads fresh, as today (no notice in
   phase 1 — stubs are recorded but drive no UI yet).
6. **Cleanup & privacy.**
   - Auto-hygiene first: stubs are near-free; resolved drafts delete
     immediately; dirty drafts are **never silently expired** — an orphaned
     draft (host never reconnected) stays until the user acts.
   - A Settings **cleanup panel**: per-host list (host → draft count, size)
     with per-host clear and a confirm-gated **Clear all** — the
     browser-cookies model, for the many-servers case.
   - **Privacy:** drafts are plaintext copies of (possibly sensitive) server
     file content on the local disk. A global `drafts.enabled` toggle exists
     for exactly this; disabled = today's behavior everywhere, and the
     startup ask reverts to the plain reconnect dialog.
7. **Interplay with staged saves** ([atomic-save.md](atomic-save.md)): after
   a relaunch, drafts are the primary recovery — restore the buffer, mark
   dirty, reconcile, let the user save. The staged-save pending record + the
   server-side temp remain the fallback for when drafts are disabled — and
   the only **cross-machine** copy (drafts are per-machine; the temp is on
   the server both PCs share).

## The flow, state by state

**While editing.** Every dirty tab gets a debounced draft write (local
transport commands — no new backend). Stubs refresh on open / reload / save.
UI: nothing; drafts are invisible until needed.

**On save (success).** The draft is deleted — durability hands over to the
save path (and, once built, the staged-save protocol).

**On explicit "Don't save".** The user chose to drop the edits — the draft is
discarded with them. (An explicit choice is a resolution; the net is for
*accidents*.)

**On app close.** Nothing special to do — drafts are already on disk. The
exit-confirm dialog stays as-is; with drafts enabled it is truthful to exit
with dirty tabs, because nothing is lost.

**On crash / power loss.** Drafts up to the last debounce tick survive; at
most the final ~1–2 s of typing is gone.

**On relaunch.** Per `restore.openFiles`: reopen the remembered tabs. A tab
with a draft loads the **draft** as its content and starts **dirty**, with
the warning bar if `baselineMtime` no longer matches the file; a tab without
a draft loads from disk/server exactly as today. Declined restores leave
drafts in place (decision 4) — they surface in the cleanup panel and on the
next ask.

**On reconnect (app alive).** The RAM buffer was never lost, but a file with
an **unresolved draft is reopened** anyway (Issue 1, 2026-07-15) — like a
pinned file, so unsaved work always comes back with its host instead of only
surfacing if you happen to reopen the file. The reopened tab shows the draft
bar (or auto-restores per the host's decision). Pending staged saves reconcile
in the same pass.

## Pinned tabs reopen on every connect

Shipped alongside (2026-07-14): a pinned (⌖) tab now means "this file is
part of my workspace on that host", persisted per connection identity
(`lib/pinnedTabs.ts`, localStorage). Pinned files open — pinned — on **every**
connect: launch restore, a manual connect, and mid-session reconnects, which
previously dropped pinned tabs with the rest on disconnect and never brought
them back. Closing a pinned tab does **not** unpin the file (it returns on
the next connect); unpinning removes it from the list. Idempotent with
session restore — an already-open file is just focused.

**Always-on by design** — there is deliberately no setting governing whether
pins reopen (a pin *is* the opt-in). Management lives in **Settings → Pinned
files**: per-file unpin and per-host / clear-all, mirroring the drafts
cleanup panel. Unpinning there also unpins a live tab, and it is the only
way to unpin a file on a host you're not currently connected to.

## Plain tabs (unpinned + clean) — deliberately session-scoped

Decided 2026-07-14: no "park on disconnect". A plain open tab survives app
relaunch (session restore reopens it when its host connects) and connection
*drops* (the tab never leaves), but an **explicit disconnect closes it for
good**, and skipping a host's startup ask forgets its remembered tabs (the
0.8.15 no-ghost-ask rule). The rule users learn: **want it back? pin it.**
Nothing of value is lost by this — dirty content is protected by drafts
independently of any tab list, and pins persist independently of both.

## Honest limits

- **Per-machine.** PC A's drafts are invisible on PC B; the staged-save
  server temp is the only cross-machine copy (see interplay, decision 7).
- The last debounce interval of typing can be lost in a hard crash.
- Plaintext at rest on the local disk (mitigation: the disable toggle;
  documented location).
- No clean-file content diffs in phase 1 (stubs only).
- A huge dirty file (up to the 50 MB open cap) is re-written per debounce
  burst — fine on modern disks; phase 2 measures it (the same experiment
  informs whether the 50 MB editor cap itself can rise — a separate,
  Monaco-bound decision).

## Status & sequencing

**Implemented 2026-07-14** (revised same day after the first test round:
undo-baseline fix, per-host two-mode asks, pinned-tab reopen). Frontend +
existing local file IPC only — no new Rust. Shipped alongside: WSL tabs are
session-persisted (session.ts scope "wsl") and pinned tabs reopen on every
connect (section above). Build order (decided): hot exit first, then staged
saves ([atomic-save.md](atomic-save.md)) with S5b in its reduced fallback
form, one combined test pass before the version bump.

Verification and the remaining work live in the working doc:
`docs/dev/data-safety-test-plan.md` (gitignored, session material).

Phase 2 (optional, measured): full clean-content mirroring, background-tab
model eviction, and the 50 MB cap experiment.
