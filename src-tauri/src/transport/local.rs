//! Local filesystem transport (`std::fs` via `tokio::fs`).

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite};

use crate::transport::{
    any_basename, copy_variant, looks_binary, sort_entries, DirListing, FileContent, FileEntry,
    FileStat, FileTransport, WriteResult, BINARY_SNIFF, MAX_READ_BYTES,
};

pub struct LocalTransport;

fn home() -> PathBuf {
    directories::UserDirs::new()
        .map(|d| d.home_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn mtime_secs(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(unix)]
fn perms_string(meta: &std::fs::Metadata) -> String {
    use std::os::unix::fs::PermissionsExt;
    crate::transport::mode_to_rwx(meta.permissions().mode())
}

#[cfg(windows)]
fn perms_string(meta: &std::fs::Metadata) -> String {
    // Windows has no Unix mode; approximate from the read-only flag.
    if meta.permissions().readonly() {
        "r--r--r--".to_string()
    } else {
        "rw-rw-rw-".to_string()
    }
}

#[async_trait::async_trait]
impl FileTransport for LocalTransport {
    async fn list_dir(&self, path: &str) -> Result<DirListing, String> {
        let base = if path.is_empty() {
            home()
        } else {
            PathBuf::from(path)
        };

        let mut read_dir = tokio::fs::read_dir(&base)
            .await
            .map_err(|e| format!("could not list {}: {e}", base.display()))?;

        let mut entries: Vec<FileEntry> = Vec::new();
        while let Some(entry) = read_dir
            .next_entry()
            .await
            .map_err(|e| format!("could not read directory: {e}"))?
        {
            let name = entry.file_name().to_string_lossy().into_owned();
            let full = entry.path();

            // lstat-style: detect the symlink itself, then follow to classify.
            let link_meta = match tokio::fs::symlink_metadata(&full).await {
                Ok(m) => m,
                Err(_) => continue,
            };
            let is_symlink = link_meta.file_type().is_symlink();

            let (is_dir, size, symlink_target, modified, permissions) = if is_symlink {
                let target = tokio::fs::read_link(&full)
                    .await
                    .ok()
                    .map(|p| p.to_string_lossy().into_owned());
                match tokio::fs::metadata(&full).await {
                    Ok(m) => (
                        m.is_dir(),
                        m.len(),
                        target,
                        mtime_secs(&m),
                        perms_string(&m),
                    ),
                    Err(_) => (
                        false,
                        link_meta.len(),
                        target,
                        mtime_secs(&link_meta),
                        perms_string(&link_meta),
                    ),
                }
            } else {
                (
                    link_meta.is_dir(),
                    link_meta.len(),
                    None,
                    mtime_secs(&link_meta),
                    perms_string(&link_meta),
                )
            };

            entries.push(FileEntry {
                name,
                path: full.to_string_lossy().into_owned(),
                size,
                is_dir,
                is_symlink,
                symlink_target,
                permissions,
                owner: String::new(),
                group: String::new(),
                modified,
            });
        }

        sort_entries(&mut entries);
        Ok(DirListing {
            path: base.to_string_lossy().into_owned(),
            entries,
        })
    }

    async fn read_file(&self, path: &str) -> Result<FileContent, String> {
        let target = PathBuf::from(path);
        let meta = tokio::fs::metadata(&target)
            .await
            .map_err(|e| format!("could not stat {path}: {e}"))?;
        let size = meta.len();
        let modified = mtime_secs(&meta);
        let truncated = size > MAX_READ_BYTES;

        let file = tokio::fs::File::open(&target)
            .await
            .map_err(|e| format!("could not open {path}: {e}"))?;
        let mut reader = file.take(MAX_READ_BYTES);

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
        let target = PathBuf::from(path);
        let meta = tokio::fs::metadata(&target)
            .await
            .map_err(|e| format!("could not stat {path}: {e}"))?;
        Ok(FileStat {
            path: path.to_string(),
            size: meta.len(),
            is_dir: meta.is_dir(),
            modified: mtime_secs(&meta),
            permissions: perms_string(&meta),
        })
    }

    async fn write_file(
        &self,
        path: &str,
        content: &str,
        expected_modified: Option<i64>,
    ) -> Result<WriteResult, String> {
        let target = PathBuf::from(path);

        if let Some(expected) = expected_modified {
            if expected > 0 {
                if let Ok(meta) = tokio::fs::metadata(&target).await {
                    let current = mtime_secs(&meta);
                    if current > expected {
                        return Ok(WriteResult { conflict: true, modified: current });
                    }
                }
            }
        }

        tokio::fs::write(&target, content.as_bytes())
            .await
            .map_err(|e| format!("could not write {path}: {e}"))?;

        let modified = tokio::fs::metadata(&target)
            .await
            .ok()
            .map(|m| mtime_secs(&m))
            .unwrap_or(0);
        Ok(WriteResult {
            conflict: false,
            modified,
        })
    }

    async fn rename(&self, path: &str, new_name: &str) -> Result<String, String> {
        let from = PathBuf::from(path);
        let new_path = from
            .parent()
            .map(|p| p.join(new_name))
            .unwrap_or_else(|| PathBuf::from(new_name));
        tokio::fs::rename(&from, &new_path)
            .await
            .map_err(|e| format!("could not rename {path}: {e}"))?;
        Ok(new_path.to_string_lossy().into_owned())
    }

    async fn create_entry(
        &self,
        parent: &str,
        name: &str,
        is_dir: bool,
    ) -> Result<String, String> {
        let path = PathBuf::from(parent).join(name);
        if is_dir {
            tokio::fs::create_dir(&path)
                .await
                .map_err(|e| format!("could not create folder: {e}"))?;
        } else {
            tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .await
                .map_err(|e| format!("could not create file: {e}"))?;
        }
        Ok(path.to_string_lossy().into_owned())
    }

    async fn remove(&self, path: &str) -> Result<(), String> {
        remove_path(&PathBuf::from(path)).await
    }

    async fn move_to(&self, path: &str, dest_dir: &str) -> Result<String, String> {
        let src = PathBuf::from(path);
        let name = src
            .file_name()
            .ok_or_else(|| format!("invalid path {path}"))?
            .to_os_string();
        let dest = PathBuf::from(dest_dir).join(&name);
        if dest == src {
            return Ok(dest.to_string_lossy().into_owned()); // already here
        }
        if tokio::fs::symlink_metadata(&dest).await.is_ok() {
            return Err(format!("{} already exists", dest.display()));
        }
        // A plain rename works within a filesystem; fall back to copy+remove
        // across devices (where rename errors with EXDEV).
        if tokio::fs::rename(&src, &dest).await.is_err() {
            copy_recursive(src.clone(), dest.clone()).await?;
            remove_path(&src).await?;
        }
        Ok(dest.to_string_lossy().into_owned())
    }

    async fn copy_to(&self, path: &str, dest_dir: &str) -> Result<String, String> {
        let src = PathBuf::from(path);
        let name = src
            .file_name()
            .ok_or_else(|| format!("invalid path {path}"))?
            .to_string_lossy()
            .into_owned();
        let dir = PathBuf::from(dest_dir);
        let mut dest = dir.join(&name);
        let mut n = 1;
        while tokio::fs::symlink_metadata(&dest).await.is_ok() {
            dest = dir.join(copy_variant(&name, n));
            n += 1;
        }
        copy_recursive(src, dest.clone()).await?;
        Ok(dest.to_string_lossy().into_owned())
    }

    async fn open_read(&self, path: &str) -> Result<Pin<Box<dyn AsyncRead + Send>>, String> {
        let file = tokio::fs::File::open(path)
            .await
            .map_err(|e| format!("could not open {path}: {e}"))?;
        Ok(Box::pin(file))
    }

    async fn open_write(&self, path: &str) -> Result<Pin<Box<dyn AsyncWrite + Send>>, String> {
        let file = tokio::fs::File::create(path)
            .await
            .map_err(|e| format!("could not create {path}: {e}"))?;
        Ok(Box::pin(file))
    }

    async fn entry_meta(&self, path: &str) -> Result<FileEntry, String> {
        let link = tokio::fs::symlink_metadata(path)
            .await
            .map_err(|e| format!("could not stat {path}: {e}"))?;
        let is_symlink = link.file_type().is_symlink();
        let (is_dir, size, symlink_target, modified, permissions) = if is_symlink {
            let target = tokio::fs::read_link(path)
                .await
                .ok()
                .map(|p| p.to_string_lossy().into_owned());
            match tokio::fs::metadata(path).await {
                Ok(m) => (m.is_dir(), m.len(), target, mtime_secs(&m), perms_string(&m)),
                Err(_) => (
                    false,
                    link.len(),
                    target,
                    mtime_secs(&link),
                    perms_string(&link),
                ),
            }
        } else {
            (
                link.is_dir(),
                link.len(),
                None,
                mtime_secs(&link),
                perms_string(&link),
            )
        };
        Ok(FileEntry {
            name: any_basename(path).to_string(),
            path: path.to_string(),
            size,
            is_dir,
            is_symlink,
            symlink_target,
            permissions,
            owner: String::new(),
            group: String::new(),
            modified,
        })
    }

    fn join(&self, parent: &str, name: &str) -> String {
        PathBuf::from(parent)
            .join(name)
            .to_string_lossy()
            .into_owned()
    }
}

async fn remove_path(target: &PathBuf) -> Result<(), String> {
    let meta = tokio::fs::symlink_metadata(target)
        .await
        .map_err(|e| format!("could not stat {}: {e}", target.display()))?;
    if meta.is_dir() {
        tokio::fs::remove_dir_all(target)
            .await
            .map_err(|e| format!("could not remove folder: {e}"))?;
    } else {
        tokio::fs::remove_file(target)
            .await
            .map_err(|e| format!("could not remove file: {e}"))?;
    }
    Ok(())
}

/// Recursively copy a local path (depth-first). Symlinks are followed and
/// copied as regular files.
fn copy_recursive(
    src: PathBuf,
    dst: PathBuf,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> {
    Box::pin(async move {
        let meta = tokio::fs::symlink_metadata(&src)
            .await
            .map_err(|e| format!("could not stat {}: {e}", src.display()))?;
        if meta.is_dir() {
            tokio::fs::create_dir(&dst)
                .await
                .map_err(|e| format!("could not create folder {}: {e}", dst.display()))?;
            let mut rd = tokio::fs::read_dir(&src)
                .await
                .map_err(|e| format!("could not list {}: {e}", src.display()))?;
            while let Some(entry) = rd
                .next_entry()
                .await
                .map_err(|e| format!("could not read {}: {e}", src.display()))?
            {
                copy_recursive(entry.path(), dst.join(entry.file_name())).await?;
            }
        } else {
            tokio::fs::copy(&src, &dst)
                .await
                .map_err(|e| format!("could not copy {}: {e}", src.display()))?;
        }
        Ok(())
    })
}
