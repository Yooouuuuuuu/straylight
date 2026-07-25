//! Deep-pipelined SFTP reads for transfers (T3 — docs/connections.md).
//!
//! russh_sftp's `File` issues ONE read request at a time, so every ~255 KB
//! chunk pays a full round trip — measured at ~37 ms through the WSL relay,
//! which capped a download leg at ~7 MB/s while scp (64 requests in flight)
//! moved 160 MB/s on the same route. This reader keeps a configurable count
//! of requests standing (Full: 32 ≈ 8 MiB) against a dedicated raw SFTP
//! session, reassembling completions into a strictly ordered byte stream.
//!
//! Robustness rules:
//! - The read grid is planned from the stat'd file size; a SHORT read before
//!   EOF (legal per spec, rare in practice) reschedules its remainder so the
//!   grid stays gapless.
//! - A server EOF before the expected size (file shrank mid-transfer) ends
//!   the stream short — the same behavior the serial reader had.
//! - Cancel/drop aborts the pump and closes the remote handle detached and
//!   time-bounded; a leaked handle at worst dies with its (ephemeral)
//!   transfer lane.

use std::collections::BTreeMap;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::RawSftpSession;
use russh_sftp::protocol::StatusCode;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::mpsc;

/// Start the pump and hand back the ordered reader. `req_len` is the
/// per-request size (the server's advertised read limit), `size` the stat'd
/// file size the grid is planned from, `depth` the standing request count
/// (Full: 32 ≈ 8 MiB — 4× scp's default, inside the 16 MiB lane window;
/// Background: shallow).
pub fn start(
    raw: Arc<RawSftpSession>,
    handle: String,
    size: u64,
    req_len: u32,
    depth: usize,
) -> PipelinedSftpReader {
    let depth = depth.max(1);
    // depth+2 of buffering decouples the pump from the consumer a little
    // without growing memory beyond the standing window.
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>(depth + 2);
    let task = tokio::spawn(pump(raw.clone(), handle.clone(), size, req_len, depth, tx));
    PipelinedSftpReader {
        rx,
        current: None,
        raw,
        handle,
        task,
    }
}

async fn pump(
    raw: Arc<RawSftpSession>,
    handle: String,
    size: u64,
    req_len: u32,
    depth: usize,
    tx: mpsc::Sender<Result<Vec<u8>, String>>,
) {
    let mut join = tokio::task::JoinSet::new();
    let mut next = 0u64; // next grid offset to schedule
    let mut staged: BTreeMap<u64, Vec<u8>> = BTreeMap::new();
    let mut delivered = 0u64; // contiguous bytes handed to the reader
    let mut eof = false; // server said EOF (file ended early)

    loop {
        while !eof && join.len() < depth && next < size {
            let len = req_len.min((size - next).min(u64::from(u32::MAX)) as u32);
            let raw2 = raw.clone();
            let h = handle.clone();
            let off = next;
            join.spawn(async move { (off, len, raw2.read(h, off, len).await) });
            next += u64::from(len);
        }
        if join.is_empty() {
            break; // grid fully scheduled, completed, and staged
        }
        let Some(Ok((off, asked, result))) = join.join_next().await else {
            break;
        };
        match result {
            Ok(data) => {
                let got = data.data.len() as u64;
                if got < u64::from(asked) && off + got < size && got > 0 {
                    // Short read before EOF: reschedule the remainder so the
                    // grid stays gapless (delivery is offset-contiguous).
                    let raw2 = raw.clone();
                    let h = handle.clone();
                    let roff = off + got;
                    let rlen = asked - got as u32;
                    join.spawn(async move { (roff, rlen, raw2.read(h, roff, rlen).await) });
                }
                if got == 0 {
                    eof = true; // zero-length data = end of file
                } else {
                    staged.insert(off, data.data);
                }
            }
            Err(SftpError::Status(s)) if s.status_code == StatusCode::Eof => {
                eof = true; // reads past the (shrunk) end
            }
            Err(e) => {
                let _ = tx.send(Err(e.to_string())).await;
                return;
            }
        }
        // Deliver the contiguous prefix in order.
        while let Some(chunk) = staged.remove(&delivered) {
            let n = chunk.len() as u64;
            if tx.send(Ok(chunk)).await.is_err() {
                return; // reader dropped (cancel) — its Drop closes the handle
            }
            delivered += n;
        }
    }

    // Graceful end: close the remote handle (bounded), then the sender drop
    // signals EOF to the reader.
    let _ = tokio::time::timeout(Duration::from_secs(3), raw.close(handle)).await;
}

/// The ordered consumer end. Implements the transfer source contract:
/// `AsyncRead` for the bytes, `AsyncWrite` only so `shutdown()` can close the
/// remote handle explicitly (mirroring the plain reader's close discipline).
pub struct PipelinedSftpReader {
    rx: mpsc::Receiver<Result<Vec<u8>, String>>,
    current: Option<(Vec<u8>, usize)>,
    raw: Arc<RawSftpSession>,
    handle: String,
    task: tokio::task::JoinHandle<()>,
}

impl PipelinedSftpReader {
    /// Stop the pump and close the remote handle, detached + bounded. Safe to
    /// call more than once; a double SFTP close is a harmless error status.
    fn teardown(&mut self) {
        self.task.abort();
        let raw = self.raw.clone();
        let handle = std::mem::take(&mut self.handle);
        if !handle.is_empty() {
            tokio::spawn(async move {
                let _ = tokio::time::timeout(Duration::from_secs(3), raw.close(handle)).await;
            });
        }
    }
}

impl Drop for PipelinedSftpReader {
    fn drop(&mut self) {
        self.teardown();
    }
}

impl AsyncRead for PipelinedSftpReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        loop {
            if let Some((chunk, pos)) = &mut self.current {
                let n = buf.remaining().min(chunk.len() - *pos);
                buf.put_slice(&chunk[*pos..*pos + n]);
                *pos += n;
                if *pos == chunk.len() {
                    self.current = None;
                }
                return Poll::Ready(Ok(()));
            }
            match std::task::ready!(self.rx.poll_recv(cx)) {
                Some(Ok(chunk)) => self.current = Some((chunk, 0)),
                Some(Err(e)) => return Poll::Ready(Err(io::Error::other(e))),
                None => return Poll::Ready(Ok(())), // EOF: empty read
            }
        }
    }
}

impl AsyncWrite for PipelinedSftpReader {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        _buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(Err(io::Error::other("read-only transfer source")))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.teardown();
        Poll::Ready(Ok(()))
    }
}
