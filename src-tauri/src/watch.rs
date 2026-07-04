//! Filesystem watcher for **local** repos, so the Source Control panel updates
//! live (VS Code-style) when files or `.git`/`.jj` change outside the app —
//! e.g. `git add` in a terminal or an editor save elsewhere. Remote/WSL repos
//! have no watcher (no agent on the host); they refresh on window focus instead.
//!
//! Events are debounced (trailing ~300 ms of quiet) and emitted to the frontend
//! as one `vcs-fs-change` per burst; the frontend adds its own guard against
//! reacting to the status call's own `.git/index` touch.

use std::path::Path;
use std::time::Duration;

use notify::{EventKind, RecursiveMode, Watcher};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};

use crate::AppState;

/// A live watcher; dropping it stops the watch.
pub struct RepoWatcher {
    _watcher: notify::RecommendedWatcher,
}

fn key_for(conn_id: &str, root: &str) -> String {
    format!("{conn_id}::{root}")
}

/// Start watching a local repo root (recursive). Idempotent per (conn, root).
#[tauri::command]
pub async fn vcs_watch(
    app: AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    root: String,
) -> Result<(), String> {
    let key = key_for(&conn_id, &root);
    let mut watchers = state.repo_watchers.lock().await;
    if watchers.contains_key(&key) {
        return Ok(());
    }

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let mut watcher = notify::recommended_watcher(
        move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                if matches!(
                    event.kind,
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
                ) {
                    let _ = tx.send(());
                }
            }
        },
    )
    .map_err(|e| format!("could not create watcher: {e}"))?;
    watcher
        .watch(Path::new(&root), RecursiveMode::Recursive)
        .map_err(|e| format!("could not watch {root}: {e}"))?;

    // Debounce: after a first event, drain until 300 ms of quiet, then emit one
    // change notification for the whole burst (a build touching thousands of
    // files becomes a single refresh when it goes quiet).
    tauri::async_runtime::spawn(async move {
        while rx.recv().await.is_some() {
            loop {
                match tokio::time::timeout(Duration::from_millis(300), rx.recv()).await {
                    Ok(Some(())) => continue,
                    _ => break,
                }
            }
            let _ = app.emit(
                "vcs-fs-change",
                json!({ "connId": conn_id, "root": root }),
            );
        }
    });

    watchers.insert(key, RepoWatcher { _watcher: watcher });
    Ok(())
}

/// Stop watching a repo (no-op if it wasn't watched).
#[tauri::command]
pub async fn vcs_unwatch(
    state: State<'_, AppState>,
    conn_id: String,
    root: String,
) -> Result<(), String> {
    state
        .repo_watchers
        .lock()
        .await
        .remove(&key_for(&conn_id, &root));
    Ok(())
}
