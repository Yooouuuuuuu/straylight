//! Version control (git; jj arrives in a later slice).
//!
//! VCS operations run on the host that owns the repo — an SSH exec channel for
//! remote/WSL, or a local process — because Straylight has no local clone (see
//! docs/version-control.md). We parse only stable machine formats
//! (`git status --porcelain=v2 -z`).

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::ssh::connection::Connection;
use crate::transport::looks_binary;
use crate::{AppState, Session};

/// Result of running one command on a host.
struct CmdOutput {
    stdout: String,
    stderr: String,
    code: i32,
}

/// Quote one argument for a POSIX shell (single-quote, escaping embedded quotes).
fn shell_quote(arg: &str) -> String {
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('\'');
    for ch in arg.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// Run `argv` in `cwd` on the host behind `conn_id` (SSH exec or local process).
async fn run_command(
    state: &AppState,
    conn_id: &str,
    cwd: &str,
    argv: &[&str],
) -> Result<CmdOutput, String> {
    enum Target {
        Ssh(Arc<Connection>),
        Local,
    }
    // Resolve the target and drop the lock before the (possibly slow) command.
    let target = {
        let sessions = state.sessions.lock().await;
        match sessions.get(conn_id) {
            Some(Session::Ssh(conn)) => Target::Ssh(conn.clone()),
            Some(Session::Local) => Target::Local,
            None => return Err(format!("session '{conn_id}' is not open")),
        }
    };
    match target {
        Target::Ssh(conn) => run_ssh(&conn, cwd, argv).await,
        Target::Local => run_local(cwd, argv).await,
    }
}

async fn run_ssh(conn: &Connection, cwd: &str, argv: &[&str]) -> Result<CmdOutput, String> {
    use russh::ChannelMsg;

    let mut channel = conn.open_channel().await?;
    let quoted: Vec<String> = argv.iter().map(|a| shell_quote(a)).collect();
    // `cd` into the repo, force a stable locale, then run the command.
    let command = format!("cd {} && LC_ALL=C {}", shell_quote(cwd), quoted.join(" "));
    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|e| format!("could not start command: {e}"))?;

    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let mut code: Option<i32> = None;
    // Read to the end of the channel; ExitStatus can arrive before or after Eof,
    // so we keep going until the channel actually closes.
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { data }) => stdout.extend_from_slice(&data),
            Some(ChannelMsg::ExtendedData { data, .. }) => stderr.extend_from_slice(&data),
            Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status as i32),
            Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    Ok(CmdOutput {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        code: code.unwrap_or(-1),
    })
}

async fn run_local(cwd: &str, argv: &[&str]) -> Result<CmdOutput, String> {
    let (bin, rest) = argv.split_first().ok_or("empty command")?;
    let output = tokio::process::Command::new(bin)
        .args(rest)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("could not run {bin}: {e}"))?;
    Ok(CmdOutput {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        code: output.status.code().unwrap_or(-1),
    })
}

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
}

/// Validate that `dir` is a repository and return its backend + root. Rejects a
/// non-repo so the UI can refuse to add it. (git only for now.)
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
        &["git", "status", "--porcelain=v2", "--branch", "-z"],
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
    let changes = parse_jj_summary(&diff.stdout);

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
            "bookmarks ++ \"\\t\" ++ change_id.short() ++ \"\\t\" ++ description.first_line()",
        ],
    )
    .await?;
    let parent = run_command(
        state,
        conn_id,
        root,
        &[
            "jj", "--color", "never", "log", "--no-graph", "-r", "@-", "-T", "bookmarks",
        ],
    )
    .await?;

    let fields: Vec<&str> = at.stdout.trim_end().split('\t').collect();
    let at_bm = fields.first().map(|s| s.trim()).unwrap_or("");
    let change_id = fields.get(1).map(|s| s.trim()).unwrap_or("");
    let parent_bm = parent.stdout.trim();
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
    })
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
                path: new,
                old_path: Some(old),
                kind: kind.into(),
                staged: false,
            });
        } else {
            out.push(VcsChange {
                path: rest.to_string(),
                old_path: None,
                kind: kind.into(),
                staged: false,
            });
        }
    }
    out
}

/// Map a porcelain v2 `<XY>` field to a change kind + staged flag. `X` is the
/// index (staged) status, `Y` the worktree; we report the worktree change if
/// present, else the staged one.
fn kind_from_xy(xy: &str) -> (String, bool) {
    let b = xy.as_bytes();
    let x = *b.first().unwrap_or(&b'.') as char;
    let y = *b.get(1).unwrap_or(&b'.') as char;
    let staged = x != '.';
    let code = if y != '.' { y } else { x };
    let kind = match code {
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'T' => "typechange",
        'U' => "conflicted",
        _ => "modified",
    };
    (kind.to_string(), staged)
}

/// Parse `git status --porcelain=v2 --branch -z`. In `-z` mode every record
/// (headers included) is NUL-terminated; a type-2 (rename/copy) record is
/// followed by a separate NUL field holding the original path.
fn parse_porcelain_v2(data: &str) -> VcsStatus {
    let mut reference = String::new();
    let mut ahead = None;
    let mut behind = None;
    let mut changes = Vec::new();

    let tokens: Vec<&str> = data.split('\0').filter(|t| !t.is_empty()).collect();
    let mut i = 0;
    while i < tokens.len() {
        let t = tokens[i];
        if let Some(rest) = t.strip_prefix("# branch.head ") {
            reference = rest.to_string();
        } else if let Some(rest) = t.strip_prefix("# branch.ab ") {
            for part in rest.split_whitespace() {
                if let Some(a) = part.strip_prefix('+') {
                    ahead = a.parse().ok();
                } else if let Some(bh) = part.strip_prefix('-') {
                    behind = bh.parse().ok();
                }
            }
        } else if let Some(rest) = t.strip_prefix("1 ") {
            // <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            let parts: Vec<&str> = rest.splitn(8, ' ').collect();
            if parts.len() == 8 {
                let (kind, staged) = kind_from_xy(parts[0]);
                changes.push(VcsChange {
                    path: parts[7].to_string(),
                    old_path: None,
                    kind,
                    staged,
                });
            }
        } else if let Some(rest) = t.strip_prefix("2 ") {
            // <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path> ; origPath = next token
            let parts: Vec<&str> = rest.splitn(9, ' ').collect();
            if parts.len() == 9 {
                let (kind, staged) = kind_from_xy(parts[0]);
                let old_path = tokens.get(i + 1).map(|s| s.to_string());
                i += 1; // consume the original-path token
                changes.push(VcsChange {
                    path: parts[8].to_string(),
                    old_path,
                    kind,
                    staged,
                });
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
        }
        // "! " ignored entries and other headers are skipped.
        i += 1;
    }

    VcsStatus {
        backend: "git".into(),
        reference,
        ahead,
        behind,
        changes,
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
