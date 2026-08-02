//! SFTP as a [`FileTransport`]: directory listing, file read/write (with fast
//! binary detection and save-conflict checks), rename/create/remove/copy/move,
//! and streamed transfer handles, over a remote SSH connection's SFTP channel.

use std::sync::Arc;

use std::future::Future;
use std::pin::Pin;

use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::ssh::connection::Connection;
use crate::transport::{
    copy_variant, decode_text, join_path, looks_binary, mode_to_rwx, posix_basename, sort_entries,
    DirListing, FileContent, FileEntry, FileStat, FileTransport, TransferSource, WriteResult,
    BINARY_SNIFF, MAX_READ_BYTES,
};

/// A [`FileTransport`] backed by an SSH connection's SFTP subsystem.
pub struct SftpTransport(pub Arc<Connection>);

/// A SESSION-level SFTP failure — the whole SFTP session is wedged (the server's
/// per-session handle table is full: "Limit exceeded: Handle limit reached") —
/// as opposed to a plain per-file error (no such file, permission denied) which
/// must NOT trigger a reset. Kept deliberately narrow so a normal error never
/// resets the session (incident 2026-07-30).
fn is_session_fatal(e: &str) -> bool {
    let e = e.to_ascii_lowercase();
    e.contains("handle limit") || e.contains("limit exceeded") || e.contains("too many open")
}

impl SftpTransport {
    /// Drop the wedged SFTP session so the next op opens a FRESH one with zero
    /// handles — the self-heal for a handle-exhausted data lane. The transport
    /// (terminals, the main lane) is untouched. Also reclaims any handles leaked
    /// by russh_sftp's read_dir error path: they die with the old session.
    /// Incident 2026-07-30: turns "wedged until a manual reconnect" into a
    /// ~1-round-trip recovery.
    async fn heal(&self, err: &str) {
        crate::diag::alert(
            "warn",
            format!(
                "SFTP on {} hit the server's handle limit ({err}) — recovered by resetting \
                 the file session; your terminals were untouched.",
                self.0.info.host
            ),
        );
        self.0.reset_sftp().await;
    }

    async fn list_dir_once(&self, path: &str) -> Result<DirListing, String> {
        let sftp = self.0.sftp().await?;
        let started = std::time::Instant::now();

        let base = if path.is_empty() || path == "." {
            sftp.canonicalize(".")
                .await
                .map_err(|e| format!("could not resolve home directory: {e}"))?
        } else {
            path.to_string()
        };

        let read_dir = sftp
            .read_dir(base.clone())
            .await
            .map_err(|e| format!("could not list {base}: {e}"))?;

        let mut entries: Vec<FileEntry> = Vec::new();
        for entry in read_dir {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let meta = entry.metadata();
            let full = join_path(&base, &name);
            let is_symlink = meta.is_symlink();

            // For symlinks, follow to the target to decide whether it behaves
            // like a directory and to show the target path.
            let (is_dir, size, symlink_target) = if is_symlink {
                let target = sftp.read_link(full.clone()).await.ok();
                match sftp.metadata(full.clone()).await {
                    Ok(resolved) => (resolved.is_dir(), resolved.size.unwrap_or(0), target),
                    Err(_) => (false, meta.size.unwrap_or(0), target),
                }
            } else {
                (meta.is_dir(), meta.size.unwrap_or(0), None)
            };

            entries.push(FileEntry {
                name,
                path: full,
                size,
                is_dir,
                is_symlink,
                symlink_target,
                permissions: mode_to_rwx(meta.permissions.unwrap_or(0)),
                owner: meta
                    .user
                    .clone()
                    .or_else(|| meta.uid.map(|u| u.to_string()))
                    .unwrap_or_default(),
                group: meta
                    .group
                    .clone()
                    .or_else(|| meta.gid.map(|g| g.to_string()))
                    .unwrap_or_default(),
                modified: meta.mtime.map(|m| m as i64).unwrap_or(0),
            });
        }

        sort_entries(&mut entries);
        // Attribution for the "big folder = whole-app lag" report: if this is
        // slow, the cost is the SFTP read (a whole-directory walk + a round-trip
        // per symlink) — not the frontend. Cheap; only logs the notable ones.
        let ms = started.elapsed().as_millis();
        if ms > 300 || entries.len() > 800 {
            crate::diag::event(
                "sftp",
                format!("list {base}: {} entries in {ms}ms", entries.len()),
            );
        }
        self.0.touch_activity(); // completed SFTP op = proof of life
        Ok(DirListing {
            path: base,
            entries,
        })
    }

    async fn read_file_once(&self, path: &str) -> Result<FileContent, String> {
        let sftp = self.0.sftp().await?;

        let meta = sftp
            .metadata(path.to_string())
            .await
            .map_err(|e| format!("could not stat {path}: {e}"))?;
        let size = meta.size.unwrap_or(0);
        let modified = meta.mtime.map(|m| m as i64).unwrap_or(0);
        let truncated = size > MAX_READ_BYTES;

        let file = sftp
            .open(path.to_string())
            .await
            .map_err(|e| format!("could not open {path}: {e}"))?;
        let mut reader = file.take(MAX_READ_BYTES);

        // Read just the first chunk and sniff for NUL bytes; a binary file
        // returns here without downloading the rest.
        let mut buffer: Vec<u8> = Vec::with_capacity(BINARY_SNIFF);
        let mut chunk = [0u8; 4096];
        while buffer.len() < BINARY_SNIFF {
            let n = reader
                .read(&mut chunk)
                .await
                .map_err(|e| format!("could not read {path}: {e}"))?;
            if n == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..n]);
        }

        if looks_binary(&buffer) {
            return Ok(FileContent {
                path: path.to_string(),
                content: String::new(),
                is_binary: true,
                encoding: "binary".to_string(),
                size,
                modified,
                truncated,
                lossy: false,
            });
        }

        reader
            .read_to_end(&mut buffer)
            .await
            .map_err(|e| format!("could not read {path}: {e}"))?;

        self.0.touch_activity();
        let (content, lossy) = decode_text(buffer);
        Ok(FileContent {
            path: path.to_string(),
            content,
            is_binary: false,
            encoding: if lossy { "non-utf-8" } else { "utf-8" }.to_string(),
            size,
            modified,
            truncated,
            lossy,
        })
    }

    async fn write_file_once(
        &self,
        path: &str,
        content: &str,
        expected_modified: Option<i64>,
    ) -> Result<WriteResult, String> {
        let sftp = self.0.sftp().await?;

        if let Some(expected) = expected_modified {
            if expected > 0 {
                if let Ok(meta) = sftp.metadata(path.to_string()).await {
                    let current = meta.mtime.map(|m| m as i64).unwrap_or(0);
                    if current > expected {
                        return Ok(WriteResult { conflict: true, modified: current });
                    }
                }
            }
        }

        // `create` opens write + create + truncate.
        let mut file = sftp
            .create(path.to_string())
            .await
            .map_err(|e| format!("could not open {path} for writing: {e}"))?;
        file.write_all(content.as_bytes())
            .await
            .map_err(|e| format!("could not write {path}: {e}"))?;
        file.flush()
            .await
            .map_err(|e| format!("could not flush {path}: {e}"))?;
        file.shutdown().await.ok();

        let modified = sftp
            .metadata(path.to_string())
            .await
            .ok()
            .and_then(|m| m.mtime)
            .map(|m| m as i64)
            .unwrap_or(0);
        self.0.touch_activity();
        Ok(WriteResult {
            conflict: false,
            modified,
        })
    }
}

#[async_trait::async_trait]
impl FileTransport for SftpTransport {
    async fn list_dir(&self, path: &str) -> Result<DirListing, String> {
        // Self-heal: a handle-exhausted SFTP session gets reset + retried ONCE
        // on a fresh session (incident 2026-07-30). A plain per-file error is
        // returned as-is.
        match self.list_dir_once(path).await {
            Err(e) if is_session_fatal(&e) => {
                self.heal(&e).await;
                self.list_dir_once(path).await
            }
            r => r,
        }
    }

    async fn read_file(&self, path: &str) -> Result<FileContent, String> {
        match self.read_file_once(path).await {
            Err(e) if is_session_fatal(&e) => {
                self.heal(&e).await;
                self.read_file_once(path).await
            }
            r => r,
        }
    }

    async fn stat(&self, path: &str) -> Result<FileStat, String> {
        let sftp = self.0.sftp().await?;

        let meta = sftp
            .metadata(path.to_string())
            .await
            .map_err(|e| format!("could not stat {path}: {e}"))?;
        self.0.touch_activity();
        Ok(FileStat {
            path: path.to_string(),
            size: meta.size.unwrap_or(0),
            is_dir: meta.is_dir(),
            modified: meta.mtime.map(|m| m as i64).unwrap_or(0),
            permissions: mode_to_rwx(meta.permissions.unwrap_or(0)),
        })
    }

    async fn write_file(
        &self,
        path: &str,
        content: &str,
        expected_modified: Option<i64>,
    ) -> Result<WriteResult, String> {
        match self.write_file_once(path, content, expected_modified).await {
            Err(e) if is_session_fatal(&e) => {
                self.heal(&e).await;
                self.write_file_once(path, content, expected_modified).await
            }
            r => r,
        }
    }

    async fn rename(&self, path: &str, new_name: &str) -> Result<String, String> {
        let sftp = self.0.sftp().await?;
        let new_path = posix_sibling(path, new_name);
        sftp.rename(path.to_string(), new_path.clone())
            .await
            .map_err(|e| format!("could not rename {path}: {e}"))?;
        self.0.touch_activity();
        Ok(new_path)
    }

    async fn create_entry(
        &self,
        parent: &str,
        name: &str,
        is_dir: bool,
    ) -> Result<String, String> {
        let sftp = self.0.sftp().await?;
        let path = join_path(parent, name);
        if sftp.metadata(path.clone()).await.is_ok() {
            return Err(format!("{path} already exists"));
        }
        if is_dir {
            sftp.create_dir(path.clone())
                .await
                .map_err(|e| format!("could not create folder {path}: {e}"))?;
        } else {
            sftp.create(path.clone())
                .await
                .map_err(|e| format!("could not create file {path}: {e}"))?;
        }
        Ok(path)
    }

    async fn remove(&self, path: &str) -> Result<(), String> {
        let sftp = self.0.sftp().await?;
        // Same machine: one server-side `rm -rf` deletes a whole tree in one
        // round trip — the SFTP fallback below walks it file by file (a
        // 10k-file folder = 10k+ round trips, minutes over a real link). The
        // delete was already recursive-destructive and confirm-gated upstream;
        // this only changes the speed. `-f` also makes "already gone" a
        // success, which is the right answer for a raced delete.
        let cmd = format!("rm -rf -- {}", crate::exec::shell_quote(path));
        if let Ok(out) = crate::exec::exec_ssh(&self.0, &cmd).await {
            if out.code == 0 {
                self.0.touch_activity();
                return Ok(());
            }
            // `rm` refused (permissions, read-only fs) — the SFTP walk retries
            // and surfaces its own, more specific error.
        }
        remove_recursive(&sftp, path.to_string()).await
    }

    async fn remove_many(&self, paths: &[String]) -> Result<(), String> {
        // One server-side `rm -rf` takes every path at once — a multi-select
        // delete is one round trip, not one per item.
        if paths.len() > 1 {
            let mut cmd = String::from("rm -rf --");
            for p in paths {
                cmd.push(' ');
                cmd.push_str(&crate::exec::shell_quote(p));
            }
            if let Ok(out) = crate::exec::exec_ssh(&self.0, &cmd).await {
                if out.code == 0 {
                    self.0.touch_activity();
                    return Ok(());
                }
            }
        }
        // Single path, or the batch refused — per path (each retries rm →
        // SFTP walk), collecting errors so every path gets its attempt.
        // Already-deleted paths from a partial batch count as success
        // (`rm -f`), so this can't double-report.
        let mut errs: Vec<String> = Vec::new();
        for p in paths {
            if let Err(e) = self.remove(p).await {
                errs.push(e);
            }
        }
        if errs.is_empty() {
            Ok(())
        } else {
            Err(errs.join("; "))
        }
    }

    async fn move_to(&self, path: &str, dest_dir: &str) -> Result<String, String> {
        let sftp = self.0.sftp().await?;
        let dest = join_path(dest_dir, &posix_basename(path));
        if dest == path {
            return Ok(dest); // already in this directory
        }
        if sftp.metadata(dest.clone()).await.is_ok() {
            return Err(format!("{dest} already exists"));
        }
        sftp.rename(path.to_string(), dest.clone())
            .await
            .map_err(|e| format!("could not move {path}: {e}"))?;
        Ok(dest)
    }

    async fn copy_to(&self, path: &str, dest_dir: &str) -> Result<String, String> {
        let sftp = self.0.sftp().await?;
        let name = posix_basename(path);
        let mut dest = join_path(dest_dir, &name);
        let mut n = 1;
        while sftp.metadata(dest.clone()).await.is_ok() {
            dest = join_path(dest_dir, &copy_variant(&name, n));
            n += 1;
        }
        // Both ends are the SAME machine: one server-side `cp -a` (recursive,
        // preserves modes/times/links) copies without moving a byte over the
        // link. The SFTP fallback below streams every file down to the client
        // and back up — only for hosts where exec/`cp` isn't available
        // (restricted shells).
        let cmd = format!(
            "cp -a -- {} {}",
            crate::exec::shell_quote(path),
            crate::exec::shell_quote(&dest),
        );
        if let Ok(out) = crate::exec::exec_ssh(&self.0, &cmd).await {
            if out.code == 0 {
                self.0.touch_activity();
                return Ok(dest);
            }
            // `cp` exists but refused (permissions, odd fs) — fall through so
            // the SFTP path retries and surfaces its own, specific error.
        }
        copy_recursive(&sftp, path.to_string(), dest.clone()).await?;
        Ok(dest)
    }

    async fn open_read(&self, path: &str) -> Result<Pin<Box<dyn TransferSource>>, String> {
        let sftp = self.0.sftp().await?;
        let file = sftp
            .open(path.to_string())
            .await
            .map_err(|e| format!("could not open {path}: {e}"))?;
        self.0.touch_activity();
        Ok(Box::pin(file))
    }

    async fn open_read_fast(
        &self,
        path: &str,
        size_hint: u64,
        depth: usize,
    ) -> Result<Pin<Box<dyn TransferSource>>, String> {
        // Small files: the pipeline's setup (channel + subsystem + open ≈ 3
        // round trips) costs more than it saves. The serial reader wins there.
        const PIPELINE_MIN: u64 = 4 * 1024 * 1024;
        if size_hint < PIPELINE_MIN || depth <= 1 {
            return self.open_read(path).await;
        }
        // A dedicated raw SFTP session on its own channel, so 32 in-flight
        // reads never contend with the shared session's everyday requests.
        let channel = self.0.open_channel("sftp-fast").await?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("failed to start SFTP subsystem: {e}"))?; // guard closes on ?
        // Hand the channel to the stream (ChannelCloseOnDrop owns the hang-up).
        let mut raw = russh_sftp::client::RawSftpSession::new(channel.into_inner().into_stream());
        raw.init()
            .await
            .map_err(|e| format!("could not initialize SFTP: {e}"))?;
        // The server's advertised per-request read limit (OpenSSH: ~255 KB);
        // conservative fallback where the limits extension is absent.
        let req_len = match raw.limits().await {
            Ok(ext) => {
                let limits = russh_sftp::client::rawsession::Limits::from(ext);
                let req = limits.read_len.unwrap_or(32 * 1024).min(261_120) as u32;
                raw.set_limits(limits);
                req
            }
            Err(_) => 32 * 1024,
        };
        let handle = raw
            .open(
                path.to_string(),
                russh_sftp::protocol::OpenFlags::READ,
                russh_sftp::protocol::FileAttributes::default(),
            )
            .await
            .map_err(|e| format!("could not open {path}: {e}"))?
            .handle;
        self.0.touch_activity();
        Ok(Box::pin(crate::transport::pipeline::start(
            std::sync::Arc::new(raw),
            handle,
            size_hint,
            req_len,
            depth,
        )))
    }

    async fn open_write(&self, path: &str) -> Result<Pin<Box<dyn AsyncWrite + Send>>, String> {
        let sftp = self.0.sftp().await?;
        let file = sftp
            .create(path.to_string())
            .await
            .map_err(|e| format!("could not create {path}: {e}"))?;
        self.0.touch_activity();
        Ok(Box::pin(file))
    }

    async fn entry_meta(&self, path: &str) -> Result<FileEntry, String> {
        let sftp = self.0.sftp().await?;
        let link = sftp
            .symlink_metadata(path.to_string())
            .await
            .map_err(|e| format!("could not stat {path}: {e}"))?;
        let is_symlink = link.is_symlink();
        let (is_dir, size, symlink_target) = if is_symlink {
            let target = sftp.read_link(path.to_string()).await.ok();
            match sftp.metadata(path.to_string()).await {
                Ok(resolved) => (resolved.is_dir(), resolved.size.unwrap_or(0), target),
                Err(_) => (false, link.size.unwrap_or(0), target),
            }
        } else {
            (link.is_dir(), link.size.unwrap_or(0), None)
        };
        Ok(FileEntry {
            name: posix_basename(path),
            path: path.to_string(),
            size,
            is_dir,
            is_symlink,
            symlink_target,
            permissions: mode_to_rwx(link.permissions.unwrap_or(0)),
            owner: link
                .user
                .clone()
                .or_else(|| link.uid.map(|u| u.to_string()))
                .unwrap_or_default(),
            group: link
                .group
                .clone()
                .or_else(|| link.gid.map(|g| g.to_string()))
                .unwrap_or_default(),
            modified: link.mtime.map(|m| m as i64).unwrap_or(0),
        })
    }

    fn join(&self, parent: &str, name: &str) -> String {
        join_path(parent, name)
    }
}

fn posix_sibling(path: &str, new_name: &str) -> String {
    match path.rsplit_once('/') {
        Some(("", _)) => format!("/{new_name}"),
        Some((parent, _)) => format!("{parent}/{new_name}"),
        None => new_name.to_string(),
    }
}

/// Recursively delete a remote path (depth-first), removing the symlink itself
/// rather than following it.
fn remove_recursive(
    sftp: &russh_sftp::client::SftpSession,
    path: String,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
    Box::pin(async move {
        let meta = sftp
            .symlink_metadata(path.clone())
            .await
            .map_err(|e| format!("could not stat {path}: {e}"))?;
        if meta.is_dir() && !meta.is_symlink() {
            let entries = sftp
                .read_dir(path.clone())
                .await
                .map_err(|e| format!("could not list {path}: {e}"))?;
            for entry in entries {
                let name = entry.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                let child = join_path(&path, &name);
                remove_recursive(sftp, child).await?;
            }
            sftp.remove_dir(path.clone())
                .await
                .map_err(|e| format!("could not remove folder {path}: {e}"))?;
        } else {
            sftp.remove_file(path.clone())
                .await
                .map_err(|e| format!("could not remove {path}: {e}"))?;
        }
        Ok(())
    })
}

/// Recursively copy a remote path (depth-first). Symlinks are followed and
/// copied as regular files (the common case for a code tree).
fn copy_recursive(
    sftp: &russh_sftp::client::SftpSession,
    src: String,
    dst: String,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
    Box::pin(async move {
        let meta = sftp
            .symlink_metadata(src.clone())
            .await
            .map_err(|e| format!("could not stat {src}: {e}"))?;
        if meta.is_dir() && !meta.is_symlink() {
            sftp.create_dir(dst.clone())
                .await
                .map_err(|e| format!("could not create folder {dst}: {e}"))?;
            let entries = sftp
                .read_dir(src.clone())
                .await
                .map_err(|e| format!("could not list {src}: {e}"))?;
            for entry in entries {
                let name = entry.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                copy_recursive(sftp, join_path(&src, &name), join_path(&dst, &name)).await?;
            }
        } else {
            let mut reader = sftp
                .open(src.clone())
                .await
                .map_err(|e| format!("could not open {src}: {e}"))?;
            let mut writer = sftp
                .create(dst.clone())
                .await
                .map_err(|e| format!("could not create {dst}: {e}"))?;
            tokio::io::copy(&mut reader, &mut writer)
                .await
                .map_err(|e| format!("could not copy to {dst}: {e}"))?;
            writer
                .flush()
                .await
                .map_err(|e| format!("could not flush {dst}: {e}"))?;
            // Await-close both handles; the read side would otherwise leak on a
            // deep tree (Drop only fires a no-wait close). See `TransferSource`.
            writer.shutdown().await.ok();
            reader.shutdown().await.ok();
        }
        Ok(())
    })
}
