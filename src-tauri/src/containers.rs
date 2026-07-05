//! List running containers (podman or docker) on any connected host, for the
//! Containers tab in the terminal panel. Both engines accept the same
//! Go-template `ps --format`; podman is preferred when both exist.

use serde::Serialize;
use tauri::State;

use crate::exec::run_command;
use crate::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInfo {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: String,
    pub ports: String,
    pub engine: String,
}

/// Running containers on the host behind `conn_id` (empty when no engine).
#[tauri::command]
pub async fn container_list(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<Vec<ContainerInfo>, String> {
    const FMT: &str = "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}";
    for engine in ["podman", "docker"] {
        let out = match run_command(&state, &conn_id, ".", &[engine, "ps", "--format", FMT]).await
        {
            Ok(o) => o,
            Err(_) => continue,
        };
        if out.code != 0 {
            continue; // engine missing (127) or its daemon is down — try the next
        }
        let mut list = Vec::new();
        for line in out.stdout.lines() {
            let fields: Vec<&str> = line.split('\t').collect();
            if fields.len() >= 4 {
                list.push(ContainerInfo {
                    id: fields[0].trim().to_string(),
                    name: fields[1].trim().to_string(),
                    image: fields[2].trim().to_string(),
                    status: fields[3].trim().to_string(),
                    ports: fields.get(4).map(|s| s.trim()).unwrap_or("").to_string(),
                    engine: engine.to_string(),
                });
            }
        }
        return Ok(list);
    }
    Ok(Vec::new())
}
