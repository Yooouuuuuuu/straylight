# WSL connection

Straylight browses files and runs terminals inside a **WSL distro** by treating
it as an SSH host on localhost, reusing the SSH/SFTP/PTY transport it already
has. A distro gets the same first-class treatment as a remote server — files, a
terminal, transfers — at **native ext4 speed**, with no second transport to
maintain.

---

## Background: why this is non-trivial

A WSL2 distro is a lightweight Linux VM. Its files live on a fast Linux ext4 disk.
Windows can reach those files, but only through a slow translation layer — the
`\\wsl$` / `\\wsl.localhost` UNC path, backed by the **9P** protocol. 9P is ~9×
slower than native ext4 (≈110 MB/s vs ≈1 GB/s) and stalls or hangs under load.
So the naïve "pin `\\wsl.localhost\<distro>` as a folder" approach is cheap but
gives a poor experience on big directory listings and (future) git status.

### How VS Code avoids 9P

VS Code uses a **client/server split**: the Windows window is just UI; a Node.js
**VS Code Server** is installed *inside* the distro (`~/.vscode-server/`) and does
all the real work — files, terminal, git, language servers, debuggers — natively
on ext4. The window talks to the server over a localhost TCP port (WSL2 forwards
localhost automatically). Files never cross the 9P bridge.

VS Code *has* to ship a custom server because it runs extensions, language
servers, and debuggers remotely — things plain SSH cannot host. (Its Remote-SSH
mode uses SSH only as a pipe and **still** installs that same server on the far
end.) The server is the product, not a workaround for a missing `sshd`.

### Why Straylight is different

Straylight only needs **three things** from a remote environment: browse files,
a terminal, and file transfers. SSH already provides exactly those (SFTP + PTY +
transfer plumbing). So we do **not** need a custom server — a standard `sshd`
running in the distro is enough, and we already know how to talk to it.

---

## SSH into the distro, not 9P

Treat a WSL distro as an **SSH host on `localhost`**: ensure an `sshd` is running
inside the distro, then connect to `localhost:<port>` with the existing SSH/SFTP
transport. WSL becomes "just another SSH connection."

| Option | Effort | File speed | New code |
| --- | --- | --- | --- |
| `\\wsl.localhost` as a local folder | tiny | slow (9P) | ~none |
| **SSH into the distro (chosen)** | **medium** | **native ext4** | **a provisioner only** |
| Custom Rust agent (VS Code-style) | large | native ext4 | a whole 2nd transport |

The SSH path gets VS-Code-level performance by **reuse**: no new transport, no
cross-compiled Linux agent, no 9P. The only genuinely new piece is a small
**provisioner** that makes sure `sshd` is up before we connect.

```
        WINDOWS                              │   LINUX  (the WSL distro)
                                             │
  Straylight backend                         │
   ├─ wsl.exe (control channel) ─────────────┼─► provision: install/start sshd,
   │                                         │     inject key, pick port
   └─ SSH/SFTP transport ── ssh localhost:PORT ─► sshd
        (existing)                           │     ├─ SFTP  → files (native ext4)
                                             │     └─ PTY   → terminal
```

---

## Distro discovery

- **Source of truth:** `wsl -l -v` (verbose). Unlike `wsl --list`, its output is
  **locale-independent** — the default distro is marked with `*` and each row
  carries Running/Stopped state and the WSL version. (`wsl --list` prints
  localized decoration like `(預設)` / `(Default)` that we must not parse.)
  Output is UTF-16LE with a BOM — strip it, as the terminal picker already does.
- **When:** enumerate **asynchronously at startup, non-blocking, with a timeout
  (~3–5 s).** The UI has already drawn, so a hung/updating WSL never freezes the
  app — we simply drop the result on timeout. Re-enumerate on window focus and on
  a manual refresh.
- **Default distro:** highlight the `*` one (it's the one a bare `wsl` targets).
- **Show state:** a Running/Stopped indicator per distro is cheap and useful.
- **Filter system distros:** hide container-runtime backends by denylist —
  `docker-desktop`, `docker-desktop-data`, `rancher-desktop`, `podman-*`, etc.
  (We already filter `docker-desktop` for the terminal picker.) A "show all"
  escape hatch can be added later if anyone needs one.
- **No auto-start:** listing a distro must not boot it. A distro only starts (and
  gets provisioned) when the user clicks to connect.

---

## Provisioning `sshd`

Most fresh distros ship the ssh *client* but **no running `sshd`**, so we set one
up — with consent, not silently.

**On connect to a distro:**
1. Check whether `sshd` is installed (e.g. `wsl -d <distro> -- command -v sshd`).
2. **Installed →** start it if not running (quick, silent), then connect.
3. **Not installed → first-time prompt:** *"<distro> has no SSH server — install
   one so Straylight can connect? [Install] [Cancel]."* On **Install**, run the
   install (showing progress), start `sshd`, then connect. On **Cancel**, don't
   connect.

Once installed, `sshd` stays installed — so future connects find it and go
straight through. **The presence of `sshd` is the memory**; there is no separate
"approved" flag to persist, and we only ever re-prompt if it's genuinely missing.

**Provisioning runs through `wsl.exe -u root`**, which gives **passwordless root**
inside the distro (the Windows user already owns it). Steps:
- install `openssh-server` (e.g. `apt-get install -y openssh-server` on
  Debian/Ubuntu);
- ensure host keys (`ssh-keygen -A`);
- inject Straylight's generated public key into the distro user's
  `~/.ssh/authorized_keys` (key auth — no password stored on disk);
- start `sshd` bound to `127.0.0.1` on a chosen port.

**Distro coverage:** target `apt` (Ubuntu/Debian) first — what most people run.
Detect and show a clear message for non-`apt` distros (Alpine `apk`, Arch
`pacman`, openSUSE `zypper`) rather than failing opaquely; per-distro package
managers can be added later.

---

## Sidebar / connection model

A **WSL** section joins **Local** and **Remote**, independent of the remote
slots: a window can hold **local folders + up to three WSL distros + up to
three SSH remotes** at once (1 + 3 + 3). The WSL section lists the discovered
distros (default highlighted, system ones hidden, a readiness dot per distro);
clicking one provisions and connects it as a root with its own host bar, and
the section's + attaches more (hidden at three). Each connected distro is a
full peer — color, pins, terminal group, VCS, search, status-bar dot — and all
attached distros restore on relaunch.

---

## Transfers (see [transfers.md](transfers.md))

Because WSL is its own transport, transfers involving it are **transport-to-
transport**, which the transfer engine supports:

- **WSL → remote** (or remote → WSL): no direct path — relayed through the app as
  a transparent 2-step (read from one SSH endpoint, write to the other). This is
  the case that requires the engine to relay rather than do a single-endpoint copy.
- **WSL ↔ Windows (local):** works over SSH like any local↔remote transfer. As an
  **optimization to revisit at build time**, since both live on the same machine,
  `wsl.exe` can move bytes directly without an SSH round-trip.

File **browsing/operations** stay on SSH/SFTP — natural reuse, native speed —
until we hit a concrete problem worth special-casing.

---

## The `wsl.exe` control channel (and escape hatch)

`wsl.exe` is a normal Windows executable we already invoke from the Rust backend
(for `wsl --list`). `wsl.exe -d <distro> [-u root] -- <command>` runs arbitrary
commands inside any distro **with no network involved**. It is:

- the channel for **discovery** and **provisioning** (above), and
- a genuine **last-resort fallback** for file operations if the SSH-over-localhost
  hop ever proves flaky.

So Straylight is never "uncontrollable" with respect to a distro — worst case, we
drive it directly through `wsl.exe`.

---

## Risks & fallbacks

- **WSL2 localhost forwarding** — the SSH hop relies on it. Usually fine, but has
  edge cases (mirrored networking mode, older builds). Fallback: drive the distro
  through `wsl.exe` directly (control channel above).
- **Non-`apt` distros** — auto-provisioning targets `apt` first; others get a
  clear message instead of a silent failure.
- **`sshd` lifecycle** — doesn't survive a distro shutdown, so we (re)start it on
  each connect (idempotent).
- **First connect installs a package** (needs network once); communicate it in the
  consent prompt + progress.

---

## Implementation

Backend lives in `src-tauri/src/wsl.rs`; the sidebar section is
`src/components/connection/WslSection.tsx`.

- **Script delivery.** Every script runs inside the distro via a base64 wrapper —
  `wsl.exe -d <distro> [-u root] -- bash -c "echo '<base64>' | base64 -d | bash"`.
  The wrapper command is pure alphanumerics, so `wsl.exe`'s command-line quoting
  can't mangle the real script (nested quotes, `$()`, redirects). *This was the
  bug that made the first attempts fail — a corrupted provisioning script started
  `sshd` but never wrote `authorized_keys`, surfacing as "no usable key".*
- **Discovery** (`wsl_list_distros`): `wsl -l -v` (locale-independent `*` =
  default) + `wsl -l --running -q` for the running set; system distros
  (`docker-desktop*`, `rancher-desktop`, `podman-*`) filtered; 5s timeout;
  loaded async in `WslSection`.
- **Key.** A shared ed25519 key under the app config dir
  (`wsl_id_ed25519`), generated once via the distro's `ssh-keygen` and carried out
  **base64-encoded** (newline-proof), then load-checked with the same
  `russh_keys::load_secret_key` the connection uses (self-heals if unloadable).
- **Provisioning** (`wsl_connect`, off-thread): resolve the login user
  (`whoami`); install `openssh-server` only with consent on `apt` distros; then
  derive the public key **from the exact private key** inside the distro
  (`ssh-keygen -y`) and authorize *that* (so `authorized_keys` can't drift);
  restart `sshd` on a **deterministic per-distro loopback port** with
  `StrictModes=no` (loopback + key-only, so permission strictness can't reject
  the key); finally hand a normal SSH connection to `ssh_connect`.
- **Slots.** `wsls[]` in the store (up to three, with legacy single-`wsl`
  mirrors of the first) — each distro has its own hidden/refresh/"ago" state, a
  sidebar toolbar matching Local/Remote, and a terminal opened on connect.
  Reuses SFTP, the PTY, and the reconnect supervisor per distro.
- **Performance.** `wsl.exe` work happens **only on a connect click** (~3 short
  calls + a 0.5s `sshd` restart). All file/terminal I/O afterwards is SFTP/PTY
  over loopback to native ext4 — no `wsl.exe`, no 9P.

### Known limitations (acceptable v1)

- **`sshd` dying mid-session does not auto-recover.** If `sshd` is killed while a
  distro is connected (e.g. the distro shuts down), the tree and terminal break
  and stay broken — the reconnect supervisor only re-opens the SSH transport, it
  doesn't re-provision/restart `sshd`. Recover by **disconnecting and
  reconnecting** (which re-provisions). *Verified 2026-06-18:* install / uninstall
  / kill-while-disconnected all recover correctly; only kill-while-connected
  needs the manual round-trip. **Future fix:** on a WSL connection drop, have the
  supervisor re-run provisioning before re-opening the transport.
- WSL connection state **is** surfaced (0.9.4): a dropped link shows a red
  status-bar dot, and a successful reconnect refreshes the tree + restarts the
  terminal like a remote. (Auto re-provisioning on failure is still future
  work — a reconnect only succeeds if `sshd` still lives, per the point above.)
- `sshd` is restarted on every explicit connect (idempotent; cheap).
- All attached distros — and their editor tabs — restore on relaunch, gated by
  the startup ask (`autoConnect.wsl`: ask / always / never; "always" is silent).
