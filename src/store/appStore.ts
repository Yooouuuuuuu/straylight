/**
 * Global application state (Zustand).
 *
 * A window always has a **local** session and may attach **one remote** SSH
 * connection. Files open as **tabs**; each tab owns its own content (in a Monaco
 * model), dirty state, and cursor, so switching tabs never loses edits.
 */
import { create } from "zustand";

import { basename } from "../lib/format";
import type { ConnectionState, SshHostEntry } from "../lib/ipc";

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
}

export type NewTab = Omit<EditorTab, "id" | "dirty" | "cursor">;

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
  epoch: number;
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
  /** WSL distro connection — its own slot (an SSH connection to localhost). */
  wsl: RemoteConnection | null;
  wslRootPath: string | null;
  connState: ConnectionState;
  connMessage: string | null;

  // UI -------------------------------------------------------------------
  dialogOpen: boolean;
  dialogPrefill: SshHostEntry | null;
  /** Optional note shown atop the connect dialog (e.g. why it opened). */
  dialogNote: string | null;
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
  selected: TreeNode | null;
  contextMenu: (TreeNode & { x: number; y: number }) | null;
  renaming: { connId: string; path: string } | null;
  newEntry: { connId: string; parent: string; isDir: boolean } | null;
  confirmDelete: TreeNode | null;
  /** Cut/copy buffer for the explorer; paste drops it into a folder. */
  clipboard: { mode: "cut" | "copy"; node: TreeNode } | null;

  // Notifications --------------------------------------------------------
  notices: Notice[];

  // Actions --------------------------------------------------------------
  setLocalConnId: (id: string) => void;
  addPinnedFolder: (path: string) => void;
  removePinnedFolder: (path: string) => void;

  setRemote: (remote: RemoteConnection, rootPath: string) => void;
  clearRemote: () => void;
  setWsl: (wsl: RemoteConnection, rootPath: string) => void;
  clearWsl: () => void;
  setConnState: (state: ConnectionState, message?: string | null) => void;

  setDialogOpen: (open: boolean) => void;
  openDialog: (prefill?: SshHostEntry | null, note?: string | null) => void;
  toggleSidebar: () => void;
  setSidebarVisible: (visible: boolean) => void;
  toggleTerminal: () => void;
  setTerminalVisible: (visible: boolean) => void;
  setNewTerminalTarget: (target: TerminalTargetPref) => void;
  toggleHiddenLocal: () => void;
  toggleHiddenRemote: () => void;
  toggleHiddenWsl: () => void;
  refreshLocal: () => void;
  refreshRemote: () => void;
  refreshWsl: () => void;
  /** Refresh whichever section owns this connection (used after file ops). */
  refreshConn: (connId: string) => void;
  /** Stamp a section's "last refreshed" time once its tree has actually loaded. */
  markRefreshed: (connId: string) => void;

  openTerminal: (connId: string, label: string, command?: string[] | null) => void;
  closeTerminal: (id: string) => void;
  setActiveTerminal: (id: string) => void;
  cycleTerminal: (direction: 1 | -1) => void;
  /** Restart every terminal on a connection (its PTYs died — e.g. a reconnect). */
  restartConnTerminals: (connId: string) => void;
  /** Close every terminal on a connection (e.g. an explicit disconnect). */
  closeConnTerminals: (connId: string) => void;

  openTab: (tab: NewTab) => void;
  setActiveTab: (id: string) => void;
  cycleTab: (direction: 1 | -1) => void;
  closeTab: (id: string) => void;
  forceCloseTab: (id: string) => void;
  setTabDirty: (id: string, dirty: boolean) => void;
  markTabSaved: (id: string, modified: number) => void;
  setTabCursor: (id: string, cursor: CursorPosition) => void;
  setBusyPath: (path: string | null) => void;

  setConflict: (tabId: string, content: string) => void;
  clearConflict: () => void;
  clearCloseConfirm: () => void;

  setSelected: (node: TreeNode | null) => void;
  openContextMenu: (node: TreeNode, x: number, y: number) => void;
  closeContextMenu: () => void;
  startRename: (connId: string, path: string) => void;
  cancelRename: () => void;
  openNewEntry: (connId: string, parent: string, isDir: boolean) => void;
  closeNewEntry: () => void;
  openConfirmDelete: (node: TreeNode) => void;
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

  remote: null,
  remoteRootPath: null,
  wsl: null,
  wslRootPath: null,
  connState: "disconnected",
  connMessage: null,

  dialogOpen: false,
  dialogPrefill: null,
  dialogNote: null,
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

  terminals: [],
  activeTerminalId: null,

  tabs: [],
  activeTabId: null,
  busyPath: null,
  conflict: null,
  closeConfirm: null,

  selected: null,
  contextMenu: null,
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
    set({ remote, remoteRootPath: rootPath, connState: "connected", connMessage: null }),

  clearRemote: () =>
    set((s) => {
      // Close any tabs and terminals belonging to the remote.
      const remoteId = s.remote?.connId;
      const tabs = remoteId
        ? s.tabs.filter((t) => t.connId !== remoteId)
        : s.tabs;
      const activeTabId = tabs.some((t) => t.id === s.activeTabId)
        ? s.activeTabId
        : (tabs[tabs.length - 1]?.id ?? null);
      const terminals = remoteId
        ? s.terminals.filter((t) => t.connId !== remoteId)
        : s.terminals;
      const activeTerminalId = terminals.some((t) => t.id === s.activeTerminalId)
        ? s.activeTerminalId
        : (terminals[terminals.length - 1]?.id ?? null);
      return {
        remote: null,
        remoteRootPath: null,
        connState: "disconnected",
        connMessage: null,
        tabs,
        activeTabId,
        terminals,
        activeTerminalId,
      };
    }),

  setWsl: (wsl, rootPath) => set({ wsl, wslRootPath: rootPath }),
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
      return { wsl: null, wslRootPath: null, tabs, activeTabId, terminals, activeTerminalId };
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
  toggleHiddenRemote: () =>
    set((s) => ({ showHiddenRemote: !s.showHiddenRemote })),
  toggleHiddenWsl: () => set((s) => ({ showHiddenWsl: !s.showHiddenWsl })),
  refreshLocal: () =>
    set((s) => ({ refreshTokenLocal: s.refreshTokenLocal + 1 })),
  refreshRemote: () =>
    set((s) => ({ refreshTokenRemote: s.refreshTokenRemote + 1 })),
  refreshWsl: () => set((s) => ({ refreshTokenWsl: s.refreshTokenWsl + 1 })),
  refreshConn: (connId) =>
    set((s) =>
      connId === s.localConnId
        ? { refreshTokenLocal: s.refreshTokenLocal + 1 }
        : connId === s.wsl?.connId
          ? { refreshTokenWsl: s.refreshTokenWsl + 1 }
          : { refreshTokenRemote: s.refreshTokenRemote + 1 },
    ),
  markRefreshed: (connId) =>
    set((s) =>
      connId === s.localConnId
        ? { lastRefreshLocal: Date.now() }
        : connId === s.wsl?.connId
          ? { lastRefreshWsl: Date.now() }
          : connId === s.remote?.connId
            ? { lastRefreshRemote: Date.now() }
            : {},
    ),

  openTerminal: (connId, label, command = null) =>
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
      const term: TerminalSession = { id, connId, title, command, epoch: 0 };
      return { terminals: [...s.terminals, term], activeTerminalId: id };
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
      return { terminals, activeTerminalId };
    }),

  setActiveTerminal: (activeTerminalId) => set({ activeTerminalId }),

  cycleTerminal: (direction) =>
    set((s) => {
      if (s.terminals.length === 0) return {};
      const idx = s.terminals.findIndex((t) => t.id === s.activeTerminalId);
      const next = (idx + direction + s.terminals.length) % s.terminals.length;
      return { activeTerminalId: s.terminals[next].id };
    }),

  restartConnTerminals: (connId) =>
    set((s) => ({
      terminals: s.terminals.map((t) =>
        t.connId === connId ? { ...t, epoch: t.epoch + 1 } : t,
      ),
    })),

  closeConnTerminals: (connId) =>
    set((s) => {
      const terminals = s.terminals.filter((t) => t.connId !== connId);
      const activeTerminalId = terminals.some((t) => t.id === s.activeTerminalId)
        ? s.activeTerminalId
        : (terminals[terminals.length - 1]?.id ?? null);
      return { terminals, activeTerminalId };
    }),

  openTab: (tab) =>
    set((s) => {
      const existing = s.tabs.find(
        (t) => t.connId === tab.connId && t.path === tab.path,
      );
      if (existing) return { activeTabId: existing.id };
      const id = `tab-${(tabCounter += 1)}`;
      const newTab: EditorTab = {
        ...tab,
        id,
        dirty: false,
        cursor: { line: 1, column: 1 },
      };
      return { tabs: [...s.tabs, newTab], activeTabId: id };
    }),

  setActiveTab: (activeTabId) => set({ activeTabId }),

  cycleTab: (direction) =>
    set((s) => {
      if (s.tabs.length === 0) return {};
      const idx = s.tabs.findIndex((t) => t.id === s.activeTabId);
      const next = (idx + direction + s.tabs.length) % s.tabs.length;
      return { activeTabId: s.tabs[next].id };
    }),

  closeTab: (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (tab?.dirty) {
      set({ closeConfirm: { tabId: id } });
      return;
    }
    get().forceCloseTab(id);
  },

  forceCloseTab: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return {};
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeTabId = s.activeTabId;
      if (s.activeTabId === id) {
        activeTabId = tabs[idx - 1]?.id ?? tabs[idx]?.id ?? null;
      }
      return {
        tabs,
        activeTabId,
        conflict: s.conflict?.tabId === id ? null : s.conflict,
        closeConfirm: s.closeConfirm?.tabId === id ? null : s.closeConfirm,
      };
    }),

  setTabDirty: (id, dirty) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, dirty } : t)),
    })),

  markTabSaved: (id, modified) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, dirty: false, modified } : t)),
      conflict: s.conflict?.tabId === id ? null : s.conflict,
    })),

  setTabCursor: (id, cursor) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, cursor } : t)),
    })),

  setBusyPath: (busyPath) => set({ busyPath }),

  setConflict: (tabId, content) => set({ conflict: { tabId, content } }),
  clearConflict: () => set({ conflict: null }),
  clearCloseConfirm: () => set({ closeConfirm: null }),

  setSelected: (selected) => set({ selected }),
  openContextMenu: (node, x, y) =>
    set({ selected: node, contextMenu: { ...node, x, y } }),
  closeContextMenu: () => set({ contextMenu: null }),
  startRename: (connId, path) =>
    set({ renaming: { connId, path }, contextMenu: null }),
  cancelRename: () => set({ renaming: null }),
  openNewEntry: (connId, parent, isDir) =>
    set({ newEntry: { connId, parent, isDir }, contextMenu: null }),
  closeNewEntry: () => set({ newEntry: null }),
  openConfirmDelete: (node) => set({ confirmDelete: node, contextMenu: null }),
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
