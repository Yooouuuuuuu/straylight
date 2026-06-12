/**
 * Global application state (Zustand).
 *
 * One window owns one connection in Straylight, so a single flat store models
 * the whole UI: the active connection, the open file, and panel visibility.
 */
import { create } from "zustand";

import type { ConnectionState, SshHostEntry } from "../lib/ipc";

/** A file currently shown in the editor. */
export interface OpenFile {
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

/** Metadata for the window's active connection. */
export interface ConnectionMeta {
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

interface AppState {
  // Connection -----------------------------------------------------------
  connection: ConnectionMeta | null;
  connState: ConnectionState;
  connMessage: string | null;

  // UI -------------------------------------------------------------------
  dialogOpen: boolean;
  /** When the dialog is opened from a config host, its details prefill the form. */
  dialogPrefill: SshHostEntry | null;
  sidebarVisible: boolean;
  terminalVisible: boolean;
  showHidden: boolean;

  // File tree ------------------------------------------------------------
  rootPath: string | null;
  /** Bumped to force the tree to re-fetch (F5 / refresh). */
  treeRefreshToken: number;

  // Editor ---------------------------------------------------------------
  openFile: OpenFile | null;
  cursor: CursorPosition;
  busyPath: string | null;

  // Notifications --------------------------------------------------------
  notices: Notice[];

  // Actions --------------------------------------------------------------
  setConnection: (connection: ConnectionMeta) => void;
  setConnState: (state: ConnectionState, message?: string | null) => void;
  clearConnection: () => void;

  setDialogOpen: (open: boolean) => void;
  openDialog: (prefill?: SshHostEntry | null) => void;
  toggleSidebar: () => void;
  setSidebarVisible: (visible: boolean) => void;
  toggleTerminal: () => void;
  setTerminalVisible: (visible: boolean) => void;
  toggleHidden: () => void;

  setRootPath: (path: string | null) => void;
  refreshTree: () => void;

  setOpenFile: (file: OpenFile | null) => void;
  setCursor: (cursor: CursorPosition) => void;
  setBusyPath: (path: string | null) => void;

  pushNotice: (kind: Notice["kind"], text: string) => void;
  dismissNotice: (id: number) => void;
}

let noticeId = 0;

export const useAppStore = create<AppState>()((set) => ({
  connection: null,
  connState: "disconnected",
  connMessage: null,

  dialogOpen: false,
  dialogPrefill: null,
  sidebarVisible: true,
  terminalVisible: true,
  showHidden: false,

  rootPath: null,
  treeRefreshToken: 0,

  openFile: null,
  cursor: { line: 1, column: 1 },
  busyPath: null,

  notices: [],

  setConnection: (connection) =>
    set({ connection, connState: "connected", connMessage: null }),

  setConnState: (state, message = null) =>
    set({ connState: state, connMessage: message }),

  clearConnection: () =>
    set({
      connection: null,
      connState: "disconnected",
      connMessage: null,
      rootPath: null,
      openFile: null,
      cursor: { line: 1, column: 1 },
      busyPath: null,
    }),

  setDialogOpen: (dialogOpen) =>
    set(dialogOpen ? { dialogOpen } : { dialogOpen, dialogPrefill: null }),
  openDialog: (prefill = null) => set({ dialogOpen: true, dialogPrefill: prefill }),
  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  setSidebarVisible: (sidebarVisible) => set({ sidebarVisible }),
  toggleTerminal: () => set((s) => ({ terminalVisible: !s.terminalVisible })),
  setTerminalVisible: (terminalVisible) => set({ terminalVisible }),
  toggleHidden: () => set((s) => ({ showHidden: !s.showHidden })),

  setRootPath: (rootPath) => set({ rootPath }),
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
