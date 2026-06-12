//! SSH subsystem: connection management, `~/.ssh/config` parsing, SFTP file
//! operations (as a [`crate::transport::FileTransport`]), and PTY terminal
//! sessions.

pub mod config;
pub mod connection;
pub mod pty;
pub mod sftp;
