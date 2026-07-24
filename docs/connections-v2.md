# Connections v2 — terminals never die on suspicion

**Status: v2 design, being implemented and field-tested. Supersedes the current
supervisor behavior (and its description in architecture.md) once proven on the
machine that exposed the problem; until then this doc is the spec and the old
behavior is the fallback we can revert to.**

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

## Phase 1 — two pipes (planned)

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

## Phase 2 — transfers that finish (planned)

On lane B: abortive cancel (`select!` against a cancel/epoch signal — cancel
works even mid-hang), epoch-abort when the lane reconnects under a transfer,
and **auto-resume** — the batch continues from the incomplete file
(`.straypart` discipline already makes files atomic), retrying with backoff
until done or cancelled. The progress bar gains a `waiting for connection…`
state. House rule holds: no self-imposed timeouts; the user cancels, not a
timer.

## Phase 2.5 — soft-restore for general terminals (planned)

When a terminal's connection *really* dies: the xterm component and its
scrollback survive in-app; a divider line marks the break; on reconnect a
fresh shell opens in the same component, best-effort `cd` to the last known
cwd; CHAT terminals offer one-click `claude --continue`. Honest restart, zero
context lost in the UI.

## Phase 3 — explicit persistent sessions (last; allowed to fail)

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
