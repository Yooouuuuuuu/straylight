//! Run a command on the host that owns a connection — an SSH exec channel for
//! remote/WSL, or a local process. Shared by the VCS layer, the file finder, and
//! search-in-files (none of which have a local clone to work against).

use std::sync::Arc;

use crate::ssh::connection::Connection;
use crate::{AppState, Session};

/// Result of running one command on a host.
pub struct CmdOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

/// Quote one argument for a POSIX shell (single-quote, escaping embedded quotes).
pub fn shell_quote(arg: &str) -> String {
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
pub async fn run_command(
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
        Target::Ssh(conn) => {
            // Exec rides the data lane (second SSH connection) so
            // chunky command output (git diffs, finders) can't congest the
            // terminals on the interactive lane (docs/connections.md
            // Phase 1). Falls back to the interactive lane if the dial fails.
            let conn = match state.app.get() {
                Some(app) => conn.data_lane(app).await,
                None => conn,
            };
            // SSH exec runs a non-login shell whose PATH often misses
            // `~/.cargo/bin` etc. — exactly where jj lives. Substitute the
            // probed absolute path (cached per connection) so jj detection
            // doesn't silently fall back to git on remotes/WSL.
            if argv.first().copied() == Some("jj") {
                let cached = state.jj_paths.lock().await.get(conn_id).cloned();
                let resolved = match cached {
                    Some(r) => r,
                    None => {
                        let found = probe_jj(&conn).await;
                        state
                            .jj_paths
                            .lock()
                            .await
                            .insert(conn_id.to_string(), found.clone());
                        found
                    }
                };
                if let Some(path) = resolved {
                    let owned: Vec<String> = std::iter::once(path)
                        .chain(argv[1..].iter().map(|s| s.to_string()))
                        .collect();
                    let refs: Vec<&str> = owned.iter().map(String::as_str).collect();
                    return run_ssh(&conn, cwd, &refs).await;
                }
                // Not found anywhere: run as-is; the 127 makes detection fall
                // back to git exactly as before. (Re-probed on reconnect.)
            }
            run_ssh(&conn, cwd, argv).await
        }
        Target::Local => run_local(cwd, argv).await,
    }
}

/// Locate `jj` on an SSH host: default PATH first, then the common install
/// dirs, then a login shell (whose profile may extend PATH further).
async fn probe_jj(conn: &Connection) -> Option<String> {
    const PROBE: &str = concat!(
        "if command -v jj >/dev/null 2>&1; then command -v jj; ",
        "elif [ -x \"$HOME/.cargo/bin/jj\" ]; then echo \"$HOME/.cargo/bin/jj\"; ",
        "elif [ -x \"$HOME/.local/bin/jj\" ]; then echo \"$HOME/.local/bin/jj\"; ",
        "elif [ -x /usr/local/bin/jj ]; then echo /usr/local/bin/jj; ",
        "else bash -lc 'command -v jj' 2>/dev/null; fi",
    );
    let out = exec_ssh(conn, PROBE).await.ok()?;
    pick_jj_path(&out.stdout)
}

/// Pull the jj path out of probe output (login shells can print motd noise).
fn pick_jj_path(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| l.starts_with('/') && l.ends_with("/jj"))
        .map(String::from)
}

async fn run_ssh(conn: &Connection, cwd: &str, argv: &[&str]) -> Result<CmdOutput, String> {
    let quoted: Vec<String> = argv.iter().map(|a| shell_quote(a)).collect();
    // `cd` into the dir, force a stable locale, then run the command.
    let command = format!("cd {} && LC_ALL=C {}", shell_quote(cwd), quoted.join(" "));
    exec_ssh(conn, &command).await
}

/// Run a raw shell command over an SSH exec channel and collect its output.
async fn exec_ssh(conn: &Connection, command: &str) -> Result<CmdOutput, String> {
    use russh::ChannelMsg;

    let mut channel = conn.open_channel().await?;
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
        // If the awaiting future is dropped (op cancelled), kill the child
        // instead of leaving it running detached.
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| format!("could not run {bin}: {e}"))?;
    Ok(CmdOutput {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        code: output.status.code().unwrap_or(-1),
    })
}

#[cfg(test)]
mod tests {
    use super::pick_jj_path;

    #[test]
    fn picks_jj_path_from_probe_output() {
        assert_eq!(
            pick_jj_path("/home/felix/.cargo/bin/jj\n"),
            Some("/home/felix/.cargo/bin/jj".to_string())
        );
        // Login-shell noise (motd) before the real answer.
        assert_eq!(
            pick_jj_path("Welcome to Ubuntu!\n * docs: https://x\n/usr/local/bin/jj\n"),
            Some("/usr/local/bin/jj".to_string())
        );
        assert_eq!(pick_jj_path(""), None);
        assert_eq!(pick_jj_path("bash: jj: command not found\n"), None);
    }
}
