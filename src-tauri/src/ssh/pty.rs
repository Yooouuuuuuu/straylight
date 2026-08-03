//! PTY terminal sessions, for both remote (SSH channel) and local (ConPTY)
//! connections.
//!
//! A terminal is driven through a transport-agnostic [`PtyHandle`] (an mpsc of
//! [`PtyCommand`]s for input/resize/close); output is streamed to the frontend
//! on the `pty-output` event. The owning task differs by transport:
//!
//! * **SSH**: a [`tokio::select!`] over the channel and the command queue. The
//!   macro drops the not-ready branch before running the winner, so the
//!   `&mut self` borrow from `channel.wait()` is released before `channel.data`.
//! * **Local**: a blocking reader thread plus a task that writes/resizes the
//!   ConPTY.

use std::io::{Read, Write};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::ssh::connection::Connection;
use crate::{AppState, LockSafe};

/// Output chunk emitted on the `pty-output` event. `data` is the raw bytes
/// BASE64-encoded: a `Vec<u8>` field serializes as a JSON array of numbers
/// (~3-4x the bytes, and the webview parses every number as its own token);
/// base64 is one string token at ~1.33x. Byte-exact, so partial UTF-8
/// sequences still survive — the frontend decodes back to bytes and xterm.js
/// reassembles them. An EMPTY string signals the PTY closed.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutput {
    pub pty_id: String,
    pub data: String,
}

/// Output coalescing (docs/dev/code-scan-2026-08.md A2): a fast producer
/// delivers hundreds of small packets per second, and every emit is an IPC
/// hop + JSON parse + xterm write. Batch until 32 KiB or 8 ms after the first
/// unflushed byte, whichever comes first — 8 ms is far below echo perception
/// (network RTT dominates), and cuts the event rate ~10x under load.
const FLUSH_BYTES: usize = 32 * 1024;
const FLUSH_MS: u64 = 8;

/// Emit a PTY-output chunk to the ONE window that renders this terminal — the
/// lock model guarantees exactly one — instead of broadcasting to every window.
/// Broadcasting terminal output to windows that ignore it wastes work and, during
/// a pop-out, floods a window that's mid-create/destroy with dead PostMessages
/// (docs/dev/multi-window.md). Until a window claims the PTY (`set_pty_owner`, on
/// view mount) we broadcast, so the very first chunks are never lost.
fn emit_pty_output(app: &AppHandle, pty_id: &str, data: Vec<u8>) {
    use base64::Engine as _;
    let payload = PtyOutput {
        pty_id: pty_id.to_string(),
        data: base64::engine::general_purpose::STANDARD.encode(&data),
    };
    let owner = app
        .state::<AppState>()
        .pty_owners
        .lock_safe()
        .get(pty_id)
        .cloned();
    match owner {
        Some(label) => {
            let _ = app.emit_to(label, "pty-output", payload);
        }
        None => {
            let _ = app.emit("pty-output", payload);
        }
    }
}

/// Forget a PTY's render-owner (its task ended). Keeps the map from leaking.
fn clear_pty_owner(app: &AppHandle, pty_id: &str) {
    app.state::<AppState>()
        .pty_owners
        .lock_safe()
        .remove(pty_id);
}

/// A control message sent from a Tauri command to the PTY's owning task.
pub enum PtyCommand {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

/// Handle stored in [`AppState::ptys`]; the sender side of the control channel.
pub struct PtyHandle {
    pub tx: mpsc::UnboundedSender<PtyCommand>,
    /// The connection this PTY runs on (a host connId or a `::session-k` lane).
    /// The multi-window liveness sweep keeps a PTY exactly as long as its
    /// connection lives — it cascades, never declared on its own.
    pub conn_id: String,
}

enum PtyTarget {
    Local,
    Ssh(Arc<Connection>),
}

/// Open a PTY-backed shell on a connection (SSH or local) and stream output.
#[tauri::command]
pub async fn pty_open(
    state: State<'_, AppState>,
    app: AppHandle,
    conn_id: String,
    cols: u32,
    rows: u32,
    // Optional shell command for a local profile (program + args). Ignored for
    // SSH sessions, which always start the remote login shell.
    command: Option<Vec<String>>,
) -> Result<String, String> {
    let target = {
        let sessions = state.sessions.lock().await;
        match sessions.get(&conn_id) {
            Some(crate::Session::Local) => PtyTarget::Local,
            Some(crate::Session::Ssh(conn)) => PtyTarget::Ssh(conn.clone()),
            None => return Err(format!("session '{conn_id}' is not open")),
        }
    };

    let pty_id = Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::unbounded_channel::<PtyCommand>();

    match target {
        PtyTarget::Local => open_local_pty(app, pty_id.clone(), cols, rows, command, rx)?,
        PtyTarget::Ssh(conn) => open_ssh_pty(app, conn, pty_id.clone(), cols, rows, rx).await?,
    }

    state
        .ptys
        .lock()
        .await
        .insert(pty_id.clone(), PtyHandle { tx, conn_id });
    Ok(pty_id)
}

async fn open_ssh_pty(
    app: AppHandle,
    connection: Arc<Connection>,
    pty_id: String,
    cols: u32,
    rows: u32,
    mut rx: mpsc::UnboundedReceiver<PtyCommand>,
) -> Result<(), String> {
    // A ChannelGuard so the shell channel is CHANNEL_CLOSE'd on every exit —
    // including a request_pty/request_shell failure below (the `?` drops the
    // guard, which closes) — never leaking a session slot (incident M8/M9).
    let mut channel = connection.open_channel("pty").await?;
    channel
        .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
        .await
        .map_err(|e| format!("could not request a PTY: {e}"))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("could not start the remote shell: {e}"))?;

    let task_app = app.clone();
    let task_id = pty_id.clone();
    let keepalive = connection.clone();

    tokio::spawn(async move {
        let conn = keepalive;
        // Coalescing buffer (FLUSH_BYTES / FLUSH_MS above): output accumulates
        // here and flushes as ONE event on size or deadline.
        let mut out_buf: Vec<u8> = Vec::new();
        let mut flush_at: Option<tokio::time::Instant> = None;
        loop {
            tokio::select! {
                msg = channel.wait() => {
                    let bytes = match msg {
                        // Server output = proof of life; an active terminal
                        // spares the supervisor its probe.
                        Some(russh::ChannelMsg::Data { data }) => data,
                        Some(russh::ChannelMsg::ExtendedData { data, .. }) => data,
                        Some(russh::ChannelMsg::Eof)
                        | Some(russh::ChannelMsg::Close)
                        | None => break,
                        _ => continue,
                    };
                    conn.touch_activity();
                    out_buf.extend_from_slice(&bytes);
                    if out_buf.len() >= FLUSH_BYTES {
                        emit_pty_output(&task_app, &task_id, std::mem::take(&mut out_buf));
                        flush_at = None;
                    } else if flush_at.is_none() {
                        flush_at = Some(
                            tokio::time::Instant::now()
                                + std::time::Duration::from_millis(FLUSH_MS),
                        );
                    }
                }
                _ = async { tokio::time::sleep_until(flush_at.unwrap()).await }, if flush_at.is_some() => {
                    emit_pty_output(&task_app, &task_id, std::mem::take(&mut out_buf));
                    flush_at = None;
                }
                command = rx.recv() => {
                    match command {
                        Some(PtyCommand::Data(bytes)) => {
                            if channel.data(&bytes[..]).await.is_err() {
                                break;
                            }
                        }
                        Some(PtyCommand::Resize { cols, rows }) => {
                            let _ = channel.window_change(cols, rows, 0, 0).await;
                        }
                        Some(PtyCommand::Close) | None => {
                            let _ = channel.eof().await;
                            break;
                        }
                    }
                }
            }
        }
        // Flush whatever the break left buffered BEFORE the close signal, so
        // the last screenful is never lost behind the "PTY closed" empty chunk.
        if !out_buf.is_empty() {
            emit_pty_output(&task_app, &task_id, out_buf);
        }
        // Deterministic hang-up (the guard bounds the close internally). EOF
        // alone leaves the shell running server-side and holds the slot; only
        // CHANNEL_CLOSE frees it. On a task panic the guard's Drop still closes.
        channel.close().await;
        emit_pty_output(&task_app, &task_id, Vec::new());
        clear_pty_owner(&task_app, &task_id);
        log::info!("pty {task_id} closed");
    });

    Ok(())
}

/// True if `name` is found in any PATH directory.
fn on_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(name).is_file()))
        .unwrap_or(false)
}

#[cfg(windows)]
fn default_shell() -> String {
    // Prefer modern PowerShell 7 (pwsh) when installed; otherwise the built-in
    // Windows PowerShell 5.1.
    if on_path("pwsh.exe") {
        "pwsh.exe".to_string()
    } else {
        "powershell.exe".to_string()
    }
}

#[cfg(not(windows))]
fn default_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/bash".to_string())
}

fn open_local_pty(
    app: AppHandle,
    pty_id: String,
    cols: u32,
    rows: u32,
    command: Option<Vec<String>>,
    mut rx: mpsc::UnboundedReceiver<PtyCommand>,
) -> Result<(), String> {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};

    let size = PtySize {
        rows: rows as u16,
        cols: cols as u16,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("could not open a local terminal: {e}"))?;

    // A profile supplies the program + args; otherwise fall back to the default
    // shell for this platform.
    let argv = command
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| vec![default_shell()]);
    let mut cmd = CommandBuilder::new(&argv[0]);
    for arg in &argv[1..] {
        cmd.arg(arg);
    }
    if let Some(dirs) = directories::UserDirs::new() {
        cmd.cwd(dirs.home_dir());
    }
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("could not start the shell: {e}"))?;
    // Close the parent's slave handle so the reader sees EOF when the shell exits.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("terminal reader: {e}"))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("terminal writer: {e}"))?;
    let master = pair.master;

    // Blocking reader thread → chunks into a channel; the coalescer task below
    // batches them (FLUSH_BYTES / FLUSH_MS) so a fast producer doesn't emit an
    // IPC event per 8 KiB read. Dropping the sender at EOF is the close signal.
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if out_tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let reader_app = app.clone();
    let reader_id = pty_id.clone();
    tokio::spawn(async move {
        let mut out_buf: Vec<u8> = Vec::new();
        let mut flush_at: Option<tokio::time::Instant> = None;
        loop {
            tokio::select! {
                chunk = out_rx.recv() => {
                    match chunk {
                        Some(bytes) => {
                            out_buf.extend_from_slice(&bytes);
                            if out_buf.len() >= FLUSH_BYTES {
                                emit_pty_output(&reader_app, &reader_id, std::mem::take(&mut out_buf));
                                flush_at = None;
                            } else if flush_at.is_none() {
                                flush_at = Some(
                                    tokio::time::Instant::now()
                                        + std::time::Duration::from_millis(FLUSH_MS),
                                );
                            }
                        }
                        None => break, // reader hit EOF/error — the shell exited
                    }
                }
                _ = async { tokio::time::sleep_until(flush_at.unwrap()).await }, if flush_at.is_some() => {
                    emit_pty_output(&reader_app, &reader_id, std::mem::take(&mut out_buf));
                    flush_at = None;
                }
            }
        }
        if !out_buf.is_empty() {
            emit_pty_output(&reader_app, &reader_id, out_buf);
        }
        emit_pty_output(&reader_app, &reader_id, Vec::new());
        clear_pty_owner(&reader_app, &reader_id);
    });

    // Input / resize / close. Writes to a PTY are small and non-blocking in
    // practice, so handling them on the async task is fine.
    tokio::spawn(async move {
        let master = master;
        while let Some(command) = rx.recv().await {
            match command {
                PtyCommand::Data(bytes) => {
                    if writer.write_all(&bytes).is_err() {
                        break;
                    }
                    let _ = writer.flush();
                }
                PtyCommand::Resize { cols, rows } => {
                    let _ = master.resize(PtySize {
                        rows: rows as u16,
                        cols: cols as u16,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
                PtyCommand::Close => {
                    let _ = child.kill();
                    break;
                }
            }
        }
        log::info!("pty {pty_id} closed");
    });

    Ok(())
}

/// Send keystrokes / raw input to a PTY.
#[tauri::command]
pub async fn pty_write(
    state: State<'_, AppState>,
    pty_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let ptys = state.ptys.lock().await;
    let handle = ptys
        .get(&pty_id)
        .ok_or_else(|| format!("terminal '{pty_id}' is not open"))?;
    handle
        .tx
        .send(PtyCommand::Data(data))
        .map_err(|_| "terminal has closed".to_string())
}

/// Resize a PTY (sent on xterm.js `onResize`).
#[tauri::command]
pub async fn pty_resize(
    state: State<'_, AppState>,
    pty_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let ptys = state.ptys.lock().await;
    let handle = ptys
        .get(&pty_id)
        .ok_or_else(|| format!("terminal '{pty_id}' is not open"))?;
    handle
        .tx
        .send(PtyCommand::Resize { cols, rows })
        .map_err(|_| "terminal has closed".to_string())
}

/// Close a PTY and remove it from state.
#[tauri::command]
pub async fn pty_close(state: State<'_, AppState>, pty_id: String) -> Result<(), String> {
    if let Some(handle) = state.ptys.lock().await.remove(&pty_id) {
        let _ = handle.tx.send(PtyCommand::Close);
    }
    Ok(())
}

/// A selectable local shell for the terminal's "new terminal" menu. Remote
/// terminals always use the login shell, so profiles are local-only.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProfile {
    pub id: String,
    pub label: String,
    pub command: Vec<String>,
}

/// Discover the local shells available for the terminal profile picker.
#[tauri::command]
pub async fn list_terminal_profiles() -> Vec<TerminalProfile> {
    tokio::task::spawn_blocking(discover_profiles)
        .await
        .unwrap_or_default()
}

#[cfg(windows)]
fn discover_profiles() -> Vec<TerminalProfile> {
    let mut profiles = Vec::new();
    // Prefer PowerShell 7; only fall back to the built-in Windows PowerShell 5
    // when pwsh isn't installed (pwsh otherwise covers it).
    if on_path("pwsh.exe") {
        profiles.push(TerminalProfile {
            id: "pwsh".into(),
            label: "PowerShell 7".into(),
            command: vec!["pwsh.exe".into()],
        });
    } else {
        profiles.push(TerminalProfile {
            id: "powershell".into(),
            label: "Windows PowerShell".into(),
            command: vec!["powershell.exe".into()],
        });
    }
    profiles.push(TerminalProfile {
        id: "cmd".into(),
        label: "Command Prompt".into(),
        command: vec!["cmd.exe".into()],
    });
    if let Some(bash) = find_git_bash() {
        profiles.push(TerminalProfile {
            id: "git-bash".into(),
            label: "Git Bash".into(),
            command: vec![bash, "-i".into(), "-l".into()],
        });
    }
    for distro in wsl_distros() {
        profiles.push(TerminalProfile {
            id: format!("wsl:{distro}"),
            label: format!("WSL: {distro}"),
            command: vec![
                "wsl.exe".into(),
                "-d".into(),
                distro,
                "--cd".into(),
                "~".into(),
            ],
        });
    }
    profiles
}

#[cfg(windows)]
fn find_git_bash() -> Option<String> {
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    for var in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        if let Some(p) = std::env::var_os(var) {
            roots.push(std::path::PathBuf::from(p).join("Git"));
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        roots.push(std::path::PathBuf::from(local).join("Programs").join("Git"));
    }
    for root in roots {
        let bash = root.join("bin").join("bash.exe");
        if bash.is_file() {
            return Some(bash.to_string_lossy().into_owned());
        }
    }
    None
}

#[cfg(windows)]
fn wsl_distros() -> Vec<String> {
    use std::os::windows::process::CommandExt;
    let output = std::process::Command::new("wsl.exe")
        .args(["--list", "--quiet"])
        // Suppress the console window a GUI process would flash for this spawn.
        .creation_flags(0x0800_0000)
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    // wsl.exe prints its management output as UTF-16LE, usually with a BOM —
    // which must be stripped or it ends up glued to the first distro name.
    let utf16: Vec<u16> = output
        .stdout
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let text = String::from_utf16_lossy(&utf16);
    text.trim_start_matches('\u{feff}')
        .lines()
        .map(|l| {
            l.trim()
                .trim_matches(|c: char| c == '\0' || c == '\u{feff}')
                .trim()
                .to_string()
        })
        .filter(|l| !l.is_empty() && !l.starts_with("docker-desktop"))
        .collect()
}

#[cfg(not(windows))]
fn discover_profiles() -> Vec<TerminalProfile> {
    let mut profiles = Vec::new();
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.is_empty() {
            let label = std::path::Path::new(&shell)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| shell.clone());
            profiles.push(TerminalProfile {
                id: "default".into(),
                label,
                command: vec![shell],
            });
        }
    }
    for (id, path) in [
        ("bash", "/bin/bash"),
        ("zsh", "/bin/zsh"),
        ("fish", "/usr/bin/fish"),
    ] {
        if std::path::Path::new(path).exists()
            && !profiles
                .iter()
                .any(|p| p.command.first().map(String::as_str) == Some(path))
        {
            profiles.push(TerminalProfile {
                id: id.into(),
                label: id.into(),
                command: vec![path.into()],
            });
        }
    }
    profiles
}
