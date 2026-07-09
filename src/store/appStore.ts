/**
 * Global application state (Zustand).
 *
 * A window always has a **local** session and may attach **one remote** SSH
 * connection. Files open as **tabs**; each tab owns its own content (in a Monaco
 * model), dirty state, and cursor, so switching tabs never loses edits.
 */
import { create } from "zustand";

import { basename } from "../lib/format";
import {
  fsTransferBatch,
  fsTransferCancel,
  type ConnectionState,
  type SshHostEntry,
  type TransferProgress,
} from "../lib/ipc";

/** The one in-flight cross-connection transfer (global, so it survives the
 *  transfer panel closing and shows in the status bar too). */
export interface ActiveTransfer {
  id: string;
  /** "Local → Ubuntu" — source → destination, for the status-bar line. */
  label: string;
  doneBytes: number;
  totalBytes: number;
  doneFiles: number;
  totalFiles: number;
  current: string;
}

export interface CursorPosition {
  line: number;
  column: number;
}

/** A node in the file tree, used for selection and operations. */
export interface TreeNode {
  connId: string;
  path: string;
  name: string;
  isDir: boolean;
}

/** One open file in the editor. The live text lives in a Monaco model keyed by
 *  `id`; `content` is the seed used to create that model. */
export interface EditorTab {
  /** Unique id: `${connId}::${path}`. */
  id: string;
  connId: string;
  path: string;
  name: string;
  content: string;
  language: string;
  isBinary: boolean;
  encoding: string;
  size: number;
  modified: number;
  truncated: boolean;
  lineEnding: "LF" | "CRLF";
  dirty: boolean;
  cursor: CursorPosition;
  /** "diff" shows a Monaco diff; "log" shows a repo's commit history;
   *  "terminal" hosts a terminal session in the editor area. Default "file". */
  kind?: "file" | "diff" | "log" | "merge" | "preview" | "terminal" | "settings" | "themes";
  /** Which editor group (split) the tab lives in. Absent = group 0. */
  groupId?: number;
  /** The terminal session a kind:"terminal" tab hosts. */
  terminalId?: string;
  /** VS Code-style preview tab (italic): the next preview open replaces it.
   *  Editing, double-click, or pinning promotes it to a permanent tab. */
  previewTab?: boolean;
  /** Pinned tabs sit leftmost, are spared by bulk closes, and Ctrl+W skips them. */
  pinned?: boolean;
  /** The base (HEAD / jj `@-`) content, for a diff tab's old side. */
  diffBase?: string;
  /** Whether the file exists in the base (false = added/untracked). */
  diffBaseExists?: boolean;
  /** Backend ("git" | "jj") for a log tab (path holds the repo root). */
  vcsBackend?: string;
}

export type NewTab = Omit<EditorTab, "id" | "dirty" | "cursor">;

// ---- editor groups (splits) -------------------------------------------------

export const MAX_EDITOR_GROUPS = 3;

/** DataTransfer type for dragging editor tabs (reorder / move / split). */
export const TAB_DRAG_MIME = "application/x-straylight-tab";

const gidOf = (t: EditorTab): number => t.groupId ?? 0;

interface GroupsSlice {
  tabs: EditorTab[];
  editorGroups: number[];
  groupActive: Record<number, string | null>;
  activeGroupId: number;
  activeTabId: string | null;
}

/** Recompute the group bookkeeping after any tab/group change: drops emptied
 *  groups (keeping at least one), repairs each group's active tab, and focuses
 *  `focusId` (undefined = keep the current focus if still valid). */
function groupsPatch(
  s: GroupsSlice,
  tabs: EditorTab[],
  focusId?: string | null,
): GroupsSlice {
  const present = new Set(tabs.map(gidOf));
  let editorGroups = s.editorGroups.filter((g) => present.has(g));
  for (const g of present) {
    if (!editorGroups.includes(g)) editorGroups.push(g);
  }
  if (editorGroups.length === 0) editorGroups = [0];

  const groupActive: Record<number, string | null> = {};
  for (const g of editorGroups) {
    const prev = s.groupActive[g];
    groupActive[g] =
      prev && tabs.some((t) => t.id === prev && gidOf(t) === g)
        ? prev
        : (tabs.find((t) => gidOf(t) === g)?.id ?? null);
  }

  let activeTabId = focusId !== undefined ? focusId : s.activeTabId;
  if (activeTabId && !tabs.some((t) => t.id === activeTabId)) activeTabId = null;
  let activeGroupId = s.activeGroupId;
  if (activeTabId) {
    activeGroupId = gidOf(tabs.find((t) => t.id === activeTabId)!);
    groupActive[activeGroupId] = activeTabId;
  } else {
    if (!editorGroups.includes(activeGroupId)) {
      // The focused group vanished — fall back to its former neighbor.
      const oldIdx = s.editorGroups.indexOf(activeGroupId);
      activeGroupId =
        editorGroups[Math.max(0, Math.min(oldIdx - 1, editorGroups.length - 1))] ??
        editorGroups[0];
    }
    activeTabId = groupActive[activeGroupId] ?? null;
  }
  return { tabs, editorGroups, groupActive, activeGroupId, activeTabId };
}

/** The window's single remote SSH connection. */
export interface RemoteConnection {
  connId: string;
  name: string;
  host: string;
  user: string;
  port: number;
  color: string;
  /** Auth method used — a key-based host can be silently auto-reconnected on
   *  restart; a password host cannot (we never persist the password). */
  authType: "auto" | "password";
  /** IdentityFile for key auth, if any (null for password / default keys). */
  identityFile: string | null;
  proxyJump: string | null;
}

/** One open terminal instance. Its xterm + PTY live in the component, keyed by
 *  `id`; `epoch` is bumped to force a restart (e.g. after a reconnect). */
export interface TerminalSession {
  id: string;
  /** The session this terminal runs on (local or remote). */
  connId: string;
  title: string;
  /** Shell command for a local profile (e.g. ["wsl.exe","-d","Ubuntu"]); null
   *  uses the session's default shell. Ignored for remote (login shell). */
  command: string[] | null;
  /** Typed into the shell once it opens (e.g. `podman exec -it … /bin/sh`). */
  initialInput?: string | null;
  epoch: number;
  /** Shown as an editor tab instead of in the panel (the shell survives the
   *  move — its DOM is reparented, never remounted). */
  inEditor?: boolean;
}

export interface Notice {
  id: number;
  kind: "info" | "warn" | "error";
  text: string;
}

const PINNED_KEY = "straylight.pinnedFolders";

function loadPinned(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function savePinned(folders: string[]): void {
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify(folders));
  } catch {
    /* ignore */
  }
}

// Pinned working dirs for remote/WSL connections, persisted per connection
// identity so they survive a reconnect or relaunch. Remote is keyed by
// `user@host:port`; WSL by distro name. (The local session uses PINNED_KEY.)
const REMOTE_PINS_KEY = "straylight.remotePins";
const WSL_PINS_KEY = "straylight.wslPins";

function loadPinMap(key: string): Record<string, string[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "null");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
      }
      return out;
    }
  } catch {
    /* ignore */
  }
  return {};
}

/** Saved pins for a connection id, or null when none (so the caller can fall
 *  back to seeding the home dir). */
function loadConnPins(key: string, id: string): string[] | null {
  const pins = loadPinMap(key)[id];
  return pins && pins.length ? pins : null;
}

function saveConnPins(key: string, id: string, pins: string[]): void {
  const map = loadPinMap(key);
  map[id] = pins;
  try {
    localStorage.setItem(key, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

export function remoteHostKey(r: RemoteConnection): string {
  return `${r.user}@${r.host}:${r.port}`;
}

// ---- multi-remote -----------------------------------------------------------

export const MAX_REMOTES = 3;

/** One attached remote host: its connection plus per-host explorer state.
 *  The window holds up to MAX_REMOTES of these, each with its own host bar. */
export interface RemoteWorkspace {
  conn: RemoteConnection;
  rootPath: string;
  pins: string[];
  showHidden: boolean;
  refreshToken: number;
  lastRefresh: number | null;
  state: ConnectionState;
}

/** Legacy single-remote fields, mirrored from the primary (first) remote so
 *  surfaces that only care about "the remote" keep working unchanged. */
function remoteMirror(remotes: RemoteWorkspace[]) {
  const p = remotes[0] ?? null;
  return {
    remotes,
    remote: p?.conn ?? null,
    remoteRootPath: p?.rootPath ?? null,
    remotePins: p?.pins ?? [],
    showHiddenRemote: p?.showHidden ?? false,
    refreshTokenRemote: p?.refreshToken ?? 0,
    lastRefreshRemote: p?.lastRefresh ?? null,
  };
}

// Host identity colors, keyed by `user@host:port` (remote hosts only — Local
// and WSL use their section colors). Persisted so prod stays "its" color.
const HOST_COLORS_KEY = "straylight.hostColors";
/** Default ramp for newly-seen hosts, by remote slot. Starts at the Remote
 *  section color (NOT red — that's Local's), and stops short of pure green
 *  (`var(--green)` means "tracked repo" in the tree). */
export const HOST_COLOR_RAMP = ["var(--section-remote)", "#ff8a00", "#d8e626"];

function loadHostColors(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(HOST_COLORS_KEY) ?? "null");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    /* ignore */
  }
  return {};
}

// Which explorer sections are shown (the L / W / R toggles). Hiding never
// touches the connection — just the section's rendering.
const SECTIONS_KEY = "straylight.sections";
export interface SectionVisibility {
  local: boolean;
  wsl: boolean;
  remote: boolean;
}
function loadSections(): SectionVisibility {
  try {
    const parsed = JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? "null");
    if (parsed && typeof parsed === "object") {
      return {
        local: parsed.local !== false,
        wsl: parsed.wsl !== false,
        remote: parsed.remote !== false,
      };
    }
  } catch {
    /* ignore */
  }
  return { local: true, wsl: true, remote: true };
}

/** Where a new terminal opens. "auto" = first active of remote → WSL → local. */
export type TerminalTargetPref = "auto" | "local" | "remote" | "wsl";
const TERM_TARGET_KEY = "straylight.newTerminalTarget";
function loadTermTarget(): TerminalTargetPref {
  const v = localStorage.getItem(TERM_TARGET_KEY);
  return v === "local" || v === "remote" || v === "wsl" ? v : "auto";
}

interface AppState {
  // Local session (always available) ------------------------------------
  localConnId: string | null;
  pinnedFolders: string[];

  // Remote (optional, one) ----------------------------------------------
  remote: RemoteConnection | null;
  remoteRootPath: string | null;
  /** Working dirs shown for the remote (seeded with home on connect). Session-
   *  only — reset on disconnect, since the connection itself isn't persisted. */
  remotePins: string[];
  /** WSL distro connection — its own slot (an SSH connection to localhost). */
  wsl: RemoteConnection | null;
  wslRootPath: string | null;
  /** Working dirs shown for the WSL distro (seeded with home on connect). */
  wslPins: string[];
  connState: ConnectionState;
  connMessage: string | null;

  // UI -------------------------------------------------------------------
  dialogOpen: boolean;
  dialogPrefill: SshHostEntry | null;
  /** Optional note shown atop the connect dialog (e.g. why it opened). */
  dialogNote: string | null;
  /** True while the transfer panel is open — so global F2/Delete don't act on
   *  the explorer selection while the transfer pane owns those keys. */
  transferOpen: boolean;
  /** The fuzzy file finder (Ctrl+P) overlay. */
  finderOpen: boolean;
  /** The search-in-files (Ctrl+Shift+F) overlay. */
  searchOpen: boolean;
  /** The port-forwarding overlay. */
  portsOpen: boolean;
  /** The command palette (Ctrl+Shift+P). */
  paletteOpen: boolean;
  /** Problems found in settings.json (shown in the palette; empty = healthy). */
  settingsIssues: string[];
  /** A line to reveal once a file's editor model is ready (from search). */
  revealTarget: { connId: string; path: string; line: number } | null;
  sidebarVisible: boolean;
  terminalVisible: boolean;
  /** User preference for which workspace a new terminal opens on. */
  newTerminalTarget: TerminalTargetPref;
  // Explorer controls are per-section: Local and Remote each keep their own
  // hidden-files toggle, refresh token, and "last refreshed" timestamp.
  showHiddenLocal: boolean;
  showHiddenRemote: boolean;
  showHiddenWsl: boolean;
  refreshTokenLocal: number;
  refreshTokenRemote: number;
  refreshTokenWsl: number;
  lastRefreshLocal: number | null;
  lastRefreshRemote: number | null;
  lastRefreshWsl: number | null;
  /** Identity colors for remote hosts (`user@host:port` → color). */
  hostColors: Record<string, string>;
  /** Explorer section visibility (the L / W / R header toggles). */
  sections: SectionVisibility;

  // Terminals ------------------------------------------------------------
  terminals: TerminalSession[];
  activeTerminalId: string | null;

  // Editor tabs ----------------------------------------------------------
  tabs: EditorTab[];
  activeTabId: string | null;
  busyPath: string | null;
  /** A save refused because the file changed on disk; holds the pending content. */
  conflict: { tabId: string; content: string } | null;
  /** A close blocked by unsaved changes, awaiting the user's choice. */
  closeConfirm: { tabId: string } | null;

  // File tree operations -------------------------------------------------
  /** The anchor node — last clicked; drives rename, keyboard nav, new-file target. */
  selected: TreeNode | null;
  /** The full multi-selection (always within one connection; includes the anchor). */
  selection: TreeNode[];
  contextMenu: (TreeNode & { x: number; y: number }) | null;
  /** Items shown in the Properties dialog (one or many), or null when closed. */
  propertiesFor: TreeNode[] | null;
  /** The one in-flight transfer, or null when idle. */
  activeTransfer: ActiveTransfer | null;
  renaming: { connId: string; path: string } | null;
  newEntry: { connId: string; parent: string; isDir: boolean } | null;
  /** Items pending delete confirmation (one or many). */
  confirmDelete: TreeNode[] | null;
  /** Cut/copy buffer for the explorer; paste drops it into a folder. */
  clipboard: { mode: "cut" | "copy"; node: TreeNode } | null;

  // Notifications --------------------------------------------------------
  notices: Notice[];

  // Actions --------------------------------------------------------------
  setLocalConnId: (id: string) => void;
  addPinnedFolder: (path: string) => void;
  removePinnedFolder: (path: string) => void;

  /** All attached remotes (≤ MAX_REMOTES); `remote` etc. mirror the first. */
  remotes: RemoteWorkspace[];
  /** Add (or refresh, matched by user@host:port) a connected remote. */
  setRemote: (remote: RemoteConnection, rootPath: string) => void;
  /** Detach one remote (closing its tabs/terminals); no arg = the primary. */
  clearRemote: (connId?: string) => void;
  /** Per-remote connection state (host bar dot / reconnect). */
  setRemoteState: (connId: string, state: ConnectionState, message?: string | null) => void;
  addRemotePin: (connId: string, path: string) => void;
  removeRemotePin: (connId: string, path: string) => void;
  setWsl: (wsl: RemoteConnection, rootPath: string) => void;
  clearWsl: () => void;
  addWslPin: (path: string) => void;
  removeWslPin: (path: string) => void;
  setConnState: (state: ConnectionState, message?: string | null) => void;

  setDialogOpen: (open: boolean) => void;
  openDialog: (prefill?: SshHostEntry | null, note?: string | null) => void;
  setTransferOpen: (open: boolean) => void;
  setFinderOpen: (open: boolean) => void;
  setSearchOpen: (open: boolean) => void;
  setPortsOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setSettingsIssues: (issues: string[]) => void;
  setRevealTarget: (t: { connId: string; path: string; line: number } | null) => void;
  toggleSidebar: () => void;
  setSidebarVisible: (visible: boolean) => void;
  toggleTerminal: () => void;
  setTerminalVisible: (visible: boolean) => void;
  setNewTerminalTarget: (target: TerminalTargetPref) => void;
  toggleHiddenLocal: () => void;
  toggleHiddenRemote: (connId: string) => void;
  toggleHiddenWsl: () => void;
  /** Set (or null = reset to the auto ramp) a remote host's identity color. */
  setHostColor: (hostKey: string, color: string | null) => void;
  toggleSection: (which: keyof SectionVisibility) => void;
  refreshLocal: () => void;
  /** Refresh one remote's trees, or all remotes when no id is given. */
  refreshRemote: (connId?: string) => void;
  refreshWsl: () => void;
  /** Refresh whichever section owns this connection (used after file ops). */
  refreshConn: (connId: string) => void;
  /** Stamp a section's "last refreshed" time once its tree has actually loaded. */
  markRefreshed: (connId: string) => void;

  openTerminal: (
    connId: string,
    label: string,
    command?: string[] | null,
    initialInput?: string | null,
  ) => void;
  closeTerminal: (id: string) => void;
  setActiveTerminal: (id: string) => void;
  /** What the terminal panel body shows: the terminals, or a tool group. */
  terminalView: "terminals" | "containers" | "ports" | "forwarding" | "transfers";
  setTerminalView: (
    v: "terminals" | "containers" | "ports" | "forwarding" | "transfers",
  ) => void;
  /** Panel group-bar order (conn ids; unknown/new conns append). Draggable. */
  termGroupOrder: string[];
  setTermGroupOrder: (order: string[]) => void;
  /** The right-side terminal list collapsed to icons only. */
  termListMini: boolean;
  setTermListMini: (mini: boolean) => void;
  /** Ports table → Forwarding: prefill for the next forward. */
  forwardPrefill: { connId: string; port: number } | null;
  setForwardPrefill: (p: { connId: string; port: number } | null) => void;
  /** Last-known counts for the tool chips (filled while a tab polls). */
  portCounts: Record<string, number>;
  setPortCounts: (c: Record<string, number>) => void;
  containerCounts: Record<string, number>;
  setContainerCounts: (c: Record<string, number>) => void;
  forwardCount: number;
  setForwardCount: (n: number) => void;
  /** Startup "connect to last …?" asks, shown one at a time. Skipping runs
   *  `onSkip` (drops the host from the saved session — no re-ask next time). */
  connectAsks: { kind: "wsl" | "remote"; label: string; run: () => void; onSkip?: () => void }[];
  pushConnectAsk: (a: { kind: "wsl" | "remote"; label: string; run: () => void; onSkip?: () => void }) => void;
  shiftConnectAsk: () => void;
  /** Reorder terminals in the list (drag). */
  moveTerminal: (fromId: string, toId: string) => void;
  cycleTerminal: (direction: 1 | -1) => void;
  /** Restart every terminal on a connection (its PTYs died — e.g. a reconnect). */
  restartConnTerminals: (connId: string) => void;
  /** Close every terminal on a connection (e.g. an explicit disconnect). */
  closeConnTerminals: (connId: string) => void;

  // Editor groups (splits, max MAX_EDITOR_GROUPS side by side) --------------
  /** Ordered group ids, left to right. Always at least one. */
  editorGroups: number[];
  /** The focused group (openTab targets it). */
  activeGroupId: number;
  /** Each group's active tab. `activeTabId` mirrors the focused group's. */
  groupActive: Record<number, string | null>;
  setActiveGroup: (gid: number) => void;
  /** Move a tab into a new group — right of its own, or at the far right. */
  splitRight: (tabId: string, opts?: { end?: boolean }) => void;
  /** Move a tab into an existing group. */
  moveTabToGroup: (tabId: string, gid: number) => void;
  /** Drag-drop: place a tab in `gid` before `beforeId` (null = group end).
   *  Same group = reorder; different group = move. */
  moveTabToPosition: (tabId: string, gid: number, beforeId: string | null) => void;
  /** Session restore: reassign tabs to groups in one pass. */
  setTabGroups: (byTabId: Record<string, number>) => void;
  /** Pull a terminal session out of the panel into an editor tab. */
  moveTerminalToEditor: (terminalId: string) => void;
  /** Open (or focus) the Settings / Themes editor tabs. */
  openAppTab: (kind: "settings" | "themes") => void;

  openTab: (tab: NewTab, opts?: { preview?: boolean; pinned?: boolean }) => void;
  /** Promote a preview tab to permanent (double-click, edit, pin). */
  promoteTab: (id: string) => void;
  /** Pin/unpin a tab; pinning also moves it to the end of the pinned block. */
  pinTab: (id: string, pinned: boolean) => void;
  /** Tab-bar right-click menu state. */
  tabMenu: { x: number; y: number; tabId: string } | null;
  openTabMenu: (x: number, y: number, tabId: string) => void;
  closeTabMenu: () => void;
  /** Open (or focus) a read-only diff tab for a changed file. */
  openDiffTab: (d: {
    connId: string;
    name: string;
    path: string;
    relPath: string;
    base: string;
    baseExists: boolean;
    content: string;
    language: string;
    isBinary: boolean;
  }) => void;
  /** Open (or focus) a rendered Markdown preview for a file. */
  openPreviewTab: (d: {
    connId: string;
    path: string;
    name: string;
    content: string;
  }) => void;
  /** Open (or focus) a 3-way merge editor for a conflicted file. */
  openMergeTab: (d: {
    connId: string;
    path: string;
    name: string;
    content: string;
    modified: number;
    language: string;
  }) => void;
  /** Open (or focus) a repo's commit-history tab. */
  openLogTab: (d: {
    connId: string;
    root: string;
    backend: string;
    label: string;
  }) => void;
  setActiveTab: (id: string) => void;
  cycleTab: (direction: 1 | -1) => void;
  closeTab: (id: string, allowPinned?: boolean) => void;
  forceCloseTab: (id: string) => void;
  setTabDirty: (id: string, dirty: boolean) => void;
  /** Mark a tab written to disk. `content` syncs the tab's seed text so the
   *  file watcher's reload guard recognizes our own save (else it would
   *  reload the file and wipe the undo history). */
  markTabSaved: (id: string, modified: number, content?: string) => void;
  /** Reflect an in-editor line-ending conversion (LF ⇄ CRLF). */
  setTabLineEnding: (id: string, eol: "LF" | "CRLF") => void;
  /** Replace a clean tab's content after an external reload (App Refresh). */
  reloadTabContent: (
    id: string,
    file: {
      content: string;
      size: number;
      modified: number;
      encoding: string;
      truncated: boolean;
    },
  ) => void;
  setTabCursor: (id: string, cursor: CursorPosition) => void;
  setBusyPath: (path: string | null) => void;

  setConflict: (tabId: string, content: string) => void;
  clearConflict: () => void;
  clearCloseConfirm: () => void;

  setSelected: (node: TreeNode | null) => void;
  /** Ctrl+click: toggle a node in the selection (resets across connections). */
  toggleSelected: (node: TreeNode) => void;
  /** Shift+click: replace the selection with a computed range, keeping `anchor`. */
  setSelection: (nodes: TreeNode[], anchor: TreeNode) => void;
  openContextMenu: (node: TreeNode, x: number, y: number) => void;
  closeContextMenu: () => void;
  openProperties: (nodes: TreeNode[]) => void;
  closeProperties: () => void;
  /** Start a streamed cross-connection transfer; progress is global. */
  runTransfer: (args: {
    transferId: string;
    srcConnId: string;
    srcPaths: string[];
    destConnId: string;
    destDir: string;
    rename: boolean;
    label: string;
    firstName: string;
  }) => Promise<void>;
  updateTransferProgress: (progress: TransferProgress) => void;
  cancelActiveTransfer: () => void;
  startRename: (connId: string, path: string) => void;
  cancelRename: () => void;
  openNewEntry: (connId: string, parent: string, isDir: boolean) => void;
  closeNewEntry: () => void;
  openConfirmDelete: (nodes: TreeNode[]) => void;
  closeConfirmDelete: () => void;
  applyRename: (connId: string, oldPath: string, newPath: string) => void;
  applyDelete: (connId: string, path: string) => void;
  setClipboard: (mode: "cut" | "copy", node: TreeNode) => void;
  clearClipboard: () => void;

  pushNotice: (kind: Notice["kind"], text: string) => void;
  dismissNotice: (id: number) => void;
}

let noticeId = 0;
let tabCounter = 0;
let terminalCounter = 0;

export const useAppStore = create<AppState>()((set, get) => ({
  localConnId: null,
  pinnedFolders: loadPinned(),

  remotes: [],
  remote: null,
  remoteRootPath: null,
  remotePins: [],
  wsl: null,
  wslRootPath: null,
  wslPins: [],
  connState: "disconnected",
  connMessage: null,

  dialogOpen: false,
  dialogPrefill: null,
  dialogNote: null,
  transferOpen: false,
  finderOpen: false,
  searchOpen: false,
  portsOpen: false,
  paletteOpen: false,
  settingsIssues: [],
  revealTarget: null,
  terminalView: "terminals" as const,
  sidebarVisible: true,
  terminalVisible: true,
  newTerminalTarget: loadTermTarget(),
  showHiddenLocal: false,
  showHiddenRemote: false,
  showHiddenWsl: false,
  refreshTokenLocal: 0,
  refreshTokenRemote: 0,
  refreshTokenWsl: 0,
  lastRefreshLocal: null,
  lastRefreshRemote: null,
  lastRefreshWsl: null,
  hostColors: loadHostColors(),
  sections: loadSections(),

  terminals: [],
  activeTerminalId: null,

  tabs: [],
  activeTabId: null,
  editorGroups: [0],
  activeGroupId: 0,
  groupActive: {},
  busyPath: null,
  conflict: null,
  closeConfirm: null,

  selected: null,
  selection: [],
  contextMenu: null,
  propertiesFor: null,
  activeTransfer: null,
  renaming: null,
  newEntry: null,
  confirmDelete: null,
  clipboard: null,

  notices: [],

  setLocalConnId: (localConnId) => set({ localConnId }),

  addPinnedFolder: (path) =>
    set((s) => {
      if (s.pinnedFolders.includes(path)) return {};
      const pinnedFolders = [...s.pinnedFolders, path];
      savePinned(pinnedFolders);
      return { pinnedFolders };
    }),

  removePinnedFolder: (path) =>
    set((s) => {
      const pinnedFolders = s.pinnedFolders.filter((p) => p !== path);
      savePinned(pinnedFolders);
      return { pinnedFolders };
    }),

  setRemote: (remote, rootPath) =>
    set((s) => {
      const key = remoteHostKey(remote);
      const fresh: RemoteWorkspace = {
        conn: remote,
        rootPath,
        pins: loadConnPins(REMOTE_PINS_KEY, key) ?? [rootPath],
        showHidden: false,
        refreshToken: 0,
        lastRefresh: null,
        state: "connected",
      };
      const idx = s.remotes.findIndex((r) => remoteHostKey(r.conn) === key);
      const remotes =
        idx >= 0
          ? // Re-connect to a known host: keep its pins/toggles, swap the conn.
            s.remotes.map((r, i) =>
              i === idx
                ? { ...fresh, pins: r.pins, showHidden: r.showHidden }
                : r,
            )
          : [...s.remotes, fresh];
      return { ...remoteMirror(remotes), connState: "connected", connMessage: null };
    }),

  clearRemote: (connId) =>
    set((s) => {
      const target = connId ?? s.remotes[0]?.conn.connId;
      if (!target) return {};
      const remotes = s.remotes.filter((r) => r.conn.connId !== target);
      // Close any tabs and terminals belonging to that remote.
      const tabs = s.tabs.filter((t) => t.connId !== target);
      const terminals = s.terminals.filter((t) => t.connId !== target);
      const activeTerminalId = terminals.some((t) => t.id === s.activeTerminalId)
        ? s.activeTerminalId
        : (terminals[terminals.length - 1]?.id ?? null);
      return {
        ...remoteMirror(remotes),
        connState: remotes[0]?.state ?? "disconnected",
        connMessage: null,
        ...(tabs.length !== s.tabs.length ? groupsPatch(s, tabs) : {}),
        terminals,
        activeTerminalId,
      };
    }),

  setRemoteState: (connId, state, message = null) =>
    set((s) => {
      const remotes = s.remotes.map((r) =>
        r.conn.connId === connId ? { ...r, state } : r,
      );
      const primary = remotes[0]?.conn.connId === connId;
      return {
        remotes,
        ...(primary ? { connState: state, connMessage: message } : {}),
      };
    }),

  addRemotePin: (connId, path) =>
    set((s) => {
      const entry = s.remotes.find((r) => r.conn.connId === connId);
      if (!entry || entry.pins.includes(path)) return {};
      const pins = [...entry.pins, path];
      saveConnPins(REMOTE_PINS_KEY, remoteHostKey(entry.conn), pins);
      return remoteMirror(
        s.remotes.map((r) => (r.conn.connId === connId ? { ...r, pins } : r)),
      );
    }),
  removeRemotePin: (connId, path) =>
    set((s) => {
      const entry = s.remotes.find((r) => r.conn.connId === connId);
      if (!entry) return {};
      const pins = entry.pins.filter((p) => p !== path);
      saveConnPins(REMOTE_PINS_KEY, remoteHostKey(entry.conn), pins);
      return remoteMirror(
        s.remotes.map((r) => (r.conn.connId === connId ? { ...r, pins } : r)),
      );
    }),

  setWsl: (wsl, rootPath) =>
    set({
      wsl,
      wslRootPath: rootPath,
      wslPins: loadConnPins(WSL_PINS_KEY, wsl.name) ?? [rootPath],
    }),
  clearWsl: () =>
    set((s) => {
      const id = s.wsl?.connId;
      const tabs = id ? s.tabs.filter((t) => t.connId !== id) : s.tabs;
      const activeTabId = tabs.some((t) => t.id === s.activeTabId)
        ? s.activeTabId
        : (tabs[tabs.length - 1]?.id ?? null);
      const terminals = id ? s.terminals.filter((t) => t.connId !== id) : s.terminals;
      const activeTerminalId = terminals.some((t) => t.id === s.activeTerminalId)
        ? s.activeTerminalId
        : (terminals[terminals.length - 1]?.id ?? null);
      return {
        wsl: null,
        wslRootPath: null,
        wslPins: [],
        tabs,
        activeTabId,
        terminals,
        activeTerminalId,
      };
    }),
  addWslPin: (path) =>
    set((s) => {
      if (s.wslPins.includes(path)) return {};
      const wslPins = [...s.wslPins, path];
      if (s.wsl) saveConnPins(WSL_PINS_KEY, s.wsl.name, wslPins);
      return { wslPins };
    }),
  removeWslPin: (path) =>
    set((s) => {
      const wslPins = s.wslPins.filter((p) => p !== path);
      if (s.wsl) saveConnPins(WSL_PINS_KEY, s.wsl.name, wslPins);
      return { wslPins };
    }),
  setConnState: (state, message = null) => set({ connState: state, connMessage: message }),

  setDialogOpen: (dialogOpen) =>
    set(
      dialogOpen
        ? { dialogOpen }
        : { dialogOpen, dialogPrefill: null, dialogNote: null },
    ),
  openDialog: (prefill = null, note = null) =>
    set({ dialogOpen: true, dialogPrefill: prefill, dialogNote: note }),
  setTransferOpen: (transferOpen) => set({ transferOpen }),
  setFinderOpen: (finderOpen) => set({ finderOpen }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setPortsOpen: (portsOpen) => set({ portsOpen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setSettingsIssues: (settingsIssues) => set({ settingsIssues }),
  setRevealTarget: (revealTarget) => set({ revealTarget }),
  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  setSidebarVisible: (sidebarVisible) => set({ sidebarVisible }),
  toggleTerminal: () => set((s) => ({ terminalVisible: !s.terminalVisible })),
  setTerminalVisible: (terminalVisible) => set({ terminalVisible }),
  setNewTerminalTarget: (newTerminalTarget) => {
    try {
      localStorage.setItem(TERM_TARGET_KEY, newTerminalTarget);
    } catch {
      /* ignore */
    }
    set({ newTerminalTarget });
  },
  toggleHiddenLocal: () => set((s) => ({ showHiddenLocal: !s.showHiddenLocal })),
  toggleHiddenRemote: (connId) =>
    set((s) =>
      remoteMirror(
        s.remotes.map((r) =>
          r.conn.connId === connId ? { ...r, showHidden: !r.showHidden } : r,
        ),
      ),
    ),
  toggleHiddenWsl: () => set((s) => ({ showHiddenWsl: !s.showHiddenWsl })),
  setHostColor: (hostKey, color) =>
    set((s) => {
      const hostColors = { ...s.hostColors };
      if (color === null) delete hostColors[hostKey];
      else hostColors[hostKey] = color;
      try {
        localStorage.setItem(HOST_COLORS_KEY, JSON.stringify(hostColors));
      } catch {
        /* ignore */
      }
      return { hostColors };
    }),
  toggleSection: (which) =>
    set((s) => {
      const sections = { ...s.sections, [which]: !s.sections[which] };
      try {
        localStorage.setItem(SECTIONS_KEY, JSON.stringify(sections));
      } catch {
        /* ignore */
      }
      return { sections };
    }),
  refreshLocal: () =>
    set((s) => ({ refreshTokenLocal: s.refreshTokenLocal + 1 })),
  refreshRemote: (connId) =>
    set((s) =>
      remoteMirror(
        s.remotes.map((r) =>
          connId === undefined || r.conn.connId === connId
            ? { ...r, refreshToken: r.refreshToken + 1 }
            : r,
        ),
      ),
    ),
  refreshWsl: () => set((s) => ({ refreshTokenWsl: s.refreshTokenWsl + 1 })),
  refreshConn: (connId) =>
    set((s) =>
      connId === s.localConnId
        ? { refreshTokenLocal: s.refreshTokenLocal + 1 }
        : connId === s.wsl?.connId
          ? { refreshTokenWsl: s.refreshTokenWsl + 1 }
          : remoteMirror(
              s.remotes.map((r) =>
                r.conn.connId === connId
                  ? { ...r, refreshToken: r.refreshToken + 1 }
                  : r,
              ),
            ),
    ),
  markRefreshed: (connId) =>
    set((s) =>
      connId === s.localConnId
        ? { lastRefreshLocal: Date.now() }
        : connId === s.wsl?.connId
          ? { lastRefreshWsl: Date.now() }
          : remoteMirror(
              s.remotes.map((r) =>
                r.conn.connId === connId ? { ...r, lastRefresh: Date.now() } : r,
              ),
            ),
    ),

  openTerminal: (connId, label, command = null, initialInput = null) =>
    set((s) => {
      const id = `term-${(terminalCounter += 1)}`;
      // Keep titles unique per connection so two shells on the same workspace are
      // distinguishable (e.g. "Local", "Local 2") without clashing across hosts.
      let title = label;
      let n = 1;
      while (s.terminals.some((t) => t.connId === connId && t.title === title)) {
        n += 1;
        title = `${label} ${n}`;
      }
      const term: TerminalSession = {
        id,
        connId,
        title,
        command,
        initialInput,
        epoch: 0,
      };
      return {
        terminals: [...s.terminals, term],
        activeTerminalId: id,
        terminalView: "terminals" as const,
      };
    }),

  closeTerminal: (id) =>
    set((s) => {
      const idx = s.terminals.findIndex((t) => t.id === id);
      if (idx < 0) return {};
      const terminals = s.terminals.filter((t) => t.id !== id);
      let activeTerminalId = s.activeTerminalId;
      if (s.activeTerminalId === id) {
        // `idx` is the closed terminal's original position; after filtering, the
        // terminal that slid into it is terminals[idx]. Prefer the previous one,
        // else the next, else none. (Same pattern as forceCloseTab.)
        activeTerminalId = terminals[idx - 1]?.id ?? terminals[idx]?.id ?? null;
      }
      // A killed session also closes its editor-area tab, if it had one.
      const tabId = `term::${id}`;
      const hadTab = s.tabs.some((t) => t.id === tabId);
      const tabs = hadTab ? s.tabs.filter((t) => t.id !== tabId) : s.tabs;
      return {
        terminals,
        activeTerminalId,
        ...(hadTab ? groupsPatch(s, tabs) : {}),
      };
    }),

  setActiveTerminal: (activeTerminalId) =>
    set({ activeTerminalId, terminalView: "terminals" }),

  setTerminalView: (terminalView) => set({ terminalView }),

  termGroupOrder: [],
  setTermGroupOrder: (termGroupOrder) => set({ termGroupOrder }),
  termListMini: false,
  setTermListMini: (termListMini) => set({ termListMini }),
  forwardPrefill: null,
  setForwardPrefill: (forwardPrefill) => set({ forwardPrefill }),
  portCounts: {},
  setPortCounts: (portCounts) => set({ portCounts }),
  containerCounts: {},
  setContainerCounts: (containerCounts) => set({ containerCounts }),
  forwardCount: 0,
  setForwardCount: (forwardCount) => set({ forwardCount }),
  connectAsks: [],
  pushConnectAsk: (a) => set((s) => ({ connectAsks: [...s.connectAsks, a] })),
  shiftConnectAsk: () => set((s) => ({ connectAsks: s.connectAsks.slice(1) })),
  moveTerminal: (fromId, toId) =>
    set((s) => {
      const from = s.terminals.findIndex((t) => t.id === fromId);
      const to = s.terminals.findIndex((t) => t.id === toId);
      if (from < 0 || to < 0 || from === to) return {};
      const terminals = [...s.terminals];
      const [moved] = terminals.splice(from, 1);
      terminals.splice(to, 0, moved);
      return { terminals };
    }),

  cycleTerminal: (direction) =>
    set((s) => {
      // Editor-hosted terminals aren't part of the panel's ring.
      const ring = s.terminals.filter((t) => !t.inEditor);
      if (ring.length === 0) return {};
      const idx = ring.findIndex((t) => t.id === s.activeTerminalId);
      const next = ring[(idx + direction + ring.length) % ring.length];
      return { activeTerminalId: next.id };
    }),

  restartConnTerminals: (connId) =>
    set((s) => ({
      terminals: s.terminals.map((t) =>
        t.connId === connId ? { ...t, epoch: t.epoch + 1 } : t,
      ),
    })),

  closeConnTerminals: (connId) =>
    set((s) => {
      const gone = new Set(
        s.terminals.filter((t) => t.connId === connId).map((t) => `term::${t.id}`),
      );
      const terminals = s.terminals.filter((t) => t.connId !== connId);
      const activeTerminalId = terminals.some((t) => t.id === s.activeTerminalId)
        ? s.activeTerminalId
        : (terminals[terminals.length - 1]?.id ?? null);
      const tabs = s.tabs.filter((t) => !gone.has(t.id));
      return {
        terminals,
        activeTerminalId,
        ...(tabs.length !== s.tabs.length ? groupsPatch(s, tabs) : {}),
      };
    }),

  openAppTab: (kind) =>
    set((s) => {
      const id = `app::${kind}`;
      if (s.tabs.some((t) => t.id === id)) return groupsPatch(s, s.tabs, id);
      const tab: EditorTab = {
        id,
        connId: s.localConnId ?? "",
        path: id,
        name: kind === "settings" ? "Settings" : "Themes",
        content: "",
        language: "plaintext",
        isBinary: false,
        encoding: "utf-8",
        size: 0,
        modified: 0,
        truncated: false,
        lineEnding: "LF",
        dirty: false,
        cursor: { line: 1, column: 1 },
        kind,
        groupId: s.activeGroupId,
      };
      return groupsPatch(s, [...s.tabs, tab], id);
    }),

  openTab: (tab, opts = {}) =>
    set((s) => {
      const existing = s.tabs.find(
        (t) => t.connId === tab.connId && t.path === tab.path && t.kind !== "terminal",
      );
      if (existing) {
        // A permanent open (double-click) promotes an existing preview.
        const tabs =
          !opts.preview && existing.previewTab
            ? s.tabs.map((t) => (t.id === existing.id ? { ...t, previewTab: false } : t))
            : s.tabs;
        return groupsPatch(s, tabs, existing.id);
      }
      const id = `tab-${(tabCounter += 1)}`;
      const newTab: EditorTab = {
        ...tab,
        id,
        dirty: false,
        cursor: { line: 1, column: 1 },
        previewTab: !!opts.preview && !opts.pinned,
        pinned: !!opts.pinned,
        groupId: s.activeGroupId,
      };
      if (opts.preview) {
        // Reuse the group's single preview slot (never a dirty one — dirty
        // promotes; each split keeps its own preview slot).
        const slot = s.tabs.findIndex(
          (t) => t.previewTab && !t.dirty && gidOf(t) === s.activeGroupId,
        );
        if (slot >= 0) {
          const tabs = s.tabs.slice();
          tabs[slot] = newTab;
          return groupsPatch(s, tabs, id);
        }
      }
      return groupsPatch(s, [...s.tabs, newTab], id);
    }),

  setActiveGroup: (gid) =>
    set((s) => {
      if (!s.editorGroups.includes(gid) || s.activeGroupId === gid) return {};
      return { activeGroupId: gid, activeTabId: s.groupActive[gid] ?? null };
    }),

  splitRight: (tabId, opts = {}) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId);
      if (!tab || s.editorGroups.length >= MAX_EDITOR_GROUPS) return {};
      const newGid = Math.max(0, ...s.editorGroups) + 1;
      const tabs = s.tabs.map((t) =>
        t.id === tabId ? { ...t, groupId: newGid } : t,
      );
      const editorGroups = [...s.editorGroups];
      editorGroups.splice(
        opts.end ? editorGroups.length : editorGroups.indexOf(gidOf(tab)) + 1,
        0,
        newGid,
      );
      return groupsPatch({ ...s, editorGroups }, tabs, tabId);
    }),

  moveTabToGroup: (tabId, gid) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId);
      if (!tab || !s.editorGroups.includes(gid) || gidOf(tab) === gid) return {};
      const tabs = s.tabs.map((t) =>
        t.id === tabId ? { ...t, groupId: gid } : t,
      );
      return groupsPatch(s, tabs, tabId);
    }),

  moveTabToPosition: (tabId, gid, beforeId) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId);
      if (!tab || !s.editorGroups.includes(gid)) return {};
      if (beforeId === tabId) return {};
      const rest = s.tabs.filter((t) => t.id !== tabId);
      let idx: number;
      if (beforeId) {
        idx = rest.findIndex((t) => t.id === beforeId);
        if (idx < 0) idx = rest.length;
      } else {
        // Append after the target group's last tab.
        let last = -1;
        rest.forEach((t, i) => {
          if (gidOf(t) === gid) last = i;
        });
        idx = last >= 0 ? last + 1 : rest.length;
      }
      const tabs = rest.slice();
      tabs.splice(idx, 0, { ...tab, groupId: gid });
      return groupsPatch(s, tabs, tabId);
    }),

  setTabGroups: (byTabId) =>
    set((s) => {
      const tabs = s.tabs.map((t) =>
        byTabId[t.id] !== undefined
          ? { ...t, groupId: Math.max(0, Math.min(byTabId[t.id], MAX_EDITOR_GROUPS - 1)) }
          : t,
      );
      const editorGroups = [...new Set(tabs.map(gidOf))].sort((a, b) => a - b);
      return groupsPatch(
        { ...s, editorGroups },
        tabs,
        s.activeTabId ?? undefined,
      );
    }),

  moveTerminalToEditor: (terminalId) =>
    set((s) => {
      const sess = s.terminals.find((t) => t.id === terminalId);
      if (!sess) return {};
      const id = `term::${terminalId}`;
      const terminals = s.terminals.map((t) =>
        t.id === terminalId ? { ...t, inEditor: true } : t,
      );
      const panelLeft = terminals.filter((t) => !t.inEditor);
      const activeTerminalId =
        s.activeTerminalId === terminalId
          ? (panelLeft[0]?.id ?? null)
          : s.activeTerminalId;
      if (s.tabs.some((t) => t.id === id)) {
        return { terminals, activeTerminalId, ...groupsPatch(s, s.tabs, id) };
      }
      const tab: EditorTab = {
        id,
        connId: sess.connId,
        path: sess.title,
        name: sess.title,
        content: "",
        language: "plaintext",
        isBinary: false,
        encoding: "utf-8",
        size: 0,
        modified: 0,
        truncated: false,
        lineEnding: "LF",
        dirty: false,
        cursor: { line: 1, column: 1 },
        kind: "terminal",
        terminalId,
        groupId: s.activeGroupId,
      };
      return {
        terminals,
        activeTerminalId,
        ...groupsPatch(s, [...s.tabs, tab], id),
      };
    }),

  promoteTab: (id) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, previewTab: false } : t)),
    })),

  pinTab: (id, pinned) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab) return {};
      const gid = gidOf(tab);
      const rest = s.tabs.filter((t) => t.id !== id);
      // Pin → end of the group's pinned block; unpin → start of its unpinned
      // block (same index — right after the last pinned tab of the group).
      let firstOfGroup = -1;
      let lastPinned = -1;
      rest.forEach((t, i) => {
        if (gidOf(t) !== gid) return;
        if (firstOfGroup < 0) firstOfGroup = i;
        if (t.pinned) lastPinned = i;
      });
      const insert =
        lastPinned >= 0 ? lastPinned + 1 : firstOfGroup >= 0 ? firstOfGroup : rest.length;
      const tabs = rest.slice();
      tabs.splice(insert, 0, { ...tab, pinned, previewTab: false });
      return { tabs };
    }),

  tabMenu: null,
  openTabMenu: (x, y, tabId) => set({ tabMenu: { x, y, tabId } }),
  closeTabMenu: () => set({ tabMenu: null }),

  openDiffTab: (d) =>
    set((s) => {
      const id = `diff::${d.connId}::${d.relPath}`;
      if (s.tabs.some((t) => t.id === id)) return groupsPatch(s, s.tabs, id);
      const tab: EditorTab = {
        id,
        connId: d.connId,
        path: d.path,
        name: d.name,
        content: d.content,
        language: d.language,
        isBinary: d.isBinary,
        encoding: "utf-8",
        size: 0,
        modified: 0,
        truncated: false,
        lineEnding: d.content.includes("\r\n") ? "CRLF" : "LF",
        dirty: false,
        cursor: { line: 1, column: 1 },
        kind: "diff",
        diffBase: d.base,
        diffBaseExists: d.baseExists,
        groupId: s.activeGroupId,
      };
      return groupsPatch(s, [...s.tabs, tab], id);
    }),

  openPreviewTab: (d) =>
    set((s) => {
      const id = `preview::${d.connId}::${d.path}`;
      if (s.tabs.some((t) => t.id === id)) return groupsPatch(s, s.tabs, id);
      const tab: EditorTab = {
        id,
        connId: d.connId,
        path: d.path,
        name: d.name,
        content: d.content,
        language: "markdown",
        isBinary: false,
        encoding: "utf-8",
        size: 0,
        modified: 0,
        truncated: false,
        lineEnding: "LF",
        dirty: false,
        cursor: { line: 1, column: 1 },
        kind: "preview",
        groupId: s.activeGroupId,
      };
      return groupsPatch(s, [...s.tabs, tab], id);
    }),

  openMergeTab: (d) =>
    set((s) => {
      const id = `merge::${d.connId}::${d.path}`;
      if (s.tabs.some((t) => t.id === id)) return groupsPatch(s, s.tabs, id);
      const tab: EditorTab = {
        id,
        connId: d.connId,
        path: d.path,
        name: d.name,
        content: d.content,
        language: d.language,
        isBinary: false,
        encoding: "utf-8",
        size: 0,
        modified: d.modified,
        truncated: false,
        lineEnding: d.content.includes("\r\n") ? "CRLF" : "LF",
        dirty: false,
        cursor: { line: 1, column: 1 },
        kind: "merge",
        groupId: s.activeGroupId,
      };
      return groupsPatch(s, [...s.tabs, tab], id);
    }),

  openLogTab: (d) =>
    set((s) => {
      const id = `log::${d.connId}::${d.root}`;
      if (s.tabs.some((t) => t.id === id)) return groupsPatch(s, s.tabs, id);
      const tab: EditorTab = {
        id,
        connId: d.connId,
        path: d.root,
        name: `${d.label} — History`,
        content: "",
        language: "plaintext",
        isBinary: false,
        encoding: "utf-8",
        size: 0,
        modified: 0,
        truncated: false,
        lineEnding: "LF",
        dirty: false,
        cursor: { line: 1, column: 1 },
        kind: "log",
        vcsBackend: d.backend,
        groupId: s.activeGroupId,
      };
      return groupsPatch(s, [...s.tabs, tab], id);
    }),

  setActiveTab: (id) => set((s) => groupsPatch(s, s.tabs, id)),

  cycleTab: (direction) =>
    set((s) => {
      // Cycle within the focused group (each split keeps its own ring).
      const group = s.tabs.filter((t) => gidOf(t) === s.activeGroupId);
      if (group.length === 0) return {};
      const idx = group.findIndex((t) => t.id === s.activeTabId);
      const next = group[(idx + direction + group.length) % group.length];
      return groupsPatch(s, s.tabs, next.id);
    }),

  closeTab: (id, allowPinned = false) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (tab?.pinned && !allowPinned) return; // Ctrl+W / ×: pinned tabs stay
    if (tab?.dirty) {
      set({ closeConfirm: { tabId: id } });
      return;
    }
    get().forceCloseTab(id);
  },

  forceCloseTab: (id) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab) return {};
      // Closing a terminal tab returns the shell to the panel (never kills it —
      // explicit kill lives on the panel's × after it's back).
      const terminals =
        tab.kind === "terminal" && tab.terminalId
          ? s.terminals.map((t) =>
              t.id === tab.terminalId ? { ...t, inEditor: false } : t,
            )
          : s.terminals;
      const tabs = s.tabs.filter((t) => t.id !== id);
      let focus: string | null | undefined;
      if (s.activeTabId === id) {
        // Prefer the closed tab's neighbor within its own group.
        const group = s.tabs.filter((t) => gidOf(t) === gidOf(tab));
        const gIdx = group.findIndex((t) => t.id === id);
        const rest = group.filter((t) => t.id !== id);
        focus = rest[gIdx - 1]?.id ?? rest[gIdx]?.id ?? null;
      }
      return {
        ...groupsPatch(s, tabs, focus),
        terminals,
        conflict: s.conflict?.tabId === id ? null : s.conflict,
        closeConfirm: s.closeConfirm?.tabId === id ? null : s.closeConfirm,
      };
    }),

  setTabDirty: (id, dirty) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? { ...t, dirty, previewTab: dirty ? false : t.previewTab }
          : t,
      ),
    })),

  setTabLineEnding: (id, eol) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, lineEnding: eol } : t)),
    })),

  markTabSaved: (id, modified, content) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? { ...t, dirty: false, modified, ...(content !== undefined ? { content } : {}) }
          : t,
      ),
      conflict: s.conflict?.tabId === id ? null : s.conflict,
    })),

  reloadTabContent: (id, file) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              content: file.content,
              size: file.size,
              modified: file.modified,
              encoding: file.encoding,
              truncated: file.truncated,
              lineEnding: file.content.includes("\r\n") ? ("CRLF" as const) : ("LF" as const),
              dirty: false,
            }
          : t,
      ),
    })),

  setTabCursor: (id, cursor) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, cursor } : t)),
    })),

  setBusyPath: (busyPath) => set({ busyPath }),

  setConflict: (tabId, content) => set({ conflict: { tabId, content } }),
  clearConflict: () => set({ conflict: null }),
  clearCloseConfirm: () => set({ closeConfirm: null }),

  setSelected: (selected) =>
    set({ selected, selection: selected ? [selected] : [] }),
  toggleSelected: (node) =>
    set((s) => {
      const sameConn = s.selection.length === 0 || s.selection[0].connId === node.connId;
      if (!sameConn) return { selected: node, selection: [node] };
      const has = s.selection.some(
        (n) => n.connId === node.connId && n.path === node.path,
      );
      const selection = has
        ? s.selection.filter(
            (n) => !(n.connId === node.connId && n.path === node.path),
          )
        : [...s.selection, node];
      return { selection, selected: node };
    }),
  setSelection: (selection, selected) => set({ selection, selected }),
  openContextMenu: (node, x, y) =>
    set((s) => ({
      // Keep a multi-selection if the right-clicked node is part of it;
      // otherwise the click selects just that node.
      selection: s.selection.some(
        (n) => n.connId === node.connId && n.path === node.path,
      )
        ? s.selection
        : [node],
      selected: node,
      contextMenu: { ...node, x, y },
    })),
  closeContextMenu: () => set({ contextMenu: null }),
  openProperties: (nodes) => set({ propertiesFor: nodes, contextMenu: null }),
  closeProperties: () => set({ propertiesFor: null }),
  runTransfer: async ({
    transferId,
    srcConnId,
    srcPaths,
    destConnId,
    destDir,
    rename,
    label,
    firstName,
  }) => {
    set({
      activeTransfer: {
        id: transferId,
        label,
        doneBytes: 0,
        totalBytes: 0,
        doneFiles: 0,
        totalFiles: 0,
        current: "",
      },
    });
    try {
      const outcome = await fsTransferBatch(
        transferId,
        srcConnId,
        srcPaths,
        destConnId,
        destDir,
        rename,
      );
      // Refresh whichever section owns the destination (explorer + any panel).
      get().refreshConn(destConnId);
      if (outcome.cancelled) {
        get().pushNotice(
          "info",
          `Transfer cancelled — ${outcome.files} file${outcome.files === 1 ? "" : "s"} copied`,
        );
      } else {
        get().pushNotice(
          "info",
          outcome.files === 1
            ? `Copied ${firstName}`
            : `Copied ${outcome.files} items`,
        );
      }
    } catch (e) {
      get().pushNotice("error", `Transfer failed: ${String(e)}`);
    } finally {
      set({ activeTransfer: null });
    }
  },
  updateTransferProgress: (p) =>
    set((s) =>
      s.activeTransfer && s.activeTransfer.id === p.id
        ? {
            activeTransfer: {
              ...s.activeTransfer,
              doneBytes: p.doneBytes,
              totalBytes: p.totalBytes,
              doneFiles: p.doneFiles,
              totalFiles: p.totalFiles,
              current: p.current,
            },
          }
        : {},
    ),
  cancelActiveTransfer: () => {
    const t = get().activeTransfer;
    if (t) void fsTransferCancel(t.id);
  },
  startRename: (connId, path) =>
    set({ renaming: { connId, path }, contextMenu: null }),
  cancelRename: () => set({ renaming: null }),
  openNewEntry: (connId, parent, isDir) =>
    set({ newEntry: { connId, parent, isDir }, contextMenu: null }),
  closeNewEntry: () => set({ newEntry: null }),
  openConfirmDelete: (confirmDelete) => set({ confirmDelete, contextMenu: null }),
  closeConfirmDelete: () => set({ confirmDelete: null }),
  applyRename: (connId, oldPath, newPath) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.connId !== connId) return t;
        if (t.path === oldPath) {
          return { ...t, path: newPath, name: basename(newPath) };
        }
        if (
          t.path.startsWith(oldPath + "/") ||
          t.path.startsWith(oldPath + "\\")
        ) {
          const np = newPath + t.path.slice(oldPath.length);
          return { ...t, path: np, name: basename(np) };
        }
        return t;
      }),
    })),
  applyDelete: (connId, path) =>
    set((s) => {
      const affected = (t: EditorTab) =>
        t.connId === connId &&
        (t.path === path ||
          t.path.startsWith(path + "/") ||
          t.path.startsWith(path + "\\"));
      const tabs = s.tabs.filter((t) => !affected(t));
      const activeTabId = tabs.some((t) => t.id === s.activeTabId)
        ? s.activeTabId
        : (tabs[tabs.length - 1]?.id ?? null);
      return { tabs, activeTabId };
    }),
  setClipboard: (mode, node) => set({ clipboard: { mode, node } }),
  clearClipboard: () => set({ clipboard: null }),

  pushNotice: (kind, text) =>
    set((s) => ({ notices: [...s.notices, { id: (noticeId += 1), kind, text }] })),
  dismissNotice: (id) =>
    set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
}));
