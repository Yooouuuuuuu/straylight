//! SFTP as a [`FileTransport`]: read-only directory listing, file reading (with
//! fast binary detection), and stat over a remote SSH connection. Writing and
//! transfers arrive in Phase 2.

use std::sync::Arc;

use tokio::io::AsyncReadExt;

use crate::ssh::connection::Connection;
use crate::transport::{
    join_path, looks_binary, mode_to_rwx, sort_entries, DirListing, FileContent, FileEntry,
    FileStat, FileTransport, BINARY_SNIFF, MAX_READ_BYTES,
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
            });
        }

        reader
            .read_to_end(&mut buffer)
            .await
            .map_err(|e| format!("could not read {path}: {e}"))?;

        Ok(FileContent {
            path: path.to_string(),
            content: String::from_utf8_lossy(&buffer).into_owned(),
            is_binary: false,
            encoding: "utf-8".to_string(),
            size,
            modified,
            truncated,
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
}
