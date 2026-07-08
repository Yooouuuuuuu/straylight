//! Listening-port detection for the Ports panel. Runs the host's native
//! tooling — `ss`/`netstat` on unix-ish hosts (remote/WSL), PowerShell's
//! `Get-NetTCPConnection` on local Windows — and normalizes to one shape.
//! Polled by the frontend only while the Ports tab is open.

use tauri::State;

use crate::exec::run_command;
use crate::AppState;

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    pub port: u16,
    pub address: String,
    pub pid: Option<u32>,
    pub process: Option<String>,
}

/// `127.0.0.1:8000` / `[::]:22` / `0.0.0.0:22` → (address, port)
fn split_addr(s: &str) -> Option<(String, u16)> {
    let i = s.rfind(':')?;
    let port = s[i + 1..].parse().ok()?;
    let addr = s[..i].trim_start_matches('[').trim_end_matches(']');
    Some((addr.to_string(), port))
}

/// ss -tlnp line: `LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=123,fd=3))`
fn parse_ss_line(line: &str) -> Option<PortInfo> {
    let cols: Vec<&str> = line.split_whitespace().collect();
    if cols.first() != Some(&"LISTEN") || cols.len() < 4 {
        return None;
    }
    let (address, port) = split_addr(cols[3])?;
    let mut pid = None;
    let mut process = None;
    if let Some(users) = cols.get(5..).map(|r| r.join(" ")) {
        if let Some(name_start) = users.find("((\"") {
            let rest = &users[name_start + 3..];
            if let Some(end) = rest.find('"') {
                process = Some(rest[..end].to_string());
            }
        }
        if let Some(p) = users.find("pid=") {
            let rest = &users[p + 4..];
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            pid = digits.parse().ok();
        }
    }
    Some(PortInfo { port, address, pid, process })
}

/// netstat -tlnp line: `tcp 0 0 0.0.0.0:22 0.0.0.0:* LISTEN 123/sshd`
fn parse_netstat_line(line: &str) -> Option<PortInfo> {
    let cols: Vec<&str> = line.split_whitespace().collect();
    if !line.starts_with("tcp") || !cols.contains(&"LISTEN") || cols.len() < 4 {
        return None;
    }
    let (address, port) = split_addr(cols[3])?;
    let mut pid = None;
    let mut process = None;
    if let Some(last) = cols.last() {
        if let Some((p, name)) = last.split_once('/') {
            pid = p.parse().ok();
            process = Some(name.to_string());
        }
    }
    Some(PortInfo { port, address, pid, process })
}

/// Our PowerShell line: `address|port|pid|name`
fn parse_ps_line(line: &str) -> Option<PortInfo> {
    let mut it = line.trim().split('|');
    let address = it.next()?.to_string();
    let port = it.next()?.parse().ok()?;
    let pid = it.next().and_then(|p| p.parse().ok());
    let process = it.next().filter(|s| !s.is_empty()).map(String::from);
    if address.is_empty() {
        return None;
    }
    Some(PortInfo { port, address, pid, process })
}

fn dedup(mut ports: Vec<PortInfo>) -> Vec<PortInfo> {
    ports.sort_by_key(|p| (p.port, p.address.clone()));
    ports.dedup_by(|a, b| a.port == b.port && a.address == b.address);
    ports
}

const PS_SCRIPT: &str = "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.LocalAddress,$_.LocalPort,$_.OwningProcess,((Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName) }";

#[tauri::command]
pub async fn port_list(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<Vec<PortInfo>, String> {
    // unix-ish first (remote/WSL), then Windows PowerShell (local).
    if let Ok(out) = run_command(&state, &conn_id, ".", &["ss", "-tlnp"]).await {
        if out.code == 0 {
            return Ok(dedup(out.stdout.lines().filter_map(parse_ss_line).collect()));
        }
    }
    if let Ok(out) = run_command(&state, &conn_id, ".", &["netstat", "-tlnp"]).await {
        if out.code == 0 && out.stdout.contains("LISTEN") {
            return Ok(dedup(
                out.stdout.lines().filter_map(parse_netstat_line).collect(),
            ));
        }
    }
    let out = run_command(
        &state,
        &conn_id,
        ".",
        &["powershell", "-NoProfile", "-Command", PS_SCRIPT],
    )
    .await?;
    Ok(dedup(out.stdout.lines().filter_map(parse_ps_line).collect()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ss() {
        let p = parse_ss_line(
            r#"LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=123,fd=3))"#,
        )
        .unwrap();
        assert_eq!((p.port, p.address.as_str()), (22, "0.0.0.0"));
        assert_eq!((p.pid, p.process.as_deref()), (Some(123), Some("sshd")));
    }

    #[test]
    fn parses_netstat() {
        let p = parse_netstat_line("tcp 0 0 127.0.0.1:8000 0.0.0.0:* LISTEN 55/python3").unwrap();
        assert_eq!((p.port, p.pid), (8000, Some(55)));
        assert_eq!(p.process.as_deref(), Some("python3"));
    }

    #[test]
    fn parses_powershell() {
        let p = parse_ps_line("0.0.0.0|3000|412|node").unwrap();
        assert_eq!((p.port, p.process.as_deref()), (3000, Some("node")));
    }
}
