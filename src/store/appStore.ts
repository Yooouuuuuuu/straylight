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

interface AppState {
  // Local session (always available) ------------------------------------
  localConnId: string | null;
  pinnedFolders: string[];

  // Remote (optional, one) ----------------------------------------------
  remote: RemoteConnection | null;
  remoteRootPath: string | null;
  connState: ConnectionState;
  connMessage: string | null;

  // UI -------------------------------------------------------------------
  dialogOpen: boolean;
  dialogPrefill: SshHostEntry | null;
  sidebarVisible: boolean;
  terminalVisible: boolean;
  showHidden: boolean;
  treeRefreshToken: number;
  /** Bumped to force the terminal to restart (e.g. after a reconnect). */
  terminalEpoch: number;

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

  // Notifications --------------------------------------------------------
  notices: Notice[];

  // Actions --------------------------------------------------------------
  setLocalConnId: (id: string) => void;
  addPinnedFolder: (path: string) => void;
  removePinnedFolder: (path: string) => void;

  setRemote: (remote: RemoteConnection, rootPath: string) => void;
  clearRemote: () => void;
  setConnState: (state: ConnectionState, message?: string | null) => void;

  setDialogOpen: (open: boolean) => void;
  openDialog: (prefill?: SshHostEntry | null) => void;
  toggleSidebar: () => void;
  setSidebarVisible: (visible: boolean) => void;
  toggleTerminal: () => void;
  setTerminalVisible: (visible: boolean) => void;
  toggleHidden: () => void;
  refreshTree: () => void;
  bumpTerminalEpoch: () => void;

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

  pushNotice: (kind: Notice["kind"], text: string) => void;
  dismissNotice: (id: number) => void;
}

let noticeId = 0;
let tabCounter = 0;

export const useAppStore = create<AppState>()((set, get) => ({
  localConnId: null,
  pinnedFolders: loadPinned(),

  remote: null,
  remoteRootPath: null,
  connState: "disconnected",
  connMessage: null,

  dialogOpen: false,
  dialogPrefill: null,
  sidebarVisible: true,
  terminalVisible: true,
  showHidden: false,
  treeRefreshToken: 0,
  terminalEpoch: 0,

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
      // Close any tabs belonging to the remote.
      const remoteId = s.remote?.connId;
      const tabs = remoteId
        ? s.tabs.filter((t) => t.connId !== remoteId)
        : s.tabs;
      const activeTabId = tabs.some((t) => t.id === s.activeTabId)
        ? s.activeTabId
        : (tabs[tabs.length - 1]?.id ?? null);
      return {
        remote: null,
        remoteRootPath: null,
        connState: "disconnected",
        connMessage: null,
        tabs,
        activeTabId,
      };
    }),

  setConnState: (state, message = null) => set({ connState: state, connMessage: message }),

  setDialogOpen: (dialogOpen) =>
    set(dialogOpen ? { dialogOpen } : { dialogOpen, dialogPrefill: null }),
  openDialog: (prefill = null) => set({ dialogOpen: true, dialogPrefill: prefill }),
  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  setSidebarVisible: (sidebarVisible) => set({ sidebarVisible }),
  toggleTerminal: () => set((s) => ({ terminalVisible: !s.terminalVisible })),
  setTerminalVisible: (terminalVisible) => set({ terminalVisible }),
  toggleHidden: () => set((s) => ({ showHidden: !s.showHidden })),
  refreshTree: () => set((s) => ({ treeRefreshToken: s.treeRefreshToken + 1 })),
  bumpTerminalEpoch: () => set((s) => ({ terminalEpoch: s.terminalEpoch + 1 })),

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

  pushNotice: (kind, text) =>
    set((s) => ({ notices: [...s.notices, { id: (noticeId += 1), kind, text }] })),
  dismissNotice: (id) =>
    set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
}));
