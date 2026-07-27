//! Rekey verification harness (docs/dev/russh-upgrade.md). Dials two lanes —
//! one offering zlib, one none — with a short `rekey_time_limit`, then probes
//! each on a timer the way the supervisor does. Used to prove the zlib+rekey
//! break (0.46: died at first rekey; 0.62: first channel_open stalls) and to
//! verify no-compression lanes survive strict-kex rekeys (12/12 on 0.62).
//! Usage: cargo run --example rekeytest -- <key> <user@host> [port] [rekey_secs] [run_secs]
//! Set RUST_LOG=russh=debug for the KEX detail.
use std::borrow::Cow;
use std::sync::Arc;
use std::time::{Duration, Instant};

use russh::client;
use russh::keys::PrivateKeyWithHashAlg;

struct H;

impl client::Handler for H {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _k: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true) // diagnostic only — host already trusted interactively
    }
}

fn cfg(compress: bool, rekey_secs: u64) -> Arc<client::Config> {
    Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 20,
        window_size: 2 * 1024 * 1024,
        limits: russh::Limits {
            rekey_write_limit: 1 << 30,
            rekey_read_limit: 1 << 30,
            rekey_time_limit: Duration::from_secs(rekey_secs),
        },
        preferred: russh::Preferred {
            compression: Cow::Borrowed(if compress {
                &[
                    russh::compression::ZLIB_LEGACY,
                    russh::compression::ZLIB,
                    russh::compression::NONE,
                ]
            } else {
                &[russh::compression::NONE]
            }),
            ..Default::default()
        },
        ..Default::default()
    })
}

async fn dial(
    compress: bool,
    rekey_secs: u64,
    key_path: &str,
    user: &str,
    host: &str,
    port: u16,
) -> Result<client::Handle<H>, String> {
    let key = russh::keys::load_secret_key(key_path, None).map_err(|e| format!("load: {e}"))?;
    let mut h = client::connect(cfg(compress, rekey_secs), (host, port), H)
        .await
        .map_err(|e| format!("connect: {e}"))?;
    let hash = h
        .best_supported_rsa_hash()
        .await
        .map_err(|e| format!("ext-info: {e}"))?
        .flatten();
    let auth = h
        .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
        .await
        .map_err(|e| format!("auth: {e}"))?;
    if !auth.success() {
        return Err("auth rejected".into());
    }
    Ok(h)
}

/// Open + close a session channel — the same liveness probe the supervisor uses.
async fn step(h: &Option<client::Handle<H>>, dead: &mut bool) -> String {
    if *dead {
        return "dead".into();
    }
    match h {
        Some(handle) => match handle.channel_open_session().await {
            Ok(ch) => {
                let _ = ch.close().await;
                "ok".into()
            }
            Err(e) => {
                *dead = true;
                format!("DEAD:{e:?}")
            }
        },
        None => "n/a".into(),
    }
}

#[tokio::main]
async fn main() {
    env_logger::init();
    let args: Vec<String> = std::env::args().collect();
    let key = &args[1];
    let (user, host) = args[2].split_once('@').expect("user@host");
    let port: u16 = args.get(3).and_then(|p| p.parse().ok()).unwrap_or(22);
    let rekey: u64 = args.get(4).and_then(|p| p.parse().ok()).unwrap_or(20);
    let run: u64 = args.get(5).and_then(|p| p.parse().ok()).unwrap_or(150);

    println!("rekey harness: rekey_time_limit={rekey}s keepalive=15s run={run}s");
    let mut zlib = match dial(true, rekey, key, user, host, port).await {
        Ok(h) => Some(h),
        Err(e) => {
            println!("zlib dial failed: {e}");
            None
        }
    };
    let mut none = match dial(false, rekey, key, user, host, port).await {
        Ok(h) => Some(h),
        Err(e) => {
            println!("none dial failed: {e}");
            None
        }
    };

    let start = Instant::now();
    let mut zlib_dead = false;
    let mut none_dead = false;
    loop {
        let t = start.elapsed().as_secs();
        if t > run {
            println!("[t={t}s] run complete");
            break;
        }
        let z = step(&zlib, &mut zlib_dead).await;
        let n = step(&none, &mut none_dead).await;
        println!("[t={t:>3}s] zlib={z}  none={n}");
        if (zlib.is_none() || zlib_dead) && (none.is_none() || none_dead) {
            println!("both lanes down — stopping");
            break;
        }
        if zlib_dead {
            zlib = None;
        }
        if none_dead {
            none = None;
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    println!(
        "VERDICT: zlib {}  none {}",
        if zlib_dead { "DIED" } else { "survived" },
        if none_dead { "DIED" } else { "survived" }
    );
}
