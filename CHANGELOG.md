# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

Entries record *what shipped*, kept simple. The *why* behind a design — and the
history of design changes — lives in the docs: the decision ledger in
[docs/README.md](docs/README.md) and the per-subsystem design docs.

## [Unreleased]

### Planned

- **Auto-update** — ships with 0.10 (updater keypair + GitHub Releases).

## [0.9.18] - 2026-07-26

Quieter connections: a host bounce used to throw a toast per lane — main, data,
and every agent's session and transfer lane. Lanes went silent (each state now
shows where it lives) and only the host itself still toasts; hover a host's dot
for its live lane count.

### Changed

- **Connection toasts no longer come as a wall.** A host bounce used to fire a
  toast per lane — main, data, and every agent's session and transfer lane —
  so one blip could throw a dozen-plus toasts. Lanes are internal plumbing, so
  they no longer toast at all; each lane's state shows where it belongs (an
  agent's CHAT dot, the transfer's progress bar, the file tree), and only the
  host itself still toasts. Because a whole-host bounce takes the main lane
  too, that host toast is already the one-per-host summary — "ubuntu:
  connection lost — reconnecting…" then "back" — with no per-lane noise and no
  artificial delay. Also gone: the "dedicated connection opened" toast on every
  agent, and the transfer paused/resumed toasts (the progress bar already says
  "waiting for connection… resumes by itself"). The lane fan-out that used to
  live in toasts is now on demand — hover a host's dot to see "main + N agent
  connections".

## [0.9.17] - 2026-07-26

The small-file round: a folder of thousands of tiny files no longer crawls at
KB/s — a streaming walker feeds a dispatcher of 32 fungible slots (at most one
big file in flight at a time), the Background cap became a leak-proof token
bucket, and the progress bar learned to show time remaining. Around it, a
status bar that sheds detail by measured priority and right-click menus that
always stay on screen.

### Added

- **Time remaining on the progress bar.** Once the total size is known, the
  readout shows a coarse estimate (`~3m 20s`) computed from the same
  smoothed rate as the MB/s figure, so the two never disagree. It hides
  while the total is still calculating, while the transfer is waiting on a
  reconnect, and until the rate has a second of samples behind it.

### Changed

- **The status bar sheds by priority as it narrows, measured not guessed.** It
  used to drop file-info at fixed window widths, which couldn't tell when the
  panel buttons actually met the content. Now the bar measures its own overflow
  and sheds in order: first the four panel buttons go icon-only the moment they
  touch anything, then file info drops one item at a time (branch, path,
  Ln/Col, EOL, encoding, language), then — last — the transfer readout trims
  from the left (label, file count, bytes, percent). The transfer floor
  (2.0 MB/s · ~3m 20s · ✕) and the notification bell always survive, so the
  tightest bar is four button icons + the transfer floor + the bell. Room
  coming back restores items in reverse with exact hysteresis (no flicker).
- **Right-click menus always stay on screen.** Menus opened near the right or
  bottom edge could spill past the window and hide their lower items. Every
  context menu — file tree, editor tab, CHAT agent, explorer drop, Finder
  result, transfer pane, and the text-field menu — now measures its real
  rendered size and nudges back inside the window (8px margin). Three menus
  had no clamping at all and two clamped against guessed dimensions that broke
  when the menu grew a row; all seven now share one measured positioner.
- **Swapping terminal hosts lands on that host's newest shell.** Clicking a
  host in the terminal bar used to jump to its oldest terminal; it now selects
  the most recent one, so bouncing away and back returns you where you were
  working.
- **Folders full of small files no longer crawl.** A tiny file's cost is its
  round trips (open, write, rename, close), not its bytes — copied strictly
  one after another they capped a big tree at KB/s. A walker now streams the
  tree into bounded queues while a dispatcher copies alongside through
  **32 fungible slots**: any slot takes any file, but at most ONE holds a
  big (> 4 MiB) file at a time — one 32-deep pipelined stream fills the
  wire; a second would split it, not add to it — and a waiting big file
  starts ahead of queued smalls. The first file starts on the first listing,
  never a blocking pre-pass. The walk trusts directory-listing metadata
  instead of re-stat'ing every child (one round trip saved per file), and
  SFTP requests can finally overlap at all — the session used to sit behind
  a lock held across each whole operation. Broken-symlink tolerance is
  unchanged: dangling links still skip-and-report.
- **The Background cap can no longer be overshot.** Pacing used to hold the
  since-start average under the limit, so a stretch spent below the cap
  (small files are latency-bound) banked credit the next big file could ride
  visibly past the limit — set 2 MB/s, see 3. It is now a token bucket
  shared by every concurrent stream: budget accrues at the cap and carries
  over at most one chunk, so the wire rate holds the limit no matter what
  came before.

## [0.9.16] - 2026-07-26

The speed round: every transfer gets its own tuned connection and a 32-deep
pipelined reader, the 40× dev-build slowdown turned out to be unoptimized
crypto (one profile line), and a Full/Background speed control with a
never-exceed network budget ships on the confirm sheet.

### Added

- **Transfer lanes** (Phase T of
  [docs/connections.md](docs/connections.md)). Every running transfer
  now dials an ephemeral SSH connection of its own on each endpoint — tuned
  purely for throughput (no compression, a 16 MiB receive window, an
  impatient ~1 min keepalive) — so bulk bytes can't slow the explorer, saves,
  or VCS riding the data lane, and a mid-transfer connection death touches
  nothing else. Retry rounds redial fresh lanes with backoff instead of
  waiting on a reconnect, and a round's error is classified by probing: a
  lane that still answers means a real filesystem error (fails properly);
  silence means redial and resume. Lanes hang up when the transfer ends and
  fall back to the shared data lane if the dial fails.
- **Live transfer speed.** The status-bar readout and the Transfers panel now
  show the current rate — `… · 45 MB/2.1 GB · 34% · 87 MB/s ✕` — computed
  from progress frames, steady over ~1 s windows, including while the total
  is still being calculated (the download case).

### Fixed

- **The 40× transfer slowdown — solved, and the culprit was the dev profile.**
  A standalone bench (`examples/sftp_bench.rs`, kept for future perf work)
  finally isolated it: the identical russh stack moves **330+ MB/s in a
  release build and ~8 MB/s in a debug build** — every `tauri dev` transfer
  was CPU-bound on unoptimized cipher code, which masqueraded as a
  network/protocol problem across two machines and three red herrings.
  Dependencies now compile with `opt-level = 3` even in dev
  (`[profile.dev.package."*"]`); our own crate stays unoptimized for fast
  rebuilds. Dev-build transfers went from 7 → **500+ MB/s** on the same
  route; packaged builds were always release and unaffected.
- **The hunt's side quests were real improvements and stay.** Large files
  read through a **32-deep pipelined SFTP reader** (~8 MiB standing on a
  dedicated channel, short-read rescheduling, in-order reassembly) and
  uploads pipeline 32 write acks (was 8) — on high-latency routes these are
  the difference between chunk-per-round-trip and bandwidth-bound, exactly
  how modern scp works. `TCP_NODELAY` is set on every connection (russh never
  sets it), and bulk lanes negotiate no compression with 16 MiB windows.

### Added

- **Transfer speed control: Full / Background.** The confirm sheet grew a
  speed pick next to Cancel/Copy — **Full** uses everything your network
  gives; **Background** (the shipped default) stays under the limit and is
  the safer choice while you work. The sheet remembers your last pick for the
  session; Preferences → **Transfers** holds the limit (MB/s; 0 = no cap,
  still a shallow pipeline) and the default mode. Downloads — which have no
  sheet — always use the default. A relay's two legs share the transfer's one
  choice, and the cap is enforced in the relay pump, racing the interrupt so
  cancel stays instant even mid-sleep. The limit is your machine's **total
  network budget — set 10, never exceed 10 on the wire**: a remote⇄remote
  relay (which crosses your interface twice) paces payload at half the
  budget, loopback legs (WSL, local) count as free, and a ~3% shave covers
  SSH framing so the wire stays under the typed number.

### Changed

- **The Transfers panel header is one line, and the picker is the identity.**
  The host `<select>` itself reads `Ubuntu (user@ip)` in the host's color,
  followed by the pane's two buttons (hidden files, open-a-folder); the
  separate uppercase label line is gone. The `.straypart` temp is also now
  deleted on a manual cancel (time-bounded; a lane-reset still leaves it for
  the auto-resume to finish).
- **The connections doc dropped its "v2".** `docs/connections-v2.md` →
  `docs/connections.md` (present-tense, like every design doc); the story of
  what it replaced and why lives in the design-decision ledger in
  `docs/README.md`.

## [0.9.15] - 2026-07-25

The stability-under-fire round: a reloaded page sweeps its orphans instead of
wedging the backend, transfers stopped paying the compression tax and got a
double-buffered relay, and the Source Control history rows learned to fold.

### Changed

- **History ref chips fold instead of overflowing.** A tip commit carrying
  HEAD + branch + remote branch + tag was wider than the Source Control
  panel, crushing the subject. Rows now show at most two ref chips and fold
  the rest into a "+N" chip, and every commit row carries ONE tooltip with
  the full story — HEAD, every ref, and the commit message (deduped, so a
  tag commit whose message is the tag reads as one line). `origin/HEAD` —
  the remote's default-branch pointer, which always shadows `origin/main` —
  is hidden, and long branch names clip at a max chip width. Rows stay one
  line, so the commit graph keeps its fixed geometry.
- **The four panel buttons never squeeze.** In a crowded status bar (between
  the info ladder's breakpoints) the buttons could be compressed with their
  labels still showing. They're rigid now: full width with labels, one jump
  to icon-only below 720px — no crushed in-between state.
- **Session focus (F11) locks the title bar's app surfaces.** The ⌘ palette
  button and the ⚙ menu's Settings/Storage entries are visibly locked (not
  hidden) while focused — Quick theme stays live. Matches the keymap, which
  already swallowed app shortcuts in focus.
- **A hidden usage terminal never resurfaces on its own.** Closing (or
  returning) the last real session used to fall back to the usage-check
  terminal if one had run earlier; usage probes are now excluded from every
  auto-selection — with no sessions left, the pane shows the app-logo
  splash. "check usage" remains the only way a probe is shown.

- **Transfers stopped paying the compression tax.** The data lane now
  negotiates no SSH compression: bulk payloads are often already compressed,
  and single-threaded zlib was a hard CPU ceiling — a few dozen MB/s even
  between two machines on the same metal, paid TWICE on a relay
  (decompress one leg, recompress the other). Terminal lanes keep zlib, where
  text over a slow link genuinely wins. scp and rsync ship uncompressed by
  default for the same reason.
- **The relay pipeline overlaps its legs.** The copy loop used to read a
  chunk, then write it, then read the next — each leg idle half the time. It
  now writes the chunk in hand while reading the next (double-buffered),
  worth up to ~2× on relays where both legs cost real time.

### Fixed

- **A crashed page can no longer wedge the backend.** If the webview reloads
  (a renderer crash-recovery, a dev reload), the fresh page now sweeps
  everything the previous one left behind — connections and all their lanes,
  PTYs, forwards, and above all any still-running transfer that would
  otherwise keep pumping headlessly with nobody able to cancel it, starving
  new dials (this is what made WSL unreachable after a crash mid-transfer).
- **Many small files no longer flood the UI with progress events.** A
  transfer between fast endpoints (WSL ⇄ a local VM) completes hundreds of
  files per second, and each one force-pushed a progress event into the
  webview — the prime suspect for the renderer crash above. File boundaries
  now respect the normal ~100 ms throttle.

## [0.9.14] - 2026-07-25

Session lanes — every agent gets its own SSH connection — plus the Restore
escape hatches for broken config, and the explorer's folder round: pinned
folders answer right-click, every folder can open a terminal in place.

### Added

- **Restore — two escape hatches for broken config.** Preferences and the
  Theme tab each end with a "Restore" section (palette: "Restore: …").
  Restoring settings.json rewrites it with the shipped defaults — for when a
  hand-edit went wrong and the right format is unknowable; saved themes are
  untouched. Restoring built-in themes brings the six shipped themes back,
  renewed to their current designs; edits under their names are replaced,
  custom-named saved themes are kept. Both are confirm-gated. The Theme tab
  also reordered — Current colors, Saved themes, Restore.
- **Connecting a host confirms with a toast** — "Connected to ubuntu." /
  "Connected to Ubuntu (WSL)." — matching the toasts reconnects already had.
- **Pinned folders answer right-click.** The root row was the one row in the
  tree without a menu; now it has one: New File, New Folder, Paste, Download
  (remote) / Copy Path / Reveal (local), Properties (recursive size, counts,
  permissions), and Unpin in the danger slot. Cut, Copy, Rename, and Delete
  are deliberately absent — moving or deleting the folder a pin points at
  would strand the pin.
- **Every folder row gained an "Open in Terminal" button** (left of the
  Source Control button — pinned roots and folders under them). It opens a
  shell on the folder's host and cds into it; the cd is typed into the
  prompt, visible and cancelable.
- **Sessions get their own connections** (Phase D of
  [docs/connections.md](docs/connections.md) — **session lanes**). Every
  agent opened from the SESSIONS panel or F11 dials a dedicated SSH connection
  for its shell alone, so one busy agent can never slow down or take out
  another terminal — and when a session lane drops, only that one agent
  restarts. The ＋ you press decides the pipe: SESSIONS/F11 ＋ = own
  connection; terminal-panel ＋ = the shared main lane (even if you dock it
  into SESSIONS later); the F11 usage check stays on the shared lane (a
  ten-second one-shot doesn't need its own pipe). A per-host cap lives in
  Preferences → **Session connections** (default 10, 0 = always share): at the
  cap new sessions open on the shared lane with a toast pointing at the
  setting, and a failed dial opens nothing — the toast says to try again or
  use a terminal-panel shell instead. Dials are serialized per host, closing
  an agent hangs up its connection, and disconnecting a host sweeps all of
  its lanes. The host's other lanes were renamed to match the model: **main
  lane** (terminals + forwards) and **data lane** (SFTP + commands, formerly
  "files"; toasts now tagged "(data)").

### Changed

- **Downloads became first-class transfers.** The explorer/quick-open Download
  now runs through the same machinery as the Transfers tool: live progress in
  the status bar with ✕ to cancel, pause + auto-resume when the connection
  drops, and a completion toast with the real file count ("Downloaded 37 files
  to Downloads"), not the top-level item count. One transfer at a time still
  holds — starting a download while one runs says so instead of doing nothing.
- **The status bar let go of connection status.** The WSL/REMOTE host entries
  and their issue lights left the bar — connection state lives on the
  title-bar gauge and the explorer host bars; the bar is now about panels, the
  active file, and in-flight work. Transfers/downloads show as a plain text
  readout there — `ubuntu → Downloads · file 34/1200 · 45 MB/2.1 GB · 34% ✕`
  — no mini progress bar; the percent carries it, ✕ cancels, and the text
  turns amber while waiting out a dropped connection. (The Transfers panel
  keeps its full-width bar.)
- **Palette titles no longer end with "…"** — in a palette list the ellipsis
  read as truncated text, not as "opens a dialog."
- **Straylight is tagged "(default)"** in the theme lists (Theme tab and the
  Quick theme menu) — the six as a set stay "built-ins"; only the one a fresh
  install wakes up in is the default.
- **Pointing Source Control at a non-repo now explains itself** — "…isn't a
  repository yet — run git init (or jj git init) in a terminal there to
  create one" instead of the raw backend error. A signpost, not an Init
  button: git vs jj vs colocate is the user's call.

## [0.9.13] - 2026-07-25

The resize round: the layout now has a real degradation ladder — shrink,
densify, suppress, floor — designed surface by surface, plus the seed ledger
so new built-in themes reach existing installs.

### Added

- **The layout degrades gracefully as the window shrinks.** When the window
  can't hold every visible panel at its minimum, columns first SHRINK toward
  their minimums and are then suppressed — Sessions, then Source Control —
  always preserving the editor's floor; the explorer is never suppressed
  (the window floor holds it), the last visible column always survives, and
  the terminal auto-collapses when the height runs out. Suppression never
  touches your visibility choices: grow the window back and exactly what the
  resize hid returns, in reverse order (with a hysteresis band so thresholds
  don't flicker). The surfaces densify along the way: a slim explorer (where
  its title would touch the L button) hides the L/W/R toggles and per-file
  sizes — hideable material layers *under* the title and hide button instead
  of colliding; the status bar's panel buttons drop to icons and compact
  (bells survive), and its status/file info hides one item at a time, left
  to right, down to just the panel icons, an active transfer, and the bell;
  the terminal list auto-switches to icon-only, and the editor minimap turns
  itself off below ~500px of editor width. The terminal's group bar
  densifies by ACTUAL collision, in two stages: when the rightmost host chip
  touches the Ports button, the four tool chips go icon-only; on the next
  touch, host chips go letter-only and drop their terminal counts (names
  live in tooltips) — reversing as the bar regains room. The title bar's
  connection tally never hides: pushed by a shrinking explorer, it stops a
  few pixels beside the brand instead. Below every rung the window is
  floored — a 600×600 square (down from 820×520), the explorer minimum plus
  a roomy editor/terminal column — and the floor stays meaningful at any
  zoom (the OS minimum rescales with the page-zoom factor). Also: the
  window's pre-paint background now matches the Straylight theme instead of
  the old Dracula default.

- **New built-in themes now reach existing installs.** The theme library
  keeps a ledger of built-in names it has ever seeded; a built-in missing
  from the ledger (a newly shipped theme) is added on launch — while your
  edits are never overwritten and your deletions still stick. Previously the
  library was seeded once and new built-ins never appeared for anyone with
  an existing theme.json.

## [0.9.12] - 2026-07-24

The color era: the whole app became themeable to the bone, the Straylight
identity was designed for real (dark and light), and six built-in themes each
speak their own host language — alongside the F11 focus workspace and a round
of explorer/transfer power features.

### Added

- **Focus view (F11): a full-window CHAT workspace.** F11 (or the ⛶
  title-bar button) overlays the whole body — the editor is never involved —
  with the agents listed on the left, GROUPED BY HOST (host name in its
  color; drag headers to reorder hosts, drag agents within a host), and the
  selected agent's live terminal filling the right (the same shell as the
  CHAT column — reparented, never restarted). At the list's bottom, a HOSTS
  block shows every connected host with its issue light and a ＋ for a new
  agent there; clicking a host runs the Claude usage check — a read-only,
  list-hidden probe that starts `claude`, waits behind a loading screen, and
  opens `/usage` (re-click refreshes it with Esc + `/usage`, no re-ask;
  first run confirms, skippable, and the toggle lives in Preferences →
  Confirmations). Probes close when the view exits. The notification bell
  moves to the HOSTS header and the status bar hides while focused. Its own keymap —
  Ctrl+Tab hold-to-browse, Ctrl+PageDown/Up cycle, Ctrl+Shift+` /
  Ctrl+Shift+N new agent (Windows Terminal's digits), Ctrl+Alt+N jump to
  agent N — and every other app shortcut is inert, so the layout underneath
  can't be touched. The CHAT column's dots match the grouping: one
  host-colored pill per host, the lifecycle dots inside.
- **Transfers: a confirm sheet before the copy.** Dropping or pasting between
  the two panes opens a small sheet — source → destination, the items, and a
  size that fills in while the source is scanned. Copy is enabled from the first
  frame, so a deep tree never blocks the decision; commit early and the progress
  bar shows the total once the walk lands. The measured size is reused by the
  copy so a big tree isn't walked twice. Only one transfer runs at a time — a
  second drop now says so with a toast instead of doing nothing.
- **Right-click menu in Quick Open (Ctrl+P).** Finder rows now offer Open, Copy,
  Copy Path, Download (remote/WSL), Reveal in file manager (local), and
  Properties — the explorer's actions, without leaving the search.
- **Reveal in file manager.** Local files gain a "Reveal in file manager" action
  that opens the OS file manager with the item selected — in both the explorer
  right-click menu (under Copy Path) and the Ctrl+P menu.
- **Download folder is configurable.** Preferences → General → Download folder
  sets where Download sends files (empty = your OS Downloads folder); applies to
  both the explorer Download and the new quick-open Download.
- **Drag to move or copy within a host.** Drag file(s) or folder(s) onto another
  folder in the same host's explorer (or onto its root) and pick **Move here** /
  **Copy here** — the same operations as cut/copy + paste, just on a drag. Same
  host only (cross-host copies stay in the Transfers tool), and a folder can't be
  dropped into itself.

### Changed

- **Every host got a second pipe for file work** (Phase 1 of
  [docs/connections.md](docs/connections.md)). SFTP and remote commands
  now ride their own SSH connection (the "files lane" — renamed to **data
  lane** in the next release), dialed silently on the first file operation,
  while terminals and port forwards keep the original connection to
  themselves. Heavy transfers can no longer congest your typing or take a
  terminal down with them, and terminals stop competing with file traffic for
  the server's ~10 per-connection session slots. Costs one extra sshd process
  (a few MB) per host; if the second dial fails, the host quietly shares one
  connection as before. The lane reports its own state — tagged toasts — and
  reconnecting it refreshes the tree and settles any saves stranded by the
  drop.
- **Transfers now survive connection drops** (Phase 2). A transfer whose
  connection dies pauses — amber pulsing bar, "waiting for connection…" — and
  resumes by itself when the lane reconnects, continuing from the incomplete
  file: finished files are never re-copied, a half-written file restarts
  cleanly through its `.straypart`, and a resumed transfer keeps writing into
  the same "name copy" it started. Cancel became truly immediate — it now
  interrupts even a read parked on a dead socket (the old cancel could only
  act between chunks, so a hung transfer was uncancellable). No give-up
  timer: the transfer waits as long as it takes; you are the only timeout.
- **Connections stopped executing themselves on suspicion** (Phase 0 of
  [docs/connections.md](docs/connections.md)). A stalled link used to be
  treated as a dead one — ~45 s of unanswered keepalives or two slow probes
  tore down the whole connection and **restarted every terminal**, which on a
  flaky network meant hourly terminal deaths while plain `ssh` on the same
  machine survived for days. Now doubt is not death: probe timeouts only mark
  the connection **degraded** (steady amber dot; every channel stays open and
  usable), traffic itself counts as proof of life (an active terminal or a
  moving transfer skips the probe entirely), and the keepalive backstop fires
  only after ~5 minutes of *total* silence. Teardown + reconnect happens only
  on hard evidence — a transport error, confirmed twice — or when you ask.
  Every transition logs its cause, and while this bakes, toasts narrate each
  change generously (stalled / recovered / lost-with-reason / reconnected);
  they'll be trimmed after field testing.
- **The Straylight look, fine-tuned and promoted to the default.** A full
  palette pass toward 1.0: `#AF011C` carries the brand on chrome (dark title
  bar with a whisper of crimson underline), pure red is reserved for errors
  and attention, and cool accents (teal info, violet) rest the eye. Hosts read
  as one warm→cool spectrum — Local crimson, WSL magenta, remotes
  violet→indigo→blue. The editor's syntax softened (no more pure-magenta
  literals), find matches got a bright amber border, and the section bars
  calmed. A WCAG contrast audit closed the pass: muted text and code comments
  brightened to ≥4.5/≈3.9 ratios, the character under a host-colored terminal
  cursor now picks whichever of fg/bg reads best on that host's color, and
  host colors used *as text* (the Sessions title, the F11 HOSTS list) mix
  toward the foreground so even the dark crimson stays legible. All of it is
  the shipped default now.
- **The theme lineup: six, each earning its place.** Straylight (dark,
  default) and the new **Straylight Light** — the identity on warm paper,
  crimson chrome, semantics re-anchored for light — plus Dracula, Nord,
  Solarized Light, and the new **Catppuccin Latte**. Straylight Crimson and
  Neon retired (the default *is* the crimson identity now, done right). The
  carried-over themes gained the new contract — per-remote host slots and
  their own find-match colors — with their authentic palettes kept;
  legibility-only touch-ups where muted text was used for real UI reading.
  Every theme designs its own host identities with the same grammar: Local +
  WSL as a near pair, remotes as their own family, all five distinguishable —
  Straylight's crimson/magenta + violet→indigo→blue, Dracula's purple/pink +
  cyan→green→yellow, Nord's frost pair + aurora ramp, Solarized's blue/cyan +
  warm ramp, Latte's mauve/blue + teal→green→peach. Theme credits live in
  THIRD_PARTY_NOTICES.md (all MIT).
- **One terminal scheme + host identity.** The three per-scope terminal
  sections (`terminalLocal/Wsl/Remote`) collapsed into a single `terminal`
  scheme — Catppuccin Mocha's soft ANSI set on the warm Straylight background
  — and a new `terminalHostColor` setting (default on, Preferences →
  Interface) paints each terminal's cursor + selection in its host's identity
  color instead, including per-remote. Old settings migrate automatically.
- **Host colors are fixed slots.** The five host colors are theme slots
  (Local / WSL / Remote 1-3), edited in the Theme UI like any other color —
  the per-host color override menu is gone. Right-clicking a remote's host
  bar now offers "Make this Remote N": the host swaps position with the one
  holding that slot, taking its place and its color.
- **Connections at a glance.** Small diagonal strokes in the title bar, over
  the explorer's W and R toggles, tally the attached WSL and remote sessions:
  neutral = connected, pulsing amber = connecting/reconnecting, steady red =
  disconnected. The L/W/R toggles gained breathing room to match.
- **Every UI color follows the theme now.** Colors that were baked into the
  stylesheet or code — merge-conflict highlights, error/danger tints, the
  repo-backend badges, editor banners, the commit graph, the remote host-color
  ramp, the tool-view frame — were hardcoded (mostly leftover Dracula values)
  and ignored the active theme. They now resolve from theme slots (translucent
  ones via `color-mix`), so switching themes recolors the whole window. The
  Monaco bootstrap theme no longer duplicates the editor defaults (one source,
  no drift), the `--info` default that disagreed between the CSS and the JS is
  aligned, and the two modal scrims share one `--overlay` token. Structural
  black drop-shadows stay fixed by design.
- **Download copies straight to its folder, no prompt.** Both the explorer and
  quick-open Download send files to the configured Download folder (default:
  your OS Downloads) without asking each time.

### Fixed

- **Transfers no longer leak SFTP file handles.** Each file streamed from a
  remote/WSL source left its read handle open (russh-sftp closes them only via a
  fire-and-forget drop that lags a many-file copy), so a large tree eventually
  hit `handle limit reached` — and once the session's handle table was full,
  the explorer and Transfers panel went dead until reconnect. The copy now
  closes each read handle explicitly (awaited), keeping one open at a time; the
  same fix covers same-connection recursive copy (explorer paste on a remote).
- **A transfer no longer aborts on one unreadable entry.** A dangling symlink or
  broken submodule gitlink used to fail the whole batch during the size pre-pass
  (`could not stat … No such file`); such entries are now skipped and counted
  (`N unreadable items skipped` in the completion toast, with each path recorded
  in the log) while everything else copies. The size pre-pass and Properties
  tolerate them the same way, so one bad entry never takes the rest down with it.
- **"Reveal in file manager" selects the file on Windows.** The path is
  normalized to backslashes — forward slashes made Explorer ignore `/select` and
  just open the default folder — and quoted so paths with spaces resolve.
- **The status-bar transfer readout no longer clips its text.** The box was
  widened so the route label and byte/file progress fit without being cut off.
- **Ctrl-click on a link in the editor opens it.** Monaco showed the "follow
  link" hint but the WebView2 has no working `window.open`, so clicks did
  nothing; http(s) links now open in your default browser.

## [0.9.11] - 2026-07-22

Keyboard and split-model round: the editor grew VS Code's keys and a real
split lifecycle, every tooltip is themed now, and two server-session bugs
found by the terminal-stress test are gone.

### Added

- **A real right-click menu wherever you type.** Text fields (commit box,
  renames, dialog inputs) and the file editor get the app's own edit menu —
  Undo / Redo / Cut / Copy / Paste / Select All with their keys — instead of
  the browser's native menu (or Monaco's, in the editor). Password fields
  show the reduced Paste / Select All set; the WebView's own context menu
  (refresh/print/inspect) can no longer appear anywhere. A richer editor
  menu (Go to Definition etc.) is future work.
- **VS Code keyboard parity.** New defaults: `Ctrl+Shift+G` Source Control ·
  `Ctrl+Alt+I` / `Ctrl+Shift+I` CHAT (new command; DevTools are disabled, so
  the key is unambiguous) · `Ctrl+J` show/hide the panel (wins even from a
  shell, as in VS Code) · `Ctrl+1..3` focus editor group, and asking for the
  next index creates it · `Ctrl+W` / `Ctrl+F4` close the file — the last
  file closes its split too, and on an empty split they close the split.
  `Ctrl+PageDown/Up` is "next tab of whatever I'm in": editor tabs anywhere;
  in the terminal panel every shell in bar order, then Ports → Containers →
  Forwarding → Transfers; CHAT's residents in CHAT. Pin and close-all/saved
  stay palette-only, like the VS Code chords nobody types.
- **Splits have a real lifecycle.** `Ctrl+\` splits half/half — with several
  files the active one moves over; with one (or none) you get an EMPTY pane:
  app icon, its own ✕, a first-class drop target that lights up when you
  drag a tab over it. A group that loses its last tab closes itself; the
  green drag-to-split zone appears only when there's something to CREATE
  (never beside an existing empty pane, never past the 3-group cap).

### Fixed

- **Closed terminals no longer leak server sessions.** Closing an SSH
  terminal sent EOF but never CHANNEL_CLOSE — an interactive shell ignores
  EOF, so every closed terminal kept occupying one of sshd's session slots
  (MaxSessions, default 10) until the whole connection died. Terminals now
  close their channel explicitly, freeing the slot immediately.
- **A full server no longer reads as a dead one.** At sshd's per-connection
  session cap (`MaxSessions` — each terminal, the file browser, and every
  background command counts), the health probe's refused channel was misread
  as a dropped connection — reconnecting in a loop and restarting every
  terminal each cycle. A refusal now counts as proof of life, a drop needs
  two failed probes in a row, and actually hitting the cap says so plainly.
- **Split focus obeys the keyboard.** Focus hand-offs (Ctrl+1..3, tab
  clicks) were answered by every split at once, so the last-mounted group
  always stole the cursor; a focused empty pane also let typing fall through
  into another group's file. Only the active group answers now, and an empty
  pane swallows the keyboard.
- **The green drag-to-split zone can't get stuck or go dead.** Drops that
  closed the source's group (or were swallowed by a tab strip) left the zone
  on screen; the fix for that then unmounted the zone before its own drop
  landed. Both directions hold now.
- **The editor history tab's git ⇄ jj swap button works.** The blanked code
  editor underneath overlapped the tab's header row in hit-testing, so the
  swap button (and the head line) were visible but unclickable. The lens also
  syncs both ways now: flipping a colocated repo's backend from the repo card
  or sidebar history updates an open editor history tab too.

### Changed

- **Themed tooltips everywhere.** ~150 controls across every surface swap the
  OS-native `title` tooltip for the themed Tip bubble (instant, above the
  control, viewport-clamped), with texts shortened in the same pass — file
  tree rows and pinned roots show path + mode/owner + size + date on the
  name, one topic per line. The only native tooltips left are the handful of
  disabled-state explanations (a disabled control fires no hover events, so
  only the OS tooltip can explain *why* it's disabled).
- **Hosts carry an "issue light", not a green lamp.** Status-bar host entries
  and the explorer's per-host tools row (beside Refresh) show a light that's
  near-invisible while the host is fine and colors up on connecting /
  reconnecting / disconnected, with a state tooltip — trouble brightens an
  existing light instead of popping a new one in. No resting green anywhere.
- **Explorer ⑂ goes straight to Source Control.** No confirm dialog — a
  folder covered by a tracked repo opens the panel scrolled to its card; any
  other folder is tracked directly, and a non-repo just toasts. The button
  appears on row hover at the right edge, on every folder at any depth;
  color is the whole story: repo color = tracked, gray = not.
- **Truncated (>50 MB) files open read-only.** Editing a partial view was
  wasted work — saving it was (rightly) blocked, so typed changes could never
  be kept. The banner points at the host terminal instead; no editor lets you
  edit a truncated view (VS Code opens large files whole with features off).
- **Chrome polish.** The status bar's four panel blocks are equal-width with
  aligned icons and no tooltips (they label themselves); the CHAT column
  headlines its resident — bigger, host-colored; DevTools are locked
  (packaged builds ship without the inspector entirely); the welcome logo
  and empty-pane icon got their proper sizes.

## [0.9.10] - 2026-07-21

The first fix round out of the final test walks: saves that can't silently
lie under dropped links, trees that keep up with the app's own terminals,
auto-connect rebuilt per host, and a terminal panel that no longer loses its
place.

### Added

- **Ctrl+F finds in the current file** from anywhere — it focuses the editor
  showing the active file and opens the find widget, even while the explorer
  holds the keyboard after a single-click preview. Inside a terminal the shell
  keeps its own Ctrl+F; rebindable as `editor.find`. Find matches got real
  highlight colors — the current match brighter than the rest — as two new
  editor theme colors (`findMatch`, `findMatchHighlight`), editable like any
  other swatch and themed in every built-in preset.
- **Folder expansion is remembered.** Explorer trees (every host) and both
  transfer panes reopen with the folders you had expanded — persisted per
  host identity, so it survives restarts and reconnects alike.
- **WSL/remote trees refresh when your command finishes.** A terminal on that
  host (panel or CHAT) going quiet after output — or ringing its bell —
  freshens the host's trees automatically (throttled). Covers `mkdir`/`touch`/
  agent edits done in the app's own terminals; changes made outside the app
  still take F5 or a window refocus.
- **Notifications are copyable** — bell entries are selectable and carry a
  hover copy button.
- **Terminals know your real Windows build** — modern Win11 gets ConPTY's
  native resize reflow instead of the always-safe Win10 compensation.

### Fixed

- **Relaunch no longer steals the password cursor.** A terminal opened by the
  session restore (e.g. the WSL shell) grabbed focus mid-typing; terminals now
  never take focus while a dialog is open, queued startup asks wait for the
  connect dialog to close, and toasts can never hold keyboard focus.
- **Fetching a repo with no remote** says so in a calm info toast ("add one
  first…") instead of relaying git's fatal error.
- **Empty terminal groups behave now.** Picking a host with no panel
  terminals no longer keeps showing the previous host's terminal — an empty
  state ("No terminals on user@host yet" / "… has N in CHAT") offers a New
  terminal button with its key. Closing (or moving to CHAT) a host's last
  terminal stays on that host instead of jumping the bar to another one.
  Ctrl+Shift+` now opens a terminal in the selected group when no terminal
  is focused (it was inert), and Ctrl+` correctly hides the panel from an
  empty group instead of going dead.
- **A save can no longer look saved when it wasn't.** The local draft is
  written before a staged save touches the network (covering a save fired
  inside the edit debounce — previously such a save had no draft at all), and
  every unconfirmed outcome — upload cut short, commit undispatched, guard
  refusal — re-dirties the tab instead of keeping the optimistic clean.
- **Reconnects recover file access immediately.** A transfer hung on the dead
  link no longer blocks the reconnect (the SFTP session is swapped for a
  fresh one instead of awaited), so trees and pinned folders load right after
  the link returns instead of stalling ~45 s. A mid-session reconnect —
  manual or automatic — now also runs the same pending-save reconcile as a
  relaunch: a save stranded by the drop resolves within seconds — confirmed
  if its server-side commit landed, otherwise swept and re-dirtied — and a
  retry save dispatches immediately on the fresh link instead of queuing
  behind the dead attempt until the old transport timed it out.
- **Interrupted uploads no longer leave `.straysave` temps behind.** The save
  record is written before the upload starts, so a drop or app kill
  mid-upload leaves a tracked temp the next reconcile removes (previously
  each became an untracked orphan that accumulated).
- **A dead save no longer poisons the next one.** An attempt that died
  unconfirmed left the guard chain expecting content the server never
  received, so every following save of that file was refused as "changed on
  the server". Every resolution path now resets the chain to the last
  content actually confirmed.

### Changed

- **Hot-exit drafts now always auto-restore.** A file with unsaved changes
  reopens **dirty** on its own — no more per-host "restore drafts?" ask or the
  `restore.openFiles` setting. The draft-available banner is gone; a restored
  draft is just a dirty tab you undo back to the saved state or close without
  saving.
- **Session restore splits by host.** **Local** restores your whole workspace
  (every tab that was open); **remote/WSL** restore only pinned files plus
  anything with an unsaved draft — incidental clean tabs no longer reopen
  ("want it back? pin it"), so a relaunch matches a mid-session reconnect.
- **Compare with saved.** Any dirty tab shows a **⇄ Compare** action at the
  right of its breadcrumb bar — a one-click read-only diff of your unsaved
  buffer against the file as currently saved. (The conflict bar keeps its own.)
- **Declined hosts aren't re-asked.** The session snapshot records the hosts
  connected when the app closed, so skipping a startup reconnect or cancelling
  a password dialog drops that host from the next launch instead of prompting
  again on every start.
- **Terminal attention is a bell glyph now.** A rung terminal (any BEL — an
  agent finishing, or just the shell's beep) shows a small bell on its host's
  group chip (between the W/R letter and the name) and on the hidden TERMINAL/
  CHAT buttons — no more green dot, which read as connection health.
- **Auto-connect is per host now.** Every saved host asks on launch by
  default; the ask's checkbox ("Don't ask again — always connect this host")
  marks just that host into settings.json `autoConnect` — now a list of host
  keys like `"wsl:Ubuntu"` / `"user@host:22"`, replacing the old all-or-nothing
  per-kind modes. Marked hosts are managed (and unmarked) in the new
  **Storage → Auto-connect** tab. A marked host you disconnected before
  closing stays quiet — the mark only silences the ask, never forces a
  connection.

## [0.9.9] - 2026-07-16

A keyboard-and-focus UX round: every dialog answers to the keyboard, the
explorer finally updates itself, and the app's chrome reorganized around
Preferences / Theme / Storage.

### Added

- **Local explorer auto-refresh.** Every pinned local folder gets a recursive
  filesystem watcher (the same debounced machinery Source Control uses), so
  external creates/deletes/renames appear in the tree by themselves — no F5.
  WSL/remote trees refresh on window refocus (throttled) plus the manual
  buttons, as before. The explorer's "N ago" refresh stamps are gone — the
  trees are expected to be current now.
- **Keyboard-first dialogs.** Every popup traps focus (keys can't leak to the
  app underneath — deleting a file no longer moves the tree selection behind
  the dialog), pre-focuses its primary button, and answers to Enter (confirm),
  Esc (cancel), Tab/←→ (cycle buttons + checkboxes, wrapping), Space (toggle
  a checkbox). Focus returns where it was on close. One deliberate exception:
  the host-key prompt pre-focuses Cancel — trusting a fingerprint takes a
  deliberate Tab.
- **Window state persists** — size, position, and maximized survive a restart
  (tauri-plugin-window-state).
- **Host in the path.** Non-local files lead with a host-colored name in the
  breadcrumb (`ubuntu » src › main.rs` — » marks the host boundary) and a
  `host:` prefix on the status-bar path. Local stays plain.
- **Preferences / Theme / Storage.** The Settings tab is now **Preferences**
  (knobs only) with a new **Interface** section: *Local only* (hides the
  L/W/R toggles and non-local sections; locked while any WSL/remote host is
  connected) and *Disable CHAT* (removes the CHAT column; locked while
  terminals live in it) — locked checkboxes explain themselves with a toast.
  The pinned-files and drafts inventories moved to their own tabs under a
  new **Storage** menu section (Drafts · Pinned files). The theme tab is
  simply **Theme**. settings.json keeps its name; hand-edits still mix
  freely (`ui.localOnly`, `ui.disableChat`).

### Changed

- **Explorer clicks, VS Code-style.** Single click opens a preview and the
  explorer keeps the keyboard; double click or Enter keeps the file open and
  hands the editor the cursor. Tab clicks and Ctrl+Tab still focus the
  editor; session restore never steals focus.
- **Tab marks: one ladder.** Every editor tab carries a bottom mark in its
  host color; intensity encodes state — dim = unpicked, medium = what an
  unfocused split shows, full = the picked file. The old host top stripe is
  gone (the color no longer jumps edges when picking tabs).
- **Diffs stop squeezing** — the compare view switches to the unified inline
  diff when the editor is narrower than ~760px, back to side-by-side with
  room (VS Code behavior).
- **Settings pages read like settings** — content capped to a column instead
  of stretching across the editor, with a hairline under each row.
- **The title bar stays alive under popups** — moving, minimize, and
  maximize/restore work with any menu or dialog open; close and the menu
  buttons stay blocked.

## [0.9.8] - 2026-07-16

The CHAT column: a straight terminal docked beside Source Control, built for
pairing with Claude Code (or any CLI) — plus the dockable-column layout and an
icon system to carry it.

### Added

- **CHAT column.** A bare terminal column, one shell on screen at a time.
  Residents are ordinary terminals: send one over from the panel (its entry's
  move button), open a fresh one on any connected host (＋), return it with −,
  or kill it with ×. Hiding the column never evicts — shells keep running at
  zero width. The bottom panel's host chips count both homes (`x+y`).
- **Resident dots.** 12px host-color-outlined dots switch residents; the fill
  is a lifecycle machine, active while a tool (Claude Code, vim…) has announced
  itself via the terminal title: green = your turn, yellow = producing output,
  blank = bare shell or exited (dimmed). The on-screen resident fills white.
- **Terminal names.** Terminals follow the shell's OSC title when it's a real
  name (Claude Code's status, vim's file) and keep their clean default label
  ("Local", the host name) when it's shell noise (`…pwsh.exe`, `user@host:`
  prompts). Double-click an entry (or the CHAT name line) to rename; renaming
  to nothing reverts to auto.
- **Dockable columns.** SC and CHAT step left/right around the editor (⇤ ⇥),
  swapping past it — the editor can sit against the explorer or at the right
  edge; only the explorer is pinned. Each column keeps its own persisted width;
  the editor flexes, so hiding a column widens the editor, never a neighbor.
- **Notification bell.** Every toast lands in a status-bar bell (right edge,
  unread badge) after it fades — toast history only, deliberately-silent
  things stay silent.
- **CHAT status-bar button** beside EXPLORER · SC · TERMINAL, with separators
  between the four and one before the bell. Ctrl+Tab and Ctrl+PageUp/Down
  cycle within whichever zone has focus (editor tabs / panel terminals / chat
  residents); Ctrl+` is unchanged.

### Changed

- **Icon sweep.** The font-dependent text glyphs are drawn SVGs now: branch
  (⑂), copy/check on toasts, the SC card's commit/push/fetch/menu/discard
  glyphs, undo for keybinding reset, chevrons, closes. Connect/disconnect are
  a matched plug pair (seated ↔ pulled with spark gap) on every host surface.
  Window controls: minimize sits at the baseline, and the maximize button
  swaps to a restore glyph while maximized.
- **Three minus glyphs, three meanings** — app minimize (low dash), panel
  hide (solid slab, same button on all four bottom-left panels, set apart
  from its neighbors), and chat return (thin round dash, the ＋'s twin).
- Close buttons in terminal entries and the CHAT name line sit a deliberate
  gap away from the button before them.

### Removed

- **Terminal-in-editor.** The ⇱ "move to the editor area" tab is gone — the
  CHAT column is where a terminal goes to live beside your work.

## [0.9.7] - 2026-07-15

### Added

- **SSH host-key verification** against `~/.ssh/known_hosts`. An unknown host
  shows its SHA256 fingerprint to trust on first contact; a changed key is
  refused (no one-click override). Loopback (WSL/localhost) is skipped;
  re-verified on reconnect and session restore.
- **Passphrase-protected keys** — an encrypted key prompts for its passphrase
  (kept in memory only) and connects.
- **IPv6 `ProxyJump`** — bracketed forms like `[::1]:22` and
  `user@[2001:db8::1]:2222` now parse.

## [0.9.6] - 2026-07-15

### Changed

- **Docs overhaul.** Reorganized `docs/` around a present-tense design-doc
  model with a new [docs/README.md](docs/README.md) index + design-decision
  ledger (the "why it changed" history lives there, so the docs stay
  "what it is now" and this changelog stays code-focused). Merged the transfer
  docs into `transfers.md` and the save + hot-exit docs into `data-safety.md`;
  renamed `backlog.md` → `future-work.md` with priority tiers; rewrote
  `architecture.md` as-built (1 + 3 + 3, staged saves, drafts). Rewrote the
  root README — corrected stack facts (russh, Node 20.19+, DOM-renderer
  fallback), added a **Data Safety** pillar and a **Security & limitations**
  section.

## [0.9.5] - 2026-07-15

Data safety: don't lose an edit to a crash or a dropped save.

### Added

- **Hot exit — local drafts of unsaved edits.** Every dirty buffer is cached
  locally (app config dir, `drafts/`) as you type, so a crash, close, or power
  loss can't take it. On relaunch each host offers to restore its drafts (a
  checkbox on that host's connect ask, or a standalone prompt for Local and
  auto-connected hosts; `restore.openFiles`: `ask` / `always`). A file with an
  unresolved draft — and every pinned file — now reopens on **every** connect,
  including a mid-session reconnect. A restored draft is undoable back to the
  original. Manage or wipe both lists in **Settings → Pinned files / Drafts**;
  turn drafts off entirely for sensitive hosts. WSL editor tabs restore across
  relaunch too.
- **Staged remote saves.** Saving over SSH/WSL no longer truncates the file in
  place: the buffer uploads to a `.straysave` temp, then a **detached,
  server-side `cp` commit** swaps it into the original inode and verifies it —
  so a dropped connection can never tear the file, and ownership, symlinks, and
  hard links survive (unlike a rename). Ctrl+S returns immediately; the commit
  confirms in the background, finishes on its own, and reconciles on the next
  reconnect if the link dropped. A per-file queue serializes rapid saves, and
  the commit is **hash-guarded** so an edit from elsewhere is never silently
  overwritten.

### Changed

- **Save conflicts are a bar, not a modal — and Ctrl+S is blocked until you
  resolve them.** When the file changed on the server under you, the tab shows
  **Compare / Overwrite / Discard** (each destructive choice confirms) instead
  of a pop-up you could dismiss by pressing save again. Restored-draft and
  changed-on-disk cases share the one surface.
- **SSH compression** (`zlib@openssh.com`) is preferred on every connection —
  saves, transfers, and terminal traffic shrink on slow links; a server without
  it negotiates `none`.

### Fixed

- **Auto-reconnect no longer gives up.** The reconnect supervisor retries
  indefinitely (backoff capped at 30 s, attempt count shown) instead of
  surrendering after eight attempts; only an explicit Disconnect stops it.

## [0.9.4] - 2026-07-14

Multi-WSL, honest WSL state, and a parallel batch of data-safety fixes.

### Added

- **WSL pre-connect lights** — every distro in the WSL list carries a
  readiness dot: **green** = running with sshd already up (connects
  instantly; a ~400 ms TCP probe of its deterministic port), **yellow** =
  running (ssh starts on connect), **gray** = stopped (boots on connect).
  The detail text and tooltip spell it out.
- **WSL connection state is live** — the WSL link's ssh-status events were
  silently dropped; now the status-bar dot goes orange while reconnecting
  and red when the link is dead (e.g. sshd died in the distro), and a
  successful reconnect refreshes the tree and restarts the terminal like a
  remote. Auto re-provisioning on failure stays future work — a reconnect
  only succeeds if sshd still lives.

### Changed

- **Status-bar dots are sectioned** — a divider after TERMINAL, then a
  `WSL` section (dot + user; distro + state on hover) and a `REMOTE`
  section (dot + user@host; alias + state on hover). A section only exists
  while something is connected; WSL always comes first.

- **1 + 3 + 3 connections: up to three WSL distros at once**, alongside the
  three remotes. Each connected distro gets its own host bar (color, pins,
  hidden-files toggle, refresh, state dot, disconnect), terminal group,
  status-bar dot, and search/transfer/SCM/Ports/Containers/Forwarding
  presence; the WSL bar's + attaches more (hidden at 3) and sessions
  restore every distro (the startup ask runs per distro). Incidentally
  fixed for remotes too: the transfer pane's refresh now tracks EVERY
  remote (not just the primary), and the SCM "open a repository" picker
  offers all remotes and distros.
- **The under-10 s age bucket reads "<10s ago"** (was "in 10s") — stamp,
  its "checked" tooltip, history rows, host-bar stamps.
- **Failing background monitor checks stay calm and back off.** A ◉ check
  that errors keeps the cached status and a quiet card (no red row, no
  flicker); the stamp tooltip notes "last check failed", and consecutive
  failures stretch the poll 4 s → 8 s → 16 s → … capped at 60 s (one
  success resets everything). Explicit ⟳ / F5 failures still paint the
  card red — an asked-for refresh must not hide problems.

### Fixed

- **Saving a truncated (>50 MB) file is blocked** — Ctrl+S (and save-on-
  close) on a truncated tab shows an error toast instead of silently
  cutting the file to exactly 50 MB on disk; the banner says saving is
  disabled, and a failed save never closes the tab.
- **Non-UTF-8 files can no longer be corrupted by a save.** The backend
  flags lossy decodes (`lossy: true`, encoding "non-utf-8"); opening one
  shows the � replacements with a banner + warn toast, and Ctrl+S is
  refused — previously a save rewrote the file with literal U+FFFD bytes.
  Clean UTF-8 and binary detection are unaffected, and a clean-tab
  auto-reload clears the flag if the file becomes valid UTF-8.
- **Transfers no longer hang forever on symlinked directory cycles** — the
  measuring pass and the copy walk never descend a symlinked directory
  (`ln -s . self` used to loop the measure step with no progress bar).
  Symlinks to files still copy as regular files; skipped link-dirs are
  counted and reported in the completion toast ("… (2 linked folders
  skipped)"). Applies to the Transfers tool and context-menu Download.
- **A transfer's temp file survives a double rename failure.** If
  committing `.straypart` over the destination fails even after removing
  the target (e.g. an immutable file), the temp file is KEPT and the error
  names it ("…the copied data was kept as …straypart; rename it by hand")
  instead of deleting the only surviving copy.

## [0.9.3] - 2026-07-14

The monitoring model, and a UX polish sweep out of the test pass.

### Added

- **◉ now means "monitor", and it's ON by default** (one-time migration).
  Monitored WSL/remote repos are checked every ~5 s while the window is
  focused (plus on refocus), so terminal-driven git/jj ops inside the app
  show up without F5 — this closes the view-first loop on remote hosts.
  ◉ off = "don't touch this repo except for my own in-app actions" (for
  huge repos where status is expensive, jj's snapshot side effect, slow
  links, shared servers). Local repos stay watcher-live (◉ locked on).
  Monitoring runs status only — it never pulls, never prompts.
- **The card stamp now means one thing: "changed … ago"** — the last time
  the repo changed *as far as Straylight has seen*. It resets when a check
  finds a real difference (statuses carry a head `oid`, so message-only
  amends/rebases count) or when you save/file-op inside the repo in the app
  (any host, monitored or not — your own action is a witnessed change).
  Silent background checks never flash a spinner or reset the counter, the
  history stops refetching identical results, ages under 10 s read as a
  calm "less than 10 s ago" instead of ticking, and hovering the stamp
  answers the other question: "checked … ago" (with a "not monitored"
  prefix where apt). Manual ⟳ / F5 stay loud.
- **Card drag got tab-strip manners**: an insertion stripe shows where the
  dragged card will land (above/below the hovered card's midpoint), the
  cursor never shows "blocked" inside the panel, and dropping on empty
  space just puts the card back.
- **git ⇄ jj lens swap on the history surfaces** — colocated repos get an
  explicit "swap to git/jj history" button on its own line, in the sidebar
  history panel AND the editor log tab (the tab flips in place; card,
  panel, and tab always agree).
- **The monitor icon is a heartbeat** — an ECG pulse when monitoring, a
  flatline when off (◉ retired; the eye was already the hidden-files
  toggle).
- **Push/ahead counts are superscripts** — ↑² instead of ↑2, on the push
  button and the branch line's ahead/behind pair.
- **Connection dots moved to the status bar** — one dot + the connection's
  name (the ssh-config alias / distro) per attached connection, WSL + every
  remote, not just the primary. Hover spells it out: "my_pc_2 connected
  (liangyou@myserver)". Green solid = connected, orange pulse =
  connecting/reconnecting, red = dropped. The title bar's old primary-only
  status text is gone — the top-left is identity + drag space now.
- **The empty editor is a welcome screen** — logo, a one-line "pin a folder
  in the explorer" pointer, and five command shortcuts. The "Connect to a
  new server" button is gone (the sidebar owns connecting).
- **Middle-click opens a file permanently** in the explorer (double-click
  semantics; single-click stays preview) — VS Code behavior.
- **New hidden-files eye icons** — hand-drawn open/closed-lid pair replaces
  the old outline/slash eyes (explorer toolbars + transfer panes).
- **Readable primary buttons** — `.btn--primary` (Commit and friends) now
  uses the theme's accent with its designated on-accent text color
  (`section-fg`) and a brightness hover, replacing the Dracula-era purple
  fill and its hardcoded lilac hover that read badly under the Straylight
  themes.

### Fixed

- **A pinned dirty tab now shows its unsaved dot** (the dot lived inside
  the close button, which pinned tabs don't render).
- **A deleted/unreachable pinned folder no longer spins forever** — a
  failed listing was reloaded instantly and endlessly, so the "Folder
  unavailable" message never got a frame to render (also a busy CPU loop on
  instant failures). The message now points at F5; the per-root Retry
  button is gone (refresh is refresh).

## [0.9.2] - 2026-07-13

### Changed

- **New app icon set** — regenerated in every format (window/taskbar `.ico`,
  macOS `.icns`, the MSIX Square/Store logos, and the in-app logo), now with
  the vector source (`straylight-icon.svg`) committed alongside. The unused
  `64x64.png` and the old raster `icon-source.png` were dropped.

## [0.9.1] - 2026-07-13

The first 0.9.x batch out of the test pass (plan Parts A–B: git + jj).

### Added

- **The history panel says which lens it is.** Two-row header: **GIT
  HISTORY / JJ HISTORY** (live — follows the colocated badge toggle) over a
  host-colored repo row (tooltip = full root). The ⧉ pop-out's tab title is
  just "⎇ repo"; the lens shows in a one-line host-colored head inside the
  view ("JJ HISTORY · repo").

### Changed

- **jj is now view-first** (decision from the 0.9 test pass): Straylight
  visualizes jj — status, diffs, decorations, conflicts, live multi-lane
  history — and jj *mutations* are terminal-driven (the watcher updates the
  card/history as you type jj commands). The jj commit box (Commit /
  Describe / Fix last msg), Squash, Rebase, and ↑ push are gone from jj
  cards; what remains: **bookmark switch/create, ↩ discard, ⇣ fetch**. For
  buttons, drive a colocated repo as **git** via the badge toggle. Backend:
  `vcs_describe` / `vcs_squash` removed; `vcs_update`'s jj arm refuses with
  a terminal hint.

### Fixed

- **jj bookmarks were unclickable when they sat on `@` or `@-`.** "Current"
  detection marks the *nearest* bookmark, and the branch menu disabled
  current items — a git-ism (`git switch <current>` is a no-op) that could
  lock **every** bookmark (test plan B-I.5). jj items are never disabled now:
  `jj new <bookmark>` is always a valid move; the ● marking stays.

## [0.9.0] - 2026-07-13

The 0.9 series is the pre-release test pass, run from source (see
docs/release-plan.md): 0.9.0 = the 0.8.15 app + the 2026-07 audit fixes +
the doc/README refresh + the first test-pass UX changes; further findings
land as 0.9.x. Installers arrive at 0.10.

### Added

- **Branch menu: explicit ＋ create button** beside the new-branch/bookmark
  box (Enter still works; disabled while empty).
- **↑ Push on the branch line.** The branch line's buttons are now
  **✎ ↑ ⇣ ⋯**: Push is one click (still confirms), shows the ahead count
  ("↑2"), disables when there's nothing to push, and spins while pushing
  (⇣ spins during a fetch, ⋯ during a rebase). The ⋯ menu now holds only
  Stash & pop (git) / Rebase & squash (jj) and is named accordingly.
- **Refresh all in the Source Control header** (⟳ beside +) — refreshes every
  tracked repo on every host. The per-card refresh button is gone (a running
  refresh still shows its spinner — click to stop waiting — and the card
  stamp reads "updating…" instead of disappearing).
- **Themed tooltips** (first adopted across the Source Control panel):
  drawn above the button instead of at the OS pointer, so a large cursor
  can't cover them, and they follow the app theme.

### Changed

- **Local repo cards show ◉ locked on** — local repos are file-watched, so
  the live-updates toggle is now an always-on indicator there ("changes
  appear by themselves"); it stays a real toggle on WSL/remote cards.

- **Straylight themes: info toasts are green** (`#5ce626`, matching the
  `success` slot) instead of pink-red — success messages no longer read as
  errors. Dracula / Nord / Solarized keep their native cyan/blue info colors.

### Fixed

- **Cancelling a transfer that overwrites no longer deletes the destination.**
  Files now stream to a temporary `.straypart` sibling and are renamed into
  place only when fully written; cancel/error removes only the temp file. A
  failed final flush now reports as an error instead of a completed copy.
- **Concurrent remote VCS ops no longer cancel each other.** Fetch / push /
  update on a repo while another is running is refused (UI toast + backend
  guard) instead of spuriously cancelling the first op and breaking its
  Cancel button.
- **Settings live-reload survives closing a settings.json tab.** File watchers
  are now refcounted per owner, so the open-tab watcher letting go no longer
  tears down the watcher that applies hand-edits to settings.json/theme.json.

## [0.8.15] - 2026-07-09

### Added

- **Git history redesign.** The History panel takes the full explorer column
  (open-in-editor closes it); a **⇣ Fetch & review** button on the SCM panel
  opens it with an **Incoming** block (per-branch, git) offering
  **Merge / Dismiss** — shown at the top of the log tab too; remote branches
  list in the branch menu (click checks out, DWIM); a colocated repo's
  backend badge click-toggles git ⇄ jj; "Load older commits…"; commit detail
  loads on click.
- **Startup connect asks** — `autoConnect.wsl/remote`: ask / always / never.
  On launch a dialog offers the last WSL distro, then the last remote; the
  checkbox upgrades to "always" only on Connect; Skip also cleans the saved
  host so it isn't asked again.
- **Ctrl+Tab switcher**: a centered overlay (1.5x type) listing every editor
  tab across all splits — or, when a terminal is focused, every panel
  terminal grouped by host (group-bar order, then each host's tab order).
  Hold Ctrl, tap Tab to walk, release to land; works inside terminals.
- **Transfers docked** — the two-pane copier is now a tool group in the
  terminal panel (left pane defaults to Local; each host picker hides the
  other side's choice; picks last for the app session). The header ⇄ and the
  popup are gone.
- **Tool view frame**: Ports / Containers / Forwarding / Transfers sit inset
  in a green-outlined box that fuses with the picked chip (one block); wider
  scrollbars inside the box; tool chips carry icons.
- **Explorer host-tools line** under every host bar (host-color wash): pin,
  show-hidden, new file/folder on the left; updated-time + refresh flush
  right. Edit-ssh-config sits beside the remote connect (plug) button;
  connect menus hide already-connected hosts.
- **Download** (WSL/remote context menu) — straight to the Windows Downloads
  folder.
- **Pin badge** — pinned tabs mark the file icon with a ⌖ reticle (click the
  icon to unpin); new `pin` theme color.
- **EOL switcher**: the status bar LF/CRLF is clickable — converts the open
  file (undoable).
- **Root collapse/expand persistence** per host + folder, all hosts.

### Changed

- **Ctrl+Shift+`** opens the new terminal on the *focused terminal's* host,
  and only works while a terminal is focused (the palette command keeps the
  remote → WSL → local fallback).
- Editor tabs: the WSL/remote host stripe moved to the TOP edge — the bottom
  line now only ever means "picked tab".
- Context menus measure their real size and clamp to the screen.

## [0.8.14] - 2026-07-09

### Added

- **Terminal panel, group-bar edition.** A draggable top bar with one chip per
  connection (L/W/R letter in the host color, terminal count only when > 0);
  each group owns its terminals — + opens pwsh directly for Local (▾ for the
  shell menu) and the host's shell elsewhere. The terminal list shows the
  active group only, drag-reorders, and drag-resizes down to an icon-only
  rail; » (pointing down) collapses the panel.
- **Ports** (new tool group): listening TCP ports on monitored hosts — VS
  Code-style table (host in its color, port, address, process, PID), grouped
  by host then port. Backend runs `ss`/`netstat` (unix) or PowerShell
  (local), parsed in Rust with tests. Zero cost while closed; polls every
  `panels.portsInterval` s while open. In-panel controls (persisted to
  settings.json): per-host monitor toggles, the interval, and a
  hide-system-ports filter (<1024 + RDP/SSDP/NFS/mDNS…). Forward on a row
  prefills Forwarding.
- **Forwarding docked** — the port-forward popup now lives as a tool group in
  the panel, covering all remotes.
- **Chip digits**: Ports/Containers chips show one count per connection
  ("Ports - 4 2"), respecting the Ports ignore list; Forwarding shows its
  active count. Nothing shows until a tab has polled.
- **`panels` settings section**: hide any tool group, tune both poll
  intervals (containers default 30 s, was 5), system-port filter, ignored
  hosts.
- **New app icon** (regenerated set + in-app logo).

### Changed

- **Status bar**: left side is just EXPLORER · SC · TERMINAL — uniform
  icon+label buttons; connection state/Reconnect moved out entirely (host
  bars own them); the file path + details sit on the right.
- **Active-tab picked-marks now always use the HOST color** (local = the
  Local section color) — the green/magenta special cases are gone; the
  terminal list's active icon follows the group's color.
- **Remote default colors fixed**: the ramp starts at the Remote section
  color (was Local's red) and assigns by slot — three remotes get magenta /
  orange / chartreuse instead of all red.
- Containers covers all remotes (was primary-only).

## [0.8.13] - 2026-07-08

### Added

- **Settings & Themes as editor tabs** (⚙ menu / palette): Settings — zoom,
  terminal font, per-dialog confirmation checkboxes, and click-to-record
  keybindings; Themes — save/apply/delete library themes and edit every live
  color via swatch cards. All writes go through settings.json (UI, file, and
  hand-edits stay in sync).
- **Config architecture:** settings.json is the ONE user file — behavior keys
  on top, the live color sections at the bottom, kept a complete template
  (missing keys refill at launch; user values win). theme.json is a hidden
  library (`themes`: name → full sections) seeded once with all built-ins;
  quick-theme picks are pure data copies. Legacy/combined files migrate
  automatically.
- **Confirm dialogs got "don't ask again" checkboxes** (exit, unpin, track/
  remove repo, update, push, stash pop, squash, amend-pushed), persisted in
  settings.json `confirms`; applied only on confirm, never on cancel.
- **WSL section redesigned like Remote**: permanent WSL bar (+ swaps distros,
  properly disconnecting the old one); the connected distro is a `user@distro`
  host bar with its own right-click color (persisted per distro).
- **Draggable tabs**: reorder within a strip, drag onto another strip to move
  groups, drag onto the last group's right half (⧉ zone) to split. VC card
  drag-reorder shipped earlier now has company.
- **Breadcrumb bar** under the tab strip (`pin › folder › file`, per pinned
  root) hosting ¶ Preview; **sticky scroll** in the editor (function/block
  headers pin to the top).
- **Exit confirmation** on the window × (Enter closes / Esc stays), silenceable.
- Explorer/Source Control **panel minimize buttons** (« »), status-bar
  Explorer toggle, title-bar ⌘/⚙ spacing, themable title bar
  (`titlebar`/`titlebar-fg`, default #AF011C), pinned tabs show a magenta ⌖.

### Fixed

- **Ctrl+Z after Ctrl+S was dead**: saving triggered our own file watcher,
  whose reload reset Monaco's undo stack. Saves now sync the watcher's guard,
  and external reloads use undo-preserving edits.
- Tab-strip design system: chip tabs (no separators), a grey rail with green
  active-file marks (thicker in the focused group), an on-demand 12px scroll
  lane UNDER the rail (tabs never squeeze), always-visible pink group
  dividers, and stable handle ids for the 3-group overlap.

## [0.8.12] - 2026-07-06

### Added

- **Multi-remote: up to 3 SSH hosts in one window.** The Remote section's +
  attaches additional servers; each gets its own host bar (color, pins,
  hidden-files toggle, refresh stamp, state dot, per-host reconnect and
  disconnect) with its tree below. Terminals, version control, search/quick-
  open scopes, and tab color stripes are all per-host; sessions persist and
  restore every attached remote (key hosts auto-reconnect; the first password
  host gets the pre-filled dialog). The title/status bars show the primary
  (first) remote; transfers pair Local ⇄ the primary for now.

## [0.8.11] - 2026-07-06

### Added

- **Split editors.** Up to 3 side-by-side editor groups: tab context menu →
  Split Right / Move to Left/Right Group (also `Editor: Split Right` in the
  palette). Models are shared across groups, so a moved tab keeps its content,
  undo history, and dirty state. Per-group preview slot, pinned block, Ctrl+Tab
  ring, and bulk-close scope; the focused group carries an accent stripe;
  splits are restored on relaunch.
- **Terminals in the editor area.** ⇱ on a panel terminal moves it into an
  editor tab — the live xterm DOM is reparented, so the shell keeps running
  with scrollback intact. Closing the tab returns the terminal to the panel;
  killing the session (or disconnecting its host) closes the tab.
- **Host identity colors.** Local / WSL / Remote section bars have their own
  theme keys (`section-local/wsl/remote`); a connected remote gets a **host
  bar** (`user@host` + toolbar) under the permanent Remote bar, with a
  right-click color menu. The host's color shows on the host bar, title-bar
  tint, its VC card frames, and WSL/remote file-tab stripes; the native window
  title reads `user@host — Straylight` (taskbar / Alt+Tab). WSL's bar shows
  `user@distro`.
- **L / W / R section toggles** in the Explorer header hide/show each section
  without touching connections (persisted).
- **Draggable VC cards** — drag a card header onto another card to reorder;
  persisted.
- **⌘ Commands moved to the title bar** next to ⚙ (red while settings.json has
  problems); removed from the status bar.
- **New app icon** — full desktop icon set regenerated from the new source
  (`src-tauri/icons/icon-source.png`); used by the window/taskbar/installers
  and in-app (title-bar logo and the empty-editor screen).

### Changed

- Per-repo card colors removed: card frames now always follow the owning
  host's color; tracked-repo indicators in the tree stay green.

## [0.8.10] - 2026-07-06

### Added

- **Straylight is the built-in default theme.** The signature palette
  (`#AF011C` accent) is now what a fresh install boots with; the base CSS is
  `theme/straylight.css` and all built-in fallbacks (UI, editor, terminals,
  Monaco pre-settings theme) use it. "Theme: Straylight (default)" is the
  reset preset; Dracula stays as a normal explicit preset.
- **Solarized Light preset** — the classic light theme, with a light Monaco
  base picked by background luminance and file-icon tints that now reference
  theme palette slots (so light themes stay readable).
- **Per-shell-kind terminal theming.** settings.json now has one full xterm
  section per shell kind — `terminalLocal` (pwsh), `terminalWsl`, and
  `terminalRemote` (SSH) — with no inheritance between them. Presets write all
  three: local = WSL, remote darker (the Dracula preset ships the classic
  black Campbell console for SSH).
- **`terminalFont`** (`{ "family", "size" }`) — terminal font settings, applied
  live with a refit; deliberately never touched by theme presets.
- **Ctrl+= / Ctrl+- / Ctrl+0 in a terminal** now step/reset the terminal font
  size (persisted); outside a terminal they remain whole-app zoom.
- **Per-repo colors.** Tracked repos default to green; right-click a repo card
  in Source Control to pick its color. The card frame, explorer root label,
  repo-root folder, and ⑂ indicator all follow it.
- **Themable folder icons** — new `icon-folder` / `icon-folder-open` color
  keys (per-preset values included).

### Changed

- Explorer sections are ordered Local → WSL → Remote; all hosts share the
  theme accent (per-connection hashing removed); section bars use an accent
  gradient with the new `section-fg` contrast slot; pinned names and folder
  names are plain foreground (new `tree-root` / `tree-dir` keys), with repo
  colors reserved for tracked roots.
- "Edit ~/.ssh/config" moved from the connection panel to the Remote section
  header.
- Catppuccin Mocha preset removed (final theme roster to be decided before
  1.0.0).

## [0.8.9] - 2026-07-05

The 1.0 contracts: one settings file, a command palette, themes, zoom, and
VS Code's tab model. The promises are written down in
[docs/stability.md](docs/stability.md).

### Added

- **`settings.json`** (app config dir) — the one hand-editable preferences
  file, watched and re-applied live on save: `zoom`, `keybindings` (stable
  command id → `"ctrl+alt+f"`-style spec), and the **color sections**
  (`colors` / `editor` / `terminal`) which *are* the theme — every key
  individually editable, missing keys fall back to defaults. Problems never
  fail silently: toast + a warning row in the palette that opens the file.
- **Command palette** — `Ctrl+Shift+P` or the status-bar **⌘ Commands**: every
  command (~30, stable ids) with its effective keybinding; fuzzy search; Enter
  runs. The empty editor screen now shows the core shortcuts.
- **Themes** — a **⚙ appearance menu in the title bar**: Dracula (default),
  **Nord**, **Catppuccin Mocha**. A preset just overwrites the settings.json
  color sections; UI chrome, editor syntax colors, and live terminals restyle
  instantly.
- **Window zoom** — `Ctrl+=` / `Ctrl+-` / `Ctrl+0`, native WebView page-zoom
  (sharp, reflows, terminal/editor refit), persisted.
- **VS Code's tab model** — single-click opens an *italic preview* tab (the
  next single-click replaces it); double-click / editing / "Keep Open"
  promotes. **Pin** a tab (right-click) to keep it leftmost, spared from bulk
  closes and Ctrl+W. Tab **context menu**: Close / Others / to the Right /
  Saved / All / Pin / Copy Path — bulk closes use one "save all & close?"
  dialog. Pinned/preview state survives restarts.
- **New keys** — `Shift+Alt+C` copy path and `Alt+Enter` properties on the
  explorer selection; `Editor: Close All / Close Saved Tabs` in the palette.

### Fixed

- Creating any editor no longer resets the global Monaco theme.

## [0.8.8] - 2026-07-05

Explorer ⇄ Source Control, and ignored files dim.

### Added

- **Ignored-file dimming, VS Code-style.** Ignored files and folders (and
  everything inside an ignored folder) render dimmed in the explorer, with no
  badge, and never appear in the Source Control lists. Works for git repos and
  **colocated jj repos** (read via `git --no-optional-locks status --ignored` —
  guaranteed read-only, so jj can't desync).
- **⑂ on every explorer root.** Pinned folder headers get a source-control
  button: already tracked → reveals the panel (the ⑂ stays purple); untracked →
  a confirm, then it's validated and added like the panel's +.
- **Unpin asks first.** Removing a pinned folder from the sidebar now confirms
  (nothing on disk is touched), like the repo-card ×.

### Fixed

- **jj on Windows emits backslash paths**, which silently broke tree decorations
  for nested files in local jj repos (only top-level files got their M/A
  letters). All jj-parsed paths are now normalized to forward slashes.

## [0.8.7] - 2026-07-05

The backlog run: seven features and a cleanup sweep.

### Added

- **Multi-lane commit graph.** History renders real lanes — branches and merges
  fork and join with per-lane colors, and **all local branches** show without
  checking them out (git logs `--branches HEAD --topo-order`; jj's default
  revset was already multi-head).
- **3-way merge editor.** **⚔** on a conflicted file opens Current | Incoming
  panes (each side fully resolved) over an editable Result seeded with the
  markers — per-conflict Accept lenses, accept-all buttons, and **Complete
  merge** (save + stage) once nothing remains.
- **Containers tab.** **▣ Containers** in the terminal list shows running
  containers (podman preferred, else docker) across every connected host with
  image/ports/status — refreshed only while the tab is open. Click one to land
  in a shell inside it (a visible `… exec -it <id> /bin/sh`).
- **Markdown preview.** **¶ Preview** in the tab bar (or `Ctrl+Shift+V`) renders
  the active `.md` GitHub-style (marked + DOMPurify, bundled); shows unsaved
  edits; links can't navigate the app away.
- **Auto-reload open files.** Clean tabs reload themselves when the file changes
  on disk — local via a per-file watcher (instant log tailing; the view follows
  the tail when pinned to the bottom), remote/WSL via a 3 s mtime poll. Dirty
  tabs are never touched.
- **Remote jj detection.** `jj` is probed per SSH connection (PATH → common
  install dirs → login shell) and cached, so colocated repos on remotes/WSL stop
  silently falling back to git. (Repos opened as git before: remove + re-add.)
- **Remote-op cancel.** Fetch / push / update show a "running — Cancel" banner;
  Cancel kills the SSH channel or local process and frees the repo lock — the
  escape hatch for interactive-auth hangs on the no-TTY channel.
- **Per-connection colors.** Right-click a repo card → swatch row (+ Auto);
  the override persists and wins over the hash color.

### Fixed

- GNU grep exiting 2 on unreadable files no longer discards search results; big
  per-user toolchain dirs (`.cargo`, `.rustup`, `.cache`, …) are excluded from
  search and the finder.

### Internal

- Cleanup sweep: every registered Tauri command is invoked (59/59) and dead
  exports were removed (`ssh_get_status` end-to-end, `deleteEntry`,
  `isImageFile`, `isTerminalAction`).

## [0.8.6] - 2026-07-04

Scoped quick-open & search, and the last of the rework polish — batches 3–4.

### Added

- **Pick where to look, first.** `Ctrl+P` and `Ctrl+Shift+F` open with a host
  picker — `1 Local / 2 WSL / 3 Remote / 4 All`, chosen by number key, ↑↓ +
  Enter, or mouse (last choice remembered) — then show that host's **pinned
  folders as tabs**: `All pins` or one pin, switched with **Tab** or a click.
  Esc always closes. Both tools search pinned folders only.
- **Streaming results.** Every pin indexes/searches independently, with a
  per-pin status line ("straylight: 12 hits · notes: searching…") — one slow
  host can't block or hide the others.
- **Port forwarding polish.** Duplicate local ports are rejected; a failing
  tunnel (e.g. nothing listening on the remote port) turns the forward **red
  with the reason** and raises a toast; bind errors explain Windows'
  reserved-port ranges.
- **Tree roots that fail to list** show "Folder unavailable — may have been
  removed" with a **Retry** button (plus a 10 s timeout backstop) instead of
  loading forever.

### Fixed

- **WSL search ran "forever".** Two causes: search read *through*
  `.cargo` / `.rustup` / `.cache` / `.npm` / `.venv` / `__pycache__` … — those
  are now excluded (the finder skips them too); and GNU grep exits 2 when it
  merely hit an unreadable file *even with matches found* — those results were
  wrongly discarded.
- The native WebView right-click menu (重新整理/列印/檢查) no longer appears;
  text inputs keep native paste, and Monaco/xterm/tree menus are unaffected.

## [0.8.5] - 2026-07-04

Version control goes live-updating, learns to resolve conflicts, and gets a
calmer panel — the post-Phase-3 rework, batches 1–2.

### Added

- **Live status.** Local repos are **file-watched** (`.git`/`.jj` and the working
  tree) — the panel, tree decorations, and history update by themselves after
  terminal git/jj ops or external edits. Remote/WSL repos refresh on **window
  focus**; every repo populates once on startup/reconnect.
- **F5 / Ctrl+R = Refresh All.** Instead of reloading the app (WebView reload is
  now blocked), they refresh every explorer section and repo and reload **clean**
  open file tabs from disk — dirty tabs keep their edits. Ctrl+R still reaches the
  shell in a terminal.
- **Conflict resolution.** Conflicted files show in a red group; opening one
  highlights each conflict and offers **Accept Current / Incoming / Both** inline
  (git-style markers), with **Mark resolved** on the card. A conflicted stash pop
  shows a banner with **Drop stash**.
- **Update replaces Pull.** Fetch is always safe and silent; when behind, a
  contextual **Update** (git: merge upstream) / **Rebase** (jj) appears. Update,
  Rebase, Pop, and **Push** confirm first; amend confirms only when the last
  commit is already pushed.
- **jj parity.** The commit box has modes — git: `Commit | Amend`; jj:
  `Commit | Describe | Fix last msg` — plus **Squash into last** (`jj squash`).
  Amend now also works with staged changes and no message (keeps the message).
- **A calmer repo card.** Header: ⎇ history · ◉ live-update · ⟳ refresh · ×
  unpin (asks first). The branch line carries **✎** (commit box, opens right
  under it) and **⋯** (an actions dropdown: fetch / update / push / stash / pop —
  jj: fetch / rebase / push / squash). Cards are framed in their **connection's
  color**; full identity on hover.
- **History above the explorer.** Its own panel on top of the file tree (the
  editor stays free for comparing), opened/closed by the ⎇ toggle, always in sync
  with the repo — a "syncing…" line shows each live refresh.
- **Copyable toasts** — text is selectable, a copy button, and hovering pauses
  auto-dismiss.

### Fixed

- Native `<select>` dropdowns were white-on-white (dark-styled control, white
  native popup); form controls now follow the dark theme.
- The **Ports** button vanished without a remote/WSL connection — it's always in
  the status bar now.

## [0.8.4] - 2026-06-22

Round out version control, and add quick-open, search, and port forwarding.

### Added

- **Branch / bookmark switching.** Click the branch on a repo card to switch
  (`git switch` / `jj new <bookmark>`) or type a name to create + switch.
- **Amend** the last commit (git), and **stash / pop** (git).
- **Fuzzy file finder (Ctrl+P).** Index files across every pinned folder and
  fuzzy-open one. Local walks the filesystem; remote/WSL use `find`.
- **Search in files (Ctrl+Shift+F).** Literal search across pinned folders, grouped
  by file; click a hit to open the file at that line. Local scans in Rust;
  remote/WSL use `grep`.
- **Port forwarding.** A "Ports" status-bar control forwards a local 127.0.0.1
  port to a `host:port` reachable from the SSH server, over a `direct-tcpip`
  tunnel on the existing connection.

### Internal

- Extracted a reusable `exec` module (the host command-runner shared by VCS, the
  finder, and search).

## [0.8.3] - 2026-06-21

Sync with remotes, browse history, and undo changes.

### Added

- **Fetch / Pull / Push** per repo (jj: `jj git fetch` / `jj git push`). Note: these
  authenticate as the *host's* git identity; an interactive prompt (key passphrase,
  2FA, HTTPS password) will hang the in-app command — run those in the terminal.
- **Browse history.** Click a commit in the history view to expand its changed
  files; click a file to open a diff **for that commit** (commit vs its parent),
  for git and jj.
- **Discard changes** (↩ on a change row) — reverts a file to the last commit
  (git `restore` / jj `restore`) and deletes new/untracked files, behind a confirm.

## [0.8.2] - 2026-06-21

Commit history, and clearer staging.

### Added

- **Commit history.** The **⎇** button on a repo card opens a history panel
  appended to the left of the Source Control cards — a single-lane graph with each
  commit's refs/bookmarks, subject, author, and time — plus a **⧉** button to pop
  it out into a full-width editor tab. Works for git and jj.
- **A `git` / `jj` badge** on every repo card.

### Fixed

- **Staging status was ambiguous.** A file that's staged *and* re-modified now
  shows in **both** Staged and Changes; after `git add .` everything sits under a
  clear "✓ Staged Changes" group (previously a staged `M` was indistinguishable
  from an unstaged `M`).

## [0.8.1] - 2026-06-21

Diff and commit.

### Added

- **Diff viewer.** Click a changed file in Source Control → a read-only Monaco
  side-by-side diff (base — git `HEAD:` / jj `@-` — vs the working copy). Opens as
  a tab; added/untracked → empty old side, deleted → empty new side, renames diff
  against the old path, binaries are skipped.
- **Stage / unstage / commit.** git cards split into **Staged Changes** and
  **Changes** with per-file and "all" actions and a commit-message box (commits the
  staged set). jj uses **describe + commit** (`jj commit`) — no staging. Mutations
  serialize per repo so rapid clicks can't collide on `index.lock`.

## [0.8.0] - 2026-06-21

Phase 3 begins: see your repositories' status — for **git** and **Jujutsu (jj)**.

### Added

- **Source Control panel** (right-side, collapsible). Open a repository explicitly
  (validated as a real repo, else rejected) on any connection — local, WSL, or
  remote. Each repo shows its branch/bookmark, ahead/behind, and changed files,
  with a manual **refresh** and an **eager** toggle for live updates. Repos persist
  per connection identity, so they return on reconnect/relaunch with cached status.
- **File-tree decorations.** Changed files are colored with a status letter
  (M/A/D/R/U…); folders containing changes get a marker.
- **Status-bar branch hint** for the file you're editing.
- **git + jj backends.** VCS commands run on the host that owns the repo (an SSH
  exec channel for remote/WSL, a local process for local) — there's no local clone,
  so commits use the host's real identity, hooks, and config. A colocated repo is
  detected as jj. Design + the jj command spike: `docs/version-control.md`.
- Ignore `.jj/` in `.gitignore`.

### Notes

- This release is **read-only** (status, decorations, branch). Diff, stage/commit,
  and push/pull come next. jj on a *remote* needs `jj` on the exec PATH; detection
  falls back to git otherwise.

## [0.7.2] - 2026-06-20

Transfer files of any size, watch them move, and inspect what you're moving.

### Added

- **Streaming transfers — no size cap.** Cross-connection copies now stream a
  256 KB buffer between transports instead of buffering whole files in memory, so
  the old 512 MB limit (`MAX_TRANSFER_BYTES`) is gone and a multi-GB file copies
  with flat memory use. Design: [streaming-transfers.md](streaming-transfers.md).
- **Live progress + cancel.** A transfer shows a progress bar
  (`file 3/12 · 740 MB / 2.1 GB`) with a Cancel button. Progress is **global** —
  it stays visible in the **status bar** after you close the transfer panel, and
  Cancel rides along with it. Cancelling cleans up the partial file.
- **Properties** (right-click). Name, kind, location, size, contents, modified
  time, permissions, and owner · group for a file, folder, or multi-selection.
  Folder/selection size is computed recursively ("Calculating…"); owner · group is
  shown only where it's meaningful (remote/WSL, not local Windows).

### Changed

- A failed or cancelled transfer best-effort deletes the partial destination file,
  so a interrupted copy never leaves a silently truncated file behind.

## [0.7.1] - 2026-06-19

Target a working directory, not the home root: an in-app folder browser and
pinnable directories for every connection, reused in the transfer tab.

### Added

- **In-app folder browser** for local, WSL, and remote — replaces the OS folder
  dialog so every connection picks directories the same way. Includes a path bar,
  and on Windows a **drive bar** (`C:` `D:` …) to switch disks without typing
  (Linux/remote has a single `/` tree, so none is needed).
- **Pinnable working directories on WSL and remote**, like Local — pin the repos
  you actually work in (shown collapsed); the home dir is pinned automatically on
  connect, and every pin is removable. Pins **persist per connection**
  (`user@host:port` for remote, distro name for WSL) across reconnect and
  relaunch.
- **Spring-loaded folders** in the transfer tab — hover a collapsed folder during
  a drag and it expands after 0.5s, so you can drill in without dropping.

### Changed

- **WSL/remote roots start collapsed** instead of auto-expanding the cluttered
  home dir — you land on a tidy root and expand into your working dir.
- **Transfer tab reuses the pinned dirs** (collapsed, hidden files off) with a
  per-pane hidden-files toggle and a one-off **＋** button to open a folder for
  that panel session only (not pinned or remembered).
- Local "Open folder" now uses the in-app browser, not the Windows dialog.
- In the transfer tab, dropping onto a file copies into its parent folder (no
  dead rows mid-drag).

### Fixed

- **Transfer tab F2/Delete acted on the explorer's selection** — often a
  different host — so Delete could target the wrong machine ("session not open").
  The transfer panel now owns F2/Delete on its own selection while open, and
  pinned root rows are excluded from rename/delete.
- Forbidden drag cursor after a folder expanded mid-drag in the transfer tab.

### Removed

- Unused `tauri-plugin-dialog` and `tauri-plugin-fs` plugins (and their capability
  grants) — file operations go through our own transport commands, and the folder
  dialog is now in-app.

## [0.7.0] - 2026-06-18

Move files between machines, and act on many at once: cross-connection transfers
and multi-select.

### Added

- **Transfers between connections.** Three buttons in the Explorer header open a
  two-pane panel for a pair — **Local ⇄ Remote**, **Local ⇄ WSL**, **WSL ⇄
  Remote**. Drag a file/folder from one pane onto a folder in the other (or use
  copy/paste) to copy it across; folders go recursively, and a name clash prompts
  **Overwrite / Keep both / Cancel**. Each pane is a full file manager
  (right-click: New File/Folder, Copy, Paste, Rename, Delete, Copy Path — **Cut is
  locked**, since transfers are copy-only). Backed by a new `fs_transfer` relay
  over the transport layer (raw `read_bytes`/`write_bytes`). See
  `docs/drag-drop.md`.
- **Multi-select.** **Ctrl+click** toggles a node, **Shift+click** selects a range
  — in both the explorer and the transfer panel. Act on the batch at once:
  **delete** ("Delete N items") and **transfer** (drag or copy/paste many,
  resolving collisions in one prompt). Rename and Copy Path lock while more than
  one item is selected.

## [0.6.0] - 2026-06-18

WSL as a first-class connection: browse a distro and run its terminal at native
speed, with zero setup.

### Added

- **WSL distros as connections.** A new **WSL** sidebar section lists your
  installed distros (the default highlighted, container/system distros hidden);
  click one to connect. Under the hood Straylight **auto-provisions an SSH server
  inside the distro** — installing OpenSSH on first use (with consent) — and
  attaches it as a `localhost` SSH host, so files and the terminal run on the
  distro's **native ext4** filesystem rather than the slow `\\wsl$` bridge. WSL
  gets its own slot (Local + WSL + remote at once), a toolbar matching the other
  sections (hidden-files, New File / New Folder, refresh, "last refreshed"), a
  file tree, and a terminal opened on connect. See `docs/wsl-connection.md`.
- **Configurable new-terminal target.** `+` and `Ctrl+Shift+\`` open a terminal on
  the first active of **remote → WSL → local**; a "New opens" preference in the
  shell menu (`Auto` / `Remote` / `WSL` / `Local`) pins it, and the choice
  persists. The shell menu also lists the connected WSL distro's shell.

## [0.5.1] - 2026-06-17

A keyboard-driven explorer — full tree navigation, per-section toolbars, and
cut/copy/paste — plus a smoother no-key connect fallback.

### Added

- **File-tree keyboard navigation** — when the explorer has focus, arrow keys
  drive it: ↑/↓ move the selection (across roots), → expands a folder or steps
  into it, ← collapses it or jumps to the parent, **Enter** opens a file or
  toggles a folder, and **Home/End** jump to the first/last row. **PageUp /
  PageDown** hop to the previous / next root (each server's top). **Ctrl+Shift+E**
  focuses the tree.
- **New File / New Folder** buttons in each section's toolbar — they create in
  the selected folder (or the selected file's parent), falling back to the
  section root.
- **Cut / copy / paste** in the explorer — right-click or `Ctrl+X` / `Ctrl+C` /
  `Ctrl+V` while the tree has focus. Paste lands in the selected (or right-
  clicked) folder and auto-renames on a collision (`name copy`, `name copy 2`);
  same-connection for now. Backed by new recursive `fs_copy` / `fs_move`
  transport commands.
- **Per-section "last refreshed" stamp** (e.g. `5s ago`) beside each refresh
  button, coarsening on its own from seconds through minutes, hours, and days.

### Changed

- **Explorer controls are now per-section.** The hidden-files toggle and refresh
  live in the **Local** and **Remote** bars and act on only that section
  (`Ctrl+Shift+R` still refreshes both). The transient "Refreshed" toast is gone
  in favour of the per-section timestamp.
- **Local roots start collapsed** and load lazily — a collapsed root does no I/O
  until you open it (matters for slow network / WSL paths).
- **Single-click selects; double-click opens.** Clicking a file now only selects
  it (so you can set the keyboard cursor without opening a tab); it opens on
  double-click, Enter, or →. Folders still expand/collapse on single-click.
- The **password connect dialog auto-focuses** the field you need next — Host for
  a fresh connection, User for a config host that's missing one, Password when
  host and user are already known.
- **A config host with no usable key now falls back to password entry** — clicking
  it opens the connect dialog prefilled (with the password field focused and a
  short note) instead of dead-ending on a "no usable key" error.

### Fixed

- **Esc dismisses the delete confirmation** without deleting (same as Cancel).

## [0.5.0] - 2026-06-17

Terminals grow up: multiple terminals, a shell picker, and Windows scrollback
that finally behaves.

### Added

- **Multiple terminals** — open as many as you like, listed down the right side
  of the panel (VS Code style). `+` opens one on the current workspace;
  `Ctrl+PageDown` / `Ctrl+PageUp` cycle them; middle-click or × closes one. You
  can keep a local and a remote shell open at the same time.
- **Shell picker** — the `▾` beside `+` lists local profiles — **PowerShell 7,
  Command Prompt, Git Bash, and each installed WSL distro** — plus the remote
  login shell when connected. Picking a WSL distro opens a native `wsl.exe`
  terminal.
- A **remote terminal opens automatically** when you connect to a server (and on
  launch auto-reconnect).

### Changed

- **`Ctrl+\`` is now smart** (VS Code-style): reveals and focuses the terminal
  when it's hidden, focuses it when it's visible but unfocused, and only hides it
  when it already has focus. `Ctrl+Shift+\`` opens a new terminal.
- The terminal panel can be dragged up to **fully cover the editor**.

### Fixed

- **`Ctrl+Shift+\`` now works** — it had been matching the `~` that Shift
  produces instead of the backtick key.
- **Local / WSL terminal scrollback no longer wipes, duplicates, or drops lines**
  on hide/show or resize. Three Windows-ConPTY problems: hiding the panel no
  longer resizes the shell to one row; a fast drag is debounced to a single
  resize; and xterm is now told it's driving a ConPTY (`windowsPty`) so it
  reflows wrapped lines correctly. Remote SSH terminals are unaffected.

## [0.4.0] - 2026-06-16

Connections survive drops, and your workspace survives restarts: auto-reconnect
and session persistence.

### Added

- **Auto-reconnect** — a dropped SSH connection (sleep, Wi-Fi change, server
  blip) now recovers on its own. A per-connection supervisor detects the drop,
  shows **Reconnecting…**, and retries with backoff, swapping the transport in
  place so open tabs, the file tree, and the terminal stay attached. Key hosts
  re-authenticate silently; a password is reused from memory for the session and
  is never written to disk. After repeated failures the status bar offers a
  manual **Reconnect**.
- **Session persistence** — on relaunch Straylight restores your panel layout
  (sizes + sidebar/terminal visibility), reopens the files you had open, and
  brings back the last server: **key-based hosts reconnect automatically** and
  their tabs reopen; a **password host pre-fills the connect dialog** (its tabs
  reopen once you connect). Files are reloaded from disk — an explicit disconnect
  is remembered, so it won't reconnect next launch.

### Changed

- The terminal restarts cleanly after a reconnect, and the file tree refreshes
  to reflect any changes made while disconnected.

## [0.3.0] - 2026-06-15

Editing comes online: edit and save files (local and remote), a tabbed editor,
file-tree operations, and a local terminal.

### Added

- **File editing & save** — the Monaco editor is editable; save with `Ctrl+S` to
  local or remote files. Per-tab dirty state (which clears when you undo back to
  the saved content), and **save-conflict detection** — Overwrite / Reload /
  Cancel if the file changed on disk since you opened it.
- **Editor tabs** — open multiple files, each with its own content, undo history,
  cursor, and scroll. Middle-click or `Ctrl+W` to close (with an unsaved-changes
  prompt); `Ctrl+Tab` / `Ctrl+Shift+Tab` to cycle; clicking an open file focuses
  its tab.
- **File operations** — **F2** inline rename and a right-click menu: New File, New
  Folder, Rename, Delete (recursive, with confirmation), Copy Path. The **Delete**
  key acts on the selection. Open tabs follow renames and close on delete.
- **Local terminal** — the terminal now works without a remote, via a local PTY
  (ConPTY on Windows). It targets the remote shell when connected, otherwise a
  local shell: **PowerShell 7 (`pwsh`) when installed, else Windows PowerShell 5.1**
  on Windows, and `$SHELL` elsewhere.

### Changed

- README refreshed: current feature set, terminal / shell behavior, keyboard
  shortcuts, architecture, and a Windows **C++ build tools** prerequisite.

## [0.2.0] - 2026-06-12

Phase 2 begins: a transport abstraction with local-filesystem support, and a
multi-root sidebar that shows local folders and one remote at the same time.

### Added

- **Local filesystem support** — browse and view local files in the same UI as
  remote, via a new `FileTransport` abstraction (SFTP and `std::fs` behind one
  trait; transport-agnostic `fs_list_dir` / `fs_read_file` / `fs_stat`).
- **Multi-root sidebar** — a **Local** section (pinned folders, persisted across
  restarts) and a **Remote** section (one SSH host), shown at the same time. Pin
  a folder with **+ / Open folder**; remove it with the × on hover.
- **One local + one remote per window** — connecting a server attaches it as a
  root alongside the local folders; a second server replaces the first.
- **Edit `~/.ssh/config` in-app** — the **Edit** action opens the config in the
  editor instead of an external program.

### Changed

- The title bar now identifies the attached **remote host**, or shows **Local**
  with a neutral indicator distinct from the green "connected" state.
- The large-file truncation banner and toast appear only when a file is opened in
  the editor — never on the binary info card.
- Removed the fixed "This PC" entry in favor of user-pinned folders.

### Notes

- Still read-only; file **editing + save** (local and remote) is the next step.
- No local terminal yet — the terminal is bound to the remote connection.

## [0.1.0] - 2026-06-12

First milestone — Phase 1, the "walking skeleton": connect to an SSH server,
browse the remote filesystem, read code with syntax highlighting, and use a
terminal, in a Dracula-themed, VS Code-style window built on Tauri v2 and React.

### Added

#### Application & theming

- Tauri v2 + React 18 + Vite + TypeScript scaffold; dual MIT / Apache-2.0 license.
- Complete Dracula theme via CSS custom properties; embedded Fira Code (Light
  through Bold) with ligatures across editor, terminal, and UI.
- VS Code-style layout (`react-resizable-panels`): a decorationless custom title
  bar with window controls and a per-host workspace-color accent, collapsible
  sidebar / editor / terminal panels, and a status bar.

#### Connections (russh 0.46)

- `~/.ssh/config` parsing — every concrete `Host` (HostName, User, Port,
  IdentityFile, ProxyJump) is listed in the sidebar.
- One-click connect for config hosts using on-disk keys (IdentityFile, then the
  default `~/.ssh/id_ed25519` / `id_ecdsa` / `id_rsa`).
- Manual password connections via a dialog (host / port / user / password and an
  optional jump host, with an auto-generated `user@host` label).
- `ProxyJump` bastion support and a 10-second connect timeout.
- An "Edit" action opens `~/.ssh/config` in the system editor; the host list
  refreshes when the window regains focus.
- A disconnect control for switching hosts without restarting.

#### Files (SFTP, read-only)

- Lazy-loaded file tree with type icons, permissions / owner / mtime tooltips,
  symlink indicators (resolved so symlinked directories expand), a hidden-files
  toggle, and refresh.
- Monaco viewer with language-detected syntax highlighting.
- Fast binary detection (sniffs the first 8 KB and skips the download) shown as an
  information card.
- Large-file handling: files of 50 MB or more open in plaintext / lightweight mode
  with a truncation banner.

#### Terminal

- A real SSH PTY rendered by xterm.js (WebGL when available), streamed over Tauri
  events, with resize wired through to the remote shell.
- Focus-aware Ctrl+C (SIGINT) and right-click copy / paste.

#### Other

- Status bar: connection state, file path, language, encoding, line ending, and
  cursor position.
- Toast notifications and keyboard shortcuts (Ctrl+`, Ctrl+B, Ctrl+Shift+E,
  Ctrl+W, Ctrl+Shift+R).

### Notes

- Authentication uses on-disk keys (via `~/.ssh/config`) or a password; there is
  no ssh-agent integration.
- `~/.ssh/config` is parsed manually, as the `russh-config` crate has no published
  0.3.x and cannot enumerate `Host` blocks.
- Host keys are trusted on first use; `known_hosts` verification is planned.
- Verified with `tsc --noEmit` and `vite build` (frontend) and `cargo check` and
  `cargo test` (backend, 4 tests passing).
