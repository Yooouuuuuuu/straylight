//! Diagram-language rendering (D2 first): pipe a source buffer into the
//! HOST's own renderer binary and get SVG back — the git/jj doctrine applied
//! to diagram languages. Nothing is bundled or installed by us (the official
//! D2 WASM alone unpacks to ~57 MB against our whole ~8.5 MB installer); the
//! tool is probed per host like jj (exec.rs) and the found path cached. A
//! missing tool is a friendly state, not an error. One-shot processes only —
//! the render-server modes other editors use are rejected: they either ship
//! source off-host or park a resident process ("no remote agent").

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::exec::{exec_ssh, shell_quote, CmdOutput};
use crate::ssh::connection::Connection;
use crate::{AppState, Session};

/// What the preview needs. When the tool ran, exactly one of `svg` / `error`
/// is set; `missing` means "not installed on this host" — the UI shows the
/// install hint, never an error state.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramRender {
    pub svg: Option<String>,
    pub error: Option<String>,
    pub missing: bool,
}

fn missing() -> DiagramRender {
    DiagramRender { svg: None, error: None, missing: true }
}

fn outcome(out: CmdOutput) -> DiagramRender {
    if out.code == 0 && !out.stdout.is_empty() {
        DiagramRender { svg: Some(out.stdout), error: None, missing: false }
    } else {
        let err = out.stderr.trim();
        DiagramRender {
            svg: None,
            error: Some(if err.is_empty() {
                format!("renderer exited with code {}", out.code)
            } else {
                err.to_string()
            }),
            missing: false,
        }
    }
}

/// The renderer allowlist: tool name → (probe script, argv after the binary).
/// The frontend can only NAME a tool from this table — argv is decided here,
/// never accepted from the caller.
fn tool_spec(tool: &str) -> Option<(&'static str, &'static [&'static str])> {
    match tool {
        // `d2 - -`: source on stdin → SVG on stdout. The command runs with
        // cwd = the file's directory so relative imports (`...@lib.d2`)
        // resolve exactly as the CLI run by hand would.
        "d2" => Some((D2_PROBE, &["-", "-"])),
        _ => None,
    }
}

/// Multi-board fallback (d2): a file with `layers`/`scenarios`/`steps`
/// refuses single-SVG stdout ("multiboard output cannot be written to
/// stdout"). d2 WILL render the whole set as ONE animated SVG — but only to
/// a real `.svg` path — so the retry goes through a throwaway file in the
/// HOST's temp dir (never a user directory — the no-repo-pollution promise
/// is about their trees), written, read back, and removed.
const ANIMATE_INTERVAL_MS: &str = "1200";

fn is_multiboard_refusal(out: &CmdOutput) -> bool {
    out.code != 0 && out.stderr.contains("multiboard")
}

/// Locate `d2` on an SSH host, same shape as the jj probe: default PATH,
/// then the official installer's default (`~/.local/bin`) and the other
/// standard homes, then a login shell whose profile may extend PATH — the
/// contract is "if it runs in your terminal, the preview finds it".
const D2_PROBE: &str = concat!(
    "if command -v d2 >/dev/null 2>&1; then command -v d2; ",
    "elif [ -x \"$HOME/.local/bin/d2\" ]; then echo \"$HOME/.local/bin/d2\"; ",
    "elif [ -x /usr/local/bin/d2 ]; then echo /usr/local/bin/d2; ",
    "elif [ -x \"$HOME/go/bin/d2\" ]; then echo \"$HOME/go/bin/d2\"; ",
    "elif [ -x /opt/homebrew/bin/d2 ]; then echo /opt/homebrew/bin/d2; ",
    "else bash -lc 'command -v d2' 2>/dev/null; fi",
);

/// Pull the tool's path out of probe output (login shells can print motd
/// noise before the answer).
fn pick_tool_path(stdout: &str, tool: &str) -> Option<String> {
    let suffix = format!("/{tool}");
    stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| l.starts_with('/') && l.ends_with(suffix.as_str()))
        .map(String::from)
}

/// Render `source` with `tool` on the host behind `conn_id`, cwd `dir` (the
/// source file's directory — imports resolve against it). The live editor
/// buffer streams in over stdin: no temp files on the host, no repo
/// pollution, unsaved edits render.
#[tauri::command]
pub async fn render_diagram(
    state: State<'_, AppState>,
    conn_id: String,
    tool: String,
    dir: String,
    source: String,
) -> Result<DiagramRender, String> {
    let Some((probe, args)) = tool_spec(&tool) else {
        return Err(format!("unknown diagram tool '{tool}'"));
    };

    enum Target {
        Ssh(Arc<Connection>),
        Local,
    }
    let target = {
        let sessions = state.sessions.lock().await;
        match sessions.get(&conn_id) {
            Some(Session::Ssh(conn)) => Target::Ssh(conn.clone()),
            Some(Session::Local) => Target::Local,
            None => return Err(format!("session '{conn_id}' is not open")),
        }
    };

    match target {
        Target::Ssh(conn) => {
            // Renders ride the data lane like every exec — chunky SVG output
            // must not congest the interactive terminals.
            let conn = match state.app.get() {
                Some(app) => conn.data_lane(app).await,
                None => conn,
            };
            // Cached probe. A MISS is deliberately not cached: installing the
            // tool mid-session is picked up by the very next render, instead
            // of staying "missing" until reconnect.
            let key = format!("{conn_id}:{tool}");
            let cached = state.tool_paths.lock().await.get(&key).cloned();
            let path = match cached {
                Some(p) => Some(p),
                None => {
                    let out = exec_ssh(&conn, probe).await?;
                    let found = pick_tool_path(&out.stdout, &tool);
                    if let Some(ref p) = found {
                        state.tool_paths.lock().await.insert(key, p.clone());
                    }
                    found
                }
            };
            let Some(path) = path else {
                return Ok(missing());
            };
            let mut argv: Vec<&str> = vec![path.as_str()];
            argv.extend_from_slice(args);
            let quoted: Vec<String> = argv.iter().map(|a| shell_quote(a)).collect();
            let command = format!(
                "cd {} && LC_ALL=C {}",
                shell_quote(&dir),
                quoted.join(" ")
            );
            let out = exec_ssh_stdin(&conn, &command, source.as_bytes()).await?;
            if tool == "d2" && is_multiboard_refusal(&out) {
                // One-shot temp-file round trip (see ANIMATE_INTERVAL_MS):
                // mktemp's template can't carry an extension, and d2 infers
                // the format from one — hence the `$t.svg` sibling.
                let animate = format!(
                    "cd {dir} && t=$(mktemp) && s=\"$t.svg\" && \
                     LC_ALL=C {d2} --animate-interval {ms} - \"$s\"; c=$?; \
                     [ -s \"$s\" ] && cat \"$s\"; rm -f -- \"$t\" \"$s\"; exit $c",
                    dir = shell_quote(&dir),
                    d2 = shell_quote(&path),
                    ms = ANIMATE_INTERVAL_MS,
                );
                let out = exec_ssh_stdin(&conn, &animate, source.as_bytes()).await?;
                return Ok(outcome(out));
            }
            Ok(outcome(out))
        }
        Target::Local => {
            // PATH does the probing locally (winget/scoop/choco all put the
            // binary there); a spawn-not-found IS the missing signal.
            let mut argv: Vec<&str> = vec![tool.as_str()];
            argv.extend_from_slice(args);
            match run_local_stdin(&dir, &argv, source.as_bytes()).await {
                Ok(out) => {
                    if tool == "d2" && is_multiboard_refusal(&out) {
                        return render_local_animated(&tool, &dir, &source).await;
                    }
                    Ok(outcome(out))
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(missing()),
                Err(e) => Err(format!("could not run {tool}: {e}")),
            }
        }
    }
}

/// Like `exec_ssh`, but writes `input` to the command's stdin (then EOF)
/// before collecting output. Fine for renderer-sized inputs: the tool parses
/// its whole input before emitting output, so write-then-read can't deadlock.
async fn exec_ssh_stdin(
    conn: &Connection,
    command: &str,
    input: &[u8],
) -> Result<CmdOutput, String> {
    use russh::ChannelMsg;
    use std::time::Duration;

    let mut channel = conn.open_channel("exec").await?;
    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|e| format!("could not start command: {e}"))?; // guard closes on ?
    if channel.data(input).await.is_err() {
        return Err("could not write to the command's stdin".into());
    }
    let _ = channel.eof().await;

    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let mut code: Option<i32> = None;
    let mut saw_eof = false;
    loop {
        let msg = if saw_eof {
            match tokio::time::timeout(Duration::from_secs(5), channel.wait()).await {
                Ok(m) => m,
                Err(_) => break, // Eof but no Close in 5s — stop holding the channel
            }
        } else {
            channel.wait().await
        };
        match msg {
            Some(ChannelMsg::Data { data }) => stdout.extend_from_slice(&data),
            Some(ChannelMsg::ExtendedData { data, .. }) => stderr.extend_from_slice(&data),
            Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status as i32),
            Some(ChannelMsg::Eof) => saw_eof = true,
            Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    channel.close().await;
    Ok(CmdOutput {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        code: code.unwrap_or(-1),
    })
}

/// Local half of the multi-board fallback: render the animated SVG into a
/// temp-dir throwaway, read it back, delete it.
async fn render_local_animated(
    tool: &str,
    dir: &str,
    source: &str,
) -> Result<DiagramRender, String> {
    let tmp = std::env::temp_dir().join(format!("stray-d2-{}.svg", uuid::Uuid::new_v4()));
    let tmp_str = tmp.to_string_lossy().into_owned();
    let argv: Vec<&str> = vec![
        tool,
        "--animate-interval",
        ANIMATE_INTERVAL_MS,
        "-",
        tmp_str.as_str(),
    ];
    let render = match run_local_stdin(dir, &argv, source.as_bytes()).await {
        Ok(out) if out.code == 0 => match tokio::fs::read_to_string(&tmp).await {
            Ok(svg) => DiagramRender { svg: Some(svg), error: None, missing: false },
            Err(e) => DiagramRender {
                svg: None,
                error: Some(format!("could not read the render output: {e}")),
                missing: false,
            },
        },
        Ok(out) => outcome(out),
        Err(e) => DiagramRender {
            svg: None,
            error: Some(format!("could not run {tool}: {e}")),
            missing: false,
        },
    };
    let _ = tokio::fs::remove_file(&tmp).await;
    Ok(render)
}

/// Local process with piped stdin. `NotFound` from spawn = tool not
/// installed (the caller maps it to the friendly missing state).
async fn run_local_stdin(
    cwd: &str,
    argv: &[&str],
    input: &[u8],
) -> Result<CmdOutput, std::io::Error> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;

    let (bin, rest) = argv.split_first().expect("empty argv");
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(rest)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Windows: suppress the console flash (a GUI process spawning a console
    // program), same as run_local.
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd.spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(input).await?;
        stdin.shutdown().await?;
    } // dropping the handle sends EOF
    let output = child.wait_with_output().await?;
    Ok(CmdOutput {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        code: output.status.code().unwrap_or(-1),
    })
}

#[cfg(test)]
mod tests {
    use super::pick_tool_path;

    #[test]
    fn picks_tool_path_from_probe_output() {
        assert_eq!(
            pick_tool_path("/home/felix/.local/bin/d2\n", "d2"),
            Some("/home/felix/.local/bin/d2".to_string())
        );
        // Login-shell noise before the answer; last plausible line wins.
        assert_eq!(
            pick_tool_path("Welcome!\n/usr/local/bin/d2\n", "d2"),
            Some("/usr/local/bin/d2".to_string())
        );
        // `/x/d2d2` must not match `/d2`-suffix... (path-component check).
        assert_eq!(pick_tool_path("/usr/bin/dd2\n", "d2"), None);
        assert_eq!(pick_tool_path("", "d2"), None);
        assert_eq!(pick_tool_path("bash: d2: command not found\n", "d2"), None);
    }
}
