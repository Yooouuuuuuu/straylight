# Version control — git + jj (design + as-shipped)

Source control for **git** and **Jujutsu (jj)** on local, WSL, and remote
hosts: status, tree decorations, diffs, stage/commit, history with a
multi-lane graph, branches/bookmarks, stash, conflicts + a 3-way merge editor,
and fetch / update / push with incoming review.

Rewritten 2026-07-13 and kept as-built; accurate as of 1.0.0. The command
spikes below remain the authoritative reference for the parsers in
`src-tauri/src/vcs.rs`. Still-deferred items are listed at the end and in
[backlog.md](backlog.md).

## Core insight

We don't have a local clone — Straylight browses files live over SFTP. So VCS
operations on a remote repo **run the VCS binary on the host that owns the
repo**, through the SSH connection we already hold. There is nothing local to
point a library at. This also means VCS identity (commit author, push
credentials) is the *host's* — a commit made through Straylight is identical
to one you'd make SSH'd in by hand (right author, hooks fire, signing works).
This is a stability promise ([stability.md](stability.md)).

## Why exec, not a library (libgit2 / git2)

- libgit2 only works on a **local working copy**, which we don't have for
  remotes — we'd need the exec path anyway and end up maintaining two engines.
- jj is **not** libgit2; a library buys nothing for jj. Exec runs `git` and
  `jj` through the same channel.
- Exec inherits the user's real git/jj: config, hooks, credential helpers,
  signing, LFS. A reimplementation gets author/hooks/signing subtly wrong.

Cost: depends on the binary being installed on the host, and we parse output —
but only **stable machine formats**, never human text.

## The runner (exec.rs) — as built

`run_command(state, connId, cwd, argv)` → `{ stdout, stderr, code }`. Remote /
WSL: an SSH exec channel (argv shell-quoted, cwd included). Local:
`tokio::process::Command`, no shell.

- **jj PATH probing (built).** SSH exec shells are non-login, so jj in
  `~/.cargo/bin` is off PATH. `exec.rs` probes once per connection
  (`command -v` → common dirs → login shell), caches the absolute path, and
  substitutes it. git is invoked bare (it lives in `/usr/bin` in practice).
  A repo mis-detected as git before the probe existed needs remove + re-add.
- **No automatic timeouts** (product decision). A per-repo running banner
  doubles as **Cancel** — it kills the SSH channel / local process and frees
  the repo lock, the escape hatch for a no-TTY auth hang.
- **One remote op per repo.** Fetch/update/push register in a per-repo cancel
  slot (`vcs_ops`, token-guarded); a concurrent second op is refused (UI toast
  + backend error) rather than silently cancelling the first.
- **Per-repo mutation lock** (`repo_guard`) — commits/stages can't race on
  git's `index.lock`. Reads run concurrently.
- **Stable output**: `--color never`, machine formats.
- *Not built:* the once-designed **global concurrency cap (~2)** on status
  calls. Fine in practice; revisit if many live repos storm one host.

## Detection (per repo root)

1. `jj` installed on the host **and** `jj root` succeeds → **jj backend**
   (colocated repos prefer jj — staging UI would be wrong to show).
2. Else `git rev-parse --show-toplevel` succeeds → **git backend**.
3. Else → not a repo (rejected when opening).

A colocated repo where jj isn't installed on *that* host falls back to git.
Since 0.8.15 a colocated repo's backend badge is a **toggle** — click `jj` ⇄
`git` to drive it with either; the choice persists.

## Normalized model

```
VcsRepo {
  backend: "git" | "jj",
  root: string,
  ref: string,                       // git branch | jj bookmark/change summary
  ahead?: number, behind?: number,   // git only
  changes: VcsChange[],
}
VcsChange {
  path: string,
  oldPath?: string,                  // renames
  kind: "modified"|"added"|"deleted"|"renamed"|"untracked"|"conflicted"|"ignored",
  staged?: boolean,                  // git only
}
```

git populates `staged` / `untracked` / `ahead/behind` and (for explorer
dimming) `ignored`. jj produces A/M/D/R + conflicts — it auto-snapshots, so
there is no staging and no "untracked".

## git backend — validated commands

- Detect: `git rev-parse --show-toplevel`
- Status + branch: `git status --porcelain=v2 --branch -z` (plus `--ignored`
  records for explorer dimming)
- Diff old side (Monaco): `git show HEAD:<relpath>` (`:<relpath>` for staged)
- Stage / unstage: `git add -- <path>` / `git reset -q -- <path>`
- Commit / amend: `git commit -m` / `--amend` (`--no-edit` keeps the message)
- Log: `--branches HEAD --topo-order` with parent hashes — the frontend
  computes multi-lane graph edges in `lib/commitGraph.ts`
- Remote: `git fetch` / `git merge --no-edit @{u}` (Update) / `git push`

## jj backend — validated against jj 0.42 (spike)

- Detect / root: `jj root` (exit 0 inside; exit 1 + `Error: There is no jj
  repo` outside).
- Change list: `jj --color never diff --summary` → `M a.txt` / `A b.txt` /
  `D keep.txt` / `R {old => new}`. Empty when clean; `.gitignore` respected.
- Ref / bookmark / description (machine):
  `jj --color never log --no-graph -r '@' -T 'change_id.short() ++ "|" ++ bookmarks ++ "|" ++ description.first_line() ++ "\n"'`
  (`@` usually has no bookmark; the nearest sits on `@-`). Bookmarks:
  `jj --color never bookmark list -T 'name ++ "|" ++ normal_target.change_id().short() ++ "\n"'`
- Diff old side: `jj --color never file show -r '@-' <path>`; an added file
  errors `No such path` → empty old side; renames show the old path.
- Commit model (no staging): **mutations are terminal-driven by design** (see
  "jj is view-first" below) — the app itself only runs read commands plus
  `jj new <bookmark>` (switch), `jj bookmark create`, `jj restore` (discard),
  and `jj git fetch`. Conflicts: `jj resolve --list`.
- **Side effect:** `jj status`/`diff` snapshot the working copy — by design. A
  jj-driven colocated repo gets **only jj commands**, never git mutations
  (avoids `jj git import` desync).

## Repo tracking & refresh (as shipped)

- **Repos are opened explicitly** into the VC panel (folder browser validates
  the pick is a repo; a subdir resolves to the root). Tracked repos persist
  per connection identity; cached status paints instantly on reopen.
- **Local repos are live**: a recursive `notify` watcher on the repo root
  (300 ms debounce → `vcs-fs-change` → refresh), so terminal-side `git add` /
  commits appear by themselves — VS Code-style, watcher-driven, no timers.
- **Remote/WSL repos**: the per-repo **◉ = monitor** (ON by default) —
  status checked every ~5 s while the app window is focused, plus on
  refocus. This closes the terminal-driven loop on remote hosts, where
  there is no watcher. ◉ off = the repo is only touched by your own in-app
  actions (for huge repos, jj's snapshot side effect, slow links). In-app
  saves/file-ops always refresh the containing repo, monitored or not.
  Explicit refreshes: SC-header ⟳ and **F5 / Ctrl+R = app-wide Refresh All**
  (explorer roots + repos + clean tabs; dirty tabs untouched; connections
  and terminals are NOT restarted). Keep **< ~5 monitored** over SSH.
  The card stamp means "**changed** … ago" (last observed change — resets
  on found differences and on in-app saves, never on no-op checks); hover
  it for "checked … ago". Background checks are silent; ⟳/F5 are loud.
- History re-fetches whenever its repo's status refreshes — one refresh
  policy for everything.

## jj is view-first (decision 2026-07-13)

Wrapping jj's verbs in buttons just re-invents git's UI on top of a tool
whose whole point is a different model — and anyone choosing jj knows its
commands. So **Straylight visualizes jj and stays out of its way**: full
status / diffs / decorations / conflicts / multi-lane history, live-updated
by the watcher while you drive jj from the integrated terminal. The only
write controls on a jj card are **bookmark switch/create**, **↩ discard**,
and **⇣ fetch** (it feeds the history view). No commit box, no push, no ⋯
menu for jj — for buttons, flip a colocated repo to **git** with the badge
toggle. (`vcs_describe` / `vcs_squash` were removed with this decision; the
jj arm of `vcs_update` refuses with a hint.)

## UI (as shipped)

- **Tree decorations**: colored letter badges (M/A/D/R/U), folder roll-up,
  ignored files/dirs dimmed (git; jj repos don't dim — no cheap ignored-list
  without touching git in a colocated repo).
- **Repo cards** (right-side Source Control column): header `⎇ history ·
  ◉ live-update (locked on for local — file-watched) · × unpin (confirms)`;
  a header ⟳ in the panel refreshes all repos. The git branch line carries
  **✎ ↑ ⇣ ⋯** — ✎ commit box (modes `Commit | Amend`; Amend enables on
  message OR staged changes), **↑ push** (shows the ahead count, confirms),
  **⇣ fetch & review**, **⋯** `Stash · Pop`. A jj branch line carries **⇣**
  only (view-first). Cards drag-reorder and carry the **owning host's
  color** as a frame.
- **Confirmation tiers**: Fetch never confirms; Update (merge) / Pop confirm
  (they mutate the tree); Push confirms; Amend confirms only when the last
  commit is already pushed. Every confirm is silenceable (`confirms` in
  settings.json).
- **History**: ⎇ opens a full-column panel over the explorer (× restores);
  multi-lane SVG graph (all local branches, lanes capped at 10), click a
  commit → its files → per-commit diffs; ⧉ pops out to an editor tab; "Load
  older commits…" pages.
- **Incoming / remote flow**: **⇣ Fetch & review** fetches and opens history
  with an **Incoming block** (per-branch fetched commits, git) offering
  **Merge / Dismiss**; the branch menu lists `origin/*` — click checks out
  (DWIM tracking branch). Push/fetch run cancellably (see runner).
- **Conflicts**: a red ⚠ group (both backends); git-marker files get Accept
  Current/Incoming/Both lenses and the **⚔ 3-way merge editor** (read-only
  Current | Incoming, editable Result, accept-alls, **Complete merge** =
  save + stage + close); jj's own marker format is hand-edit — it auto-clears
  on the next snapshot. After a conflicted stash-pop: **Drop stash** offered.
- **Status bar**: a contextual `⑂ branch` hint for the focused file's repo.

## Still deferred

Blame; per-hunk staging; the global status concurrency cap; jj ignored-file
dimming; real askpass-style auth prompting (interactive fetch/push auth hangs
on the no-TTY channel — Cancel is the escape; use the terminal). Tracked in
[backlog.md](backlog.md).
