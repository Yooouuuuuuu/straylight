//! WSL integration: enumerate installed distros for the sidebar's WSL section,
//! provision an `sshd` inside a distro on connect (consent-gated, via `wsl.exe
//! -u root`), and attach it as a `localhost` SSH host, reusing the SSH
//! transport — see `docs/wsl-connection.md`.

use std::path::PathBuf;

use serde::Serialize;

/// One installed WSL distribution.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslDistro {
    pub name: String,
    /// The distro a bare `wsl` targets (marked with `*` by `wsl -l -v`).
    pub is_default: bool,
    pub running: bool,
}

/// Container-runtime backends that masquerade as distros — never user envs.
#[cfg(windows)]
fn is_system_distro(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.starts_with("docker-desktop")
        || n.starts_with("rancher-desktop")
        || n.starts_with("podman")
}

/// `wsl.exe` prints management output as UTF-16LE, usually with a BOM.
#[cfg(windows)]
fn decode_wsl(bytes: &[u8]) -> String {
    let utf16: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&utf16)
}

#[cfg(windows)]
fn clean(line: &str) -> String {
    line.trim_matches(|c: char| c == '\0' || c == '\u{feff}')
        .trim()
        .to_string()
}

/// Names of currently-running distros (`wsl -l --running -q` is name-only, so
/// it's locale-independent — unlike the STATE column of `wsl -l -v`).
#[cfg(windows)]
fn running_distros() -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    let out = std::process::Command::new("wsl.exe")
        .args(["--list", "--running", "--quiet"])
        .output();
    if let Ok(out) = out {
        if out.status.success() {
            let text = decode_wsl(&out.stdout);
            for line in text.trim_start_matches('\u{feff}').lines() {
                let name = clean(line);
                if !name.is_empty() {
                    set.insert(name);
                }
            }
        }
    }
    set
}

#[cfg(windows)]
fn list_distros() -> Vec<WslDistro> {
    let out = std::process::Command::new("wsl.exe")
        .args(["--list", "--verbose"])
        .output();
    let Ok(out) = out else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let running = running_distros();
    let text = decode_wsl(&out.stdout);
    let mut distros = Vec::new();
    for line in text.trim_start_matches('\u{feff}').lines() {
        let line = clean(line);
        if line.is_empty() {
            continue;
        }
        let is_default = line.starts_with('*');
        let rest = line.trim_start_matches('*').trim();
        let tokens: Vec<&str> = rest.split_whitespace().collect();
        // Data rows are `NAME STATE VERSION`; the (localized) header row is
        // skipped because its last column ("VERSION"/translated) isn't a number.
        if tokens.len() < 3 || tokens[tokens.len() - 1].parse::<u8>().is_err() {
            continue;
        }
        let name = tokens[0].to_string();
        if is_system_distro(&name) {
            continue;
        }
        distros.push(WslDistro {
            running: running.contains(&name),
            is_default,
            name,
        });
    }
    distros
}

#[cfg(not(windows))]
fn list_distros() -> Vec<WslDistro> {
    Vec::new()
}

/// Enumerate installed WSL distros. Bounded by a timeout so a hung or updating
/// WSL never blocks the UI — on timeout we just report none.
#[tauri::command]
pub async fn wsl_list_distros() -> Result<Vec<WslDistro>, String> {
    let task = tokio::task::spawn_blocking(list_distros);
    match tokio::time::timeout(std::time::Duration::from_secs(5), task).await {
        Ok(Ok(distros)) => Ok(distros),
        Ok(Err(e)) => Err(format!("could not list WSL distros: {e}")),
        Err(_) => Err("timed out listing WSL distros".into()),
    }
}

// ---------------------------------------------------------------------------
// Provisioning + connect (see docs/wsl-connection.md)
// ---------------------------------------------------------------------------

/// Prefix the frontend recognizes to switch to the "install OpenSSH?" prompt.
pub const NEEDS_INSTALL: &str = "WSL_NEEDS_INSTALL:";

/// Run a one-line script inside a distro. Output of a *command* (unlike the
/// management subcommands) is the program's own bytes — UTF-8 for our tools.
#[cfg(windows)]
fn wsl_exec(distro: &str, as_root: bool, script: &str) -> Result<String, String> {
    use base64::Engine as _;
    // Deliver the script base64-encoded and decode it inside the distro. The
    // wrapper command is pure alphanumerics, so nothing in the real script
    // (nested quotes, $(), redirections) can be mangled by wsl.exe's own
    // command-line quoting on the way in.
    let b64 = base64::engine::general_purpose::STANDARD.encode(script.as_bytes());
    let wrapped = format!("echo '{b64}' | base64 -d | bash");
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.arg("-d").arg(distro);
    if as_root {
        cmd.arg("-u").arg("root");
    }
    cmd.arg("--").arg("bash").arg("-c").arg(wrapped);
    let out = cmd.output().map_err(|e| format!("wsl.exe failed: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if out.status.success() {
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        Err(if stderr.trim().is_empty() {
            stdout
        } else {
            stderr.trim().to_string()
        })
    }
}

/// The distro's default login user (runs as that user, so locale-independent).
#[cfg(windows)]
fn default_user(distro: &str) -> Result<String, String> {
    let user = wsl_exec(distro, false, "whoami")?.trim().to_string();
    if user.is_empty() {
        Err("could not determine the WSL login user".into())
    } else {
        Ok(user)
    }
}

#[cfg(windows)]
fn sshd_installed(distro: &str) -> bool {
    wsl_exec(distro, true, "test -x /usr/sbin/sshd").is_ok()
}

#[cfg(windows)]
fn install_sshd(distro: &str) -> Result<(), String> {
    if wsl_exec(distro, true, "command -v apt-get >/dev/null 2>&1").is_err() {
        return Err("Auto-install supports apt-based distros (Ubuntu/Debian). \
                    Install openssh-server in this distro manually."
            .into());
    }
    wsl_exec(
        distro,
        true,
        "export DEBIAN_FRONTEND=noninteractive; apt-get update -y && apt-get install -y openssh-server",
    )
    .map(|_| ())
    .map_err(|e| format!("could not install openssh-server: {e}"))
}

/// Config-dir paths for the shared Straylight WSL key.
fn key_paths() -> Result<(PathBuf, PathBuf), String> {
    let dirs = directories::ProjectDirs::from("dev", "straylight", "Straylight")
        .ok_or("could not resolve a config directory")?;
    let dir = dirs.config_dir().to_path_buf();
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create config dir: {e}"))?;
    Ok((dir.join("wsl_id_ed25519"), dir.join("wsl_id_ed25519.pub")))
}

/// Ensure a Straylight key exists; returns (private-key path, public-key line).
/// Generated once via the distro's `ssh-keygen` and carried out to the config
/// dir (OpenSSH format, which `russh_keys::load_secret_key` reads back).
#[cfg(windows)]
fn ensure_key(distro: &str) -> Result<PathBuf, String> {
    use base64::Engine as _;
    let (priv_path, _pub_path) = key_paths()?;
    // Reuse the key only if it still loads with the connection's own loader;
    // otherwise discard and regenerate (self-healing). The public key is derived
    // from this exact private key at provision time, so it can never drift.
    if priv_path.exists() && russh_keys::load_secret_key(&priv_path, None).is_ok() {
        return Ok(priv_path);
    }
    let _ = std::fs::remove_file(&priv_path);
    // Generate inside the distro and carry the private key out **base64**-encoded
    // so no newline translation can corrupt it.
    let out = wsl_exec(
        distro,
        true,
        "rm -f /tmp/sl_key /tmp/sl_key.pub && ssh-keygen -t ed25519 -N '' -C straylight-wsl \
         -f /tmp/sl_key -q && base64 -w0 /tmp/sl_key && rm -f /tmp/sl_key /tmp/sl_key.pub",
    )?;
    let b64 = out.lines().next().unwrap_or("").trim();
    if b64.is_empty() {
        return Err("WSL key generation produced no output".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("could not decode the generated key: {e}"))?;
    std::fs::write(&priv_path, &bytes).map_err(|e| e.to_string())?;
    // Fail loudly here if the key still won't load, rather than later as an
    // opaque "no usable key" auth error.
    russh_keys::load_secret_key(&priv_path, None)
        .map_err(|e| format!("the generated WSL key could not be loaded: {e}"))?;
    Ok(priv_path)
}

/// Pre-connect probe: does the distro's deterministic ssh port accept TCP?
/// True means sshd is already up — a connect would be instant. Cheap (~400 ms
/// cap), run by the WSL section for its per-distro readiness lights.
#[tauri::command]
pub async fn wsl_probe_ssh(distro: String) -> Result<bool, String> {
    let addr = format!("127.0.0.1:{}", port_for(&distro));
    Ok(matches!(
        tokio::time::timeout(
            std::time::Duration::from_millis(400),
            tokio::net::TcpStream::connect(&addr),
        )
        .await,
        Ok(Ok(_))
    ))
}

/// A stable localhost port per distro (WSL2 shares one network namespace, so
/// distros must not collide; the same distro reuses its port on reconnect).
fn port_for(distro: &str) -> u16 {
    let mut h: u32 = 2166136261;
    for b in distro.bytes() {
        h = (h ^ b as u32).wrapping_mul(16777619);
    }
    49152 + (h % (65535 - 49152)) as u16
}

/// Authorize our key for the user and (re)start `sshd` on `port`, bound to
/// loopback, key-auth only. The public key is derived from the *exact* private
/// key inside the distro (`ssh-keygen -y`), so `authorized_keys` can never drift
/// out of sync with what we offer. `StrictModes=no` keeps file-permission
/// strictness from rejecting the key on a loopback, key-only daemon.
#[cfg(windows)]
fn provision(distro: &str, user: &str, priv_path: &PathBuf, port: u16) -> Result<(), String> {
    use base64::Engine as _;
    let priv_b64 = base64::engine::general_purpose::STANDARD
        .encode(std::fs::read(priv_path).map_err(|e| e.to_string())?);
    let script = format!(
        "set -e; mkdir -p /run/sshd; \
         [ -f /etc/ssh/ssh_host_ed25519_key ] || ssh-keygen -A >/dev/null 2>&1 || true; \
         echo '{priv_b64}' | base64 -d > /tmp/sl_auth && chmod 600 /tmp/sl_auth; \
         PUB=$(ssh-keygen -y -f /tmp/sl_auth); rm -f /tmp/sl_auth; \
         HOME_DIR=$(getent passwd '{user}' | cut -d: -f6); [ -n \"$HOME_DIR\" ] || HOME_DIR=/home/{user}; \
         install -d -m 700 -o '{user}' \"$HOME_DIR/.ssh\"; \
         touch \"$HOME_DIR/.ssh/authorized_keys\"; \
         grep -qxF \"$PUB\" \"$HOME_DIR/.ssh/authorized_keys\" || echo \"$PUB\" >> \"$HOME_DIR/.ssh/authorized_keys\"; \
         chmod 600 \"$HOME_DIR/.ssh/authorized_keys\"; chown '{user}' \"$HOME_DIR/.ssh/authorized_keys\"; \
         pkill -f \"sshd.*Port={port}\" 2>/dev/null || true; \
         sleep 0.5; \
         /usr/sbin/sshd -o ListenAddress=127.0.0.1 -o Port={port} -o StrictModes=no -o PasswordAuthentication=no -o PubkeyAuthentication=yes"
    );
    wsl_exec(distro, true, &script).map(|_| ())
}

/// What `wsl_connect` hands back: the connection id plus the login user (the
/// UI labels the distro `user@distro`).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslConnection {
    pub conn_id: String,
    pub user: String,
}

/// Connect to a WSL distro: provision an `sshd` inside it, then attach as a
/// `localhost` SSH host via the existing transport. Returns the connection id.
#[cfg(windows)]
#[tauri::command]
pub async fn wsl_connect(
    state: tauri::State<'_, crate::AppState>,
    app: tauri::AppHandle,
    distro: String,
    allow_install: bool,
) -> Result<WslConnection, String> {
    let provisioned = {
        let distro = distro.clone();
        tokio::task::spawn_blocking(move || -> Result<(String, u16, PathBuf), String> {
            let user = default_user(&distro)?;
            if !sshd_installed(&distro) {
                if !allow_install {
                    return Err(format!("{NEEDS_INSTALL}{distro}"));
                }
                install_sshd(&distro)?;
            }
            let key_path = ensure_key(&distro)?;
            let port = port_for(&distro);
            provision(&distro, &user, &key_path, port)?;
            Ok((user, port, key_path))
        })
        .await
        .map_err(|e| e.to_string())??
    };
    let (user, port, key_path) = provisioned;
    let auth = crate::ssh::connection::AuthMethod::Auto {
        identity_file: Some(key_path.to_string_lossy().into_owned()),
        passphrase: None,
    };
    let conn_id = crate::ssh::connection::ssh_connect(
        state,
        app,
        "127.0.0.1".to_string(),
        port,
        user.clone(),
        auth,
        None,
    )
    .await?;
    Ok(WslConnection { conn_id, user })
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn wsl_connect(_distro: String, _allow_install: bool) -> Result<WslConnection, String> {
    Err("WSL is only available on Windows".into())
}
