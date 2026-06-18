# Straylight

A lightweight, open-source SSH file manager + terminal + code viewer built with Tauri v2, React, and Rust. The VS Code remote experience without the VS Code weight.

**License:** MIT OR Apache-2.0 (dual, following Rust ecosystem convention)
**Platforms:** Windows, Linux
**Target:** ~30-50MB memory, <10MB installer, <2s startup

---

## Tech stack

```
┌──────────────────────────────────────────────────┐
│                  Tauri v2 Shell                   │
│          (native window, menus, system tray)      │
├──────────────────────────────────────────────────┤
│                                                  │
│   ┌─────────────────────────────────────────┐    │
│   │         React + Vite (Frontend)         │    │
│   │                                         │    │
│   │  Monaco Editor    xterm.js   React UI   │    │
│   │  (code viewer)   (terminal)  (panels)   │    │
│   │                                         │    │
│   └──────────────────┬──────────────────────┘    │
│                      │ Tauri IPC (JSON)          │
│   ┌──────────────────┴──────────────────────┐    │
│   │           Rust Backend (async)           │    │
│   │                                          │    │
│   │  russh        SSH exec    russh-config  │    │
│   │  (SSH/SFTP)  (git/podman) (config parse)│    │
│   │                                          │    │
│   │  tokio runtime    serde    keyring       │    │
│   │  (async I/O)     (JSON)   (credentials)  │    │
│   └──────────────────────────────────────────┘    │
│                                                  │
└──────────────────────────────────────────────────┘
```

### Frontend
- **React 18+** with Vite for fast dev/build
- **Monaco Editor** (npm: monaco-editor) — code viewing/editing with tabs
- **xterm.js** (npm: xterm) — terminal emulator
- **Zustand** — lightweight state management
- **react-resizable-panels** — drag-to-resize layout panels
- **Fira Code** — embedded font with ligatures
- **Dracula Theme** — CSS variables from official spec (MIT)
- **Catppuccin Icons** — file type icons (MIT)

### Rust backend (Tauri commands)
- **russh** + **russh-sftp** — SSH connections, SFTP file ops, PTY sessions
- **russh-config** — parse `~/.ssh/config` (Host, ProxyJump, IdentityFile, etc.)
- **Podman via SSH exec** — run podman commands on remote, parse JSON output (no extra dependency)
- **Git via SSH exec** — run git commands on remote and parse output (no git2-rs needed)
- **tokio** — async runtime
- **serde** / **serde_json** — serialization for IPC
- **keyring** — OS-level credential storage (fallback only, ssh-agent is primary)
- **directories** — platform-appropriate config/data paths

---

## Project structure

```
straylight/
├── src-tauri/                    # Rust backend
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs               # Tauri app entry
│       ├── lib.rs                 # Command registration
│       ├── ssh/
│       │   ├── mod.rs
│       │   ├── connection.rs      # SSH connection pool + auto-reconnect
│       │   ├── config.rs          # Parse ~/.ssh/config via russh-config
│       │   ├── sftp.rs            # File operations (list, read, write, delete)
│       │   ├── pty.rs             # PTY session for terminal
│       │   ├── tunnel.rs          # Port forwarding
│       │   └── transfer.rs        # Upload/download with progress events
│       ├── container/
│       │   ├── mod.rs
│       │   ├── podman.rs          # Podman ops via SSH exec + JSON parsing
│       │   └── compose.rs         # Podman compose via SSH exec
│       ├── git/
│       │   ├── mod.rs
│       │   ├── status.rs          # File status (modified/staged/untracked)
│       │   ├── blame.rs           # Line-by-line blame
│       │   ├── log.rs             # Commit history
│       │   └── diff.rs            # Diff generation
│       ├── session/
│       │   ├── mod.rs
│       │   ├── store.rs           # Connection profiles (save/load)
│       │   ├── persistence.rs     # Window state, open tabs, layout
│       │   └── credentials.rs     # Keychain integration
│       └── config/
│           ├── mod.rs
│           └── settings.rs        # App preferences
│
├── src/                           # React frontend
│   ├── main.tsx                   # App entry
│   ├── App.tsx                    # Layout shell
│   ├── theme/
│   │   ├── dracula.css            # Dracula color variables
│   │   ├── tokens.css             # Spacing, radius, shadows
│   │   └── fonts.css              # Fira Code embedding
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Sidebar.tsx        # Left panel (file tree / containers / git)
│   │   │   ├── EditorArea.tsx     # Center (Monaco + tabs)
│   │   │   ├── TerminalPanel.tsx  # Bottom panel (xterm.js)
│   │   │   ├── StatusBar.tsx      # Bottom bar (connection, branch, etc)
│   │   │   └── TitleBar.tsx       # Custom titlebar with connection color
│   │   ├── filetree/
│   │   │   ├── FileTree.tsx       # Remote file tree
│   │   │   ├── FileNode.tsx       # Individual tree node
│   │   │   ├── FileIcons.tsx      # Icon mapping
│   │   │   ├── ContextMenu.tsx    # Right-click menu
│   │   │   └── FuzzyFinder.tsx    # Ctrl+P quick open
│   │   ├── editor/
│   │   │   ├── EditorTabs.tsx     # Tab bar
│   │   │   ├── MonacoWrapper.tsx  # Monaco instance management
│   │   │   └── DiffView.tsx       # Side-by-side diff
│   │   ├── terminal/
│   │   │   ├── Terminal.tsx        # xterm.js wrapper
│   │   │   ├── TerminalTabs.tsx   # Terminal tab bar
│   │   │   └── SplitPanes.tsx     # Split terminal layout
│   │   ├── git/
│   │   │   ├── GitStatus.tsx      # Changed files panel
│   │   │   ├── BlameView.tsx      # Inline blame overlay
│   │   │   └── GitLog.tsx         # Commit history
│   │   ├── containers/
│   │   │   ├── ContainerList.tsx  # Podman container list
│   │   │   ├── ContainerActions.tsx
│   │   │   └── LogViewer.tsx      # Container log streaming
│   │   ├── connection/
│   │   │   ├── ConnectionManager.tsx  # Server profiles
│   │   │   ├── ConnectionDialog.tsx   # New/edit connection
│   │   │   └── KeyManager.tsx         # SSH key management
│   │   └── transfer/
│   │       ├── TransferQueue.tsx      # Upload/download list
│   │       └── ProgressBar.tsx
│   ├── hooks/
│   │   ├── useSSH.ts              # SSH connection state
│   │   ├── useSFTP.ts             # File operations
│   │   ├── useTerminal.ts         # Terminal session
│   │   ├── useGit.ts              # Git operations
│   │   ├── useContainers.ts       # Podman state
│   │   ├── useKeyboard.ts         # Keyboard shortcuts
│   │   └── useSession.ts          # Persistence (layout, tabs)
│   ├── store/
│   │   └── appStore.ts            # Zustand — global state
│   └── lib/
│       ├── ipc.ts                 # Typed Tauri invoke wrappers
│       ├── fileIcons.ts           # Extension → icon mapping
│       └── shortcuts.ts           # Keybinding definitions
│
├── public/
│   └── fonts/
│       └── FiraCode-*.woff2
├── package.json
├── vite.config.ts
└── README.md
```

---

## Module deep dive

### 1. SSH connection (the heart of everything)

```
Connection lifecycle:
                                    ┌──────────────┐
  User clicks "Connect"  ────────► │  Connecting   │
                                    └──────┬───────┘
                                           │ auth success
                                    ┌──────▼───────┐
                              ┌───► │  Connected    │ ◄──── reconnect success
                              │     └──┬───┬───┬───┘
                              │        │   │   │
                              │    SFTP │ PTY │ Tunnel
                              │   channels channels channels
                              │        │   │   │
                              │     ┌──▼───▼───▼───┐
                              │     │  Working...   │
                              │     └──────┬───────┘
                              │            │ connection dropped
                              │     ┌──────▼───────┐
                              └──── │ Reconnecting  │ (auto, with backoff)
                                    │ buffer I/O    │
                                    └──────┬───────┘
                                           │ max retries exceeded
                                    ┌──────▼───────┐
                                    │ Disconnected  │
                                    └──────────────┘
```

Key design decisions:
- One SSH connection per server, multiplexed into many channels (SFTP, PTY, exec)
- Auto-reconnect with exponential backoff (1s, 2s, 4s, 8s, max 30s)
- Buffer terminal input during reconnect, replay on reconnect
- SSH agent integration for seamless key auth
- Configurable connection timeout (default 10s, user can adjust)
- **Timeout behavior:** on timeout or connection loss, show a non-intrusive warning in the status bar (e.g. "Reconnecting..." with a spinner). Keep the session alive, keep retrying silently in the background. Never close the window, never pop up a modal, never restart the session. The user's tabs, terminal history, and state stay intact. When connection recovers, silently resume. This is the opposite of VS Code's annoying "reconnecting" modal that blocks everything.

#### SSH config parsing (core, phase 1)

Parse `~/.ssh/config` via `russh-config` crate on startup. Present all Host entries in the connection manager automatically. Supported directives:

- `Host` / `HostName` / `User` / `Port` — basic connection info
- `IdentityFile` — key path, handed to ssh-agent or loaded directly
- `ProxyJump` / `ProxyCommand` — jump host / bastion support (critical for corporate setups)
- `ForwardAgent` — agent forwarding to remote
- `LocalForward` / `RemoteForward` — port forwarding rules

Flow: user opens app → sees SSH config entries listed → clicks one → connects with all config applied. Manual connections still supported for servers not in config.

#### Credential handling

Primary: ssh-agent manages keys. App asks agent to sign, never touches private keys directly. No secrets stored by the app.

Fallback: if password auth is needed (no key) or key has passphrase and no agent running, prompt the user. Password is held in memory for the session only, never persisted to disk. User can use ssh-agent for persistence.

### 2. SFTP file operations

Tauri commands exposed to frontend:

```rust
// Core SFTP commands (src-tauri/src/ssh/sftp.rs)
#[tauri::command] async fn sftp_list_dir(conn_id, path) -> Vec<FileEntry>
#[tauri::command] async fn sftp_read_file(conn_id, path) -> FileContent
#[tauri::command] async fn sftp_write_file(conn_id, path, content) -> Result
#[tauri::command] async fn sftp_delete(conn_id, path) -> Result
#[tauri::command] async fn sftp_rename(conn_id, old, new) -> Result
#[tauri::command] async fn sftp_mkdir(conn_id, path) -> Result
#[tauri::command] async fn sftp_stat(conn_id, path) -> FileStat
#[tauri::command] async fn sftp_upload(conn_id, local, remote) -> Result  // emits progress events
#[tauri::command] async fn sftp_download(conn_id, remote, local) -> Result // emits progress events
```

FileEntry includes: name, size, permissions (rwx), owner, group, modified date, is_dir, is_symlink, symlink_target.

Drag-and-drop: Tauri v2's `on_drag_drop_event` catches local files dragged onto the window. Frontend tracks which remote directory is the drop target. Backend handles the SFTP upload with progress events streamed via `app.emit("transfer-progress", ...)`.

#### File explorer behavior

- **Symlinks:** show with arrow overlay icon. Tooltip shows symlink target path. Follow symlink on click.
- **Hidden files (dotfiles):** toggle button in file tree header, default OFF.
- **Binary files:** detect via null bytes in first 8KB. Show info card (size, type, date) with "Download" and "Open with system default" buttons. Don't load into Monaco.
- **Image files (.png, .jpg, .gif, .svg, .webp):** show inline preview panel instead of editor.
- **Large directories:** load all files, no pagination. Keep it simple.
- **File tree caching:** cached per session. Re-fetched on: user refresh (F5), file create/delete/rename via the app, or folder re-expanded after collapse.
- **Folder upload:** recursive local traversal, SFTP file-by-file, create dirs as needed. Progress shows current file + overall %.
- **Folder download:** recursive SFTP read, save to local directory with progress.

#### File conflict on save

Check remote file's modified timestamp against our last-known timestamp. If server copy is newer (someone else edited it), show warning: "Overwrite" / "Diff" (show both versions) / "Cancel".

#### File encoding and line endings

Default UTF-8. If decoding fails, detect encoding (BOM, common patterns). Show encoding in status bar, user can switch via dropdown. Line endings: Monaco handles LF/CRLF natively. Status bar shows current style. Default to whatever the file uses; new files use LF.

### 3. Monaco Editor setup

```typescript
// Monaco configuration for the app
import * as monaco from 'monaco-editor';

// Dracula theme (translated from official spec)
monaco.editor.defineTheme('dracula', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment',    foreground: '6272A4' },
    { token: 'keyword',    foreground: 'FF79C6' },
    { token: 'string',     foreground: 'F1FA8C' },
    { token: 'number',     foreground: 'BD93F9' },
    { token: 'type',       foreground: '8BE9FD' },
    { token: 'function',   foreground: '50FA7B' },
    { token: 'variable',   foreground: 'F8F8F2' },
    { token: 'constant',   foreground: 'BD93F9' },
    // ... full mapping from Dracula spec
  ],
  colors: {
    'editor.background':           '#282A36',
    'editor.foreground':           '#F8F8F2',
    'editor.lineHighlightBackground': '#44475A',
    'editor.selectionBackground':  '#44475A',
    'editorCursor.foreground':     '#F8F8F2',
    // ... full Dracula color mapping
  }
});
```

Tab system: each open file gets a tab. Tabs track: file path, connection ID, dirty state, scroll position. When you click a file in the tree, it opens in a tab (or focuses existing tab). Modified files show a dot indicator.

#### Large file handling

For files over 10MB, show a brief toast ("large file, some features disabled for performance"). For files over 50MB, open in Monaco's lightweight mode: syntax highlighting off (language set to plaintext), minimap off, folding off, `largeFileOptimizations: true`. File is still fully editable and searchable — just without the heavy features. Same editor, same keybindings, just faster. This matches VS Code's behavior.

#### Auto-save / crash recovery

Keep a local temp copy of unsaved changes (in app config directory). On crash, next launch detects dirty temp files and offers to restore them. Temp files cleaned up after successful save or explicit discard.

#### Monaco web workers

Monaco uses web workers for syntax tokenization. These need to work in Tauri's webview context. Phase 1 tests this early — if web workers have issues in WebKitGTK, we use the synchronous tokenizer fallback (slightly slower highlighting, but functional).

### 4. Terminal (xterm.js + SSH PTY)

```
Frontend (xterm.js)                    Rust Backend
┌──────────────┐                  ┌──────────────────┐
│  xterm.js    │ ── user input ──►│  PTY channel     │
│  instance    │                  │  (russh)         │
│              │◄── PTY output ── │                  │
│  (renders    │   (Tauri event   │  Sends to remote │
│   terminal)  │    stream)       │  shell via SSH   │
└──────────────┘                  └──────────────────┘
```

- Each terminal tab = one SSH channel with PTY request
- xterm.js `onData` sends keystrokes to Rust via Tauri command
- Rust streams PTY output back via Tauri events (efficient, non-blocking)
- Terminal resize: xterm.js `onResize` → Rust `channel.window_change(cols, rows)`
- Split panes: multiple xterm.js instances, same SSH connection, different channels

#### Shell and environment

The remote server's login shell runs automatically (whatever `/etc/passwd` defines for the user). User's dotfiles (`.bashrc`, `.zshrc`, `.profile`) are sourced by the shell. We don't choose or configure the shell — the server decides. This matches VS Code behavior.

#### Keyboard shortcut conflicts

When terminal is focused, terminal-bound keys take priority: `Ctrl+C` = SIGINT (not copy), `Ctrl+V` = paste to terminal, `Ctrl+W` = terminal input (not close tab). When editor or file tree is focused, app shortcuts take priority. Implementation: a simple "which panel has focus" check before dispatching shortcuts. Clipboard copy in terminal uses `Ctrl+Shift+C` (Linux convention) or selection-based copy.

### 5. Container management (Podman via SSH exec)

Like git, we run podman commands on the remote server via SSH and parse the output. This is simpler and more reliable than tunneling the Podman socket (bollard's SSH support is less battle-tested), and works identically whether Podman is rootless or root.

```rust
// List containers (JSON output for easy parsing)
let output = ssh_exec(&conn, "podman ps -a --format json").await;
let containers: Vec<Container> = serde_json::from_str(&output)?;

// Start/stop
ssh_exec(&conn, "podman start my-app").await;
ssh_exec(&conn, "podman stop my-app").await;

// Stream logs (via SSH exec with streaming)
ssh_exec_stream(&conn, "podman logs -f my-app").await;
// Stream to frontend via Tauri events

// Podman compose
ssh_exec(&conn, "podman-compose -f /path/compose.yaml up -d").await;
ssh_exec(&conn, "podman-compose -f /path/compose.yaml ps --format json").await;
```

Advantage: no bollard dependency needed, same SSH connection used for everything, works on any server with podman installed. Podman's `--format json` flag gives structured output for every command.

### 6. Git integration (via SSH exec)

Run git commands on the remote server and parse output. Simpler than git2-rs (which needs local filesystem access) and works everywhere git is installed.

```rust
// Run git command on remote
async fn git_exec(conn: &SshConnection, repo_path: &str, cmd: &str) -> String {
    let full_cmd = format!("cd {} && git {}", repo_path, cmd);
    conn.exec(&full_cmd).await
}

// Git status → parse porcelain output
let status = git_exec(&conn, path, "status --porcelain=v2").await;

// Git blame → parse for inline display
let blame = git_exec(&conn, path, "blame --porcelain file.py").await;

// Git log → parse for history view
let log = git_exec(&conn, path, "log --oneline --graph -50").await;

// Git diff → feed into Monaco diff editor
let diff = git_exec(&conn, path, "diff HEAD -- file.py").await;
```

### 7. Session persistence

Saved to `~/.config/straylight/` (or OS-appropriate path via `directories` crate):

```json
{
  "connections": [
    {
      "id": "uuid",
      "name": "prod-server",
      "host": "10.0.1.5",
      "port": 22,
      "user": "deploy",
      "auth": "agent",
      "color": "#FF79C6",
      "last_path": "/opt/myapp"
    }
  ],
  "window": {
    "width": 1400,
    "height": 900,
    "sidebar_width": 260,
    "terminal_height": 300
  },
  "last_session": {
    "connection_id": "uuid",
    "open_tabs": [
      { "path": "/opt/myapp/main.py", "scroll": 142 },
      { "path": "/opt/myapp/config.yaml", "scroll": 0 }
    ],
    "active_tab": 0,
    "terminal_count": 2
  }
}
```

### 8. Keyboard shortcuts

```
Ctrl+P          Fuzzy file finder
Ctrl+`          Toggle terminal panel
Ctrl+Shift+`    New terminal tab
Ctrl+Tab        Next editor tab
Ctrl+Shift+Tab  Previous editor tab
Ctrl+W          Close current tab
Ctrl+S          Save file
Ctrl+Shift+E    Focus file explorer
Ctrl+Shift+G    Focus git panel
Ctrl+Shift+F    Search in files
Ctrl+K Ctrl+S   Open keyboard shortcuts settings
F1              Command palette (stretch goal)
```

---

## Build phases

### Phase 1 — Walking skeleton (2-3 weeks)
Get a window open with a working SSH connection.

- [ ] Tauri v2 + React + Vite scaffold
- [ ] Dracula CSS variables (via CSS custom properties for future theme swap) + Fira Code font
- [ ] Basic layout shell (sidebar, editor area, terminal panel, status bar) with react-resizable-panels
- [ ] Parse `~/.ssh/config` via russh-config, show entries in connection list
- [ ] SSH connection dialog (host, port, user, key/password) for manual connections
- [ ] Single SSH connection via russh (with ssh-agent support)
- [ ] SFTP directory listing → file tree in sidebar (with permissions, symlink indicators)
- [ ] Hidden files toggle (default off)
- [ ] Click file → read via SFTP → display in Monaco with syntax highlighting
- [ ] Binary file detection → show info card instead of editor
- [ ] xterm.js terminal connected to SSH PTY channel
- [ ] Basic status bar (connected/disconnected, current path, encoding, line endings)
- [ ] **WebKitGTK performance test on Linux** — verify Monaco + xterm.js render acceptably

**Milestone: you can connect to a server, browse files, read code, and use a terminal.**

### Phase 2 — Usable daily driver (2-3 weeks)
The features that make it feel like a real tool.

- [ ] File tabs (open, close, switch, dirty indicator)
- [ ] File editing (write back via SFTP on save)
- [ ] File conflict detection on save (timestamp check, warn if server copy newer)
- [ ] Auto-save temp copies for crash recovery
- [ ] Drag-and-drop upload/download with progress bar (single files and folders)
- [ ] Right-click context menu (rename, delete, new file, new folder, copy path, download)
- [ ] Terminal tabs + split panes
- [ ] Terminal shortcut context (Ctrl+C = SIGINT when terminal focused, copy when editor focused)
- [ ] Auto-reconnect on connection drop (status bar indicator, silent retry, no modal popups, preserve all state)
- [ ] Connection manager (save manual profiles + show ~/.ssh/config entries)
- [ ] Multi-window support (Ctrl+N, each window = one host)
- [ ] Session persistence (window state, open tabs, last connection, panel sizes)
- [ ] File permissions display in tree (rwx, owner, date)
- [ ] Keyboard shortcuts (Ctrl+P, Ctrl+`, Ctrl+S, Ctrl+W, Ctrl+Tab)
- [ ] File type icons (Catppuccin)
- [ ] Workspace color coding per connection
- [ ] File encoding display + switch in status bar
- [ ] Large file handling (>10MB toast, >50MB Monaco lightweight mode: no highlighting, no minimap)
- [ ] Image file preview panel (.png, .jpg, .gif, .svg)

**Milestone: you could actually use this instead of VS Code for daily remote work.**

### Phase 3 — Power features (2-4 weeks)
Git, containers, search.

- [ ] Git status indicators in file tree (modified/staged/untracked)
- [ ] Git blame inline in editor
- [ ] Git log / commit history panel
- [ ] Git diff viewer (Monaco diff editor)
- [ ] Podman container list (via SSH exec + `podman ps --format json`)
- [ ] Container start/stop/restart
- [ ] Container log streaming
- [ ] Podman compose support (via SSH exec)
- [ ] Fuzzy file finder (Ctrl+P)
- [ ] Search in files (remote grep/ripgrep via SSH exec)
- [ ] Port forwarding UI
- [ ] Markdown preview panel
- [ ] YAML validation
- [ ] App auto-update (Tauri built-in updater)

**Milestone: full replacement for your VS Code workflow.**

---

## Cargo.toml (Rust dependencies)

```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon", "dialog"] }
russh = "0.46"
russh-sftp = "2"
russh-keys = "0.46"
russh-config = "0.3"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
keyring = "3"
directories = "5"
uuid = { version = "1", features = ["v4"] }
chrono = "0.4"
log = "0.4"
env_logger = "0.11"
```

## package.json (key frontend deps)

```json
{
  "dependencies": {
    "react": "^18",
    "react-dom": "^18",
    "monaco-editor": "^0.50",
    "@xterm/xterm": "^5",
    "@xterm/addon-fit": "^0.10",
    "@xterm/addon-webgl": "^0.18",
    "zustand": "^4",
    "react-resizable-panels": "^2",
    "fuse.js": "^7",
    "@tauri-apps/api": "^2"
  }
}
```

---

## Resolved decisions

### License: MIT + Apache 2.0 (dual)

Following the Rust ecosystem convention. Users can choose whichever license works for them. Compatible with all dependencies (russh, bollard, tokio, tauri, Monaco, xterm.js).

Both LICENSE-MIT and LICENSE-APACHE files in repo root. Cargo.toml: `license = "MIT OR Apache-2.0"`.

### Cross-platform: Windows + Linux

Tauri v2 builds natively for both. The Rust backend compiles to native code per platform. The frontend is identical (web tech in OS webview).

| | Windows | Linux |
|---|---|---|
| Webview | WebView2 (Edge, pre-installed Win 10/11) | WebKitGTK (most distros include it) |
| Keychain | Windows Credential Manager | GNOME Keyring / KDE Wallet |
| Podman socket | `//./pipe/podman` (named pipe) | `$XDG_RUNTIME_DIR/podman/podman.sock` |
| Config path | `%APPDATA%\straylight\` | `~/.config/straylight/` |
| SSH agent | Pageant / OpenSSH agent | ssh-agent (Unix socket) |

Platform-specific code handled via `#[cfg(target_os = "windows")]` / `#[cfg(target_os = "linux")]` in Rust. Minimal — mostly just path and socket differences.

Note: On Windows with WSL, the app runs as a native Windows app but SSHes into WSL or remote Linux servers, exactly like VS Code does now.

### Multi-window: one app, multiple windows, each window = one host

One app process. Users can open multiple windows (Ctrl+N / File → New Window). Each window connects to one host (or works locally). Within a window, all file tabs and terminals belong to that one host.

Implementation: Tauri v2 `WebviewWindowBuilder::new()` for each window. Each window gets its own SSH connection, file tree, and tab set. The connection manager (saved profiles) is shared across all windows.

### State management: Zustand

Lightweight shared store. Straightforward for this scope — connections, tabs, file tree, terminal sessions. Not complex enough for Redux, not granular enough for Jotai.

### Layout resizing: react-resizable-panels

Library handles drag-to-resize between sidebar ↔ editor and editor ↔ terminal panel. Provides `<PanelGroup>`, `<Panel>`, and `<PanelResizeHandle>` components. Well-maintained, handles min/max sizes and persistence automatically.

### Local file panel: skip for v1

For uploads: drag files from OS file explorer into the app window (Tauri handles this natively). For downloads: "Save As" dialog to choose local destination. A built-in local file panel (WinSCP-style side-by-side) can be added in a later version if needed.

### Git operations: SSH exec (not git2-rs)

Run git commands on the remote server via SSH and parse output (`git status --porcelain`, `git blame --porcelain`, `git log`, `git diff`). Simpler than git2-rs which requires local filesystem access. Works everywhere git is installed on the server.

### Podman: SSH exec (not bollard)

Run podman commands on the remote server via SSH and parse JSON output (`podman ps --format json`, `podman logs`, etc.). Simpler and more reliable than tunneling the Podman socket. Same pattern as git — one SSH connection handles everything.

### SSH config: parsed automatically

`~/.ssh/config` parsed via `russh-config` on startup. All Host entries shown in connection manager. Supports ProxyJump (bastions), IdentityFile, ForwardAgent, port forwarding directives. User's existing SSH setup works out of the box.

### Credential handling: ssh-agent primary, no storage

ssh-agent manages keys. App never stores secrets to disk. If password auth needed or key passphrase required without agent, prompt user — password held in memory for session only.

### Theming: Dracula-only, CSS variable abstraction

Dracula hardcoded for now. All colors via CSS custom properties (`--bg-primary`, `--fg-primary`, etc.) so a theme can be swapped by providing a different set of values. Lowest-effort refactor when the time comes.

### Tauri performance: test early, Electron fallback

WebView2 (Windows) = Chrome-level performance, no concerns. WebKitGTK (Linux) = potential jank with complex UIs. Phase 1 includes explicit performance test on Linux. If unacceptable, Electron fallback — React frontend stays identical, only the shell changes.
