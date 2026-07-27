//! Standalone SFTP read-throughput bench against a live sshd — reproduces the
//! app's transfer read path with every knob exposed, so the 7 MB/s mystery can
//! be bisected without the app in the loop.
//!
//! Usage (PowerShell):
//!   cargo run --release --example sftp_bench -- `
//!     127.0.0.1 57191 yooouuuuuuu `
//!     $env:APPDATA\straylight\Straylight\config\wsl_id_ed25519 /tmp/big.bin
//!
//! Optional trailing args: window_bytes depth req_len total_mb
//! (defaults: 16 MiB, 32, 261120, 64)

use std::sync::Arc;
use std::time::Instant;

use russh::client;
use russh_sftp::client::RawSftpSession;

struct AcceptAll;

impl client::Handler for AcceptAll {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let host = args.get(1).map(String::as_str).unwrap_or("127.0.0.1");
    let port: u16 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(57191);
    let user = args.get(3).map(String::as_str).unwrap_or("yooouuuuuuu");
    let key_path = args
        .get(4)
        .cloned()
        .unwrap_or_else(|| format!("{}/straylight/Straylight/config/wsl_id_ed25519",
            std::env::var("APPDATA").unwrap_or_default()));
    let file = args.get(5).map(String::as_str).unwrap_or("/tmp/big.bin");
    let window: u32 = args.get(6).and_then(|s| s.parse().ok()).unwrap_or(16 * 1024 * 1024);
    let depth: usize = args.get(7).and_then(|s| s.parse().ok()).unwrap_or(32);
    let req_len: u32 = args.get(8).and_then(|s| s.parse().ok()).unwrap_or(261_120);
    let total_mb: u64 = args.get(9).and_then(|s| s.parse().ok()).unwrap_or(64);

    println!(
        "bench: {user}@{host}:{port} {file} | window {window} depth {depth} req {req_len} total {total_mb} MB"
    );

    let config = Arc::new(client::Config {
        window_size: window,
        maximum_packet_size: 32768,
        preferred: russh::Preferred {
            compression: std::borrow::Cow::Borrowed(&[russh::compression::NONE]),
            ..Default::default()
        },
        ..Default::default()
    });

    let socket = tokio::net::TcpStream::connect((host, port)).await.expect("tcp connect");
    socket.set_nodelay(true).ok();
    let mut handle = client::connect_stream(config, socket, AcceptAll)
        .await
        .expect("ssh connect");

    let key = russh::keys::load_secret_key(&key_path, None).expect("load key");
    let hash = handle
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .flatten();
    let ok = handle
        .authenticate_publickey(
            user,
            russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash),
        )
        .await
        .expect("auth call");
    assert!(ok.success(), "auth rejected");
    println!("authenticated");

    let channel = handle.channel_open_session().await.expect("channel");
    channel
        .request_subsystem(true, "sftp")
        .await
        .expect("sftp subsystem");
    let mut raw = RawSftpSession::new(channel.into_stream());
    raw.init().await.expect("sftp init");
    if let Ok(ext) = raw.limits().await {
        println!(
            "server limits: read {:?} write {:?} packet {:?}",
            ext.max_read_len, ext.max_write_len, ext.max_packet_len
        );
        raw.set_limits(russh_sftp::client::rawsession::Limits::from(ext));
    }
    let raw = Arc::new(raw);

    let handle_str = raw
        .open(
            file.to_string(),
            russh_sftp::protocol::OpenFlags::READ,
            russh_sftp::protocol::FileAttributes::default(),
        )
        .await
        .expect("open")
        .handle;

    let total_bytes = total_mb * 1024 * 1024;
    let t0 = Instant::now();
    let mut join = tokio::task::JoinSet::new();
    let mut next = 0u64;
    let mut done = 0u64;
    let mut completions = 0u64;
    let mut first_start: Option<Instant> = None;

    loop {
        while join.len() < depth && next < total_bytes {
            let raw2 = raw.clone();
            let h = handle_str.clone();
            let off = next;
            let seq = completions + join.len() as u64;
            join.spawn(async move {
                let t = Instant::now();
                let r = raw2.read(h, off, req_len).await;
                (seq, off, t.elapsed(), r)
            });
            next += u64::from(req_len);
        }
        if join.is_empty() {
            break;
        }
        let Some(Ok((seq, _off, lat, result))) = join.join_next().await else {
            break;
        };
        first_start.get_or_insert_with(Instant::now);
        match result {
            Ok(data) => done += data.data.len() as u64,
            Err(e) => {
                println!("read error: {e}");
                break;
            }
        }
        completions += 1;
        if seq < 40 {
            println!("req#{seq} latency {:.1} ms", lat.as_secs_f64() * 1000.0);
        }
        if completions % 64 == 0 {
            let secs = t0.elapsed().as_secs_f64();
            println!(
                "{completions} reads, {:.1} MB, {:.1} MB/s",
                done as f64 / 1e6,
                done as f64 / 1e6 / secs
            );
        }
    }
    let secs = t0.elapsed().as_secs_f64();
    println!(
        "TOTAL: {:.1} MB in {:.2}s = {:.1} MB/s (window {window}, depth {depth}, req {req_len})",
        done as f64 / 1e6,
        secs,
        done as f64 / 1e6 / secs
    );
    let _ = raw.close(handle_str).await;
}
