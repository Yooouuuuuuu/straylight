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

/// A live single-file watcher plus its owner count. Two features can need the
/// same file — the settings live-reload watches settings.json/theme.json for
/// the app's lifetime, while an open editor tab on the same file watches it
/// too (tab auto-reload) and unwatches on close. The watcher is only dropped
/// when the last owner unwatches.
pub struct FileWatcher {
    _watcher: notify::RecommendedWatcher,
    owners: usize,
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

/// Watch one **local** file for external changes (open-tab auto-reload / log
/// tailing). The parent directory is watched non-recursively and events are
/// filtered to this filename — editors that save via rename-over-the-file
/// would detach a direct file watch. Emits debounced `file-fs-change`.
#[tauri::command]
pub async fn file_watch(
    app: AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    path: String,
) -> Result<(), String> {
    let key = key_for(&conn_id, &path);
    let mut watchers = state.file_watchers.lock().await;
    if let Some(w) = watchers.get_mut(&key) {
        w.owners += 1;
        return Ok(());
    }

    let p = std::path::PathBuf::from(&path);
    let parent = p
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .ok_or("path has no parent directory")?
        .to_path_buf();
    let fname = p
        .file_name()
        .ok_or("path has no file name")?
        .to_os_string();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let mut watcher = notify::recommended_watcher(
        move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                if matches!(
                    event.kind,
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
                ) && event
                    .paths
                    .iter()
                    .any(|ep| ep.file_name() == Some(fname.as_os_str()))
                {
                    let _ = tx.send(());
                }
            }
        },
    )
    .map_err(|e| format!("could not create watcher: {e}"))?;
    watcher
        .watch(&parent, RecursiveMode::NonRecursive)
        .map_err(|e| format!("could not watch {}: {e}", parent.display()))?;

    tauri::async_runtime::spawn(async move {
        while rx.recv().await.is_some() {
            loop {
                match tokio::time::timeout(Duration::from_millis(300), rx.recv()).await {
                    Ok(Some(())) => continue,
                    _ => break,
                }
            }
            let _ = app.emit(
                "file-fs-change",
                json!({ "connId": conn_id, "path": path }),
            );
        }
    });

    watchers.insert(key, FileWatcher { _watcher: watcher, owners: 1 });
    Ok(())
}

/// Release one owner of a file watch; the watcher itself is only removed when
/// the last owner lets go (no-op if the file wasn't watched).
#[tauri::command]
pub async fn file_unwatch(
    state: State<'_, AppState>,
    conn_id: String,
    path: String,
) -> Result<(), String> {
    let key = key_for(&conn_id, &path);
    let mut watchers = state.file_watchers.lock().await;
    if let Some(w) = watchers.get_mut(&key) {
        w.owners -= 1;
        if w.owners == 0 {
            watchers.remove(&key);
        }
    }
    Ok(())
}
