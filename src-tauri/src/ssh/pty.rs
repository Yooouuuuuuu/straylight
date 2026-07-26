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
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::ssh::connection::Connection;
use crate::AppState;

/// Output chunk emitted on the `pty-output` event. `data` is raw bytes (a JSON
/// number array over IPC) so partial UTF-8 sequences survive — xterm.js
/// reassembles them. An empty chunk signals the PTY closed.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutput {
    pub pty_id: String,
    pub data: Vec<u8>,
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
        .insert(pty_id.clone(), PtyHandle { tx });
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
    let mut channel = connection.open_channel().await?;
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
        loop {
            tokio::select! {
                msg = channel.wait() => {
                    match msg {
                        Some(russh::ChannelMsg::Data { data }) => {
                            // Server output = proof of life; an active terminal
                            // spares the supervisor its probe.
                            conn.touch_activity();
                            let _ = task_app.emit(
                                "pty-output",
                                PtyOutput { pty_id: task_id.clone(), data: data.to_vec() },
                            );
                        }
                        Some(russh::ChannelMsg::ExtendedData { data, .. }) => {
                            conn.touch_activity();
                            let _ = task_app.emit(
                                "pty-output",
                                PtyOutput { pty_id: task_id.clone(), data: data.to_vec() },
                            );
                        }
                        Some(russh::ChannelMsg::Eof)
                        | Some(russh::ChannelMsg::Close)
                        | None => break,
                        _ => {}
                    }
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
        // Actively CLOSE the channel, bounded. EOF alone leaves an interactive
        // PTY shell running server-side, and a dropped channel never sends
        // CHANNEL_CLOSE — so every closed terminal would permanently hold one
        // of sshd's session slots (MaxSessions, default 10) until the whole
        // connection died. CHANNEL_CLOSE makes sshd HUP the shell and free the
        // slot immediately.
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), channel.close()).await;
        let _ = task_app.emit(
            "pty-output",
            PtyOutput { pty_id: task_id.clone(), data: Vec::new() },
        );
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

    // Blocking reader thread → stream output to the frontend.
    let reader_app = app.clone();
    let reader_id = pty_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if reader_app
                        .emit(
                            "pty-output",
                            PtyOutput {
                                pty_id: reader_id.clone(),
                                data: buf[..n].to_vec(),
                            },
                        )
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
        let _ = reader_app.emit(
            "pty-output",
            PtyOutput { pty_id: reader_id.clone(), data: Vec::new() },
        );
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
