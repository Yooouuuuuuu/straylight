# Straylight docs

The map to everything in `docs/`, and the ledger of *why* the design has
changed over time. Each doc below stays **present-tense — "what it is now"**;
the history of how it got there lives in the ledger at the bottom, so the
design docs don't accrete revision logs and the root `CHANGELOG.md` can stay
code-focused.

## Where things live

- **README** (repo root) — feature-level behavior, for users and contributors.
- **CHANGELOG.md** (repo root) — what shipped, per release. Simple; no deep
  design reasoning (that's here).
- **This file** — the docs map + the design-decision ledger.

### Reference (kept true to the running app)

| Doc | What it is |
|---|---|
| [architecture.md](architecture.md) | The as-built system: process shape, backend modules, frontend state, how a save/transfer/VCS call actually flows. Start here. |
| [stability.md](stability.md) | What 1.0 promises not to break — command ids, `settings.json` keys, VCS semantics — and what it deliberately does not promise. |
| [future-work.md](future-work.md) | The prioritized pool of "might do later", by rough order. |

(The release plan and other working notes live in `docs/dev/`, which is not
published — maintainer material, not user docs.)

### Design records (one per subsystem, present-tense)

| Doc | What it is |
|---|---|
| [data-safety.md](data-safety.md) | How saving works and why edits are never lost: local direct write, remote **staged saves**, **hot-exit drafts**, and the conflict bar. |
| [version-control.md](version-control.md) | git + jj on the host that owns the repo: status, diffs, history, and the **jj view-first** stance. |
| [wsl-connection.md](wsl-connection.md) | Treating a WSL distro as a localhost SSH host (provision `sshd`, skip 9P), and the 1 + 3 WSL model. |
| [connections.md](connections.md) | The four SSH lane kinds per host (main / data / session / transfer), the doubt-is-not-death supervision doctrine, and the pipelined transfer engine. |
| [transfers.md](transfers.md) | Cross-connection file copies: the docked two-pane tool and the streaming, cancel-safe engine. |

### Working material

`docs/dev/` is **gitignored** — session handoffs and manual test plans (e.g.
`data-safety-test-plan.md`). Not design docs; not shipped.

---

## Design-decision ledger

Brief, dated notes on the load-bearing decisions and the places the approach
**changed** — the archaeology the design docs deliberately omit. Newest first.

- **2026-07 · The connection redesign** ([connections.md](connections.md),
  0.9.15+) — the original model was ONE SSH connection per host, multiplexing
  every channel, with an aggressive health supervisor (45 s keepalive kill,
  probe-timeout ×2 → tear down and restart every terminal). Field data broke
  it: a flaky machine lost terminals hourly while plain `ssh` survived for
  days — nearly every death was a self-inflicted false positive. Replaced,
  in phases: **doubt is not death** (probe failures only mark `degraded`;
  teardown needs hard evidence or the user; activity counts as liveness),
  then **lanes** — separate connections for terminals (main), file traffic
  (data), each SESSIONS agent (session, capped with graceful fallback), and
  each running transfer (ephemeral, redialed per retry round). The transfer
  engine grew abortive cancel, epoch-abort, pause/auto-resume, a 32-deep
  pipelined SFTP reader, and Full/Background speed control (Background is
  the shipped default). Rejected along the way: shelling out to scp/rsync
  (credentials would have to leave the process via askpass hacks; Windows
  OpenSSH has no ControlMaster) and invisible tmux-wrapping of normal
  terminals (explicit per-terminal persistence stays a future opt-in). The
  climactic 40× "slow transfers" hunt ended at the **dev profile**:
  unoptimized crypto capped dev builds at ~8 MB/s (release did 330+), fixed
  with `[profile.dev.package."*"] opt-level = 3` and benched by
  `src-tauri/examples/sftp_bench.rs`.

- **2026-07 · The color era** ([stability.md](stability.md), 0.9.12) — every
  hardcoded color was extracted to theme slots (translucent tints via
  `color-mix`), the Straylight identity was designed for real (restrained
  crimson: brand on chrome, red reserved for errors, cool accents for rest)
  and promoted to the shipped defaults — plus a first-party light theme. The
  three per-scope terminal sections collapsed into ONE `terminal` scheme with
  a `terminalHostColor` switch (identity cursor/selection per host); host
  colors became five fixed slots (per-host overrides removed — right-click
  swaps remote *positions* instead), with each built-in theme designing its
  own host family (Local+WSL as a near pair, remotes as a ramp). Lineup went
  from 6 to 6 differently: Crimson and Neon retired, Straylight Light and
  Catppuccin Latte added. Third-party palettes stay authentic (their dim
  comments are theirs); only our themes obey the WCAG floors strictly.

- **2026-07 · Data safety** ([data-safety.md](data-safety.md)) — hot-exit
  drafts and staged remote saves designed together (0.9.5). Staged saves first
  shipped with a *synchronous* ack (the tab waited for the server to confirm),
  then were reworked the same week to an **optimistic background ack**: the
  wait was never load-bearing for safety (drafts + the on-server temp already
  hold the content), so Ctrl+S now returns at dispatch and confirmation is a
  background concern. The save-conflict **modal** was replaced by a per-tab
  **bar** with Ctrl+S blocked until resolved, after testing showed the modal
  could be dismissed by just pressing save again. Rejected along the way:
  `rename`-based atomic replace (breaks inodes/ownership/symlinks) and a
  resident remote agent (see "No remote agent").

- **2026-07 · jj view-first** ([version-control.md](version-control.md), 0.9.1)
  — reversed the earlier "wrap jj's verbs in buttons" approach. jj cards became
  view-only (status, diffs, history, conflicts) with mutations driven from the
  integrated terminal; the commit box, push, squash, and rebase buttons were
  removed for jj. For buttons on a colocated repo, drive it as git via the
  badge toggle. Rationale: jj's model isn't git's, and anyone choosing jj knows
  its commands — re-inventing git's UI on top of it fought the tool.

- **2026-06 · One window, many hosts** ([architecture.md](architecture.md)) —
  multi-window was considered and dropped in favor of a single window holding
  **local + up to 3 WSL distros + up to 3 SSH remotes** at once (grew from one
  remote → 3 remotes at 0.8.12 → 1 + 3 + 3 at 0.9.4). Trees, terminals, VCS,
  search, and transfers are all per-host.

- **2026-06 · Transfers → streaming** ([transfers.md](transfers.md), 0.7.2) —
  the first transfer engine buffered whole files in memory behind a 512 MB cap;
  it was replaced by a **streaming** engine (256 KB chunks, no cap) that
  commits each file via a `.straypart` temp rename, so a cancel or drop never
  corrupts the destination. 0.8.15 docked the two-pane copier into the terminal
  panel as a tool group.

- **2026-06 · WSL over SSH** ([wsl-connection.md](wsl-connection.md), 0.6.0) —
  rejected the slow `\\wsl$` 9P bridge and a VS-Code-style custom agent; instead
  auto-provision `sshd` inside the distro (with consent) and treat it as a
  localhost SSH host, reusing the existing SFTP/PTY/transfer plumbing at native
  ext4 speed.

- **Recurring · No remote agent** — Straylight needs only files, a terminal,
  transfers, and command-exec from a host, and SSH already provides all four.
  A resident agent (however small) is rejected — it would add a cross-compile
  build matrix, die on `noexec` mounts, and change the security posture — until
  a feature that genuinely needs it (remote file-watching, LSP-on-host) makes
  it an *opt-in accelerator*, never a requirement.

- **2026-06/07 · Settings-as-theme** ([stability.md](stability.md), 0.8.9–13) —
  one hand-editable `settings.json` **is** the theme (the color sections live at
  the bottom of it); a "theme" preset just fills those sections. No separate
  user theme files. A hidden `theme.json` holds the saved-theme library only.
