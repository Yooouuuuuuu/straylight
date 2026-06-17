/**
 * Typed wrappers around the Tauri command surface.
 *
 * Field names mirror the Rust structs, which serialize with
 * `#[serde(rename_all = "camelCase")]`. Command *argument* names are written in
 * camelCase here; Tauri automatically maps them to the snake_case Rust
 * parameters (e.g. `connId` -> `conn_id`).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// Shared types (mirror of the Rust serde types)
// ---------------------------------------------------------------------------

export type AuthMethod =
  | { type: "password"; password: string }
  | { type: "auto"; identityFile?: string | null };

export type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export interface ConnectionStatus {
  connId: string;
  state: ConnectionState;
  message: string | null;
}

export interface SshHostEntry {
  name: string;
  hostName: string | null;
  user: string | null;
  port: number | null;
  identityFile: string | null;
  proxyJump: string | null;
}

export interface FileEntry {
  name: string;
  path: string;
  size: number;
  isDir: boolean;
  isSymlink: boolean;
  symlinkTarget: string | null;
  permissions: string;
  owner: string;
  group: string;
  /** Unix mtime, seconds. */
  modified: number;
}

export interface FileContent {
  path: string;
  content: string;
  isBinary: boolean;
  encoding: string;
  size: number;
  modified: number;
  truncated: boolean;
}

export interface FileStat {
  path: string;
  size: number;
  isDir: boolean;
  modified: number;
  permissions: string;
}

export interface DirListing {
  /** The absolute path the listing was resolved to. */
  path: string;
  entries: FileEntry[];
}

export interface PtyOutput {
  ptyId: string;
  /** Raw bytes as a number array. */
  data: number[];
}

// ---------------------------------------------------------------------------
// SSH connection
// ---------------------------------------------------------------------------

export function sshListConfigHosts(): Promise<SshHostEntry[]> {
  return invoke("ssh_list_config_hosts");
}

/** Ensure ~/.ssh/config exists and return its absolute path (to open in-app). */
export function sshConfigPath(): Promise<string> {
  return invoke("ssh_config_path");
}

export interface ConnectArgs {
  host: string;
  port: number;
  user: string;
  auth: AuthMethod;
  proxyJump?: string | null;
}

export function sshConnect(args: ConnectArgs): Promise<string> {
  return invoke("ssh_connect", {
    host: args.host,
    port: args.port,
    user: args.user,
    auth: args.auth,
    proxyJump: args.proxyJump ?? null,
  });
}

export function sshDisconnect(connId: string): Promise<void> {
  return invoke("ssh_disconnect", { connId });
}

/** Manually re-establish a dropped connection, keeping the same connId. */
export function sshReconnect(connId: string): Promise<void> {
  return invoke("ssh_reconnect", { connId });
}

export function sshGetStatus(connId: string): Promise<ConnectionStatus> {
  return invoke("ssh_get_status", { connId });
}

// ---------------------------------------------------------------------------
// Filesystem (transport-agnostic: SFTP for SSH sessions, std::fs for local)
// ---------------------------------------------------------------------------

/** Open a local-filesystem session; returns its connection id. */
export function localConnect(): Promise<string> {
  return invoke("local_connect");
}

export function fsListDir(connId: string, path: string): Promise<DirListing> {
  return invoke("fs_list_dir", { connId, path });
}

export function fsReadFile(connId: string, path: string): Promise<FileContent> {
  return invoke("fs_read_file", { connId, path });
}

export function fsStat(connId: string, path: string): Promise<FileStat> {
  return invoke("fs_stat", { connId, path });
}

export interface WriteResult {
  /** True if the file changed on disk since `expectedModified`; not written. */
  conflict: boolean;
  /** New mtime after a write, or the current (newer) mtime on conflict. */
  modified: number;
}

export function fsWriteFile(
  connId: string,
  path: string,
  content: string,
  expectedModified?: number | null,
): Promise<WriteResult> {
  return invoke("fs_write_file", {
    connId,
    path,
    content,
    expectedModified: expectedModified ?? null,
  });
}

/** Rename an entry within its directory; returns the new absolute path. */
export function fsRename(
  connId: string,
  path: string,
  newName: string,
): Promise<string> {
  return invoke("fs_rename", { connId, path, newName });
}

/** Create a file or directory; returns the new absolute path. */
export function fsCreate(
  connId: string,
  parent: string,
  name: string,
  isDir: boolean,
): Promise<string> {
  return invoke("fs_create", { connId, parent, name, isDir });
}

/** Remove a path (recursively for directories). */
export function fsRemove(connId: string, path: string): Promise<void> {
  return invoke("fs_remove", { connId, path });
}

/** Move an entry into `destDir` (same connection); returns the new path. */
export function fsMove(
  connId: string,
  path: string,
  destDir: string,
): Promise<string> {
  return invoke("fs_move", { connId, path, destDir });
}

/** Copy an entry into `destDir` (recursive; auto-renames on collision). */
export function fsCopy(
  connId: string,
  path: string,
  destDir: string,
): Promise<string> {
  return invoke("fs_copy", { connId, path, destDir });
}

// ---------------------------------------------------------------------------
// PTY / terminal
// ---------------------------------------------------------------------------

export interface TerminalProfile {
  id: string;
  label: string;
  /** Program + args to launch for a local terminal. */
  command: string[];
}

/** Local shells available for the terminal profile picker. */
export function listTerminalProfiles(): Promise<TerminalProfile[]> {
  return invoke("list_terminal_profiles");
}

export function ptyOpen(
  connId: string,
  cols: number,
  rows: number,
  command?: string[] | null,
): Promise<string> {
  return invoke("pty_open", { connId, cols, rows, command: command ?? null });
}

export function ptyWrite(
  ptyId: string,
  data: number[] | Uint8Array,
): Promise<void> {
  return invoke("pty_write", { ptyId, data: Array.from(data) });
}

export function ptyResize(
  ptyId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("pty_resize", { ptyId, cols, rows });
}

export function ptyClose(ptyId: string): Promise<void> {
  return invoke("pty_close", { ptyId });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export function onPtyOutput(
  handler: (output: PtyOutput) => void,
): Promise<UnlistenFn> {
  return listen<PtyOutput>("pty-output", (event) => handler(event.payload));
}

export function onSshStatus(
  handler: (status: ConnectionStatus) => void,
): Promise<UnlistenFn> {
  return listen<ConnectionStatus>("ssh-status", (event) =>
    handler(event.payload),
  );
}
