//! PTY terminal sessions.
//!
//! Each terminal is one SSH session channel with a PTY + shell request. A
//! dedicated task owns the channel and multiplexes two directions over a
//! [`tokio::select!`]:
//!
//! * **server → UI**: [`russh::ChannelMsg::Data`] is forwarded to the frontend
//!   on the `pty-output` event.
//! * **UI → server**: keystrokes, resizes, and close requests arrive on an mpsc
//!   channel and are written to the SSH channel.
//!
//! `tokio::select!` drops the not-yet-ready branch futures before running the
//! winning branch's body, so the `&mut self` borrow from `channel.wait()` is
//! released before the input branch calls `channel.data(..)` / `window_change`.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::ssh::connection::get_connection;
use crate::AppState;

/// Output chunk emitted on the `pty-output` event. `data` is raw bytes (a JSON
/// number array over IPC) so partial UTF-8 sequences survive — xterm.js
/// reassembles them.
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

/// Open a PTY-backed shell on a connection and start streaming output.
#[tauri::command]
pub async fn pty_open(
    state: State<'_, AppState>,
    app: AppHandle,
    conn_id: String,
    cols: u32,
    rows: u32,
) -> Result<String, String> {
    let connection = get_connection(&state, &conn_id).await?;

    let mut channel = connection
        .handle
        .channel_open_session()
        .await
        .map_err(|e| format!("could not open terminal channel: {e}"))?;
    channel
        .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
        .await
        .map_err(|e| format!("could not request a PTY: {e}"))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("could not start the remote shell: {e}"))?;

    let pty_id = Uuid::new_v4().to_string();
    let (tx, mut rx) = mpsc::unbounded_channel::<PtyCommand>();

    let task_app = app.clone();
    let task_id = pty_id.clone();
    // Hold an Arc to the connection so it isn't torn down while this terminal is
    // alive.
    let keepalive = connection.clone();

    tokio::spawn(async move {
        let _keepalive = keepalive;
        loop {
            tokio::select! {
                msg = channel.wait() => {
                    match msg {
                        Some(russh::ChannelMsg::Data { data }) => {
                            let _ = task_app.emit(
                                "pty-output",
                                PtyOutput { pty_id: task_id.clone(), data: data.to_vec() },
                            );
                        }
                        Some(russh::ChannelMsg::ExtendedData { data, .. }) => {
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
        // Signal the frontend that this PTY has ended (empty chunk = closed).
        let _ = task_app.emit(
            "pty-output",
            PtyOutput { pty_id: task_id.clone(), data: Vec::new() },
        );
        log::info!("pty {task_id} closed");
    });

    state
        .ptys
        .lock()
        .await
        .insert(pty_id.clone(), PtyHandle { tx });
    Ok(pty_id)
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
