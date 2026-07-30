//! Version control (git + jj).
//!
//! VCS operations run on the host that owns the repo — an SSH exec channel for
//! remote/WSL, or a local process — because Straylight has no local clone (see
//! docs/version-control.md). We parse only stable machine formats
//! (`git status --porcelain=v2 -z`).

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::exec::{run_command, CmdOutput};
use crate::transport::looks_binary;
use crate::AppState;

/// A detected repository: which VCS, and its absolute root.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsRepoInfo {
    pub backend: String,
    pub root: String,
}

/// One changed path in a repo's status.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsChange {
    /// Path relative to the repo root (forward-slash separated).
    pub path: String,
    /// The pre-rename path, for renames/copies.
    pub old_path: Option<String>,
    /// modified | added | deleted | renamed | copied | typechange | conflicted | untracked
    pub kind: String,
    /// Git: staged in the index. (jj has no staging — always false there.)
    pub staged: bool,
}

/// A repo's status: branch/ref, ahead/behind, and the changed paths.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsStatus {
    pub backend: String,
    #[serde(rename = "ref")]
    pub reference: String,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub changes: Vec<VcsChange>,
    /// Head fingerprint — changes on ANY history rewrite even when the change
    /// list doesn't (amend, rebase), so the frontend's "did anything actually
    /// change?" comparison can skip no-op refreshes. git: `branch.oid`;
    /// jj: `<@ commit id>/<@- commit id>`.
    pub oid: String,
}

/// Validate that `dir` is a repository and return its backend + root. Rejects a
/// non-repo so the UI can refuse to add it.
#[tauri::command]
pub async fn vcs_open(
    state: State<'_, AppState>,
    conn_id: String,
    dir: String,
) -> Result<VcsRepoInfo, String> {
    // Prefer jj: a colocated repo has both `.jj` and `.git`, and if the user is
    // driving with jj we must not show git's staging model. `jj root` fails (or
    // jj isn't installed) on a plain git repo, so we fall through to git.
    if let Ok(out) = run_command(&state, &conn_id, &dir, &["jj", "root"]).await {
        if out.code == 0 {
            let root = out.stdout.trim().to_string();
            if !root.is_empty() {
                return Ok(VcsRepoInfo {
                    backend: "jj".into(),
                    root,
                });
            }
        }
    }
    let out = run_command(
        &state,
        &conn_id,
        &dir,
        &["git", "rev-parse", "--show-toplevel"],
    )
    .await?;
    if out.code == 0 {
        let root = out.stdout.trim().to_string();
        if !root.is_empty() {
            return Ok(VcsRepoInfo {
                backend: "git".into(),
                root,
            });
        }
    }
    Err("Not a git or jj repository".into())
}

/// One commit in the history graph.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsCommit {
    pub id: String,
    pub parents: Vec<String>,
    pub author: String,
    pub timestamp: i64,
    pub subject: String,
    pub refs: Vec<String>,
    pub current: bool,
}

/// Commit history for a repo (newest first), for the history/graph view.
#[tauri::command]
pub async fn vcs_log(
    state: State<'_, AppState>,
    conn_id: String,
    root: String,
    backend: String,
    limit: u32,
) -> Result<Vec<VcsCommit>, String> {
    if backend == "jj" {
        jj_log(&state, &conn_id, &root, limit).await
    } else {
        git_log(&state, &conn_id, &root, limit).await
    }
}

fn parse_git_refs(d: &str) -> (bool, Vec<String>) {
    let mut current = false;
    let mut refs = Vec::new();
    for part in d.split(", ") {
        let p = part.trim();
        if p.is_empty() {
            continue;
        }
        if p == "HEAD" {
            current = true;
        } else if let Some(branch) = p.strip_prefix("HEAD -> ") {
            current = true;
            refs.push(branch.to_string());
        } else if let Some(tag) = p.strip_prefix("tag: ") {
            refs.push(tag.to_string());
        } else {
            refs.push(p.to_string());
        }
    }
    (current, refs)
}

async fn git_log(
    state: &AppState,
    conn_id: &str,
    root: &str,
    limit: u32,
) -> Result<Vec<VcsCommit>, String> {
    let n = limit.to_string();
    let out = run_command(
        state,
        conn_id,
        root,
        &[
            "git",
            "log",
            // All local branches + HEAD, children before parents — what the
            // frontend's multi-lane graph layout expects.
            "--branches",
            "HEAD",
            "--topo-order",
            "-n",
            &n,
            "--pretty=format:%h%x1f%p%x1f%an%x1f%at%x1f%D%x1f%s",
            "-z",
        ],
    )
    .await?;
    if out.code != 0 {
        let msg = out.stderr.trim();
        return Err(if msg.is_empty() {
            "git log failed".into()
        } else {
            msg.to_string()
        });
    }
    let mut commits = Vec::new();
    for rec in out.stdout.split('\0').filter(|r| !r.is_empty()) {
        let f: Vec<&str> = rec.splitn(6, '\u{1f}').collect();
        if f.len() < 6 {
            continue;
        }
        let (current, refs) = parse_git_refs(f[4]);
        commits.push(VcsCommit {
            id: f[0].to_string(),
            parents: f[1].split_whitespace().map(String::from).collect(),
            author: f[2].to_string(),
            timestamp: f[3].trim().parse().unwrap_or(0),
            subject: f[5].to_string(),
            refs,
            current,
        });
    }
    Ok(commits)
}

async fn jj_log(
    state: &AppState,
    conn_id: &str,
    root: &str,
    limit: u32,
) -> Result<Vec<VcsCommit>, String> {
    let n = limit.to_string();
    // Validated template (jj 0.42): tab-delimited fields, `%s` epoch timestamp.
    let tmpl = "commit_id.short() ++ \"\\t\" ++ parents.map(|c| c.commit_id().short()).join(\" \") ++ \"\\t\" ++ author.name() ++ \"\\t\" ++ author.timestamp().format(\"%s\") ++ \"\\t\" ++ bookmarks ++ \"\\t\" ++ if(current_working_copy, \"@\", \"\") ++ \"\\t\" ++ description.first_line() ++ \"\\n\"";
    let out = run_command(
        state,
        conn_id,
        root,
        &[
            "jj", "--color", "never", "log", "--no-graph", "--limit", &n, "-T", tmpl,
        ],
    )
    .await?;
    if out.code != 0 {
        let msg = out.stderr.trim();
        return Err(if msg.is_empty() {
            "jj log failed".into()
        } else {
            msg.to_string()
        });
    }
    let is_zero = |s: &str| !s.is_empty() && s.chars().all(|c| c == '0');
    let mut commits = Vec::new();
    for line in out.stdout.lines() {
        if line.is_empty() {
            continue;
        }
        let f: Vec<&str> = line.splitn(7, '\t').collect();
        if f.len() < 7 {
            continue;
        }
        if is_zero(f[0]) {
            continue; // the virtual root commit
        }
        commits.push(VcsCommit {
            id: f[0].to_string(),
            parents: f[1]
                .split_whitespace()
                .filter(|p| !is_zero(p))
                .map(String::from)
                .collect(),
            author: f[2].to_string(),
            timestamp: f[3].trim().parse().unwrap_or(0),
            subject: f[6].to_string(),
            refs: f[4].split_whitespace().map(String::from).collect(),
            current: f[5] == "@",
        });
    }
    Ok(commits)
}

/// Get (or create) the per-repo lock so VCS mutations serialize per repo.
async fn repo_guard(state: &AppState, conn_id: &str, root: &str) -> Arc<tokio::sync::Mutex<()>> {
    let key = format!("{conn_id}::{root}");
    let mut locks = state.vcs_locks.lock().await;
    locks
        .entry(key)
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

fn ok_or_stderr(out: CmdOutput, what: &str) -> Result<(), String> {
    if out.code == 0 {
        return Ok(());
    }
    let msg = out.stderr.trim();
    Err(if msg.is_empty() {
        format!("{what} failed (exit {})", out.code)
    } else {
        msg.to_string()
    })
}

/// Stage paths (git index). git-only — jj has no staging.
#[tauri::command]
pub async fn vcs_stage(
    state: State<'_, AppState>,
    conn_id: String,
    root: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let lock = repo_guard(&state, &conn_id, &root).await;
    let _held = lock.lock().await;
    let mut argv: Vec<&str> = vec!["git", "add", "--"];
    argv.extend(paths.iter().map(String::as_str));
    let out = run_command(&state, &conn_id, &root, &argv).await?;
    ok_or_stderr(out, "git add")
}

/// Unstage paths (git index).
#[tauri::command]
pub async fn vcs_unstage(
    state: State<'_, AppState>,
    conn_id: String,
    root: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let lock = repo_guard(&state, &conn_id, &root).await;
    let _held = lock.lock().await;
    let mut argv: Vec<&str> = vec!["git", "reset", "-q", "HEAD", "--"];
    argv.extend(paths.iter().map(String::as_str));
    let out = run_command(&state, &conn_id, &root, &argv).await?;
    ok_or_stderr(out, "git reset")
}

/// Commit: git commits the staged set; jj commits the working-copy change and
/// starts a new one (`jj commit` = describe + new).
#[tauri::command]
pub async fn vcs_commit(
    state: State<'_, AppState>,
    conn_id: String,
    root: String,
    backend: String,
    message: String,
) -> Result<(), String> {
    let lock = repo_guard(&state, &conn_id, &root).await;
    let _held = lock.lock().await;
    let out = if backend == "jj" {
        run_command(
            &state,
            &conn_id,
            &root,
            &["jj", "--color", "never", "commit", "-m", &message],
        )
        .await?
    } else {
        run_command(&state, &conn_id, &root, &["git", "commit", "-m", &message]).await?
    };
    ok_or_stderr(out, "commit")
}

/// A branch (git) or bookmark (jj).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsBranch {
    pub name: String,
    pub current: bool,
    /// A remote-tracking branch (e.g. "origin/x") — checking it out creates
    /// the local tracking branch.
    #[serde(default)]
    pub remote: bool,
}

/// List local branches / bookmarks, marking the current one.
#[tauri::command]
pub async fn vcs_branches(
    state: State<'_, AppState>,
    conn_id: String,
    root: String,
    backend: String,
) -> Result<Vec<VcsBranch>, String> {
    if backend == "jj" {
        let names = run_command(
            &state,
            &conn_id,
            &root,
            &["jj", "--color", "never", "bookmark", "list", "-T", "name ++ \"\\n\""],
        )
        .await?;
        let cur = run_command(
            &state,
            &conn_id,
            &root,
            &["jj", "--color", "never", "log", "--no-graph", "-r", "@ | @-", "-T", "bookmarks ++ \" \""],
        )
        .await?;
        let current: std::collections::HashSet<&str> = cur.stdout.split_whitespace().collect();
        Ok(names
            .stdout
            .lines()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(|n| VcsBranch {
                name: n.to_string(),
                current: current.contains(n),
                remote: false,
            })
            .collect())
    } else {
        let cur = run_command(&state, &conn_id, &root, &["git", "branch", "--show-current"]).await?;
        let current = cur.stdout.trim().to_string();
        let list = run_command(
            &state,
            &conn_id,
            &root,
            &["git", "for-each-ref", "--format=%(refname:short)", "refs/heads"],
        )
        .await?;
        if list.code != 0 {
            return Err(list.stderr.trim().to_string());
        }
        let mut out: Vec<VcsBranch> = list
            .stdout
            .lines()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(|n| VcsBranch {
                name: n.to_string(),
                current: n == current,
                remote: false,
            })
            .collect();
        // Remote-tracking branches (after any fetch); skip the origin/HEAD
        // pointer and remotes shadowed by an existing local branch.
        if let Ok(remotes) = run_command(
            &state,
            &conn_id,
            &root,
            &["git", "for-each-ref", "--format=%(refname:short)", "refs/remotes"],
        )
        .await
        {
            let locals: std::collections::HashSet<String> =
                out.iter().map(|b| b.name.clone()).collect();
            for n in remotes.stdout.lines().map(str::trim) {
                if n.is_empty() || n.ends_with("/HEAD") {
                    continue;
                }
                let short = n.split_once('/').map(|(_, s)| s).unwrap_or(n);
                if locals.contains(short) {
                    continue;
                }
                out.push(VcsBranch {
                    name: n.to_string(),
                    current: false,
                    remote: true,
                });
            }
        }
        Ok(out)
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingCommit {
    pub id: String,
    pub subject: String,
    pub author: String,
    pub timestamp: Option<i64>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingInfo {
    /// The upstream ref name, or None when the branch tracks nothing.
    pub upstream: Option<String>,
    pub commits: Vec<IncomingCommit>,
}

/// Commits on the current branch's upstream that aren't local yet (git only —
/// reads the last fetch, no network). The Incoming block in the history panel.
#[tauri::command]
pub async fn vcs_incoming(
    state: State<'_, AppState>,
    conn_id: String,
    root: String,
    backend: String,
) -> Result<IncomingInfo, String> {
    if backend == "jj" {
        return Ok(IncomingInfo { upstream: None, commits: Vec::new() });
    }
    let up = run_command(
        &state,
        &conn_id,
        &root,
        &["git", "rev-parse", "--abbrev-ref", "@{upstream}"],
    )
    .await?;
    if up.code != 0 {
        return Ok(IncomingInfo { upstream: None, commits: Vec::new() });
    }
    let upstream = up.stdout.trim().to_string();
    let log = run_command(
        &state,
        &conn_id,
        &root,
        &[
            "git",
            "log",
            "--format=%h%x1f%s%x1f%an%x1f%ct",
            "HEAD..@{upstream}",
        ],
    )
    .await?;
    if log.code != 0 {
        return Err(log.stderr.trim().to_string());
    }
    let commits = log
        .stdout
        .lines()
        .filter_map(|l| {
            let mut f = l.split('\u{1f}');
            Some(IncomingCommit {
                id: f.next()?.to_string(),
                subject: f.next().unwrap_or("").to_string(),
                author: f.next().unwrap_or("").to_string(),
                timestamp: f.next().and_then(|t| t.trim().parse().ok()),
            })
        })
        .collect();
    Ok(IncomingInfo { upstream: Some(upstream), commits })
}

/// Switch to an existing branch / bookmark (jj: start a new change on it).
#[tauri::command]
pub async fn vcs_switch(
    state: State<'_, AppState>,
    conn_id: String,
    root: String,
    backend: String,
    target: String,
) -> Result<(), String> {
    let lock = repo_guard(&state, &conn_id, &root).await;
    let _held = lock.lock().await;
    let out = if backend == "jj" {
        run_command(&state, &conn_id, &root, &["jj", "new", &target]).await?
    } else {
        run_command(&state, &conn_id, &root, &["git", "switch", &target]).await?
    };
    ok_or_stderr(out, "switch")
}

/// Create a new branch / bookmark at the current position and switch to it.
#[tauri::command]
pub async fn vcs_create_branch(
    state: State<'_, AppState>,
    conn_id: String,
    root: String,
    backend: String,
    name: String,
) -> Result<(), String> {
    let lock = repo_guard(&state, &conn_id, &root).await;
    let _held = lock.lock().await;
    let out = if backend == "jj" {
        run_command(&state, &conn_id, &root, &["jj", "bookmark", "create", &name, "-r", "@"]).await?
    } else {
        run_command(&state, &conn_id, &root, &["git", "switch", "-c", &name]).await?
    };
    ok_or_stderr(out, "create branch")
}

/// Amend the last commit (git only) — uses the staged set; keeps the existing
/// message when `message` is empty.
#[tauri::command]
pub async fn vcs_amend(
    state: State<'_, AppState>,
    conn_id: String,
    root: String,
    message: String,
) -> Result<(), String> {
    let lock = repo_guard(&state, &conn_id, &root).await;
    let _held = lock.lock().await;
    let out = if message.trim().is_empty() {
        run_command(&state, &conn_id, &root, &["git", "commit", "--amend", "--no-edit"]).await?
    } else {
        run_command(&state, &conn_id, &root, &["git", "commit", "--amend", "-m", &message]).await?
    };
    ok_or_stderr(out, "amend")
}

/// git stash (git only): op = `push` | `pop` | `list`. `list` returns the
/// stashes (one per line); the others return their output for a toast.
#[tauri::command]
pub async fn vcs_stash(
    state: State<'_, AppState>,
    conn_id: String,
    root: String,
    op: String,
    message: String,
) -> Result<String, String> {
    let lock = repo_guard(&state, &conn_id, &root).await;
    let _held = lock.lock().await;
    let argv: Vec<&str> = match op.as_str() {
        "push" if message.trim().is_empty() => vec!["git", "stash", "push"],
        "push" => vec!["git", "stash", "push", "-m", &message],
        "pop" => vec!["git", "stash", "pop"],
        "drop" => vec!["git", "stash", "drop"],
        "list" => vec!["git", "stash", "list", "--format=%gd: %s"],
        _ => return Err(format!("unknown stash op '{op}'")),
    };
    let out = run_command(&state, &conn_id, &root, &argv).await?;
    if out.code != 0 {
        let msg = out.stderr.trim();
        return Err(if msg.is_empty() {
            format!("stash {op} failed")
        } else {
            msg.to_string()
        });
    }
    Ok(out.stdout.trim().to_string())
}

/// Run a remote-facing command so it can be cancelled: `vcs_remote_cancel`
/// drops the in-flight future, which closes the SSH channel (killing the
/// remote command) or kills the local child — the escape hatch for an
/// interactive-auth hang on the no-TTY exec channel.
async fn run_cancellable(
    state: &AppState,
    conn_id: &str,
    root: &str,
    argv: &[&str],
) -> Result<CmdOutput, String> {
    let key = format!("{conn_id}::{root}");
    let token = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    {
        // One remote op per repo: inserting over an existing slot would drop
        // the first op's sender, which its select! reads as a cancellation.
        let mut ops = state.vcs_ops.lock().await;
        if ops.contains_key(&key) {
            return Err("another remote operation is already running on this repository".into());
        }
        ops.insert(key.clone(), (token.clone(), tx));
    }
    let result = tokio::select! {
        r = run_command(state, conn_id, root, argv) => r,
        _ = rx => Err("cancelled".to_string()),
    };
    // Clear only our own slot — a cancel may have freed it and a new op may
    // have claimed the key while our select! was resolving.
    let mut ops = state.vcs_ops.lock().await;
    if ops.get(&key).is_some_and(|(t, _)| t == &token) {
        ops.remove(&key);
    }
    result
}

/// Cancel the repo's in-flight remote op (fetch / push / update), if any.
#[tauri::command]
pub async fn vcs_remote_cancel(
    state: State<'_, AppState>,
    conn_id: String,
    root: String,
) -> Result<(), String> {
    if let Some((_, tx)) = state
        .vcs_ops
        .lock()
        .await
        .remove(&format!("{conn_id}::{root}"))
    {
        let _ = tx.send(());
    }
    Ok(())
}

/// Bring the local line up to date with the fetched upstream: git merges
/// `@{u}` (the Incoming block's Merge action). Mutates the working tree — the
/// UI confirms first. jj is view-first by design — its syncs are
/// terminal-driven, so the jj arm refuses.
#[tauri::command]
pub async fn vcs_update(
    state: State<'_, AppState>,
    conn_id: String,
    root: String,
    backend: String,
    target: String,
) -> Result<String, String> {
    let lock = repo_guard(&state, &conn_id, &root).await;
    let _held = lock.lock().await;
    let out = if backend == "jj" {
        return Err(format!(
            "jj syncs are terminal-driven — run: jj rebase -d {target}@origin"
        ));
    } else {
        run_cancellable(&state, &conn_id, &root, &["git", "merge", "--no-edit", "@{u}"]).await?
    };
    let msg = format!("{}\n{}", out.stdout.trim(), out.stderr.trim())
        .trim()
        .to_string();
    if out.code != 0 {
        // A conflicting merge leaves the working tree half-applied — conflict
        // markers written into files (this is what corrupted package.json and
        // broke a restart). Never leave the user there: roll the merge back so
        // the tree is clean again, and point them at the terminal. Resolving
        // conflicts is git work Straylight signposts rather than wraps.
        if msg.contains("CONFLICT") || msg.contains("Automatic merge failed") {
            // Best-effort restore of the pre-merge state (nothing to undo → no-op).
            let _ = run_command(&state, &conn_id, &root, &["git", "merge", "--abort"]).await;
            return Err(
                "Couldn't auto-merge — the local branch and the remote have conflicting \
                 changes. The merge was rolled back (nothing left half-applied); resolve it \
                 in a terminal: git pull, fix the conflicts, then commit."
                    .into(),
            );
        }
        return Err(if msg.is_empty() { "update failed".into() } else { msg });
    }
    Ok(if msg.is_empty() { "Up to date.".into() } else { msg })
}

/// Fetch / pull / push (jj: `jj git fetch` / `jj git push`; jj "pull" maps to
/// fetch). Returns the command output for a toast. May hang on interactive auth —
/// run those in the terminal instead (our exec channel has no TTY).
#[tauri::command]
pub async fn vcs_remote(
    state: State<'_, AppState>,
    conn_id: String,
    root: String,
    backend: String,
    op: String,
) -> Result<String, String> {
    let argv: Vec<&str> = match (backend.as_str(), op.as_str()) {
        ("jj", "fetch") | ("jj", "pull") => vec!["jj", "git", "fetch"],
        ("jj", "push") => vec!["jj", "git", "push"],
        (_, "fetch") => vec!["git", "fetch"],
        (_, "pull") => vec!["git", "pull"],
        (_, "push") => vec!["git", "push"],
        _ => return Err(format!("unknown operation '{op}'")),
    };
    let out = run_cancellable(&state, &conn_id, &root, &argv).await?;
    let msg = format!("{}\n{}", out.stdout.trim(), out.stderr.trim())
        .trim()
        .to_string();
    if out.code != 0 {
        return Err(if msg.is_empty() {
            format!("{op} failed (exit {})", out.code)
        } else {
            msg
        });
    }
    Ok(if msg.is_empty() {
        format!("{op} complete")
    } else {
        msg
    })
}

/// Create an annotated tag at HEAD (git only), and optionally push just that tag
/// to origin. Empty `message` → the tag name is used as the annotation. The push
/// is cancellable (`vcs_remote_cancel`); if it fails, the local tag still stands
/// so a retry only needs to push.
#[tauri::command]
pub async fn vcs_tag(
    state: State<'_, AppState>,
    conn_id: String,
    root: String,
    name: String,
    message: String,
    push: bool,
) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("a tag needs a name".into());
    }
    let msg = if message.trim().is_empty() {
        name
    } else {
        message.trim()
    };
    // Create the annotated tag — local and fast, under the repo write guard.
    {
        let lock = repo_guard(&state, &conn_id, &root).await;
        let _held = lock.lock().await;
        let out =
            run_command(&state, &conn_id, &root, &["git", "tag", "-a", name, "-m", msg]).await?;
        if out.code != 0 {
            let e = out.stderr.trim();
            return Err(if e.is_empty() {
                format!("could not create tag {name}")
            } else {
                e.to_string()
            });
        }
    }
    if !push {
        return Ok(format!("Tagged {name}"));
    }
    // Push only this tag (network, cancellable).
    let out = run_cancellable(&state, &conn_id, &root, &["git", "push", "origin", name]).await?;
    if out.code != 0 {
        let e = format!("{}\n{}", out.stdout.trim(), out.stderr.trim())
            .trim()
            .to_string();
        return Err(if e.is_empty() {
            format!("Tagged {name} locally, but the push failed (exit {})", out.code)
        } else {
            format!("Tagged {name} locally, but the push failed: {e}")
        });
    }
    Ok(format!("Tagged and pushed {name}"))
}

/// The files changed by one commit (vs its parent), for browsing history.
#[tauri::command]
pub async fn vcs_commit_files(
    state: State<'_, AppState>,
    conn_id: String,
    root: String,
    backend: String,
    commit: String,
) -> Result<Vec<VcsChange>, String> {
    if backend == "jj" {
        let out = run_command(
            &state,
            &conn_id,
            &root,
            &["jj", "--color", "never", "diff", "-r", &commit, "--summary"],
        )
        .await?;
        if out.code != 0 {
            return Err(out.stderr.trim().to_string());
        }
        Ok(parse_jj_summary(&out.stdout))
    } else {
        let out = run_command(
            &state,
            &conn_id,
            &root,
            &[
                "git",
                "diff-tree",
                "--no-commit-id",
                "-r",
                "--name-status",
                "-z",
                "--root",
                &commit,
            ],
        )
        .await?;
        if out.code != 0 {
            return Err(out.stderr.trim().to_string());
        }
        Ok(parse_name_status_z(&out.stdout))
    }
}

/// Parse `git diff-tree --name-status -z`: a status token then its path token(s)
/// (renames/copies carry both old and new paths).
fn parse_name_status_z(data: &str) -> Vec<VcsChange> {
    let tokens: Vec<&str> = data.split('\0').filter(|t| !t.is_empty()).collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let code = tokens[i].chars().next().unwrap_or('M');
        if (code == 'R' || code == 'C') && i + 2 < tokens.len() {
            out.push(VcsChange {
                path: tokens[i + 2].to_string(),
                old_path: Some(tokens[i + 1].to_string()),
                kind: kind_from_code(code).into(),
                staged: false,
            });
            i += 3;
        } else if i + 1 < tokens.len() {
            out.push(VcsChange {
                path: tokens[i + 1].to_string(),
                old_path: None,
                kind: kind_from_code(code).into(),
                staged: false,
            });
            i += 2;
        } else {
            break;
        }
    }
    out
}

/// A file's content at a specific revision (for browsing a commit's diffs).
#[tauri::command]
pub async fn vcs_file_at(
    state: State<'_, AppState>,
    conn_id: String,
    root: String,
    backend: String,
    rev: String,
    path: String,
) -> Result<VcsFileBase, String> {
    let out = if backend == "jj" {
        run_command(
            &state,
            &conn_id,
            &root,
            &["jj", "--color", "never", "file", "show", "-r", &rev, &path],
        )
        .await?
    } else {
        let spec = format!("{rev}:{path}");
        run_command(&state, &conn_id, &root, &["git", "show", &spec]).await?
    };
    if out.code != 0 {
        return Ok(VcsFileBase {
            content: String::new(),
            exists: false,
            is_binary: false,
        });
    }
    let is_binary = looks_binary(out.stdout.as_bytes());
    Ok(VcsFileBase {
        content: if is_binary { String::new() } else { out.stdout },
        exists: true,
        is_binary,
    })
}

/// Discard working-tree changes for paths (git: restore to HEAD + unstage; jj:
/// restore from the parent). Destructive — the UI confirms first.
#[tauri::command]
pub async fn vcs_discard(
    state: State<'_, AppState>,
    conn_id: String,
    root: String,
    backend: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let lock = repo_guard(&state, &conn_id, &root).await;
    let _held = lock.lock().await;
    let mut argv: Vec<&str> = if backend == "jj" {
        vec!["jj", "restore"]
    } else {
        vec!["git", "restore", "--staged", "--worktree", "--"]
    };
    argv.extend(paths.iter().map(String::as_str));
    let out = run_command(&state, &conn_id, &root, &argv).await?;
    ok_or_stderr(out, "discard")
}

/// The base (pre-change) version of a file, for the diff's "old" side: git's
/// `HEAD:<path>` or jj's `@-` revision. `exists: false` means the file isn't in
/// the base (added/untracked) — the diff shows an empty old side.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsFileBase {
    pub content: String,
    pub exists: bool,
    pub is_binary: bool,
}

#[tauri::command]
pub async fn vcs_file_base(
    state: State<'_, AppState>,
    conn_id: String,
    root: String,
    backend: String,
    path: String,
) -> Result<VcsFileBase, String> {
    let out = if backend == "jj" {
        run_command(
            &state,
            &conn_id,
            &root,
            &["jj", "--color", "never", "file", "show", "-r", "@-", &path],
        )
        .await?
    } else {
        let spec = format!("HEAD:{path}");
        run_command(&state, &conn_id, &root, &["git", "show", &spec]).await?
    };
    if out.code != 0 {
        // Not in the base (added / untracked): no old side.
        return Ok(VcsFileBase {
            content: String::new(),
            exists: false,
            is_binary: false,
        });
    }
    let is_binary = looks_binary(out.stdout.as_bytes());
    Ok(VcsFileBase {
        content: if is_binary { String::new() } else { out.stdout },
        exists: true,
        is_binary,
    })
}

/// Return the normalized status for a repo, dispatching on its backend.
#[tauri::command]
pub async fn vcs_status(
    state: State<'_, AppState>,
    conn_id: String,
    root: String,
    backend: String,
) -> Result<VcsStatus, String> {
    match backend.as_str() {
        "jj" => jj_status(&state, &conn_id, &root).await,
        _ => git_status(&state, &conn_id, &root).await,
    }
}

async fn git_status(state: &AppState, conn_id: &str, root: &str) -> Result<VcsStatus, String> {
    let out = run_command(
        state,
        conn_id,
        root,
        // `--ignored` adds `! <path>` records (fully-ignored dirs collapse to
        // one entry) — the explorer dims them, the panel filters them out.
        &["git", "status", "--porcelain=v2", "--branch", "--ignored", "-z"],
    )
    .await?;
    if out.code != 0 {
        let msg = out.stderr.trim();
        return Err(if msg.is_empty() {
            format!("git status failed (exit {})", out.code)
        } else {
            msg.to_string()
        });
    }
    Ok(parse_porcelain_v2(&out.stdout))
}

/// jj status: the working-copy change list (`jj diff --summary`) plus a ref —
/// the bookmark on `@`, else on `@-`, else the change id (see the jj spike in
/// docs/version-control.md). jj has no staging or untracked state.
async fn jj_status(state: &AppState, conn_id: &str, root: &str) -> Result<VcsStatus, String> {
    let diff = run_command(
        state,
        conn_id,
        root,
        &["jj", "--color", "never", "diff", "--summary"],
    )
    .await?;
    if diff.code != 0 {
        let msg = diff.stderr.trim();
        return Err(if msg.is_empty() {
            format!("jj diff failed (exit {})", diff.code)
        } else {
            msg.to_string()
        });
    }
    let mut changes = parse_jj_summary(&diff.stdout);

    // Ignored files: jj has no "list ignored", but a colocated repo has .git —
    // read it without taking any lock (`--no-optional-locks` guarantees git
    // writes nothing, so jj can't desync). Non-colocated repos fail the command
    // and simply get no dimming.
    if let Ok(ig) = run_command(
        state,
        conn_id,
        root,
        &[
            "git",
            "--no-optional-locks",
            "status",
            "--porcelain=v2",
            "--ignored",
            "-z",
        ],
    )
    .await
    {
        if ig.code == 0 {
            changes.extend(
                parse_porcelain_v2(&ig.stdout)
                    .changes
                    .into_iter()
                    .filter(|c| c.kind == "ignored"),
            );
        }
    }

    // Conflicted paths (spike-verified on jj 0.42): `jj resolve --list` prints
    // `path    2-sided conflict` per line and exits 0; with no conflicts it
    // exits 2. Conflicts appear in the summary as a plain `M`, so upgrade them.
    let resolve = run_command(
        state,
        conn_id,
        root,
        &["jj", "--color", "never", "resolve", "--list"],
    )
    .await?;
    if resolve.code == 0 {
        for path in parse_jj_resolve_list(&resolve.stdout) {
            match changes.iter_mut().find(|c| c.path == path) {
                Some(c) => c.kind = "conflicted".into(),
                None => changes.push(VcsChange {
                    path,
                    old_path: None,
                    kind: "conflicted".into(),
                    staged: false,
                }),
            }
        }
    }

    // `@` bookmark / change id / description (tab-delimited), and `@-` bookmark.
    let at = run_command(
        state,
        conn_id,
        root,
        &[
            "jj",
            "--color",
            "never",
            "log",
            "--no-graph",
            "-r",
            "@",
            "-T",
            "bookmarks ++ \"\\t\" ++ change_id.short() ++ \"\\t\" ++ description.first_line() ++ \"\\t\" ++ commit_id.short()",
        ],
    )
    .await?;
    let parent = run_command(
        state,
        conn_id,
        root,
        &[
            "jj", "--color", "never", "log", "--no-graph", "-r", "@-", "-T",
            "bookmarks ++ \"\\t\" ++ commit_id.short()",
        ],
    )
    .await?;

    let fields: Vec<&str> = at.stdout.trim_end().split('\t').collect();
    let at_bm = fields.first().map(|s| s.trim()).unwrap_or("");
    let change_id = fields.get(1).map(|s| s.trim()).unwrap_or("");
    let at_commit = fields.get(3).map(|s| s.trim()).unwrap_or("");
    let pfields: Vec<&str> = parent.stdout.trim_end().split('\t').collect();
    let parent_bm = pfields.first().map(|s| s.trim()).unwrap_or("");
    let parent_commit = pfields.get(1).map(|s| s.trim()).unwrap_or("");
    let reference = if !at_bm.is_empty() {
        at_bm.to_string()
    } else if !parent_bm.is_empty() {
        parent_bm.to_string()
    } else {
        change_id.to_string()
    };

    Ok(VcsStatus {
        backend: "jj".into(),
        reference,
        ahead: None,
        behind: None,
        changes,
        oid: format!("{at_commit}/{parent_commit}"),
    })
}

/// Parse `jj resolve --list`: one `path<2+ spaces>N-sided conflict` per line.
fn parse_jj_resolve_list(data: &str) -> Vec<String> {
    data.lines()
        .filter_map(|line| {
            let line = line.trim_end();
            if line.is_empty() {
                return None;
            }
            Some(
                line.split("  ")
                    .next()
                    .unwrap_or(line)
                    .trim_end()
                    .replace('\\', "/"),
            )
        })
        .collect()
}

/// Expand git/jj brace-rename notation (`dir/{old => new}/x`) into (old, new).
fn expand_rename(s: &str) -> (String, String) {
    if let (Some(open), Some(arrow)) = (s.find('{'), s.find(" => ")) {
        if let Some(close) = s.find('}') {
            if open < arrow && arrow < close {
                let prefix = &s[..open];
                let old_mid = &s[open + 1..arrow];
                let new_mid = &s[arrow + 4..close];
                let suffix = &s[close + 1..];
                return (
                    format!("{prefix}{old_mid}{suffix}"),
                    format!("{prefix}{new_mid}{suffix}"),
                );
            }
        }
    }
    (s.to_string(), s.to_string())
}

/// Parse `jj diff --summary` (`M path` / `A path` / `D path` / `R {old => new}`).
fn parse_jj_summary(data: &str) -> Vec<VcsChange> {
    let mut out = Vec::new();
    for line in data.lines() {
        let line = line.trim_end();
        if line.len() < 2 {
            continue;
        }
        let code = &line[..1];
        let rest = line[1..].trim_start();
        let kind = match code {
            "A" => "added",
            "M" => "modified",
            "D" => "deleted",
            "R" => "renamed",
            "C" => "copied",
            _ => continue,
        };
        if code == "R" || code == "C" {
            let (old, new) = expand_rename(rest);
            out.push(VcsChange {
                path: new.replace('\\', "/"),
                old_path: Some(old.replace('\\', "/")),
                kind: kind.into(),
                staged: false,
            });
        } else {
            // jj on Windows emits backslash paths — normalize so decoration
            // keys and diff/stage calls line up with the git convention.
            out.push(VcsChange {
                path: rest.replace('\\', "/"),
                old_path: None,
                kind: kind.into(),
                staged: false,
            });
        }
    }
    out
}

/// Map a single porcelain status letter to a change kind.
fn kind_from_code(code: char) -> &'static str {
    match code {
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'T' => "typechange",
        'U' => "conflicted",
        _ => "modified",
    }
}

/// Parse `git status --porcelain=v2 --branch -z`. In `-z` mode every record
/// (headers included) is NUL-terminated; a type-2 (rename/copy) record is
/// followed by a separate NUL field holding the original path.
fn parse_porcelain_v2(data: &str) -> VcsStatus {
    let mut reference = String::new();
    let mut oid = String::new();
    let mut ahead = None;
    let mut behind = None;
    let mut changes = Vec::new();

    let tokens: Vec<&str> = data.split('\0').filter(|t| !t.is_empty()).collect();
    let mut i = 0;
    while i < tokens.len() {
        let t = tokens[i];
        if let Some(rest) = t.strip_prefix("# branch.head ") {
            reference = rest.to_string();
        } else if let Some(rest) = t.strip_prefix("# branch.oid ") {
            oid = rest.to_string();
        } else if let Some(rest) = t.strip_prefix("# branch.ab ") {
            for part in rest.split_whitespace() {
                if let Some(a) = part.strip_prefix('+') {
                    ahead = a.parse().ok();
                } else if let Some(bh) = part.strip_prefix('-') {
                    behind = bh.parse().ok();
                }
            }
        } else if let Some(rest) = t.strip_prefix("1 ") {
            // <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>. X = index (staged),
            // Y = worktree — emit a separate entry for each non-`.` side so a
            // file staged *and* re-modified shows in both groups.
            let parts: Vec<&str> = rest.splitn(8, ' ').collect();
            if parts.len() == 8 {
                let xy = parts[0].as_bytes();
                let x = *xy.first().unwrap_or(&b'.') as char;
                let y = *xy.get(1).unwrap_or(&b'.') as char;
                let path = parts[7].to_string();
                if x != '.' {
                    changes.push(VcsChange {
                        path: path.clone(),
                        old_path: None,
                        kind: kind_from_code(x).into(),
                        staged: true,
                    });
                }
                if y != '.' {
                    changes.push(VcsChange {
                        path,
                        old_path: None,
                        kind: kind_from_code(y).into(),
                        staged: false,
                    });
                }
            }
        } else if let Some(rest) = t.strip_prefix("2 ") {
            // <XY> … <Xscore> <path> ; origPath = next token (rename/copy).
            let parts: Vec<&str> = rest.splitn(9, ' ').collect();
            if parts.len() == 9 {
                let xy = parts[0].as_bytes();
                let x = *xy.first().unwrap_or(&b'.') as char;
                let y = *xy.get(1).unwrap_or(&b'.') as char;
                let path = parts[8].to_string();
                let old_path = tokens.get(i + 1).map(|s| s.to_string());
                i += 1; // consume the original-path token
                if x != '.' {
                    changes.push(VcsChange {
                        path: path.clone(),
                        old_path,
                        kind: kind_from_code(x).into(),
                        staged: true,
                    });
                }
                if y != '.' {
                    changes.push(VcsChange {
                        path,
                        old_path: None,
                        kind: kind_from_code(y).into(),
                        staged: false,
                    });
                }
            }
        } else if let Some(rest) = t.strip_prefix("u ") {
            // <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            let parts: Vec<&str> = rest.splitn(10, ' ').collect();
            if parts.len() == 10 {
                changes.push(VcsChange {
                    path: parts[9].to_string(),
                    old_path: None,
                    kind: "conflicted".into(),
                    staged: false,
                });
            }
        } else if let Some(rest) = t.strip_prefix("? ") {
            changes.push(VcsChange {
                path: rest.to_string(),
                old_path: None,
                kind: "untracked".into(),
                staged: false,
            });
        } else if let Some(rest) = t.strip_prefix("! ") {
            // Ignored file or fully-ignored directory (trailing slash).
            changes.push(VcsChange {
                path: rest.trim_end_matches('/').to_string(),
                old_path: None,
                kind: "ignored".into(),
                staged: false,
            });
        }
        i += 1;
    }

    VcsStatus {
        backend: "git".into(),
        reference,
        ahead,
        behind,
        changes,
        oid,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_and_changes() {
        // Verified shape from `git status --porcelain=v2 --branch -z`.
        let data = "# branch.oid abc123\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\01 .M N... 100644 100644 100644 aaa bbb docs/backlog.md\0? docs/new.md\0";
        let s = parse_porcelain_v2(data);
        assert_eq!(s.reference, "main");
        assert_eq!(s.ahead, Some(2));
        assert_eq!(s.behind, Some(1));
        assert_eq!(s.changes.len(), 2);
        assert_eq!(s.changes[0].path, "docs/backlog.md");
        assert_eq!(s.changes[0].kind, "modified");
        assert!(!s.changes[0].staged);
        assert_eq!(s.changes[1].path, "docs/new.md");
        assert_eq!(s.changes[1].kind, "untracked");
    }

    #[test]
    fn parses_staged_and_rename() {
        let data = "# branch.head main\01 A. N... 100644 100644 100644 aaa bbb added.txt\02 R. N... 100644 100644 100644 aaa bbb R100 new.txt\0old.txt\0";
        let s = parse_porcelain_v2(data);
        assert_eq!(s.changes.len(), 2);
        assert_eq!(s.changes[0].kind, "added");
        assert!(s.changes[0].staged);
        assert_eq!(s.changes[1].kind, "renamed");
        assert_eq!(s.changes[1].path, "new.txt");
        assert_eq!(s.changes[1].old_path.as_deref(), Some("old.txt"));
    }

    #[test]
    fn jj_summary_normalizes_windows_paths() {
        let data = "M docs\\backlog.md\nA src\\lib\\new.ts\n";
        let c = parse_jj_summary(data);
        assert_eq!(c[0].path, "docs/backlog.md");
        assert_eq!(c[1].path, "src/lib/new.ts");
    }

    #[test]
    fn parses_ignored_entries() {
        let data = "# branch.head main\0! node_modules/\0! secret.env\0? new.txt\0";
        let s = parse_porcelain_v2(data);
        assert_eq!(s.changes.len(), 3);
        assert_eq!(s.changes[0].kind, "ignored");
        assert_eq!(s.changes[0].path, "node_modules"); // trailing slash stripped
        assert_eq!(s.changes[1].path, "secret.env");
        assert_eq!(s.changes[2].kind, "untracked");
    }

    #[test]
    fn splits_staged_and_unstaged() {
        // "MM" = staged modification + further worktree modification → both groups.
        let data = "# branch.head main\01 MM N... 100644 100644 100644 aaa bbb f.txt\0";
        let s = parse_porcelain_v2(data);
        assert_eq!(s.changes.len(), 2);
        assert!(s.changes[0].staged && s.changes[0].kind == "modified");
        assert!(!s.changes[1].staged && s.changes[1].kind == "modified");
    }

    #[test]
    fn parses_jj_resolve_list() {
        let data = "a.txt    2-sided conflict\nsrc/my file.rs    3-sided conflict\n";
        assert_eq!(
            parse_jj_resolve_list(data),
            vec!["a.txt".to_string(), "src/my file.rs".to_string()]
        );
    }

    #[test]
    fn parses_jj_summary() {
        // Verified shape from `jj diff --summary`.
        let data = "M a.txt\nA b.txt\nD keep.txt\nR {ren.txt => ren2.txt}\n";
        let c = parse_jj_summary(data);
        assert_eq!(c.len(), 4);
        assert_eq!((c[0].kind.as_str(), c[0].path.as_str()), ("modified", "a.txt"));
        assert_eq!((c[1].kind.as_str(), c[1].path.as_str()), ("added", "b.txt"));
        assert_eq!((c[2].kind.as_str(), c[2].path.as_str()), ("deleted", "keep.txt"));
        assert_eq!(c[3].kind, "renamed");
        assert_eq!(c[3].path, "ren2.txt");
        assert_eq!(c[3].old_path.as_deref(), Some("ren.txt"));
    }

    #[test]
    fn expands_dir_rename() {
        let (old, new) = expand_rename("src/{old.rs => new.rs}");
        assert_eq!(old, "src/old.rs");
        assert_eq!(new, "src/new.rs");
    }
}
