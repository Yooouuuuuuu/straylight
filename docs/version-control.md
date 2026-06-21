# Version control (Phase 3) — git + jj

Status panel, tree decorations, diffs, and commit — for **git** and **Jujutsu
(jj)**, on local, WSL, and remote hosts. Read + local mutations (status / diff /
stage / commit) are in scope; push/pull is deferred to the built-in terminal for
now (see "Out of scope").

## Core insight

We don't have a local clone — Straylight browses files live over SFTP. So VCS
operations on a remote repo **run the VCS binary on the host that owns the repo**,
through the SSH connection we already hold. There is nothing local to point a
library at. This also means VCS identity (commit author, push credentials) is the
*host's* — a commit made through Straylight is identical to one you'd make SSH'd in
by hand (right author, hooks fire, signing works).

## Why exec, not a library (libgit2 / git2)

- libgit2 only works on a **local working copy**, which we don't have for remotes —
  so we'd need the exec path anyway, and end up maintaining two engines.
- jj is **not** libgit2; a library buys us nothing for jj. Exec runs `git` and `jj`
  through the same channel.
- Exec inherits the user's real git/jj: config, hooks, credential helpers, signing,
  LFS. A reimplementation gets author/hooks/signing subtly wrong.

Cost: depends on the binary being installed on the host, and we parse output — but
only the **stable machine formats** (validated below), never human text.

## The CommandRunner (exec engine)

A transport-aware runner: `run(connId, cwd, argv) -> { stdout, stderr, code }`.

- **Remote / WSL:** open a channel (same primitive SFTP/PTY use), `channel.exec`,
  collect `Data` (stdout) + `ExtendedData` (stderr) until `Eof`/`Close`, capture
  `ExitStatus`. WSL is SSH-to-localhost, so it's covered by the remote path.
- **Local:** `tokio::process::Command` with argv (no shell).

Must-haves baked in:

- **Binary PATH resolution.** An SSH *exec* shell is non-login/non-interactive and
  often lacks the user's full PATH. git is usually in `/usr/bin` (fine), but **jj is
  commonly in `~/.cargo/bin` / `~/.local/bin`** which exec won't see. Resolve each
  binary's absolute path once per host (`command -v` / `bash -lc`) and cache it.
  This is the single most likely "works in terminal, not in app" bug.
- **No automatic timeouts.** Per the product decision, we do **not** auto-pause or
  time out a "slow" repo. A per-repo **running/consuming icon** shows activity; it
  doubles as a **user-initiated cancel** (tears down the channel). The only
  automatic teardown is on disconnect. The user decides.
- **Per-repo mutation serialization.** Reads (status/diff/log) run concurrently;
  mutations (`git add`/`commit`) take `index.lock`, so serialize them per repo.
- **Stable output.** `--color never`, no pager, machine formats, `LC_ALL=C` for git.
- **Global concurrency cap** (~2) on status calls so N eager repos can't storm a host.

## The Vcs seam

One backend boundary, two implementations, producing a **normalized model** the UI
consumes without caring which VCS.

### Detection (per repo root) — the spine of Phase 3

1. If `jj` is installed on the host **and** `jj root` succeeds in the dir → **jj
   backend** (root = its output). A colocated repo has both `.jj` and `.git`; we
   prefer jj because the user is driving with jj (staging would be wrong to show).
2. Else if `git rev-parse --show-toplevel` succeeds → **git backend**.
3. Else → **not a repo** (reject when opening; no decoration).

A jj-colocated repo where jj isn't installed on *that* host gracefully falls back to
the git backend.

### Normalized model

```
VcsRepo {
  backend: "git" | "jj",
  root: string,                 // toplevel
  ref: string,                  // git branch | jj bookmark/change summary
  ahead?: number, behind?: number,   // git only; jj: none
  changes: VcsChange[],
}
VcsChange {
  path: string,
  oldPath?: string,             // renames
  kind: "modified"|"added"|"deleted"|"renamed"|"untracked"|"conflicted",
  staged?: boolean,             // git only; jj ignores
}
```

git populates `staged`, `untracked`, `ahead/behind`. jj produces only
A/M/D/R + conflicts (it auto-snapshots — no staging, no "untracked" state).

## git backend — validated commands

- Detect: `git rev-parse --show-toplevel`
- Status + branch: `git status --porcelain=v2 --branch -z`
  (XY codes per file; `# branch.head`, `# branch.ab +A -B`)
- Diff old side (for Monaco): `git show HEAD:<relpath>` (or `:<relpath>` staged)
- Stage / unstage: `git add -- <path>` / `git reset -q -- <path>`
- Commit: `git commit -m <msg>`

## jj backend — validated against jj 0.42.0 (spike)

All confirmed working in a colocated repo; outputs are clean and delimiter-friendly.

- Detect / root: `jj root` → prints root, exit 0 inside; `Error: There is no jj repo`,
  exit 1 outside.
- Change list: `jj --color never diff --summary` →
  ```
  M a.txt
  A b.txt
  D keep.txt
  R {ren.txt => ren2.txt}
  ```
  Empty when clean. Renames are `R {old => new}`. No staged/untracked dimension —
  new files auto-appear as `A`; `.gitignore` is respected.
- Ref / bookmark / description (machine):
  `jj --color never log --no-graph -r '@' -T 'change_id.short() ++ "|" ++ bookmarks ++ "|" ++ description.first_line() ++ "\n"'`
  The working copy `@` usually has no bookmark; the nearest bookmark sits on `@-`
  (template it too). Bookmarks list:
  `jj --color never bookmark list -T 'name ++ "|" ++ normal_target.change_id().short() ++ "\n"'`
- Diff old side (for Monaco): `jj --color never file show -r '@-' <path>` → parent
  content. An **added** file errors `No such path` (exit 1) → treat as empty old
  side. For a rename, old = `file show -r '@-' <oldpath>`.
- Commit model (no staging): `jj describe -m <msg>` (set message) + `jj new` (start a
  new change).
- **Side effect:** `jj status`/`diff` snapshot the working copy into `@` — by design.
  So a jj "refresh" mutates the working-copy commit. Backends stay clean: a
  jj-driven colocated repo gets **only jj commands**, never git mutations (avoids
  `jj git import` desync).

(For a unified-patch fallback, `jj diff --git` emits standard git-format patches —
but the Monaco diff editor wants old+new text, so we use `file show` + the working
file.)

## Repo tracking model (the product decisions)

- **Repos are opened explicitly into the right-side VC panel** — not auto-derived
  from explorer pins. Adding reuses the in-app folder browser, but **validates the
  pick is a repo** (via the runner: `jj root` / `git rev-parse`); a non-repo is
  rejected ("Not a git or jj repository"). Picking a subdir resolves to the repo
  root.
- **Eager is off by default.** A newly added repo shows cached/local data and does
  not auto-refresh. **First add does one populate refresh** so the card isn't empty;
  after that it's quiet until toggled.
- **Per-repo controls:** an **eager toggle** (live updates when on), a **manual
  refresh** button, and a **running/consuming icon** that shows activity and
  doubles as cancel. No auto-timeout/auto-pause — the user decides.
- **No hard cap** on repo count. Guidance to keep **< ~5 eager** for snappy updates
  goes in the README on its future rewrite (tracked in `docs/backlog.md`).
- **Persisted status** per repo, keyed by repo identity (`user@host:port` + root for
  remote, distro + root for WSL, root for local) — so decorations paint instantly
  from cache on reopen/reconnect, then refresh on demand.

### Refresh policy

- First add: one refresh. Eager on: debounced (~400 ms), **affected-repo-only**
  after a save/file-op (never "all repos"). Eager off: cached until manual refresh.
- All status calls go through the global concurrency cap. Mutations serialize
  per repo. No automatic timeouts.

## UI surfaces

- **Tree decorations (shared).** Color the filename + a letter badge (M/A/D/R/…),
  roll child changes up to collapsed folders. Derived from a tracked repo's status
  (cached or live). Dracula colors: modified=orange, added=green, deleted=red,
  renamed=blue, conflicted=red.
- **Diff viewer (shared) — a new editor tab type.** Monaco's diff editor; new side =
  working file (read over SFTP), old side = `git show HEAD:path` / `jj file show
  -r @- path`. Added → empty old; deleted → empty new; binary → skip.
- **Right-side Source Control panel.** A collapsible, resizable third window column
  (`sidebar | editor | SCM`), hidden when no repos, layout persisted. A stack of
  per-repo **cards**:
  - git card: branch + ahead/behind, **Staged / Changes** sections, stage/unstage,
    commit box.
  - jj card: bookmark/change summary, single change list (no staging), a
    **description** field (`jj describe`) + **New change** (`jj new`).
- **Status bar:** a contextual branch hint for the focused file's repo (not a
  limiter — the panel is the multi-repo surface).

## Out of scope (Phase 3 v1)

Commit **log/history graph**, **blame**, **push/pull UI** (use the terminal — it has
a real PTY + the host's agent), **merge/rebase tooling**, **conflict-resolution
editor**, **ignored-file dimming**. Addable later.

## Slice plan

1. **Runner + Vcs seam + git status → tree decoration + status-bar hint.** Read-only.
   The exec engine lives here (biggest chunk).
2. **jj status backend** — right after git, before any UI forks, to validate the
   seam with a second backend while the surface is still backend-agnostic
   decorations.
3. **Diff viewer** (new diff tab), shared by both backends.
4. **SCM panel + commit:** git (stage/commit) first, then the jj fork (describe/new).

Push/pull stays in the terminal (no build).
