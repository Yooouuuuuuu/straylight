//! Local SSH port forwarding (`-L`): bind a local 127.0.0.1 port and tunnel each
//! connection to `host:port` as reachable from the server, over a `direct-tcpip`
//! channel on the existing SSH connection. Tunnel failures (e.g. nothing
//! listening on the remote port) are surfaced per forward and as a toast event.

use std::sync::{Arc, Mutex as StdMutex};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, State};
use tokio::io::copy_bidirectional;
use tokio::net::TcpListener;

use crate::AppState;

/// An active local forward.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo {
    pub id: String,
    pub conn_id: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    /// The most recent tunnel failure for this forward, if any.
    pub last_error: Option<String>,
}

/// Map entry: the listener task, the static info, and a live error slot.
pub struct ForwardEntry {
    pub task: tokio::task::JoinHandle<()>,
    pub info: ForwardInfo,
    pub last_error: Arc<StdMutex<Option<String>>>,
}

/// Start forwarding `127.0.0.1:local_port` → `remote_host:remote_port` (the host
/// being reachable from the SSH server, e.g. `localhost` for the server itself).
#[tauri::command]
pub async fn port_forward_start(
    app: AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Result<ForwardInfo, String> {
    let conn = state.ssh_connection(&conn_id).await?;

    let mut forwards = state.forwards.lock().await;
    if forwards.values().any(|e| e.info.local_port == local_port) {
        return Err(format!("127.0.0.1:{local_port} is already being forwarded"));
    }

    let listener = TcpListener::bind(("127.0.0.1", local_port))
        .await
        .map_err(|e| {
            let hint = if e.kind() == std::io::ErrorKind::PermissionDenied {
                " The port may be reserved by Windows (Hyper-V/WSL excluded ranges) or held by another service — try a different local port."
            } else {
                ""
            };
            format!("could not bind 127.0.0.1:{local_port}: {e}.{hint}")
        })?;

    let id = uuid::Uuid::new_v4().to_string();
    let info = ForwardInfo {
        id: id.clone(),
        conn_id,
        local_port,
        remote_host: remote_host.clone(),
        remote_port,
        last_error: None,
    };
    let last_error: Arc<StdMutex<Option<String>>> = Arc::new(StdMutex::new(None));

    let rp = remote_port as u32;
    let err_slot = last_error.clone();
    let emit_id = id.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = match listener.accept().await {
                Ok(s) => s,
                Err(_) => break,
            };
            let conn = conn.clone();
            let host = remote_host.clone();
            let err_slot = err_slot.clone();
            let app = app.clone();
            let emit_id = emit_id.clone();
            tokio::spawn(async move {
                match conn.open_direct_tcpip(&host, rp).await {
                    Ok(channel) => {
                        let mut stream = channel.into_stream();
                        let _ = copy_bidirectional(&mut socket, &mut stream).await;
                    }
                    Err(e) => {
                        let msg = format!(
                            "tunnel to {host}:{rp} failed: {e} (is the service listening there?)"
                        );
                        log::warn!("{msg}");
                        if let Ok(mut slot) = err_slot.lock() {
                            *slot = Some(msg.clone());
                        }
                        let _ = app.emit(
                            "port-forward-error",
                            json!({ "id": emit_id, "message": msg }),
                        );
                    }
                }
            });
        }
    });

    log::info!(
        "forward 127.0.0.1:{local_port} -> {}:{remote_port}",
        info.remote_host
    );
    forwards.insert(
        id,
        ForwardEntry {
            task,
            info: info.clone(),
            last_error,
        },
    );
    Ok(info)
}

/// Stop a forward — aborts its listener task (freeing the local port).
#[tauri::command]
pub async fn port_forward_stop(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Some(entry) = state.forwards.lock().await.remove(&id) {
        entry.task.abort();
    }
    Ok(())
}

/// List active forwards, with each one's most recent tunnel error (if any).
#[tauri::command]
pub async fn port_forward_list(state: State<'_, AppState>) -> Result<Vec<ForwardInfo>, String> {
    Ok(state
        .forwards
        .lock()
        .await
        .values()
        .map(|e| {
            let mut info = e.info.clone();
            info.last_error = e.last_error.lock().ok().and_then(|g| g.clone());
            info
        })
        .collect())
}
