//! Local SSH port forwarding (`-L`): bind a local 127.0.0.1 port and tunnel each
//! connection to `host:port` as reachable from the server, over a `direct-tcpip`
//! channel on the existing SSH connection.

use serde::Serialize;
use tauri::State;
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
}

/// Start forwarding `127.0.0.1:local_port` → `remote_host:remote_port` (the host
/// being reachable from the SSH server, e.g. `localhost` for the server itself).
#[tauri::command]
pub async fn port_forward_start(
    state: State<'_, AppState>,
    conn_id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Result<ForwardInfo, String> {
    let conn = state.ssh_connection(&conn_id).await?;
    let listener = TcpListener::bind(("127.0.0.1", local_port))
        .await
        .map_err(|e| format!("could not bind 127.0.0.1:{local_port}: {e}"))?;

    let id = uuid::Uuid::new_v4().to_string();
    let info = ForwardInfo {
        id: id.clone(),
        conn_id,
        local_port,
        remote_host: remote_host.clone(),
        remote_port,
    };

    let rp = remote_port as u32;
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = match listener.accept().await {
                Ok(s) => s,
                Err(_) => break,
            };
            let conn = conn.clone();
            let host = remote_host.clone();
            tokio::spawn(async move {
                match conn.open_direct_tcpip(&host, rp).await {
                    Ok(channel) => {
                        let mut stream = channel.into_stream();
                        let _ = copy_bidirectional(&mut socket, &mut stream).await;
                    }
                    Err(e) => log::warn!("tunnel open failed: {e}"),
                }
            });
        }
    });

    log::info!(
        "forward 127.0.0.1:{local_port} -> {}:{remote_port}",
        info.remote_host
    );
    state.forwards.lock().await.insert(id, (task, info.clone()));
    Ok(info)
}

/// Stop a forward — aborts its listener task (freeing the local port).
#[tauri::command]
pub async fn port_forward_stop(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Some((task, _)) = state.forwards.lock().await.remove(&id) {
        task.abort();
    }
    Ok(())
}

/// List active forwards.
#[tauri::command]
pub async fn port_forward_list(state: State<'_, AppState>) -> Result<Vec<ForwardInfo>, String> {
    Ok(state
        .forwards
        .lock()
        .await
        .values()
        .map(|(_, info)| info.clone())
        .collect())
}
