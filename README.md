# Straylight

A lightweight, open-source desktop application engineered to replace VS Code for remote server development. Straylight delivers the essential VS Code Remote-SSH experience—combining an **SSH file manager, embedded terminals, a tabbed code editor, and source control**—built on a Tauri v2 (Rust) backend and a React frontend. 

The project achieves a massive resource reduction, operating at **~30–50 MB of memory** (compared to VS Code's ~500 MB) packed inside a **~10 MB installer**.

**Status (v0.9.0):** Production-ready for source-build testing. A single unified window supports side-by-side management of local folders, a WSL distribution, and up to three concurrent SSH remotes. Installers and binaries will debut with the v0.10.0 release (see `docs/release-plan.md`).

> 💡 **[Insert a high-resolution screenshot or a looping 15-second WebP/GIF here showing Local, WSL, and a Remote server side-by-side, featuring a split Monaco editor and an open terminal.]**

---

## Key Features & Pillars

### 🖥️ Unified Multi-Host Workspace
* **True Multi-Root Sidebar:** Seamlessly blend pinned local folders, local WSL distributions, and up to three remote SSH targets within a single window.
* **Host Identity Colors:** Assign a stable identity color to each remote (via right-click). The host bar, title-bar tint, editor tab stripes, terminal chips, and Source Control card borders dynamically match this color for instant visual context.
* **Resilient Sessions & Auto-Reconnect:** Dropped SSH connections automatically reconnect with exponential backoff. Workspace layouts, editor splits, pinned/preview tabs, open files, and connected hosts are fully persisted and restored on relaunch.

### ⚡ Deep WSL & SSH Integration
* **Native-Speed WSL Access:** Straylight bypasses the slow `\\wsl$` network bridge. It automatically provisions an internal SSH server inside your WSL distribution (with explicit user consent) and attaches to it over a native `localhost` SSH connection, achieving raw ext4 performance.
* **Robust SSH Client:** Connect to `~/.ssh/config` hosts in a single click, supporting `IdentityFile` key authentication with automatic fallback to password entry. Built-in support for single-hop `ProxyJump` bastions and explicit 10-second connection timeouts.

### 🛠️ Advanced File Management & Streamed Transfers
* **Full Keyboard Navigation:** Complete tree navigation via keyboard (`Arrows`, `Enter`, `Home/End`, `PageUp/PageDown` to jump between roots) with persistent collapse/expand states.
* **Zero-Cap Streaming Transfers:** A dedicated multi-pane transfer tool copies files directly between any two hosts (Local ⇄ WSL ⇄ Remote) using true streams. To ensure atomicity, files are written to a temporary name and renamed into place upon completion—canceling a transfer will never corrupt an existing destination file.

### 🌿 First-Class Version Control (Git & Jujutsu)
* **Dual Git & Jujutsu (`jj`) Engine:** Run source control workloads directly on the host machine where the repository lives. No local cloning or heavy remote daemons required. 
* **Colocated Repo Support:** If a repository contains both `.git` and `.jj`, a badge in the UI lets you instantly toggle the driving backend.
* **Live Commits & Interactive History:** Features file-watched local updates, remote status refreshes on window focus, side-by-side diffing, conflict resolution (with a native 3-way merge editor), and a live multi-lane commit graph. Interactive network actions (`fetch`, `push`) include safety confirmation gates and a hard cancel banner for hung remote auth.

### ⌨️ Professional Editor & Terminal Experience
* **Splittable Monaco Editor:** Supports up to three distinct editor tab split groups. Features italic preview tabs, explicit tab pinning, breadcrumbs, sticky scroll, real-time Markdown preview (`Ctrl+Shift+V`), line-ending conversion (`LF`/`CRLF`), and a lightweight mode optimized for massive log files.
* **Hardware-Accelerated Terminals:** Powered by `xterm.js` (WebGL with canvas fallback) driving genuine system PTYs. Terminals are grouped by host, support drag-and-drop reordering, and feature a **Pop-out (`⇱`)** action that detaches a running terminal into an editor tab.

### 🔌 Bottom-Panel Power Tools
* **Live Port Monitoring:** Track listening TCP ports (process name, PID, address) across all connected hosts with one-click local port forwarding.
* **Container Shelling:** Detects running Podman or Docker containers on any active host—click any container to instantly drop into an interactive shell.

---

## Architecture

Straylight achieves its extreme efficiency by removing heavy remote agents and local clones. A single SSH connection per remote host is multiplexed into distinct, lightweight channels handling specific tasks. All version control commands, file-finding, and shell operations execute binaries natively on the remote host via a custom asynchronous `exec` runner.

```mermaid
flowchart TB
    subgraph Client [Local Client Environment - Tauri App]
        UI[React UI Architecture\nMonaco / xterm.js / Zustand]
        Tauri[Tauri v2 Rust Backend\nCore App Orchestration]
        UI <-->|Typed camelCase IPC\nsrc/lib/ipc.ts| Tauri
    end

    subgraph Transport [Transport Translation Layer]
        FT{FileTransport Trait}
        Exec[Async Exec Runner\nsrc/exec.rs]
        Tauri <--> FT
        Tauri <--> Exec
    end

    subgraph LocalHost [Local Machine OS]
        FT <-->|std::fs / tokio::fs| LocalFS[(Local Filesystem)]
        Exec <-->|ConPTY / Process Spawn| LocalPTY[Local Shell / Binaries]
    end

    subgraph RemoteHost [Remote Server / WSL Instance]
        Tunnel{Multiplexed SSH Session\nvia thrussh}
        Exec <-->|SSH Exec Channel| Tunnel
        FT <-->|SFTP Subsystem Channel| Tunnel
        
        Tunnel <-->|Direct-TCPip Channel| PortFwd[Local Port Forwarding]
        Tunnel <-->|PTY Session Channel| RemotePTY[Remote Login Shell]
        
        Tunnel <-->|Remote Exec Calls| RemoteBinaries[Native Binaries\ngit / jj / ss / docker]
        Tunnel <-->|SFTP Operations| RemoteFS[(Remote Filesystem)]
    end

    %% Styling
    style Client fill:#1a1c23,stroke:#3b4252,color:#eceff4
    style UI fill:#2e3440,stroke:#81a1c1,color:#eceff4
    style Tauri fill:#bf616a,stroke:#d08770,color:#eceff4
    style Transport fill:#2e3440,stroke:#4c566a,color:#eceff4
    style LocalHost fill:#232831,stroke:#4c566a,color:#eceff4
    style RemoteHost fill:#1e222a,stroke:#5e81ac,stroke-dasharray: 5 5,color:#eceff4
    style Tunnel fill:#434c5e,stroke:#88c0d0,color:#eceff4
```

---

## Prerequisites

| Tool / Dependency | Version | Notes |
| :--- | :--- | :--- |
| **Node.js** | >= 18 | Required for the frontend compiler (Tested against Node 24). |
| **Rust** | Stable | Backend compiler. `cargo` and `rustc` must be accessible on your environment path. |
| **C++ Build Tools** *(Windows)* | MSVC | Required for linking the Rust binary (`link.exe`). |
| **Tauri v2 System Deps** | Platform Dep | **Windows:** WebView2 (Preinstalled on Win 10/11).<br>**Linux:** WebKitGTK 4.1, `libssl`, `librsvg`, `build-essential`. |

### Quick Setup for Windows C++ Build Tools
If you do not have Visual Studio installed on Windows, you can quickly provision the required compiler toolchain via `winget`:
```bash
winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

---

## Getting Started

```bash
# 1. Install frontend and development dependencies
npm install

# 2. Synchronize built-in typography assets
node scripts/fetch-fonts.mjs

# 3. Launch the environment in development mode (Vite HMR + Rust hot reload)
npm run tauri dev
```
*Note: The initial `tauri dev` execution compiles the entire Rust backend wrapper and fetches its crate dependency tree. This can take a few minutes. Subsequent executions leverage cache targets and compile instantly.*

To compile production-optimized standalone native installers:
```bash
npm run tauri build
```

---

## Core Command Matrix

| Command | Function |
| :--- | :--- |
| `npm run dev` | Runs the isolated Vite development server inside a standard browser context (No native backend). |
| `npm run typecheck` | Executes an explicit TypeScript compilation verification (`tsc --noEmit`). |
| `npm run build` | Compiles a production-ready, type-checked static distribution of the React frontend. |
| `npm run tauri dev` | Boots the full desktop framework equipped with real-time UI and backend hot reloading. |
| `npm run tauri build` | Evaluates native target specifications and packages production-ready system installers. |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Triggers Rust unit-testing suites (Parsers for configuration files, git/jj output, permissions, and networking layers). |

---

## Primary Keyboard Shortcuts

| Keybinding | Action Context |
| :--- | :--- |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd> | Global Command Palette |
| <kbd>Ctrl</kbd> + <kbd>P</kbd> | Quick-Open Fuzzy File Search |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>F</kbd> | Global Content Search Across Files |
| <kbd>Ctrl</kbd> + <kbd>S</kbd> | Save Current File |
| <kbd>Ctrl</kbd> + <kbd>W</kbd> | Close Active Tab (Pinned items are bypassed) |
| <kbd>F5</kbd> / <kbd>Ctrl</kbd> + <kbd>R</kbd> | Hard Refresh Workspace States (Keeps dirty tabs intact) |
| <kbd>Ctrl</kbd> + <kbd>Tab</kbd> | Contextual Overlay Switcher (Toggles editor tabs / terminal groups) |
| <kbd>Ctrl</kbd> + <kbd>`</kbd> | Toggle Bottom Terminal Panel Visibility |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>`</kbd> | Launch New Terminal on the Currently Focused Host |
| <kbd>Ctrl</kbd> + <kbd>PageDown</kbd> / <kbd>PageUp</kbd> | Cycle Between Panel Terminals |
| <kbd>Ctrl</kbd> + <kbd>B</kbd> | Toggle Sidebar Visibility |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>E</kbd> | Focus File Explorer |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>R</kbd> | Hard Reload Target File Tree |
| <kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd> | File Tree Navigation (<kbd>→</kbd> Expand/Enter, <kbd>←</kbd> Collapse/Parent) |
| <kbd>Enter</kbd> | Open File / Toggle Folder Target |
| <kbd>Ctrl</kbd> + <kbd>X</kbd> / <kbd>C</kbd> / <kbd>V</kbd> | File Explorer Cut / Copy / Paste Actions |
| <kbd>F2</kbd> | Inline File/Folder Renaming |
| <kbd>Del</kbd> | Destructive File/Folder Elimination |

*Note: While the terminal context has focus, key sequences like <kbd>Ctrl</kbd> + <kbd>C</kbd> are naturally routed to the underling host shell subsystem (e.g., sending `SIGINT`) and are not captured by the application window. Keybindings are fully customizable inside the user settings tab or directly inside `settings.json`.*

---

## Licensing

Straylight is dual-licensed under the **MIT License** and the **Apache License 2.0**. You may freely choose either license path to govern your usage of this software. See `LICENSE-MIT` and `LICENSE-APACHE` for verbatim legal disclosures.