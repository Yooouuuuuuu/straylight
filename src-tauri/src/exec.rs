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
        Target::Ssh(conn) => run_ssh(&conn, cwd, argv).await,
        Target::Local => run_local(cwd, argv).await,
    }
}

async fn run_ssh(conn: &Connection, cwd: &str, argv: &[&str]) -> Result<CmdOutput, String> {
    use russh::ChannelMsg;

    let mut channel = conn.open_channel().await?;
    let quoted: Vec<String> = argv.iter().map(|a| shell_quote(a)).collect();
    // `cd` into the dir, force a stable locale, then run the command.
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
