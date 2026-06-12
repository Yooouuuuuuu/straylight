/**
 * Global application state (Zustand).
 *
 * A window always has a **local** session (the local filesystem) and may attach
 * **one remote** SSH connection. The sidebar shows pinned local folders plus the
 * remote host as separate roots; the editor opens files from either (each open
 * file records the `connId` it came from).
 */
import { create } from "zustand";

import type { ConnectionState, SshHostEntry } from "../lib/ipc";

/** A file currently shown in the editor. */
export interface OpenFile {
  /** The session this file was read from (local session or an SSH connection). */
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
}

/** The window's single remote SSH connection. */
export interface RemoteConnection {
  connId: string;
  name: string;
  host: string;
  user: string;
  port: number;
  /** Accent color used to tint the title bar (workspace color-coding). */
  color: string;
}

export interface CursorPosition {
  line: number;
  column: number;
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
    /* ignore quota/availability errors */
  }
}

interface AppState {
  // Local session (always available) ------------------------------------
  localConnId: string | null;
  /** Pinned local folders shown as roots; persisted to localStorage. */
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
  /** Bumped to force the trees to re-fetch (refresh). */
  treeRefreshToken: number;

  // Editor ---------------------------------------------------------------
  openFile: OpenFile | null;
  cursor: CursorPosition;
  busyPath: string | null;

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

  setOpenFile: (file: OpenFile | null) => void;
  setCursor: (cursor: CursorPosition) => void;
  setBusyPath: (path: string | null) => void;

  pushNotice: (kind: Notice["kind"], text: string) => void;
  dismissNotice: (id: number) => void;
}

let noticeId = 0;

export const useAppStore = create<AppState>()((set) => ({
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

  openFile: null,
  cursor: { line: 1, column: 1 },
  busyPath: null,

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
    set({
      remote,
      remoteRootPath: rootPath,
      connState: "connected",
      connMessage: null,
    }),

  clearRemote: () =>
    set((s) => ({
      remote: null,
      remoteRootPath: null,
      connState: "disconnected",
      connMessage: null,
      // Close the editor if it was showing a file from the remote.
      openFile:
        s.remote && s.openFile?.connId === s.remote.connId ? null : s.openFile,
    })),

  setConnState: (state, message = null) =>
    set({ connState: state, connMessage: message }),

  setDialogOpen: (dialogOpen) =>
    set(dialogOpen ? { dialogOpen } : { dialogOpen, dialogPrefill: null }),
  openDialog: (prefill = null) => set({ dialogOpen: true, dialogPrefill: prefill }),
  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  setSidebarVisible: (sidebarVisible) => set({ sidebarVisible }),
  toggleTerminal: () => set((s) => ({ terminalVisible: !s.terminalVisible })),
  setTerminalVisible: (terminalVisible) => set({ terminalVisible }),
  toggleHidden: () => set((s) => ({ showHidden: !s.showHidden })),
  refreshTree: () => set((s) => ({ treeRefreshToken: s.treeRefreshToken + 1 })),

  setOpenFile: (openFile) =>
    set({ openFile, cursor: { line: 1, column: 1 } }),
  setCursor: (cursor) => set({ cursor }),
  setBusyPath: (busyPath) => set({ busyPath }),

  pushNotice: (kind, text) =>
    set((s) => ({
      notices: [...s.notices, { id: (noticeId += 1), kind, text }],
    })),
  dismissNotice: (id) =>
    set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
}));
