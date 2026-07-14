//! SFTP as a [`FileTransport`]: directory listing, file read/write (with fast
//! binary detection and save-conflict checks), rename/create/remove/copy/move,
//! and streamed transfer handles, over a remote SSH connection's SFTP channel.

use std::sync::Arc;

use std::future::Future;
use std::pin::Pin;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::ssh::connection::Connection;
use crate::transport::{
    copy_variant, decode_text, join_path, looks_binary, mode_to_rwx, posix_basename, sort_entries,
    DirListing, FileContent, FileEntry, FileStat, FileTransport, WriteResult, BINARY_SNIFF,
    MAX_READ_BYTES,
};

/// A [`FileTransport`] backed by an SSH connection's SFTP subsystem.
pub struct SftpTransport(pub Arc<Connection>);

#[async_trait::async_trait]
impl FileTransport for SftpTransport {
    async fn list_dir(&self, path: &str) -> Result<DirListing, String> {
        let guard = self.0.sftp().await?;
        let sftp = guard.as_ref().expect("sftp session initialized above");

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
        Ok(DirListing {
            path: base,
            entries,
        })
    }

    async fn read_file(&self, path: &str) -> Result<FileContent, String> {
        let guard = self.0.sftp().await?;
        let sftp = guard.as_ref().expect("sftp session initialized above");

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

    async fn stat(&self, path: &str) -> Result<FileStat, String> {
        let guard = self.0.sftp().await?;
        let sftp = guard.as_ref().expect("sftp session initialized above");

        let meta = sftp
            .metadata(path.to_string())
            .await
            .map_err(|e| format!("could not stat {path}: {e}"))?;
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
        let guard = self.0.sftp().await?;
        let sftp = guard.as_ref().expect("sftp session initialized above");

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
        Ok(WriteResult {
            conflict: false,
            modified,
        })
    }

    async fn rename(&self, path: &str, new_name: &str) -> Result<String, String> {
        let guard = self.0.sftp().await?;
        let sftp = guard.as_ref().expect("sftp session initialized above");
        let new_path = posix_sibling(path, new_name);
        sftp.rename(path.to_string(), new_path.clone())
            .await
            .map_err(|e| format!("could not rename {path}: {e}"))?;
        Ok(new_path)
    }

    async fn create_entry(
        &self,
        parent: &str,
        name: &str,
        is_dir: bool,
    ) -> Result<String, String> {
        let guard = self.0.sftp().await?;
        let sftp = guard.as_ref().expect("sftp session initialized above");
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
        let guard = self.0.sftp().await?;
        let sftp = guard.as_ref().expect("sftp session initialized above");
        remove_recursive(sftp, path.to_string()).await
    }

    async fn move_to(&self, path: &str, dest_dir: &str) -> Result<String, String> {
        let guard = self.0.sftp().await?;
        let sftp = guard.as_ref().expect("sftp session initialized above");
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
        let guard = self.0.sftp().await?;
        let sftp = guard.as_ref().expect("sftp session initialized above");
        let name = posix_basename(path);
        let mut dest = join_path(dest_dir, &name);
        let mut n = 1;
        while sftp.metadata(dest.clone()).await.is_ok() {
            dest = join_path(dest_dir, &copy_variant(&name, n));
            n += 1;
        }
        copy_recursive(sftp, path.to_string(), dest.clone()).await?;
        Ok(dest)
    }

    async fn open_read(&self, path: &str) -> Result<Pin<Box<dyn AsyncRead + Send>>, String> {
        let guard = self.0.sftp().await?;
        let sftp = guard.as_ref().expect("sftp session initialized above");
        let file = sftp
            .open(path.to_string())
            .await
            .map_err(|e| format!("could not open {path}: {e}"))?;
        Ok(Box::pin(file))
    }

    async fn open_write(&self, path: &str) -> Result<Pin<Box<dyn AsyncWrite + Send>>, String> {
        let guard = self.0.sftp().await?;
        let sftp = guard.as_ref().expect("sftp session initialized above");
        let file = sftp
            .create(path.to_string())
            .await
            .map_err(|e| format!("could not create {path}: {e}"))?;
        Ok(Box::pin(file))
    }

    async fn entry_meta(&self, path: &str) -> Result<FileEntry, String> {
        let guard = self.0.sftp().await?;
        let sftp = guard.as_ref().expect("sftp session initialized above");
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
            writer.shutdown().await.ok();
        }
        Ok(())
    })
}
