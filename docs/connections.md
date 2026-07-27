# Connections — lanes, doubt-is-not-death, and the transfer engine

How Straylight holds SSH connections: the four lane kinds, the supervision
doctrine (doubt is not death), and the transfer engine that rides them. Why
this replaced the original single-connection design is in the
[docs/README.md](README.md) ledger.

## The doctrine: doubt is not death

Straylight adopts plain ssh's survival model wholesale: **only hard evidence
kills a connection — suspicion never does.** A stalled link and a dead link
look identical from outside; the difference is only ever proven by (a) a
transport error, or (b) the stall ending. So:

- **Doubt** (probe timeout, slow replies) → `Degraded`: amber, everything stays
  open, keep watching. A recovered stall returns to `Connected` with nothing
  lost — which is what happens most of the time.
- **Certainty** (russh reports the transport dead, channels error out, the
  hard-silence backstop trips) → `Reconnecting`: reestablish with backoff.
- **The user** can always force a reconnect; Straylight never forces one on doubt.

The reason this matters: the original one-connection-per-host design
self-inflicted the overwhelming majority of its terminal deaths. On a flaky
uplink it dropped hourly (WSL loopback included) where plain ssh dropped once
every day or two — false positives from an eager keepalive and probe that
shared one TCP stream with bulk SFTP, so a busy transfer made a healthy link
look dead and restarted every terminal. The cost was backwards: a false
teardown costs the user every terminal; a true teardown caught a minute late
costs a spinner.

### State machine

```
Connecting → Connected ⇄ Degraded → Reconnecting → Disconnected
                 ↑__________________________|
```

| State | Meaning | Channels | UI |
|---|---|---|---|
| `connected` | healthy (traffic or probes confirm) | open | neutral dot |
| `degraded` | probes failing/slow, no hard error | **open — nothing is touched** | steady amber dot + toast |
| `reconnecting` | transport confirmed dead; rebuilding | dead (terminals restart on recovery) | pulsing amber |
| `disconnected` | user disconnected, or reconnect refused | closed | red |

`degraded` counts as *usable* everywhere (saves and file ops proceed — channels
are alive, possibly slow). Only `reconnecting`/`disconnected` gate work.

### Supervision

- **Keepalive is a backstop, not a hair-trigger.** 15 s interval (a NAT
  refresher); `keepalive_max` 20 → ~5 minutes of *total* silence before russh
  declares the transport dead. Brief stalls don't kill; a truly dead link still
  surfaces as a hard error within minutes, and that hard error is the
  legitimate teardown signal.
- **A probe timeout is doubt, not death.** The probe runs every 12 s with an
  8 s timeout, but a timeout only marks `Degraded`. A **hard error** from the
  probe (russh says the handle is gone), confirmed by a second hard error after
  a 2 s beat, is what triggers `Reconnecting`.
- **Activity is liveness.** Any confirmed server response — PTY output, a
  completed SFTP op, a channel open — stamps `last_activity`; if there was
  activity within the probe interval, the probe is skipped (an active terminal
  or running transfer *is* the health check). Bulk load can't make the
  connection look sick — moving bytes prove it isn't.
- **One toast per host.** Only the main lane — the host itself — toasts its
  transitions (degraded, recovered, lost with cause, reconnected,
  disconnected). Secondary lanes are internal plumbing and never toast; each
  shows its state where it belongs (an agent's CHAT dot, the transfer's
  progress bar, the file tree). A whole-host bounce reads as one host toast,
  not a per-lane wall. Hover a host's dot for the fan-out: "main + N agent
  connections".

## The lanes — one host, several connections

Straylight gives each host not one connection but a set, so the precious
traffic (keystrokes) never shares a pipe with the bulky traffic (bytes):

| Lane | id | Carries | Per host |
|---|---|---|---|
| **Main lane** | `<connId>` | quick terminals (terminal-panel ＋), port forwards, the F11 usage probe | exactly 1 |
| **Data lane** | `<connId>::data` | SFTP + exec — everything that moves *data* rather than keystrokes (transfers, saves, listings, VCS/finders) | at most 1 (lazy) |
| **Session lanes** | `<connId>::session-<k>` | ONE agent's PTY, nothing else | 0…cap (Preferences → Session connections, default 10) |
| **Transfer lanes** | `<connId>::transfer-<k>` | ONE running transfer's bytes | 0…1 per host while a transfer runs |

Two invariants: the data lane never carries a PTY, and a session lane carries
exactly one session channel (so `MaxSessions` can't touch it). **The ＋ you
press decides the pipe, forever:** SESSIONS panel / F11 ＋ → session lane;
terminal-panel ＋ → main lane, even if the terminal is later docked into the
SESSIONS column. The usage probe stays on main — it's a ~10-second one-shot,
the opposite of the long-lived streamers session lanes exist for.

- **The data lane** dials on the first file op and is supervised in place
  forever (its `Arc` stays valid across reconnects, which in-flight transfers
  rely on). A host where a second auth can't be silent
  (keyboard-interactive/2FA) falls back to sharing the main lane, with a 60 s
  redial cooldown. On reconnect it refreshes the tree and reconciles stranded
  saves. Cost: one extra sshd session process (a few MB) per host.
- **Session lanes** apply per-terminal isolation only to the terminals that
  earn it — long-lived, output-streaming agents. A busy agent can't slow or
  break any other terminal, and an agent's lane dying restarts only that agent.
  Dials are serialized per host (so sshd's MaxStartups never sees a burst) and
  capped (default 10, clamp 0–30; 0 = always share); at the cap the agent opens
  on the shared main lane with a toast pointing at the setting, and a failed
  dial opens nothing and says why. Closing the agent frees its sshd slot;
  disconnecting the host sweeps all its session lanes. The terminal keeps the
  host's `connId` (grouping, colors, labels unchanged) and carries `laneConnId`
  for the PTY only.
- **Transfer lanes** are ephemeral, dialed per running transfer on each SSH
  endpoint and tuned purely for throughput — see the transfer engine below.

Each lane kind carries a tuned `LaneProfile`: main/session use ~5 min
keepalive tolerance and a 2 MiB window; data widens to 16 MiB; transfer widens
to 16 MiB and uses an impatient ~1 min keepalive (a transfer lane has no
supervisor, so its keepalive is what declares a silent corpse — and misjudging
a stall costs nothing, the retry round just redials).

No lane offers compression, and rekey limits are explicit: rekey by data
volume (~1 GiB) only, never by the clock — matching stock OpenSSH
(`Compression no`, `RekeyLimit default none`). zlib@openssh.com is broken in
russh against OpenSSH strict-kex — a compressed lane died at its first rekey
(the source of the "terminals drop hourly" field bug) — and terminal-text
savings never justified carrying that risk (docs/dev/russh-upgrade.md).

## The transfer engine

A started transfer ends in "done" unless the user cancels — it may pause, wait,
and retry, but it finishes.

- **Abortive cancel.** Every await in the copy (opens, reads, writes, stats,
  listings, the commit renames, the parallel measure) races a
  `TransferInterrupt` watch channel, so cancel works even mid-hang. User cancel
  and a lane-epoch bump (the lane reconnected under the transfer) both trip it.
- **Auto-resume.** `run_transfer` runs retry rounds: completed files are
  remembered and never re-copied (the bar never moves backwards; an incomplete
  file's bytes roll back), and top-level collision choices are remembered (a
  resumed transfer continues into the same "name copy"). Between rounds the copy
  parks — amber "waiting for connection…" — until every SSH lane reports
  Connected again. Files commit atomically via a `.straypart` temp rename, so a
  cancel or drop never corrupts the destination.
- **Redial, don't nurse.** Each retry round resolves fresh endpoints and dials a
  new transfer lane per side (data-lane fallback if that dial fails), with
  backoff (1→30 s, reset whenever a round moves bytes). When a round errors, the
  lanes are probed *before* being hung up: a lane that answers means a genuine
  filesystem error (fatal); silence means redial and resume. An op that errors
  just before the supervisor notices the lane died gets one probe interval
  (~15 s) of grace, so a drop is never misread as a filesystem failure.
- **Deep-pipelined SFTP.** Files ≥ 4 MiB stream through a dedicated raw SFTP
  channel with **32 requests (~8 MiB) standing** — the grid planned from the
  stat'd size, short reads rescheduled, completions reassembled strictly in
  order. Smaller files keep the serial reader (the pipeline's ~3 setup round
  trips would cost more than they save). Writes raise russh_sftp's pipeline
  depth from 8 to 32; the 16 MiB transfer-lane window gives both room to stand.
  (The dev build once capped at ~7 MB/s — that was unoptimized crypto in the
  dev profile, fixed with `[profile.dev.package."*"] opt-level = 3`; the same
  stack does 330+ MB/s optimized. `examples/sftp_bench.rs` settled it.)
- **Full / Background speed control.** The confirm sheet picks Full or
  Background per transfer (remembered for the session; Preferences → Transfers
  holds the limit and the default mode, shipped as Background; downloads use the
  default). Background drops the read pipeline to depth 4 and paces the relay
  pump with a token bucket shared by every concurrent stream — accruing at the
  cap, carrying at most one chunk (so a slow stretch banks no credit to burst
  past the limit later), each pump repaying the chunk it just wrote and racing
  the interrupt so cancel stays instant. The limit is the machine's **total
  real-network budget** (set 10, never exceed 10 on the wire): a relay carries
  the same payload byte on every leg, so payload is paced at budget ÷ the legs
  crossing the real interface — remote⇄remote counts 2, local⇄remote and
  wsl⇄remote count 1 (loopback legs are free) — less ~3% for SSH framing. Exact,
  not adaptive: the legs are one coupled pipeline, so the arithmetic *is* the
  measurement.

## Not doing

- Invisible tmux-wrapping of normal terminals (confusing exactly for tmux users;
  violates "mirror the tool, never invent semantics").
- mosh (parallel protocol stack, UDP, no SFTP integration).
- Uploading our own persistence agent binary to hosts.
- PTY resurrection over plain sshd — protocol-impossible; only the parked,
  opt-in tmux-backed persistent-session design ([future-work.md](future-work.md))
  covers it.

Two ideas that grew out of this design but sit outside it — soft-restore for
session-lane terminals and an explicit tmux-backed persistent-session button —
are parked in [future-work.md](future-work.md).

## Reference — supervision constants

| Knob | Value | Meaning |
|---|---|---|
| `keepalive_interval` | 15 s | NAT / liveness ping |
| `keepalive_max` | 20 | ~5 min total silence → transport declared dead |
| `PROBE_INTERVAL_SECS` | 12 s | probe cadence when idle (skipped when traffic flowed) |
| `PROBE_TIMEOUT` | 8 s | probe timeout → doubt only |
| hard-death confirm | 2 s beat, 2nd hard error | teardown requires two hard errors in a row |
