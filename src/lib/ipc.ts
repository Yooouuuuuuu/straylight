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
  | { type: "auto"; identityFile?: string | null; passphrase?: string | null };

export type ConnectionState =
  | "connecting"
  | "connected"
  /** Probes failing/slow but no hard evidence of death — channels stay open
   *  and usable (possibly slow). Doubt is not death (docs/connections.md). */
  | "degraded"
  | "reconnecting"
  /** Reconnect gave up after the attempt cap and parked — the Reconnect button
   *  re-arms it (incident 2026-07-29: stops the forever-retry storm). */
  | "failed"
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
  /** The bytes weren't valid UTF-8 and were decoded with � replacements —
   *  the content is NOT a faithful copy of the file (saving is blocked). */
  lossy: boolean;
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

/** Open a session lane: a dedicated SSH connection for one SESSIONS/F11 agent
 *  (docs/connections.md Phase D). Errors with `SESSION_LANE_LIMIT:` at the
 *  per-host cap so the caller can fall back to the shared main connection. */
export function sessionLaneConnect(
  connId: string,
  label: string,
  limit: number,
): Promise<string> {
  return invoke("session_lane_connect", { connId, label, limit });
}

/** This window's boot (multi-window liveness, docs/dev/multi-window.md): clear
 *  the calling window's declared resources, then sweep anything no *live* window
 *  still needs. For the sole `main` window this equals the old `backend_reset`;
 *  a second window sharing main's connections leaves them untouched. */
export function windowBoot(): Promise<void> {
  return invoke("window_boot");
}

/** Mirror this window's connection list to the backend liveness registry,
 *  replacing its whole set (docs/dev/multi-window.md). Pushed whenever the list
 *  changes; the sweep keeps any connection ≥1 live window still shows. `conns`
 *  are ROOT connIds (local + each remote/WSL); a connection's PTYs, forwards,
 *  and session lanes cascade off it, so only connections are declared. */
export function windowSetRefs(refs: { conns: string[] }): Promise<void> {
  return invoke("window_set_refs", refs);
}

/** Publish the main window's connection list (JSON) so a workspace window can
 *  adopt the SAME connIds instead of dialing its own (docs/dev/multi-window.md).
 *  Main-only. */
export function setConnsSnapshot(snapshot: string): Promise<void> {
  return invoke("set_conns_snapshot", { snapshot });
}

/** Pull the latest published connection snapshot (null if main hasn't published
 *  yet). A workspace window calls this on boot. */
export function getConnsSnapshot(): Promise<string | null> {
  return invoke("get_conns_snapshot");
}

/** Live connection-snapshot updates (main connected/disconnected a host) so a
 *  workspace window stays in sync. */
export function onConnsSnapshot(
  handler: (snapshot: string) => void,
): Promise<UnlistenFn> {
  return listen<string>("conns-snapshot", (event) => handler(event.payload));
}

/** Publish the main window's CHAT-session list (JSON) so the sessions pop-out
 *  window can adopt it and re-attach to the same PTYs (docs/dev/multi-window.md).
 *  Main-only. */
export function setSessionsSnapshot(snapshot: string): Promise<void> {
  return invoke("set_sessions_snapshot", { snapshot });
}

/** Pull the latest session snapshot (null if none). The sessions window calls
 *  this on boot. */
export function getSessionsSnapshot(): Promise<string | null> {
  return invoke("get_sessions_snapshot");
}

/** Live session-snapshot updates (an agent opened/closed/renamed) so the sessions
 *  window stays current. */
export function onSessionsSnapshot(
  handler: (snapshot: string) => void,
): Promise<UnlistenFn> {
  return listen<string>("sessions-snapshot", (event) => handler(event.payload));
}

/** The sessions pop-out sets this true on boot / false on close so the main
 *  window can lock its CHAT panel while the sessions are popped out. */
export function setSessionsPopped(on: boolean): Promise<void> {
  return invoke("set_sessions_popped", { on });
}

/** Read the current popped-out state (main calls this on boot to restore its
 *  lock if it reloaded while the sessions window was open). */
export function getSessionsPopped(): Promise<boolean> {
  return invoke("get_sessions_popped");
}

/** Live popped-out state changes — main locks/unlocks its CHAT panel. */
export function onSessionsPopped(
  handler: (on: boolean) => void,
): Promise<UnlistenFn> {
  return listen<boolean>("sessions-popped", (event) => handler(event.payload));
}

/** The workspace window flags itself open/closed so main can lock its workspace
 *  button while it's open (docs/dev/multi-window.md). */
export function setWorkspacePopped(on: boolean): Promise<void> {
  return invoke("set_workspace_popped", { on });
}

/** Read the current workspace-open state (main, on boot). */
export function getWorkspacePopped(): Promise<boolean> {
  return invoke("get_workspace_popped");
}

/** Live workspace-open changes — main locks/unlocks its workspace button. */
export function onWorkspacePopped(
  handler: (on: boolean) => void,
): Promise<UnlistenFn> {
  return listen<boolean>("workspace-popped", (event) => handler(event.payload));
}

/** Stash a session's serialized terminal state for the window about to re-attach
 *  to it — set by the window releasing the view (docs/dev/multi-window.md). */
export function setSessionReplay(id: string, data: string): Promise<void> {
  return invoke("set_session_replay", { id, data });
}

/** Take (once) a session's stashed replay state; the attaching view writes it to
 *  reconstruct a full-screen TUI's modes/cursor/screen. Null if none. */
export function takeSessionReplay(id: string): Promise<string | null> {
  return invoke("take_session_replay", { id });
}

/** Claim a PTY's rendering for THIS window, so its output is emitted only here
 *  instead of broadcast to every window (docs/dev/multi-window.md). Called when a
 *  terminal view mounts. */
export function setPtyOwner(ptyId: string): Promise<void> {
  return invoke("set_pty_owner", { ptyId });
}

export function sshDisconnect(connId: string): Promise<void> {
  return invoke("ssh_disconnect", { connId });
}

/** Manually re-establish a dropped connection, keeping the same connId. */
export function sshReconnect(connId: string): Promise<void> {
  return invoke("ssh_reconnect", { connId });
}

/** Record an unknown host's key in `~/.ssh/known_hosts` after the user accepts
 *  its fingerprint. The stashed key is consumed; retry the connection after. */
export function sshTrustHost(host: string, port: number): Promise<void> {
  return invoke("ssh_trust_host", { host, port });
}

/** Close the web inspector if the debug WebView opened it (Ctrl+Shift+I is a
 *  browser-level accelerator the page can't preventDefault). */
export function closeDevtools(): Promise<void> {
  return invoke("ui_close_devtools");
}

/** Reveal a LOCAL path in the OS file manager (selects the item). */
export function revealPath(path: string): Promise<void> {
  return invoke("reveal_path", { path });
}

/** Open an http(s) URL in the default browser (the editor's Ctrl-click links —
 *  the WebView2 has no working window.open to an external browser). */
export function openExternal(url: string): Promise<void> {
  return invoke("open_external", { url });
}


// ---------------------------------------------------------------------------
// Filesystem (transport-agnostic: SFTP for SSH sessions, std::fs for local)
// ---------------------------------------------------------------------------

/** Open a local-filesystem session; returns its connection id. */
export function localConnect(): Promise<string> {
  return invoke("local_connect");
}

/** The local machine's filesystem roots — Windows drive letters (`C:\`, …) or
 *  `/` elsewhere — for switching disks in the folder browser. */
export function listDrives(): Promise<string[]> {
  return invoke("list_drives");
}

export function fsListDir(connId: string, path: string): Promise<DirListing> {
  return invoke("fs_list_dir", { connId, path });
}

/** List files under `root` (relative paths) for the fuzzy file finder. */
export function fsFind(connId: string, root: string): Promise<string[]> {
  return invoke("fs_find", { connId, root });
}

/** One search hit (path relative to root). */
export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

/** Literal, case-sensitive search under `root`. */
export function fsSearch(
  connId: string,
  root: string,
  query: string,
): Promise<SearchMatch[]> {
  return invoke("fs_search", { connId, root, query });
}

export function fsReadFile(connId: string, path: string): Promise<FileContent> {
  return invoke("fs_read_file", { connId, path });
}

/** A file's raw bytes as base64 — used to embed Markdown-preview images as
 *  `data:` URLs (relative `<img>` paths can't resolve in the packaged webview). */
export function fsReadBase64(connId: string, path: string): Promise<string> {
  return invoke("fs_read_base64", { connId, path });
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

/** Live progress for a batch transfer (the `transfer-progress` event). */
export interface TransferProgress {
  /** A lane died mid-transfer: the copy is parked and auto-resumes on
   *  reconnect (docs/connections.md Phase 2). */
  waiting: boolean;
  id: string;
  doneBytes: number;
  totalBytes: number;
  doneFiles: number;
  totalFiles: number;
  current: string;
}

/** What a finished (or cancelled) transfer copied. */
export interface TransferOutcome {
  files: number;
  bytes: number;
  cancelled: boolean;
  /** Symlinked directories skipped during the walk (a link cycle would loop). */
  skippedLinks: number;
  /** Entries skipped because the source couldn't be read (dangling link,
   *  broken submodule gitlink) — one bad entry no longer fails the batch. */
  skippedErrors: number;
}

/** Stream a batch of entries from one connection into a directory on another
 *  (copy-only), emitting `transfer-progress`. `renameOnConflict` resolves a
 *  top-level name clash by appending "copy", otherwise it overwrites a file /
 *  merges into an existing folder. `transferId` keys progress + cancellation.
 *  Pass `total` (from a pre-flight `fsMeasure`) to skip the copy's own size
 *  walk so a deep tree isn't measured twice. */
export function fsTransferBatch(
  transferId: string,
  srcConnId: string,
  srcPaths: string[],
  destConnId: string,
  destDir: string,
  renameOnConflict: boolean,
  total?: { bytes: number; files: number } | null,
  mode?: "full" | "background",
  limitBps?: number,
): Promise<TransferOutcome> {
  return invoke("fs_transfer_batch", {
    transferId,
    srcConnId,
    srcPaths,
    destConnId,
    destDir,
    renameOnConflict,
    totalBytes: total?.bytes ?? null,
    totalFiles: total?.files ?? null,
    mode: mode ?? null,
    limitBps: limitBps ?? null,
  });
}

/** Ask a running transfer to stop (it halts at the next chunk). */
export function fsTransferCancel(transferId: string): Promise<void> {
  return invoke("fs_transfer_cancel", { transferId });
}

/** Pre-flight size of a pending transfer, measured with the copy walk's exact
 *  rules so it matches the progress bar's total (symlinked dirs excluded). */
export interface TransferSize {
  files: number;
  bytes: number;
}

export function fsTransferMeasure(
  connId: string,
  paths: string[],
): Promise<TransferSize> {
  return invoke("fs_transfer_measure", { connId, paths });
}

/** Aggregate size + counts for the Properties dialog (recursive). */
export interface PropertiesInfo {
  files: number;
  folders: number;
  bytes: number;
}

/** Full metadata for a single path (Properties single-item detail). */
export function fsEntryMeta(connId: string, path: string): Promise<FileEntry> {
  return invoke("fs_entry_meta", { connId, path });
}

/** Recursively total files, folders, and bytes under `paths` (for Properties). */
export function fsMeasure(connId: string, paths: string[]): Promise<PropertiesInfo> {
  return invoke("fs_measure", { connId, paths });
}

export function onTransferProgress(
  handler: (progress: TransferProgress) => void,
): Promise<UnlistenFn> {
  return listen<TransferProgress>("transfer-progress", (event) =>
    handler(event.payload),
  );
}

/** Whether a transfer of `srcPath` into `destDir` on `destConnId` would collide
 *  with an existing top-level entry (so the UI can prompt). */
export function fsTransferCheck(
  srcPath: string,
  destConnId: string,
  destDir: string,
): Promise<boolean> {
  return invoke("fs_transfer_check", { srcPath, destConnId, destDir });
}

// ---------------------------------------------------------------------------
// Version control (git + jj)
// ---------------------------------------------------------------------------

export interface VcsRepoInfo {
  backend: string;
  root: string;
}

export interface VcsChange {
  /** Path relative to the repo root, forward-slash separated. */
  path: string;
  oldPath: string | null;
  /** modified | added | deleted | renamed | copied | typechange | conflicted | untracked */
  kind: string;
  staged: boolean;
}

export interface VcsStatus {
  backend: string;
  ref: string;
  ahead: number | null;
  behind: number | null;
  changes: VcsChange[];
  /** Head fingerprint — moves on any history rewrite (amend/rebase) even
   *  when the change list doesn't; used for "did anything change?" checks. */
  oid: string;
}

/** Validate that `dir` is a repository; returns its backend + root, or errors. */
export function vcsOpen(connId: string, dir: string): Promise<VcsRepoInfo> {
  return invoke("vcs_open", { connId, dir });
}

/** Run status for a repo root and return the normalized result. */
export function vcsStatus(
  connId: string,
  root: string,
  backend: string,
): Promise<VcsStatus> {
  return invoke("vcs_status", { connId, root, backend });
}

/** The base (pre-change) content of a file for the diff's old side. */
export interface VcsFileBase {
  content: string;
  exists: boolean;
  isBinary: boolean;
}

export function vcsFileBase(
  connId: string,
  root: string,
  backend: string,
  path: string,
): Promise<VcsFileBase> {
  return invoke("vcs_file_base", { connId, root, backend, path });
}

/** Stage paths in the git index (git only). */
export function vcsStage(connId: string, root: string, paths: string[]): Promise<void> {
  return invoke("vcs_stage", { connId, root, paths });
}

/** Unstage paths from the git index. */
export function vcsUnstage(
  connId: string,
  root: string,
  paths: string[],
): Promise<void> {
  return invoke("vcs_unstage", { connId, root, paths });
}

/** Commit: git commits the staged set; jj commits the working change + starts a new one. */
export function vcsCommit(
  connId: string,
  root: string,
  backend: string,
  message: string,
): Promise<void> {
  return invoke("vcs_commit", { connId, root, backend, message });
}

/** One commit in the history graph. */
export interface VcsCommit {
  id: string;
  parents: string[];
  author: string;
  /** Unix seconds. */
  timestamp: number;
  subject: string;
  refs: string[];
  current: boolean;
}

/** Commit history (newest first) for the repo. */
export function vcsLog(
  connId: string,
  root: string,
  backend: string,
  limit: number,
): Promise<VcsCommit[]> {
  return invoke("vcs_log", { connId, root, backend, limit });
}

/** Fetch / pull / push. Returns the command output (for a toast). */
export function vcsRemote(
  connId: string,
  root: string,
  backend: string,
  op: "fetch" | "pull" | "push",
): Promise<string> {
  return invoke("vcs_remote", { connId, root, backend, op });
}

/** Create an annotated tag at HEAD (git only), optionally pushing it to origin.
 *  Empty message → the tag name is used. Returns a status line for a toast. */
export function vcsTag(
  connId: string,
  root: string,
  name: string,
  message: string,
  push: boolean,
): Promise<string> {
  return invoke("vcs_tag", { connId, root, name, message, push });
}

/** Files changed by one commit (vs its parent), for browsing history. */
export function vcsCommitFiles(
  connId: string,
  root: string,
  backend: string,
  commit: string,
): Promise<VcsChange[]> {
  return invoke("vcs_commit_files", { connId, root, backend, commit });
}

/** A file's content at a specific revision (for a commit's diffs). */
export function vcsFileAt(
  connId: string,
  root: string,
  backend: string,
  rev: string,
  path: string,
): Promise<VcsFileBase> {
  return invoke("vcs_file_at", { connId, root, backend, rev, path });
}

/** Discard working-tree changes for paths (destructive). */
export function vcsDiscard(
  connId: string,
  root: string,
  backend: string,
  paths: string[],
): Promise<void> {
  return invoke("vcs_discard", { connId, root, backend, paths });
}

/** Watch a **local** repo root for filesystem changes (live status). */
export function vcsWatch(connId: string, root: string): Promise<void> {
  return invoke("vcs_watch", { connId, root });
}

export function vcsUnwatch(connId: string, root: string): Promise<void> {
  return invoke("vcs_unwatch", { connId, root });
}

/** Debounced burst of filesystem changes under a watched repo root. */
export interface VcsFsChange {
  connId: string;
  root: string;
}

export function onVcsFsChange(
  handler: (change: VcsFsChange) => void,
): Promise<UnlistenFn> {
  return listen<VcsFsChange>("vcs-fs-change", (event) => handler(event.payload));
}

/** The real Windows build number (0 elsewhere/unknown) — xterm's ConPTY
 *  reflow heuristics are keyed by it. */
export function windowsBuildNumber(): Promise<number> {
  return invoke("windows_build_number");
}

/** Watch a pinned **local** folder (recursive) for the explorer tree. */
export function dirWatch(connId: string, root: string): Promise<void> {
  return invoke("dir_watch", { connId, root });
}

export function dirUnwatch(connId: string, root: string): Promise<void> {
  return invoke("dir_unwatch", { connId, root });
}

/** Debounced external change somewhere under a watched pinned folder. */
export interface DirFsChange {
  connId: string;
  root: string;
}

export function onDirFsChange(
  handler: (change: DirFsChange) => void,
): Promise<UnlistenFn> {
  return listen<DirFsChange>("dir-fs-change", (event) => handler(event.payload));
}

/** Watch one **local** open file for external changes (tab auto-reload). */
export function fileWatch(connId: string, path: string): Promise<void> {
  return invoke("file_watch", { connId, path });
}

export function fileUnwatch(connId: string, path: string): Promise<void> {
  return invoke("file_unwatch", { connId, path });
}

/** Debounced external change to a watched open file. */
export interface FileFsChange {
  connId: string;
  path: string;
}

export function onFileFsChange(
  handler: (change: FileFsChange) => void,
): Promise<UnlistenFn> {
  return listen<FileFsChange>("file-fs-change", (event) => handler(event.payload));
}

/** A branch (git) or bookmark (jj). */
export interface VcsBranch {
  name: string;
  current: boolean;
  /** Remote-tracking ("origin/x") — checkout creates the local branch. */
  remote?: boolean;
}

export function vcsBranches(
  connId: string,
  root: string,
  backend: string,
): Promise<VcsBranch[]> {
  return invoke("vcs_branches", { connId, root, backend });
}

export interface IncomingCommit {
  id: string;
  subject: string;
  author: string;
  timestamp: number | null;
}

export interface IncomingInfo {
  upstream: string | null;
  commits: IncomingCommit[];
}

/** Fetched-but-unmerged commits on the current branch's upstream (git). */
export function vcsIncoming(
  connId: string,
  root: string,
  backend: string,
): Promise<IncomingInfo> {
  return invoke("vcs_incoming", { connId, root, backend });
}

export function vcsSwitch(
  connId: string,
  root: string,
  backend: string,
  target: string,
): Promise<void> {
  return invoke("vcs_switch", { connId, root, backend, target });
}

export function vcsCreateBranch(
  connId: string,
  root: string,
  backend: string,
  name: string,
): Promise<void> {
  return invoke("vcs_create_branch", { connId, root, backend, name });
}

/** Amend the last commit (git only). */
export function vcsAmend(connId: string, root: string, message: string): Promise<void> {
  return invoke("vcs_amend", { connId, root, message });
}

/** git stash (git only). Returns the output. */
export function vcsStash(
  connId: string,
  root: string,
  op: "push" | "pop" | "drop" | "list",
  message: string,
): Promise<string> {
  return invoke("vcs_stash", { connId, root, op, message });
}

/** After a fetch: git merges `@{u}`; jj rebases onto `<target>@origin`. */
export function vcsUpdate(
  connId: string,
  root: string,
  backend: string,
  target: string,
): Promise<string> {
  return invoke("vcs_update", { connId, root, backend, target });
}

/** Cancel the repo's in-flight remote op (fetch / push / update), if any. */
export function vcsRemoteCancel(connId: string, root: string): Promise<void> {
  return invoke("vcs_remote_cancel", { connId, root });
}

// ---------------------------------------------------------------------------
// Staged saves (docs/atomic-save.md)
// ---------------------------------------------------------------------------

/** Dispatch the detached server-side commit of a staged save: hash-guard the
 *  target (`expectedHash`; "-" skips — explicit Overwrite), cp the uploaded
 *  temp into its inode, cmp-verify, acknowledge via the ok/err marker.
 *  Returns once the job is STARTED (survives a connection drop). */
export function saveCommit(
  connId: string,
  dir: string,
  tmp: string,
  orig: string,
  okMarker: string,
  errMarker: string,
  expectedHash: string,
): Promise<void> {
  return invoke("save_commit", {
    connId,
    dir,
    tmp,
    orig,
    okMarker,
    errMarker,
    expectedHash,
  });
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

/** Absolute path of settings.json in the app config dir (dir created). */
export function settingsPath(): Promise<string> {
  return invoke("settings_path");
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

/** A running container on some connected host. */
export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  ports: string;
  engine: string;
}

/** Running containers on the host (podman preferred, else docker; [] if none). */
export function containerList(connId: string): Promise<ContainerInfo[]> {
  return invoke("container_list", { connId });
}

// ---------------------------------------------------------------------------
// Port forwarding
// ---------------------------------------------------------------------------

export interface ForwardInfo {
  id: string;
  connId: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  /** The most recent tunnel failure for this forward, if any. */
  lastError?: string | null;
}

/** A live tunnel failure on an active forward (also stored on the forward). */
export function onPortForwardError(
  handler: (e: { id: string; message: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ id: string; message: string }>("port-forward-error", (event) =>
    handler(event.payload),
  );
}

export function portForwardStart(
  connId: string,
  localPort: number,
  remoteHost: string,
  remotePort: number,
): Promise<ForwardInfo> {
  return invoke("port_forward_start", { connId, localPort, remoteHost, remotePort });
}

export function portForwardStop(id: string): Promise<void> {
  return invoke("port_forward_stop", { id });
}

export function portForwardList(): Promise<ForwardInfo[]> {
  return invoke("port_forward_list");
}

// ---------------------------------------------------------------------------
// WSL
// ---------------------------------------------------------------------------

export interface WslDistro {
  name: string;
  /** The distro a bare `wsl` targets. */
  isDefault: boolean;
  running: boolean;
}

/** List installed WSL distros (empty on non-Windows or when WSL is absent). */
export function wslListDistros(): Promise<WslDistro[]> {
  return invoke("wsl_list_distros");
}

/** Pre-connect probe: is the distro's sshd already listening on its
 *  deterministic localhost port? (~400 ms cap.) */
export function wslProbeSsh(distro: string): Promise<boolean> {
  return invoke("wsl_probe_ssh", { distro });
}

export interface PortInfo {
  port: number;
  address: string;
  pid: number | null;
  process: string | null;
}

/** Listening TCP ports on a host (ss/netstat on unix, PowerShell locally). */
export function portList(connId: string): Promise<PortInfo[]> {
  return invoke("port_list", { connId });
}

/** Provision (if allowed) and connect to a WSL distro; returns its connection
 *  id (a localhost SSH connection) plus the login user (for `user@distro`
 *  labels). Rejects with a `WSL_NEEDS_INSTALL:` prefix when the distro has no
 *  SSH server and `allowInstall` was false. */
export function wslConnect(
  distro: string,
  allowInstall: boolean,
): Promise<{ connId: string; user: string }> {
  return invoke("wsl_connect", { distro, allowInstall });
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

/** A self-diagnostics alert (CPU spin tripwire, connection recycle, strict-server
 *  cap) the backend wants surfaced as a toast (incident 2026-07-29). */
export function onDiagAlert(
  handler: (a: { level: "info" | "warn" | "error"; message: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ level: "info" | "warn" | "error"; message: string }>(
    "diag-alert",
    (event) => handler(event.payload),
  );
}

/** Write the in-memory diagnostics ring buffer to a file; returns its path. */
export function diagDump(): Promise<string> {
  return invoke("diag_dump");
}

/** A local path handed to us by the Windows "Open with Straylight" right-click
 *  verb (`straylight.exe "<path>"`). A folder becomes a pinned Local root; a
 *  file opens in the editor. */
export interface OpenTarget {
  path: string;
  isDir: boolean;
}

/** Pick up a first-launch "Open with Straylight" path (null if none / already
 *  taken). Call once the Local connection is ready. */
export function takeOpenPath(): Promise<OpenTarget | null> {
  return invoke("take_open_path");
}

/** A "Open with Straylight" path forwarded from a second launch while the app
 *  was already running (single-instance). */
export function onOpenPath(
  handler: (t: OpenTarget) => void,
): Promise<UnlistenFn> {
  return listen<OpenTarget>("open-path", (event) => handler(event.payload));
}
