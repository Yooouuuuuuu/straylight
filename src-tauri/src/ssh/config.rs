//! Parsing of `~/.ssh/config`.
//!
//! `russh-config` resolves a *single* named host but cannot enumerate every
//! `Host` block, which is what the connection manager needs. We therefore parse
//! the file ourselves — a small, well-defined subset (Host / HostName / User /
//! Port / IdentityFile / ProxyJump) that covers the directives Straylight acts
//! on.

use std::path::PathBuf;

use serde::Serialize;

/// One `Host` entry resolved from `~/.ssh/config`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostEntry {
    /// The `Host` alias the user types (`ssh <name>`).
    pub name: String,
    pub host_name: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
}

fn config_file_path() -> Option<PathBuf> {
    directories::UserDirs::new().map(|dirs| dirs.home_dir().join(".ssh").join("config"))
}

fn home_dir() -> Option<PathBuf> {
    directories::UserDirs::new().map(|dirs| dirs.home_dir().to_path_buf())
}

/// List every concrete `Host` entry from the user's SSH config. Missing or
/// unreadable config is treated as "no hosts", never an error — the app must
/// start regardless.
#[tauri::command]
pub async fn ssh_list_config_hosts() -> Result<Vec<SshHostEntry>, String> {
    let Some(path) = config_file_path() else {
        return Ok(Vec::new());
    };
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Ok(Vec::new()),
    };
    Ok(parse_ssh_config(&content))
}

/// Ensure `~/.ssh/config` exists (creating it from a template if missing) and
/// return its absolute path, so the frontend can open it in the editor as a
/// local file.
#[tauri::command]
pub async fn ssh_config_path() -> Result<String, String> {
    let path =
        config_file_path().ok_or_else(|| "could not determine your home directory".to_string())?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if !path.exists() {
        let template = "# SSH config — add hosts here, for example:\n\
                        # Host myserver\n\
                        #     HostName 10.0.0.5\n\
                        #     User me\n\
                        #     Port 22\n";
        std::fs::write(&path, template)
            .map_err(|e| format!("could not create {}: {e}", path.display()))?;
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Split an SSH config line into `(key, value)`. Supports both
/// `Key value` and `Key=value` forms and strips surrounding quotes from the
/// value.
fn split_kv(line: &str) -> Option<(String, String)> {
    let (key, value) = if let Some(idx) = line.find(|c: char| c == ' ' || c == '\t' || c == '=') {
        let (k, rest) = line.split_at(idx);
        let rest = rest.trim_start_matches(|c: char| c == ' ' || c == '\t' || c == '=');
        (k, rest)
    } else {
        return None;
    };
    let value = value.trim().trim_matches('"').trim();
    if key.is_empty() || value.is_empty() {
        return None;
    }
    Some((key.to_lowercase(), value.to_string()))
}

fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    path.to_string()
}

/// Parse SSH config text into concrete host entries. Wildcard-only blocks
/// (`Host *`) are skipped since they describe defaults rather than a server the
/// user can pick.
pub fn parse_ssh_config(content: &str) -> Vec<SshHostEntry> {
    let mut entries: Vec<SshHostEntry> = Vec::new();
    let mut current: Option<SshHostEntry> = None;

    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = split_kv(line) else {
            continue;
        };

        if key == "host" {
            if let Some(entry) = current.take() {
                entries.push(entry);
            }
            // A `Host` line may list several patterns; pick the first concrete
            // (non-wildcard) alias. If it's wildcards only, skip the block.
            let alias = value
                .split_whitespace()
                .find(|p| !p.contains(|c: char| c == '*' || c == '?'));
            current = alias.map(|alias| SshHostEntry {
                name: alias.to_string(),
                host_name: None,
                user: None,
                port: None,
                identity_file: None,
                proxy_jump: None,
            });
        } else if let Some(entry) = current.as_mut() {
            match key.as_str() {
                "hostname" => entry.host_name = Some(value),
                "user" => entry.user = Some(value),
                "port" => entry.port = value.parse().ok(),
                // First IdentityFile wins, matching OpenSSH semantics.
                "identityfile" if entry.identity_file.is_none() => {
                    entry.identity_file = Some(expand_tilde(&value));
                }
                "proxyjump" => entry.proxy_jump = Some(value),
                _ => {}
            }
        }
    }
    if let Some(entry) = current.take() {
        entries.push(entry);
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_hosts() {
        let cfg = "\
# a comment
Host prod
    HostName 10.0.1.5
    User deploy
    Port 2222
    IdentityFile ~/.ssh/id_ed25519

Host bastion-target
    HostName 10.0.9.9
    ProxyJump jump@bastion.example.com:22

Host *
    ForwardAgent yes
";
        let hosts = parse_ssh_config(cfg);
        assert_eq!(hosts.len(), 2);

        assert_eq!(hosts[0].name, "prod");
        assert_eq!(hosts[0].host_name.as_deref(), Some("10.0.1.5"));
        assert_eq!(hosts[0].user.as_deref(), Some("deploy"));
        assert_eq!(hosts[0].port, Some(2222));
        assert!(hosts[0].identity_file.as_deref().unwrap().ends_with("id_ed25519"));

        assert_eq!(hosts[1].name, "bastion-target");
        assert_eq!(
            hosts[1].proxy_jump.as_deref(),
            Some("jump@bastion.example.com:22")
        );
    }

    #[test]
    fn handles_equals_form_and_quotes() {
        let cfg = "Host=myhost\nHostName=\"example.com\"\nUser = me\n";
        let hosts = parse_ssh_config(cfg);
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].name, "myhost");
        assert_eq!(hosts[0].host_name.as_deref(), Some("example.com"));
        assert_eq!(hosts[0].user.as_deref(), Some("me"));
    }
}
