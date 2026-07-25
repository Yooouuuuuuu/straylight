# Connections — lanes, doubt-is-not-death, and the transfer engine

How Straylight holds SSH connections: the four lane kinds, the supervision
doctrine (doubt is not death), and the transfer engine that rides them. The
history of how this replaced the original single-connection design lives in
the [docs/README.md](README.md) ledger.

## The evidence that forced this

On a machine with a flaky uplink: plain `ssh` in a terminal drops **once every
1–2 days**; Straylight connections dropped **hourly**, WSL (loopback! — no
network weather at all) included, every drop restarting every terminal. So the
overwhelming majority of our terminal deaths were **self-inflicted false
positives**, not the network.

Two self-appointed executioners, neither of which plain ssh has:

1. **russh keepalive** — `keepalive_interval: 15s, keepalive_max: 3`: ~45
   seconds without a keepalive reply and russh kills the whole transport.
   OpenSSH defaults to `ServerAliveInterval 0` — it *never* self-kills.
2. **The supervisor probe** — every 12 s, open a throwaway channel with an 8 s
   timeout; two consecutive failures → tear down and reconnect everything.

Both share one TCP stream with bulk SFTP traffic. During a transfer (or under
bufferbloat, CPU load, a standby nap), control replies queue behind data for
seconds — the probes lie, and we execute a healthy connection. All channels are
multiplexed on that one transport, so the blast radius is total: every PTY,
SFTP, forwards.

The cost asymmetry was backwards: a **false** teardown costs the user every
terminal (hence "run everything in tmux," which is stupid); a **true** teardown
detected a minute late costs a spinner.

## Goals (ranked)

1. **Terminals (almost) never disconnect.** Match plain-ssh survival. A user
   must never need tmux just to trust a Straylight terminal.
2. **Transfers finish.** They may pause, wait, retry — but a started transfer
   ends in "done" unless the user cancels.

## The doctrine: doubt is not death

Plain ssh's model, adopted wholesale: **only hard evidence kills a
connection — suspicion never does.** A stalled link and a dead link look
identical from outside; the difference is only ever proven by (a) a transport
error, or (b) the stall ending. So:

- **Doubt** (probe timeout, slow replies) → `Degraded`: amber, everything stays
  open, keep watching. A recovered stall returns to `Connected` with nothing
  lost — which is what actually happens most of the time.
- **Certainty** (russh reports the transport dead, channels error out, the
  hard-silence backstop trips) → `Reconnecting`: the existing
  reestablish-with-backoff loop, unchanged.
- **The user** can always force a reconnect; we never force one on doubt.

## State machine

```
Connecting → Connected ⇄ Degraded → Reconnecting → Disconnected
                 ↑__________________________|
```

| State | Meaning | Channels | UI |
|---|---|---|---|
| `connected` | healthy (traffic or probes confirm) | open | neutral dot |
| `degraded` **(new)** | probes failing/slow, no hard error | **open — nothing is touched** | steady amber dot + toast |
| `reconnecting` | transport confirmed dead; rebuilding | dead (terminals restart on recovery) | pulsing amber |
| `disconnected` | user disconnected, or reconnect refused | closed | red |

`degraded` counts as *usable* everywhere (saves, file ops proceed — channels
are alive, possibly slow). Only `reconnecting`/`disconnected` gate work.

## Phase 0 — defuse the executioners (this change)

On the existing single transport:

- **Keepalive as backstop, not hair-trigger:** interval stays 15 s (NAT
  refresher), `keepalive_max` 3 → **20** (~5 minutes of *total* silence before
  russh declares the transport dead). Brief stalls stop killing; a truly dead
  link still surfaces as a hard error within minutes — and that hard error is
  our legitimate teardown signal.
- **Probe failure → `Degraded`, never teardown.** The probe keeps its 12 s
  cadence and 8 s timeout, but a timeout only marks doubt. A **hard error**
  from the probe (russh says the handle is gone) — confirmed by a second hard
  error after a 2 s beat — is what triggers `Reconnecting`.
- **Activity is liveness.** Any confirmed server response — PTY output, a
  completed SFTP op, a successful channel open — stamps `last_activity`. If
  there was activity within the probe interval, the probe is skipped entirely
  (an active terminal or running transfer *is* the health check). This also
  means bulk load can no longer make the connection look sick: moving bytes
  prove it isn't.
- **Cause-tagged transitions.** Every state change logs *why* (probe timeout
  vs transport error, idle time, degraded duration) so the flaky machine can
  tell us which killer was actually firing.
- **Generous toasts (build-phase rule).** Every state *transition* toasts:
  entered degraded, recovered from degraded, connection lost (with cause),
  reconnected, disconnected. Deliberately chatty while we validate the new
  behavior in the field; we trim after testing. Repeated same-state updates do
  not re-toast.

Expected effect: the hourly machine drops to plain-ssh rates (~days), and when
drops do happen they're real. Terminals survive stalls they used to die in.

## The lanes — one host, three kinds of connection

| Lane | id | Carries | Per host |
|---|---|---|---|
| **Main lane** | `<connId>` | quick terminals (terminal-panel ＋), port forwards, the F11 usage probe | exactly 1 |
| **Data lane** | `<connId>::data` | SFTP + exec — everything that moves *data* rather than keystrokes (transfers, saves, listings, VCS/finders) | at most 1 (lazy) |
| **Session lanes** | `<connId>::session-<k>` | ONE agent's PTY, nothing else | 0…cap (Preferences → Session connections, default 10) |
| **Transfer lanes** | `<connId>::transfer-<k>` | ONE running transfer's bytes | 0…1 per host while a transfer runs (one on each SSH endpoint of a relay) |

Two invariants: the data lane never carries a PTY, and a session lane carries
exactly one session channel (so `MaxSessions` can't touch it). **The ＋ you
press decides the pipe, forever**: SESSIONS panel / F11 ＋ → session lane;
terminal-panel ＋ → main lane, even if the terminal is later docked into the
SESSIONS column. The usage probe stays on main by design — it's a ~10-second
one-shot, the opposite of the long-lived streamers session lanes exist for.

## Phase 1 — two pipes (implemented)

Today's "lanes" are channels — streams inside **one** pipe sharing one TCP
queue, one event loop, one death, one MaxSessions budget. Phase 1 gives each
host **two SSH connections**:

- **Lane A — interactive (sacred):** PTYs + port forwards. Quiet by
  construction; nothing bulky can congest or kill it.
- **Lane B — bulk (expendable):** SFTP + exec. Supervised aggressively,
  rebuilt freely; nothing precious lives there.

Lazy-open lane B on first file op; hosts where a second auth can't be silent
(keyboard-interactive/2FA) fall back to sharing one pipe. MaxSessions pressure
halves as a side effect.

*As built:* the lane is `Connection::data_lane` — dialed on first file op
(`open_sibling`, the `reestablish` flow with a fresh id `<connId>::data`),
supervised in place forever (its `Arc` stays valid across reconnects, which
in-flight transfers rely on), shared-fallback with a 60 s redial cooldown when
the dial fails, torn down with its host on disconnect. SFTP **and exec** ride
it; PTYs and forwards stay on the main lane. Its status events carry the
`::data` id — the UI toasts them with a "(data)" tag and refreshes the tree +
reconciles stranded saves when it reconnects; the host's dot stays owned by
the main lane. Server cost: one extra sshd session process (a few MB) per
host.

## Phase 2 — transfers that finish (implemented)

On lane B: abortive cancel (`select!` against a cancel/epoch signal — cancel
works even mid-hang), epoch-abort when the lane reconnects under a transfer,
and **auto-resume** — the batch continues from the incomplete file
(`.straypart` discipline already makes files atomic), retrying with backoff
until done or cancelled. The progress bar gains a `waiting for connection…`
state. House rule holds: no self-imposed timeouts; the user cancels, not a
timer.

*As built:* every await in the copy (opens, reads, writes, stats, listings,
the commit renames, the parallel measure) races a `TransferInterrupt` watch
channel; user cancel and lane-epoch bumps both trip it. `run_transfer` runs
retry rounds: completed files are remembered (never re-copied; the bar never
moves backwards — an incomplete file's bytes roll back), top-level collision
resolutions are remembered too (a resumed transfer continues into the same
"name copy"), and between rounds the copy parks — amber pulsing bar,
"waiting for connection…" — until every SSH lane reports Connected again.
An op that errors just before the supervisor notices the lane died gets one
probe interval (~15 s) of grace before the error counts as fatal, so a drop
is never misread as a filesystem failure. Genuine filesystem errors on
healthy lanes still fail the transfer immediately after that check.

## Phase D — session lanes (implemented)

Every agent created from the SESSIONS panel or F11 gets **its own SSH
connection** — the per-terminal isolation argument, applied only to the
terminals that earn it (long-lived, output-streaming, precious). A busy agent
can't slow or break any other terminal; an agent's lane dying restarts only
that one agent.

- **Cap + graceful fallback:** per-host cap from Preferences → Session
  connections (default 10, clamp 0–30; 0 = always share). At the cap the
  agent still opens — on the shared main lane, with a toast pointing at the
  setting. A cap only stops connection growth, never work.
- **Dial failure is loud, not masked:** if the dedicated dial fails, nothing
  opens and the toast says why — try again, or open a terminal from the
  terminal panel (shared main lane). Silently sharing would hide a struggling
  host.
- **Serialized dials** per host (cap check + handshake under one lock):
  sshd's MaxStartups never sees a burst from us, and the cap can't be raced
  past.
- **Lifecycle:** closing the agent hangs up its connection (sshd slot freed);
  disconnecting the host sweeps all its session lanes; agents are
  session-only, so there is no restore burst at launch.
- **Plumbing:** the terminal keeps the HOST's `connId` (grouping, colors,
  labels unchanged) and carries `laneConnId` for the PTY only. A main-lane
  reconnect restarts only shared terminals — agents on their own lanes never
  died with it — and vice versa. Toasts name the agent:
  `ubuntu · web-fix: connection lost — reconnecting`.

## Phase T — transfer lanes (implemented)

Every running transfer dials an **ephemeral connection of its own** on each
SSH endpoint — tuned purely for throughput (no compression, 16 MiB receive
window) — so bulk bytes can't congest the data lane's everyday work
(listings, saves, VCS), and a mid-transfer lane death touches nothing else.

- **Profiles per lane kind** (`LaneProfile`): main/session = zlib, ~5 min
  keepalive tolerance, 2 MiB window; data = no zlib, ~5 min, 16 MiB;
  transfer = no zlib, **~1 min** keepalive, 16 MiB — transfer lanes have no
  supervisor, so the impatient keepalive is what declares a silent corpse,
  and misjudging a stall costs nothing (the retry round just redials).
- **Redial, don't nurse:** each retry round resolves fresh endpoints — a new
  transfer lane per side (data-lane fallback if the dial fails), backoff
  between rounds (1→30 s, reset whenever a round moves bytes), racing user
  cancel. The old wait-for-supervised-lane logic is gone.
- **Error classification by probing:** when a round errors, the lanes are
  probed *before* being hung up — a lane that answers means the error was a
  genuine filesystem error (fatal); silence means redial and resume.
- **Lifecycle:** registered under `<connId>::transfer-<k>` so the
  host-disconnect sweep and `backend_reset` kill them with everything else;
  dropped (bounded) at round end; clean closes are toast-silent.

## Phase T3 — deep-pipelined SFTP (implemented)

Two truths came out of the speed hunt (see `examples/sftp_bench.rs`, the
standalone harness that settled it): the ~7 MB/s dev-build ceiling was
**unoptimized crypto in the dev profile** (fixed via
`[profile.dev.package."*"] opt-level = 3` — same stack does 330+ MB/s
optimized), and, independently, russh_sftp drives reads ONE request at a
time — a real chunk-per-round-trip ceiling on high-latency routes that this
phase removes.

- **Reads:** files ≥ 4 MiB stream through `transport/pipeline.rs` — a
  dedicated raw SFTP channel with **32 requests (~8 MiB) standing**, the grid
  planned from the stat'd size, short reads rescheduled, completions
  reassembled strictly in order. Cancel aborts the pump and closes the handle
  detached + bounded (at worst a leaked handle dies with its ephemeral
  transfer lane). Small files keep the serial reader — the pipeline's ~3
  setup round trips would cost more than they save.
- **Writes:** russh_sftp already pipelines write acks; its default depth of 8
  (≈54 MB/s on a 37 ms route) is raised to **32** on our sessions.
- The 16 MiB lane windows (Phase T profiles) are what give both pipelines
  room to stand.

## Phase T4 — user speed control (implemented)

The confirm sheet picks **Full / Background** per transfer (remembered for
the session; Preferences → Transfers holds the limit + the default mode,
which ships as Background; downloads use the default). Background = read
pipeline depth 4 (vs 32) plus pacing in the relay pump — the pump sleeps off
any lead over the cap, racing the interrupt so cancel stays instant.

The limit is the machine's **total real-network budget** (golden rule: set
10, never exceed 10 on the wire). A relay carries the same payload byte on
every leg, so payload is paced at budget ÷ the number of legs crossing the
real interface — remote⇄remote counts 2, local⇄remote and wsl⇄remote count 1
(loopback legs are free) — shaved ~3% for SSH framing. This is exact, not
adaptive: the legs are one coupled pipeline, so the arithmetic *is* the
measurement.

## Phase 2.5 — soft-restore for general terminals (planned)

When a terminal's connection *really* dies: the xterm component and its
scrollback survive in-app; a divider line marks the break; on reconnect a
fresh shell opens in the same component, best-effort `cd` to the last known
cwd; CHAT terminals offer one-click `claude --continue`. Honest restart, zero
context lost in the UI.

## Phase 3 — explicit persistent sessions (parked → docs/future-work.md)

A separate **"＋ persistent session"** button (Sessions panel / FocusView) for
terminals that must survive disconnects for real. That terminal — and only
that one — runs inside a Straylight-managed tmux (`-L straylight`,
`-f /dev/null`, `prefix None`, status off, no-alt-screen, `capture-pane`
replay on reattach), wears a badge, reattaches across drops and app restarts,
and is killed on explicit tab close (leftovers surfaced on connect:
reattach/kill). If tmux isn't on the host, the button says so — no
auto-install, no wrapping of normal terminals, ever. Regular terminals stay a
pure mirror of ssh: users who want their own tmux just run it, untouched.

If this phase fights us, we drop it; phases 0–2.5 stand on their own.

## Not doing

- Invisible tmux-wrapping of normal terminals (confusing exactly for tmux
  users; violates "mirror the tool, never invent semantics").
- mosh (parallel protocol stack, UDP, no SFTP integration).
- Uploading our own persistence agent binary to hosts.
- PTY resurrection over plain sshd — protocol-impossible; only Phase 3 covers
  it, opt-in.

## Test plan

- **Mock hung transport (unit):** a `FileTransport`/probe whose future never
  resolves — assert doubt → `Degraded`, no teardown; assert hard error →
  `Reconnecting`; assert cancel interrupts a hung transfer read (Phase 2).
- **Severed-link walk (manual):** during an active transfer and an active
  terminal — firewall-drop the SSH port (silent stall) → expect `Degraded`,
  terminals stay, link restored → `Connected`, nothing restarted. Then
  RST/kill the connection (hard death) → expect `Reconnecting` + terminal
  restart + (Phase 2) transfer auto-resume.
- **The flaky machine:** run Phase 0 for a day; the cause-tagged logs decide
  what (if anything) still needs tuning before Phase 1.

## Tuning knobs (Phase 0 constants)

| Knob | Value | Meaning |
|---|---|---|
| `keepalive_interval` | 15 s | NAT/liveness ping (unchanged) |
| `keepalive_max` | 20 | ~5 min total silence → transport declared dead (was 3 / ~45 s) |
| `PROBE_INTERVAL_SECS` | 12 s | probe cadence when idle (skipped when traffic flowed) |
| `PROBE_TIMEOUT` | 8 s | probe timeout → *doubt only* |
| hard-death confirm | 2 s beat, 2nd hard error | teardown requires two hard errors in a row |
