//! List running containers (podman AND docker) on any connected host, for the
//! Containers tab in the terminal panel. Both engines accept the same
//! Go-template `ps --format`; both are queried and merged, deduped by
//! container id — on hosts where `docker` is a podman alias the two commands
//! report the same containers.

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
    pub command: String,
    pub created: String,
}

/// Running containers on the host behind `conn_id` (empty when no engine).
#[tauri::command]
pub async fn container_list(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<Vec<ContainerInfo>, String> {
    const FMT: &str =
        "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}\t{{.Command}}\t{{.RunningFor}}";
    let mut list = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for engine in ["podman", "docker"] {
        let out = match run_command(&state, &conn_id, ".", &[engine, "ps", "--format", FMT]).await
        {
            Ok(o) => o,
            Err(_) => continue,
        };
        if out.code != 0 {
            continue; // engine missing (127) or its daemon is down — try the next
        }
        for line in out.stdout.lines() {
            let fields: Vec<&str> = line.split('\t').collect();
            if fields.len() >= 4 {
                let id = fields[0].trim().to_string();
                // Alias setups (`docker` → podman) list the same containers
                // twice — the first engine to claim an id keeps it.
                if !seen.insert(id.clone()) {
                    continue;
                }
                list.push(ContainerInfo {
                    id,
                    name: fields[1].trim().to_string(),
                    image: fields[2].trim().to_string(),
                    status: fields[3].trim().to_string(),
                    ports: fields.get(4).map(|s| s.trim()).unwrap_or("").to_string(),
                    engine: engine.to_string(),
                    // Docker prints the command quoted ("nginx -g …") — strip.
                    command: fields
                        .get(5)
                        .map(|s| s.trim().trim_matches('"'))
                        .unwrap_or("")
                        .to_string(),
                    created: fields.get(6).map(|s| s.trim()).unwrap_or("").to_string(),
                });
            }
        }
    }
    Ok(list)
}
