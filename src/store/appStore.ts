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
  ptyClose,
  sessionLaneConnect,
  sshDisconnect,
  type ConnectionState,
  type SshHostEntry,
  type TransferProgress,
} from "../lib/ipc";
import { setTabPinned } from "../lib/pinnedTabs";

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
  /** Parked on a dead connection — auto-resumes when the lane reconnects. */
  waiting: boolean;
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

/** Which surface owns an in-flight inline rename. A single global `renaming`
 *  state is shared across the explorer trees and the two transfer panes; the
 *  scope keeps only the ORIGINATING surface's rename box mounted, so the same
 *  host+path shown in two places can't render two boxes that deadlock focus. */
export type RenameScope = "explorer" | "transfer";

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
  /** The file wasn't valid UTF-8 and was decoded with replacement characters —
   *  saving is blocked (it would write the damage back over the original). */
  lossy?: boolean;
  /** The tab's content came from an auto-restored hot-exit draft (dirty by
   *  construction; the crumbs Compare button diffs it against the saved file). */
  draftApplied?: boolean;
  /** The file's mtime when the draft was made — differs from `modified` when
   *  the file changed on the server while we were away (warning banner). */
  draftBaselineMtime?: number;
  /** The buffer diverges from a server copy that changed under us (a save-time
   *  conflict, a guard refusal, or a restored draft whose file moved). While
   *  set, Ctrl+S is blocked — the conflict bar's Overwrite / Discard (each
   *  confirmed) is the only way out. */
  conflict?: boolean;
  lineEnding: "LF" | "CRLF";
  dirty: boolean;
  cursor: CursorPosition;
  /** "diff" shows a Monaco diff; "log" shows a repo's commit history;
   *  Default "file". */
  kind?:
    | "file"
    | "diff"
    | "log"
    | "merge"
    | "preview"
    | "settings"
    | "themes"
    | "pins"
    | "drafts"
    | "autoconnect";
  /** Which editor group (split) the tab lives in. Absent = group 0. */
  groupId?: number;
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

/** Recompute the group bookkeeping after any tab/group change: repairs each
 *  group's active tab and focuses `focusId` (undefined = keep the current
 *  focus if still valid). Group lifecycle: a group that LOSES its last tab
 *  (close, drag away) closes itself; a group created empty on purpose
 *  (Ctrl+\, Ctrl+2/3) persists — it shows the app icon and its own ✕, and
 *  only `closeGroup` (or gaining-then-losing tabs) removes it. */
function groupsPatch(
  s: GroupsSlice,
  tabs: EditorTab[],
  focusId?: string | null,
): GroupsSlice {
  const present = new Set(tabs.map(gidOf));
  const hadTabs = new Set(s.tabs.map(gidOf));
  // Keep groups that still hold tabs, or never held any (intentional empties);
  // drop the ones this change just emptied.
  let editorGroups = s.editorGroups.filter(
    (g) => present.has(g) || !hadTabs.has(g),
  );
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
  /** The HOST this terminal belongs to (local or remote) — grouping, colors,
   *  and labels all key off this. */
  connId: string;
  /** The dedicated connection actually carrying the PTY, when this agent got
   *  its own session lane (docs/connections.md Phase D). Absent = the PTY
   *  rides the host's shared main lane. */
  laneConnId?: string;
  /** The clean default label ("pwsh", "myserver 2"), set at open and never
   *  overwritten — it's the fallback name. */
  title: string;
  /** The shell's latest raw OSC 0/2 title. Shown only when it's a meaningful
   *  name (a tool like Claude Code set it), not shell path noise — see
   *  {@link cleanOscTitle}. */
  oscTitle?: string;
  /** User rename (double-click the entry). Wins over everything until cleared. */
  customName?: string;
  /** Shell command for a local profile (e.g. ["wsl.exe","-d","Ubuntu"]); null
   *  uses the session's default shell. Ignored for remote (login shell). */
  command: string[] | null;
  /** Typed into the shell once it opens (e.g. `podman exec -it … /bin/sh`). */
  initialInput?: string | null;
  /** Timed keystrokes after open (delays from PTY-open) — the usage probe's
   *  `claude`, trust-prompt enters, `/clear`, `/usage`. */
  scriptedInput?: { text: string; delayMs: number }[];
  /** Keyboard input is dropped (a display-only terminal, e.g. the usage
   *  probe — nothing can be typed into it). */
  locked?: boolean;
  /** A usage-check probe: closed automatically when the focus view exits. */
  usageProbe?: boolean;
  epoch: number;
  /** The live backend PTY id (from `pty_open`). Stored so a terminal's *view*
   *  can be torn down and re-created on the same shell — the sessions pop-out
   *  window mounts a fresh xterm re-attached to this PTY (docs/dev/multi-window.md).
   *  Null when no PTY is live (never opened, or dead awaiting an epoch restart). */
  ptyId?: string | null;
  /** Lives in the CHAT column instead of the panel (the shell survives the
   *  move — its DOM is reparented, never remounted). */
  inChat?: boolean;
}

/** Every connected host in the CHAT ordering: ranked by `chatHostOrder`,
 *  unranked hosts keeping the canonical order (local, WSLs, remotes). Drives
 *  the focus view's HOSTS block and the Ctrl+Shift+N host digits. */
export function connectedChatHosts(s: {
  localConnId: string | null;
  wsls: { conn: { connId: string } }[];
  remotes: { conn: { connId: string } }[];
  chatHostOrder: string[];
}): string[] {
  const all: string[] = [];
  if (s.localConnId) all.push(s.localConnId);
  for (const w of s.wsls) all.push(w.conn.connId);
  for (const r of s.remotes) all.push(r.conn.connId);
  const rank = (id: string) => {
    const i = s.chatHostOrder.indexOf(id);
    return i < 0 ? s.chatHostOrder.length : i;
  };
  return all.sort((a, b) => rank(a) - rank(b));
}

/** Group the CHAT residents by host — hosts in the EXPLICIT `orderedHosts`
 *  order (from {@link connectedChatHosts}: canonical local/WSL/remote, plus
 *  the drag overrides), terminals within a host in their list order. Only
 *  hosts with agents appear. Usage probes are EXCLUDED (they live behind the
 *  host button, not in the list). Ordering does NOT depend on which terminal
 *  opened first, so closing early terminals never reshuffles the hosts.
 *  Shared by the CHAT panel's dot clusters and the focus view's list. */
export function chatHostGroups(
  terminals: TerminalSession[],
  orderedHosts: string[],
): { connId: string; terminals: TerminalSession[] }[] {
  return orderedHosts
    .map((connId) => ({
      connId,
      terminals: terminals.filter(
        (t) => t.inChat && !t.usageProbe && t.connId === connId,
      ),
    }))
    .filter((g) => g.terminals.length > 0);
}

/** A user-made "purpose" group in CHAT: a named, colored bucket that holds
 *  agents pulled from ANY host (move model — a member leaves its host block).
 *  Dissolving the group returns its agents to their host blocks. */
export interface ChatPurpose {
  id: string;
  name: string;
  color: string;
  /** Ordered membership (terminal ids). */
  termIds: string[];
}

/** Distinct colors for new purpose groups (neutral, not host identities). */
export const PURPOSE_COLORS = [
  "#7aa2f7",
  "#bb9af7",
  "#7dcfff",
  "#9ece6a",
  "#e0af68",
  "#f7768e",
];

export type ChatSection =
  | {
      kind: "purpose";
      id: string;
      name: string;
      color: string;
      terminals: TerminalSession[];
    }
  | { kind: "host"; connId: string; terminals: TerminalSession[] };

/** The CHAT layout, purpose-aware: purpose sections first (in their order,
 *  empty ones kept as drop targets), then the host blocks for every agent NOT
 *  in a purpose ("uncategorized" — looks exactly like today when there are no
 *  purposes). Shared by the focus view and the CHAT panel's clusters. */
export function chatSections(
  terminals: TerminalSession[],
  purposes: ChatPurpose[],
  orderedHosts: string[],
): ChatSection[] {
  const resident = (t: TerminalSession) => t.inChat && !t.usageProbe;
  const byId = new Map(terminals.filter(resident).map((t) => [t.id, t]));
  const claimed = new Set<string>();
  const purposeSections: ChatSection[] = purposes.map((p) => {
    const terms = p.termIds
      .map((id) => byId.get(id))
      .filter((t): t is TerminalSession => !!t);
    terms.forEach((t) => claimed.add(t.id));
    return {
      kind: "purpose",
      id: p.id,
      name: p.name,
      color: p.color,
      terminals: terms,
    };
  });
  const hostSections: ChatSection[] = orderedHosts
    .map((connId) => ({
      kind: "host" as const,
      connId,
      terminals: terminals.filter(
        (t) => resident(t) && t.connId === connId && !claimed.has(t.id),
      ),
    }))
    .filter((s) => s.terminals.length > 0);
  return [...purposeSections, ...hostSections];
}

/** An OSC title worth showing, or undefined to fall back to the default label.
 *  Shells set their window title to path/prompt noise ("Administrator:
 *  C:\…\pwsh.exe", "user@host:~/dir"); tools like Claude Code, vim, or gh set
 *  a real name. We keep the latter and reject the former, so the default label
 *  survives shell chrome but a tool can still name the terminal. */
export function cleanOscTitle(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  if (!t) return undefined;
  if (/[/\\]/.test(t)) return undefined; // any path separator
  if (/\.exe\b/i.test(t)) return undefined; // pwsh.exe, cmd.exe
  if (/^administrator:/i.test(t)) return undefined; // elevated console prefix
  if (/^\S+@\S+:/.test(t)) return undefined; // user@host: shell prompt
  return t;
}

/** What a terminal is called everywhere (entries, switcher, chat panel):
 *  the user's rename, else a meaningful OSC title, else the default label. */
export function termDisplayName(t: TerminalSession): string {
  return t.customName ?? cleanOscTitle(t.oscTitle) ?? t.title;
}

export interface Notice {
  id: number;
  kind: "info" | "warn" | "error";
  text: string;
}

/** A toast that already faded, kept for the status-bar bell. */
export interface NoticeLogEntry {
  id: number;
  kind: Notice["kind"];
  text: string;
  time: number;
}

const NOTICE_LOG_CAP = 100;

/** Column slots for the two movable panels (SC, CHAT), left-to-right around
 *  the editor: [explorer] l [editor] r1 r2. Explorer is pinned leftmost and
 *  never moves. The editor itself is one of the tokens, so the columns can
 *  step PAST it — putting the editor next to the explorer (both columns right)
 *  or at the right edge (both columns left). */
export type DockToken = "editor" | "scm" | "chat";

/** Default left→right order after the pinned explorer:
 *  explorer | editor | chat | sc. */
export const DEFAULT_DOCK_ORDER: DockToken[] = ["editor", "chat", "scm"];

const DOCK_KEY = "straylight.dockOrder";

function loadDockOrder(): DockToken[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(DOCK_KEY) ?? "");
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      (["editor", "scm", "chat"] as DockToken[]).every((t) => parsed.includes(t))
    ) {
      return parsed as DockToken[];
    }
  } catch {
    /* default below */
  }
  return [...DEFAULT_DOCK_ORDER];
}

const CHAT_VIS_KEY = "straylight.chatVisible";

function persistChatVisible(v: boolean): void {
  try {
    localStorage.setItem(CHAT_VIS_KEY, v ? "1" : "0");
  } catch {
    /* prefs only */
  }
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

export function remoteHostKey(
  r: Pick<RemoteConnection, "user" | "host" | "port">,
): string {
  return `${r.user}@${r.host}:${r.port}`;
}

/** Stable connection identity for a live connId — "local" / "wsl:<distro>" /
 *  "user@host:port" (the same convention the VCS panel persists by). Null for
 *  a connId that isn't attached right now. */
export function connKeyForConnId(connId: string): string | null {
  const s = useAppStore.getState();
  if (connId === s.localConnId) return "local";
  const w = s.wsls.find((x) => x.conn.connId === connId);
  if (w) return `wsl:${w.conn.name}`;
  const r = s.remotes.find((x) => x.conn.connId === connId);
  if (r) return remoteHostKey(r.conn);
  return null;
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

// ---- multi-WSL (1 local + 3 WSL + 3 remotes) --------------------------------

export const MAX_WSLS = 3;

/** Legacy single-WSL fields, mirrored from the first distro (same pattern as
 *  the remote mirror) so primary-only surfaces keep working unchanged. */
function wslMirror(wsls: RemoteWorkspace[]) {
  const p = wsls[0] ?? null;
  return {
    wsls,
    wsl: p?.conn ?? null,
    wslState: p?.state ?? ("disconnected" as ConnectionState),
    wslRootPath: p?.rootPath ?? null,
    wslPins: p?.pins ?? [],
    showHiddenWsl: p?.showHidden ?? false,
    refreshTokenWsl: p?.refreshToken ?? 0,
    lastRefreshWsl: p?.lastRefresh ?? null,
  };
}

/** Theme-slot color per remote slot — a warm→cool host spectrum (Local crimson,
 *  WSL magenta, remotes violet→indigo→blue) so the category reads at a glance.
 *  Host colors are FIXED to these slots by position: edit their values in the
 *  Theme UI; right-clicking a remote's host bar swaps its position (slot) with
 *  another remote. */
export const HOST_COLOR_RAMP = [
  "var(--section-remote)",
  "var(--section-remote-2)",
  "var(--section-remote-3)",
];

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

/** The session-registry payload — everything the sessions hand-off carries
 *  (docs/dev/multi-window.md): the CHAT sessions (live PTYs only), the F11
 *  layout state (purpose groups + host order, so drags survive the hop), and
 *  the per-session status maps (bells, finished times, thinking, dead PTYs) —
 *  the pop-out must look EXACTLY like the F11 view it replaces, and vice
 *  versa on return. */
export interface SessionRegistry {
  sessions: TerminalSession[];
  purposes: ChatPurpose[];
  hostOrder: string[];
  /** The selected session, so the other window opens on the same one. */
  activeId: string | null;
  belled: Record<string, true>;
  finishedAt: Record<string, number>;
  thinking: Record<string, true>;
  thinkingSince: Record<string, number>;
  ptyDead: Record<string, true>;
}

/** Build the registry payload from the current state. Only sessions with an
 *  open PTY are carried — an attach needs a live shell; the status maps are
 *  trimmed to those sessions. */
export function buildSessionRegistry(s: {
  terminals: TerminalSession[];
  chatPurposes: ChatPurpose[];
  chatHostOrder: string[];
  chatActiveId: string | null;
  belled: Record<string, true>;
  finishedAt: Record<string, number>;
  thinking: Record<string, true>;
  thinkingSince: Record<string, number>;
  ptyDead: Record<string, true>;
}): SessionRegistry {
  const sessions = s.terminals.filter((t) => t.inChat && t.ptyId);
  const pick = <V,>(m: Record<string, V>): Record<string, V> => {
    const out: Record<string, V> = {};
    for (const t of sessions) if (t.id in m) out[t.id] = m[t.id];
    return out;
  };
  return {
    sessions,
    purposes: s.chatPurposes,
    hostOrder: s.chatHostOrder,
    activeId: sessions.some((t) => t.id === s.chatActiveId)
      ? s.chatActiveId
      : null,
    belled: pick(s.belled),
    finishedAt: pick(s.finishedAt),
    thinking: pick(s.thinking),
    thinkingSince: pick(s.thinkingSince),
    ptyDead: pick(s.ptyDead),
  };
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
  /** All attached WSL distros (≤ MAX_WSLS), each an SSH link to localhost
   *  with its own host bar; `wsl` etc. mirror the first. */
  wsls: RemoteWorkspace[];
  addWsl: (conn: RemoteConnection, rootPath: string) => void;
  removeWsl: (connId: string) => void;
  setWslConnState: (connId: string, state: ConnectionState) => void;
  /** Primary (first) distro — mirror of wsls[0] for primary-only surfaces. */
  wsl: RemoteConnection | null;
  wslState: ConnectionState;
  wslRootPath: string | null;
  wslPins: string[];
  connState: ConnectionState;
  connMessage: string | null;

  // UI -------------------------------------------------------------------
  dialogOpen: boolean;
  dialogPrefill: SshHostEntry | null;
  /** Optional note shown atop the connect dialog (e.g. why it opened). */
  dialogNote: string | null;
  /** Prompt to unlock an encrypted key: the key path + a callback that retries
   *  the connection with the entered passphrase (held in memory only). */
  passphrasePrompt: { keyPath: string; onSubmit: (passphrase: string) => void } | null;
  /** Host-key decision. `unknown`: first contact — show the fingerprint and let
   *  the user trust it (`onTrust` records it, then retries). `changed`: the key
   *  differs from `known_hosts` — refuse loudly, no trust path. */
  hostKeyPrompt:
    | {
        kind: "unknown";
        host: string;
        port: number;
        fingerprint: string;
        onTrust: () => void;
      }
    | { kind: "changed"; host: string; port: number }
    | null;
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
  /** Panels hidden BY THE WINDOW SIZE (lib/layoutBudget) — a derived overlay
   *  on top of the user's visibility flags, never mutating them: growing the
   *  window restores exactly what the resize hid. */
  suppressed: import("../lib/layoutBudget").Suppressed;
  setSuppressed: (s: import("../lib/layoutBudget").Suppressed) => void;
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
  /** Explorer section visibility (the L / W / R header toggles). */
  sections: SectionVisibility;

  // Terminals ------------------------------------------------------------
  terminals: TerminalSession[];
  activeTerminalId: string | null;
  /** Per-host memory of the terminal you were last in, so swapping back to a
   *  host returns you to it — not just its newest shell. Released on the host's
   *  disconnect; a stale entry (its terminal closed) self-heals on read. */
  lastActiveByHost: Record<string, string>;

  // Editor tabs ----------------------------------------------------------
  tabs: EditorTab[];
  activeTabId: string | null;
  busyPath: string | null;
  /** A save refused because the file changed on disk; holds the pending content. */
  /** A close blocked by unsaved changes, awaiting the user's choice. */
  closeConfirm: { tabId: string } | null;

  // File tree operations -------------------------------------------------
  /** The anchor node — last clicked; drives rename, keyboard nav, new-file target. */
  selected: TreeNode | null;
  /** The full multi-selection (always within one connection; includes the anchor). */
  selection: TreeNode[];
  /** Right-click target. Pinned-root headers set `root` (the menu drops
   *  cut/rename/delete) and pass `unpin` (the ✕ action) when removable. */
  contextMenu:
    | (TreeNode & {
        x: number;
        y: number;
        root?: boolean;
        unpin?: () => void;
      })
    | null;
  /** Items shown in the Properties dialog (one or many), or null when closed. */
  propertiesFor: TreeNode[] | null;
  /** The one in-flight transfer, or null when idle. */
  activeTransfer: ActiveTransfer | null;
  /** The one in-flight inline rename. `scope` names the OWNING surface so the
   *  same connId+path shown in two mounted places (explorer + a transfer pane
   *  on the same host) doesn't render two competing rename boxes that fight for
   *  focus and lock up. */
  renaming: { connId: string; path: string; scope: RenameScope } | null;
  newEntry: { connId: string; parent: string; isDir: boolean } | null;
  /** Items pending delete confirmation (one or many). */
  confirmDelete: TreeNode[] | null;
  /** Cut/copy buffer for the explorer; paste drops it into a folder. */
  clipboard: { mode: "cut" | "copy"; node: TreeNode } | null;

  // Notifications --------------------------------------------------------
  notices: Notice[];

  // Actions --------------------------------------------------------------
  setLocalConnId: (id: string) => void;
  /** Adopt the main window's connections wholesale (workspace pop-out — it
   *  mirrors main's live sessions rather than dialing its own; see
   *  docs/dev/multi-window.md). Replaces localConnId + remotes + wsls. */
  adoptConnections: (snap: {
    localConnId: string | null;
    remotes: RemoteWorkspace[];
    wsls: RemoteWorkspace[];
  }) => void;
  /** Adopt the main window's CHAT sessions (sessions pop-out) — replace the
   *  terminal list so this window renders + re-attaches them (docs/dev/multi-window.md). */
  adoptSessions: (reg: SessionRegistry) => void;
  mergeSessions: (reg: SessionRegistry) => void;
  clearChatSessions: () => void;
  /** True while the sessions pop-out window is open — the main window locks its
   *  CHAT panel so exactly one window renders the sessions (the lock model). */
  sessionsPoppedOut: boolean;
  setSessionsPoppedOut: (on: boolean) => void;
  /** True while the workspace window is open — main disables its workspace
   *  button (docs/dev/multi-window.md). */
  workspaceOpen: boolean;
  setWorkspaceOpen: (on: boolean) => void;
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
  addWslPin: (connId: string, path: string) => void;
  removeWslPin: (connId: string, path: string) => void;
  setConnState: (state: ConnectionState, message?: string | null) => void;

  setDialogOpen: (open: boolean) => void;
  openDialog: (prefill?: SshHostEntry | null, note?: string | null) => void;
  openPassphrasePrompt: (p: { keyPath: string; onSubmit: (passphrase: string) => void }) => void;
  closePassphrasePrompt: () => void;
  openHostKeyPrompt: (p: NonNullable<AppState["hostKeyPrompt"]>) => void;
  closeHostKeyPrompt: () => void;
  setFinderOpen: (open: boolean) => void;
  setSearchOpen: (open: boolean) => void;
  setPortsOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setSettingsIssues: (issues: string[]) => void;
  /** Bumped after every settings.json (re)apply so components that read the
   *  module-level configs (uiConfig, panelsConfig…) re-render. */
  settingsRev: number;
  bumpSettingsRev: () => void;
  /** Bumped when an interaction should hand the editor the cursor (double
   *  click, Enter, quick open, tab click). A preview open never bumps it, so
   *  the explorer keeps the keyboard — the VS Code model. */
  editorFocusSeq: number;
  requestEditorFocus: () => void;
  setRevealTarget: (t: { connId: string; path: string; line: number } | null) => void;
  toggleSidebar: () => void;
  setSidebarVisible: (visible: boolean) => void;
  toggleTerminal: () => void;
  setTerminalVisible: (visible: boolean) => void;
  setNewTerminalTarget: (target: TerminalTargetPref) => void;
  toggleHiddenLocal: () => void;
  toggleHiddenRemote: (connId: string) => void;
  toggleHiddenWsl: (connId: string) => void;
  /** Swap two remotes' positions in the list — position IS the color slot
   *  (Remote 1/2/3), so this reassigns both place and identity color. */
  swapRemotes: (a: number, b: number) => void;
  toggleSection: (which: keyof SectionVisibility) => void;
  refreshLocal: () => void;
  /** Refresh one remote's trees, or all remotes when no id is given. */
  refreshRemote: (connId?: string) => void;
  /** Refresh one distro's trees, or all distros when no id is given. */
  refreshWsl: (connId?: string) => void;
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
  setActiveTerminal: (id: string | null) => void;
  /** Switch the panel to a host and restore the terminal last used there. */
  pickHostTerminal: (connId: string) => void;
  /** Version found by the quiet launch update check — lights the green dot on
   *  ⚙ → Check for updates instead of interrupting with a dialog. */
  updateAvailable: string | null;
  setUpdateAvailable: (version: string | null) => void;
  /** What the terminal panel body shows: the terminals, or a tool group. */
  terminalView: "terminals" | "containers" | "ports" | "forwarding" | "transfers";
  setTerminalView: (
    v: "terminals" | "containers" | "ports" | "forwarding" | "transfers",
  ) => void;
  /** Panel group-bar order (conn ids; unknown/new conns append). Draggable. */
  termGroupOrder: string[];
  setTermGroupOrder: (order: string[]) => void;
  /** CHAT host grouping order (conn ids). Draggable in the focus view; shared
   *  by the CHAT panel's dot clusters. Unknown/new hosts append. */
  chatHostOrder: string[];
  setChatHostOrder: (order: string[]) => void;
  /** User-made purpose groups (in display order). Session-lived, shared by
   *  the focus view and the CHAT panel. */
  chatPurposes: ChatPurpose[];
  addPurpose: (name?: string) => string;
  renamePurpose: (id: string, name: string) => void;
  /** Dissolve a group — its agents fall back to their host blocks. */
  deletePurpose: (id: string) => void;
  /** Move an agent INTO a group (leaving any other group — the move model). */
  addToPurpose: (purposeId: string, termId: string) => void;
  /** Remove an agent from whatever group holds it (back to its host block). */
  removeFromPurpose: (termId: string) => void;
  /** Reorder groups — drag a purpose before (or, with `after`, after) another,
   *  so the last slot is reachable too. */
  movePurpose: (dragId: string, targetId: string, after?: boolean) => void;
  /** Reorder a member within its group (drag one agent before another). */
  reorderInPurpose: (purposeId: string, dragId: string, targetId: string) => void;
  /** The selected group chip (conn id) — in the store so shortcuts can target
   *  it (Ctrl+Shift+` in an empty group). The panel keeps it in step with the
   *  active terminal. */
  termGroup: string | null;
  setTermGroup: (connId: string | null) => void;
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
  /** Startup asks: one "connect to last …?" per saved WSL distro / remote. */
  connectAsks: {
    kind: "wsl" | "remote";
    label: string;
    /** Host identity ("wsl:<name>" / "user@host:port") — what the dialog's
     *  "don't ask again" checkbox writes into settings `autoConnect`. */
    hostKey: string;
    run: () => void;
    onSkip?: () => void;
  }[];
  pushConnectAsk: (a: {
    kind: "wsl" | "remote";
    label: string;
    hostKey: string;
    run: () => void;
    onSkip?: () => void;
  }) => void;
  shiftConnectAsk: () => void;
  /** OSC title from the shell — updates the auto name, never the rename. */
  setTerminalTitle: (id: string, title: string) => void;
  /** User rename; empty/whitespace clears it (back to the auto name). */
  renameTerminal: (id: string, name: string) => void;
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
  /** Create a new EMPTY group after the active one and focus it (Ctrl+2/3 on
   *  the next index, or Ctrl+\ with a single file). Null at the cap. */
  addEmptyGroup: () => number | null;
  /** Remove an EMPTY group (the pane's ✕). No-op for the last group or one
   *  that still holds tabs. */
  closeGroup: (gid: number) => void;
  /** Move a tab into a new group — right of its own, or at the far right. */
  splitRight: (tabId: string, opts?: { end?: boolean }) => void;
  /** Move a tab into an existing group. */
  moveTabToGroup: (tabId: string, gid: number) => void;
  /** Drag-drop: place a tab in `gid` before `beforeId` (null = group end).
   *  Same group = reorder; different group = move. */
  moveTabToPosition: (tabId: string, gid: number, beforeId: string | null) => void;
  /** Session restore: reassign tabs to groups in one pass. */
  setTabGroups: (byTabId: Record<string, number>) => void;
  // CHAT column (the straight terminal docked beside SC) --------------------
  /** Residents are terminals with `inChat`; one shows at a time (the dots
   *  switch). Hiding the column never evicts residents. */
  chatVisible: boolean;
  setChatVisible: (v: boolean) => void;
  /** Focus view (F11): a full-window CHAT workspace (agent list + the active
   *  agent's live terminal) overlaying the normal layout. */
  focusView: boolean;
  setFocusView: (v: boolean) => void;
  toggleChat: () => void;
  /** The resident currently on screen. */
  chatActiveId: string | null;
  setChatActive: (id: string) => void;
  /** Send an existing panel terminal to the chat column (shell keeps running). */
  moveTerminalToChat: (terminalId: string) => void;
  /** − on the name line: the resident goes back to the bottom panel. */
  returnTerminalFromChat: (terminalId: string) => void;
  /** ＋ in the chat header: open a fresh shell directly as a resident. Opts
   *  cover the usage probe: timed keystrokes, an input lock, auto-close on
   *  focus-view exit. Returns the new terminal's id. */
  openTerminalInChat: (
    connId: string,
    label: string,
    opts?: Pick<
      TerminalSession,
      "scriptedInput" | "locked" | "usageProbe" | "laneConnId" | "initialInput"
    >,
  ) => string;
  /** Open a SESSIONS/F11 agent. On SSH/WSL hosts the agent gets its own
   *  dedicated connection (a session lane) so a busy agent can't slow or
   *  break any other terminal. At the per-host cap (Preferences → Session
   *  connections) it falls back to the shared main connection with a toast;
   *  on a dial failure nothing opens — the host is struggling, and that is
   *  surfaced rather than masked. Local agents just open (no SSH). */
  openAgentInChat: (
    connId: string,
    label: string,
    opts?: { initialInput?: string },
  ) => Promise<string | null>;
  /** Left→right arrangement of the editor + the two movable columns, after the
   *  pinned explorer. Persisted. */
  dockOrder: DockToken[];
  /** Step a column one place left/right, swapping with whatever is there —
   *  the editor or the other column. */
  stepDock: (panel: "scm" | "chat", dir: 1 | -1) => void;
  /** Open (or focus) the Settings / Themes editor tabs. */
  openAppTab: (
    kind: "settings" | "themes" | "pins" | "drafts" | "autoconnect",
  ) => void;

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
  /** Flip an open log tab's lens (git ⇄ jj on a colocated repo). */
  setLogTabBackend: (connId: string, root: string, backend: string) => void;
  setActiveTab: (id: string) => void;
  cycleTab: (direction: 1 | -1) => void;
  closeTab: (id: string, allowPinned?: boolean) => void;
  forceCloseTab: (id: string) => void;
  setTabDirty: (id: string, dirty: boolean) => void;
  /** Merge hot-exit draft state into a tab (restore/discard flows). */
  setTabDraft: (
    id: string,
    d: {
      draftApplied?: boolean;
      draftBaselineMtime?: number;
    },
  ) => void;
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
      lossy: boolean;
    },
  ) => void;
  setTabCursor: (id: string, cursor: CursorPosition) => void;
  setBusyPath: (path: string | null) => void;

  /** Set/clear a tab's conflict flag (drives the conflict bar + Ctrl+S block). */
  setTabConflict: (id: string, on: boolean) => void;
  clearCloseConfirm: () => void;

  setSelected: (node: TreeNode | null) => void;
  /** Ctrl+click: toggle a node in the selection (resets across connections). */
  toggleSelected: (node: TreeNode) => void;
  /** Shift+click: replace the selection with a computed range, keeping `anchor`. */
  setSelection: (nodes: TreeNode[], anchor: TreeNode) => void;
  openContextMenu: (
    node: TreeNode & { root?: boolean; unpin?: () => void },
    x: number,
    y: number,
  ) => void;
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
    /** Pre-flight size (from the confirm sheet's fsMeasure) so the bar shows
     *  the real total immediately and the backend skips a second size walk. */
    total?: { bytes: number; files: number } | null;
    /** "download" flavors the toasts ("Downloaded N files to Downloads.") —
     *  same engine, same bar, same cancel; only the words change. */
    kind?: "download";
    /** Where the download landed, for its completion toast ("Downloads" or the
     *  configured folder). */
    destLabel?: string;
    /** Speed picked on the confirm sheet; absent (downloads) = the
     *  Preferences default. Background = shallow pipeline + the MB/s cap. */
    mode?: "full" | "background";
  }) => Promise<void>;
  updateTransferProgress: (progress: TransferProgress) => void;
  cancelActiveTransfer: () => void;
  startRename: (connId: string, path: string, scope: RenameScope) => void;
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

  // Notification bell: every toast lands here too (nothing else does — what
  // was deliberately silent stays silent). ------------------------------------
  noticeLog: NoticeLogEntry[];
  /** Unread count since the bell was last opened. */
  noticeUnread: number;
  bellOpen: boolean;
  setBellOpen: (open: boolean) => void;
  clearNoticeLog: () => void;

  // Terminal attention: BEL from an unfocused shell lights its dot/entry. ----
  belled: Record<string, true>;
  markBell: (terminalId: string) => void;
  clearBell: (terminalId: string) => void;
  /** Terminals with output flowing right now (raw signal — includes redraws).
   *  Set on PTY output, cleared after a short idle. */
  busy: Record<string, true>;
  setBusy: (terminalId: string, on: boolean) => void;
  /** Terminals genuinely WORKING (a tool streaming a long response) — busy
   *  that's been SUSTAINED past a chunk threshold, so a click/resize redraw
   *  never counts. This is the "thinking" signal the focus view animates. */
  thinking: Record<string, true>;
  setThinking: (terminalId: string, on: boolean) => void;
  /** When each terminal STARTED its current thinking spell (ms) — the focus
   *  view counts seconds up from this while it works. */
  thinkingSince: Record<string, number>;
  /** When each terminal last FINISHED (ms) — stamped when a real work spell
   *  ends (thinking→idle) or on the BEL, both discrete, NEVER on a redraw.
   *  The focus view shows "Ns ago" from this; it doesn't reset on clicks. */
  finishedAt: Record<string, number>;
  /** Terminals whose PTY has exited (the backend sends an empty output chunk
   *  when the shell dies). Cleared when a fresh PTY opens (epoch restart). */
  ptyDead: Record<string, true>;
  setPtyDead: (terminalId: string, on: boolean) => void;
  /** Record (or clear) a terminal's live backend PTY id — set when its PTY opens
   *  so a re-attaching view (the sessions pop-out) can find the same shell. */
  setTerminalPtyId: (terminalId: string, ptyId: string | null) => void;
}

let noticeId = 0;
let tabCounter = 0;

/** Globally-unique ids for things that CROSS windows (docs/dev/multi-window.md).
 *  Terminals and purpose groups are created independently in main AND the
 *  sessions pop-out, then merged back by id on return — a per-window counter
 *  collides across that hand-off (the pop-out's "term-1" dedupes against
 *  main's unrelated "term-1" and silently vanishes). Random ids can't collide.
 *  Tabs and notices stay window-local, so their counters are fine. */
const crossWindowId = (prefix: string) =>
  `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

export const useAppStore = create<AppState>()((set, get) => ({
  localConnId: null,
  pinnedFolders: loadPinned(),

  remotes: [],
  remote: null,
  remoteRootPath: null,
  remotePins: [],
  wsls: [],
  wsl: null,
  wslState: "disconnected",
  wslRootPath: null,
  wslPins: [],
  connState: "disconnected",
  connMessage: null,

  dialogOpen: false,
  dialogPrefill: null,
  dialogNote: null,
  passphrasePrompt: null,
  hostKeyPrompt: null,
  finderOpen: false,
  searchOpen: false,
  portsOpen: false,
  paletteOpen: false,
  settingsIssues: [],
  revealTarget: null,
  terminalView: "terminals" as const,
  sidebarVisible: true,
  terminalVisible: true,
  suppressed: { chat: false, scm: false, sidebar: false, terminal: false },
  setSuppressed: (suppressed) => set({ suppressed }),
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
  sections: loadSections(),

  terminals: [],
  activeTerminalId: null,
  lastActiveByHost: {},
  updateAvailable: null,

  tabs: [],
  activeTabId: null,
  editorGroups: [0],
  activeGroupId: 0,
  groupActive: {},
  busyPath: null,
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

  adoptConnections: (snap) =>
    set(() => ({
      localConnId: snap.localConnId,
      ...remoteMirror(snap.remotes ?? []),
      ...wslMirror(snap.wsls ?? []),
    })),

  // The pop-out's boot: take the registry wholesale — sessions, F11 layout
  // (purposes + host order), and the status maps. This window starts empty,
  // so a replace is exact (docs/dev/multi-window.md).
  adoptSessions: (reg) =>
    set((s) => ({
      terminals: reg.sessions,
      chatPurposes: reg.purposes,
      chatHostOrder: reg.hostOrder,
      chatActiveId: reg.activeId ?? s.chatActiveId,
      belled: reg.belled,
      finishedAt: reg.finishedAt,
      thinking: reg.thinking,
      thinkingSince: reg.thinkingSince,
      ptyDead: reg.ptyDead,
      activeTerminalId: reg.sessions.some((t) => t.id === s.activeTerminalId)
        ? s.activeTerminalId
        : (reg.sessions[0]?.id ?? null),
    })),

  // The return: absorb sessions this window doesn't have (by id — ids are
  // cross-window unique), keeping its own non-CHAT terminals untouched; the
  // shared PTYs re-attach on render. Layout (purposes + host order) is taken
  // wholesale — the pop-out owned it while popped; main's copy was frozen at
  // the pop. Status maps overlay per session (docs/dev/multi-window.md).
  mergeSessions: (reg) =>
    set((s) => {
      const have = new Set(s.terminals.map((t) => t.id));
      const missing = reg.sessions.filter((t) => !have.has(t.id));
      return {
        terminals: missing.length ? [...s.terminals, ...missing] : s.terminals,
        chatPurposes: reg.purposes,
        chatHostOrder: reg.hostOrder,
        chatActiveId: reg.activeId ?? s.chatActiveId,
        belled: { ...s.belled, ...reg.belled },
        finishedAt: { ...s.finishedAt, ...reg.finishedAt },
        thinking: { ...s.thinking, ...reg.thinking },
        thinkingSince: { ...s.thinkingSince, ...reg.thinkingSince },
        ptyDead: { ...s.ptyDead, ...reg.ptyDead },
      };
    }),

  // The pop hand-off (docs/dev/multi-window.md): drop the CHAT sessions from
  // this window's list WITHOUT closing their PTYs — the shells live in the
  // backend and the pop-out re-attaches to them; these entries were only
  // main's views of them. Non-CHAT terminals are untouched.
  clearChatSessions: () =>
    set((s) => {
      const terminals = s.terminals.filter((t) => !t.inChat);
      return {
        terminals,
        activeTerminalId: terminals.some((t) => t.id === s.activeTerminalId)
          ? s.activeTerminalId
          : (terminals[0]?.id ?? null),
      };
    }),

  sessionsPoppedOut: false,
  setSessionsPoppedOut: (on) => set({ sessionsPoppedOut: on }),

  workspaceOpen: false,
  setWorkspaceOpen: (on) => set({ workspaceOpen: on }),

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

  clearRemote: (connId) => {
    const target = connId ?? get().remotes[0]?.conn.connId;
    if (!target) return;
    // The view no longer closes PTYs on unmount, so hang up this host's shells
    // here (dead already if it dropped — this reclaims the backend handle).
    for (const t of get().terminals) {
      if (t.connId === target && t.ptyId) void ptyClose(t.ptyId).catch(() => {});
    }
    set((s) => {
      const remotes = s.remotes.filter((r) => r.conn.connId !== target);
      // Close any tabs and terminals belonging to that remote.
      const tabs = s.tabs.filter((t) => t.connId !== target);
      const terminals = s.terminals.filter((t) => t.connId !== target);
      const activeTerminalId = terminals.some((t) => t.id === s.activeTerminalId)
        ? s.activeTerminalId
        : (terminals[terminals.length - 1]?.id ?? null);
      // Disconnect retires the connId for good — drop its terminal memory.
      const lastActiveByHost = { ...s.lastActiveByHost };
      delete lastActiveByHost[target];
      return {
        ...remoteMirror(remotes),
        connState: remotes[0]?.state ?? "disconnected",
        connMessage: null,
        ...(tabs.length !== s.tabs.length ? groupsPatch(s, tabs) : {}),
        terminals,
        activeTerminalId,
        lastActiveByHost,
      };
    });
  },

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

  addWsl: (conn, rootPath) =>
    set((s) => {
      const fresh: RemoteWorkspace = {
        conn,
        rootPath,
        pins: loadConnPins(WSL_PINS_KEY, conn.name) ?? [rootPath],
        showHidden: false,
        refreshToken: 0,
        lastRefresh: null,
        state: "connected",
      };
      const idx = s.wsls.findIndex((w) => w.conn.name === conn.name);
      const wsls =
        idx >= 0
          ? // Reconnect of a known distro: keep its pins/toggles, swap the conn.
            s.wsls.map((w, i) =>
              i === idx ? { ...fresh, pins: w.pins, showHidden: w.showHidden } : w,
            )
          : [...s.wsls, fresh];
      return wslMirror(wsls);
    }),

  removeWsl: (connId) => {
    // The view no longer closes PTYs on unmount — hang up this distro's shells.
    for (const t of get().terminals) {
      if (t.connId === connId && t.ptyId) void ptyClose(t.ptyId).catch(() => {});
    }
    set((s) => {
      const wsls = s.wsls.filter((w) => w.conn.connId !== connId);
      if (wsls.length === s.wsls.length) return {};
      const tabs = s.tabs.filter((t) => t.connId !== connId);
      const terminals = s.terminals.filter((t) => t.connId !== connId);
      const activeTerminalId = terminals.some((t) => t.id === s.activeTerminalId)
        ? s.activeTerminalId
        : (terminals[terminals.length - 1]?.id ?? null);
      // Disconnect retires the connId for good — drop its terminal memory.
      const lastActiveByHost = { ...s.lastActiveByHost };
      delete lastActiveByHost[connId];
      return {
        ...wslMirror(wsls),
        ...(tabs.length !== s.tabs.length ? groupsPatch(s, tabs) : {}),
        terminals,
        activeTerminalId,
        lastActiveByHost,
      };
    });
  },

  setWslConnState: (connId, state) =>
    set((s) =>
      wslMirror(
        s.wsls.map((w) => (w.conn.connId === connId ? { ...w, state } : w)),
      ),
    ),

  addWslPin: (connId, path) =>
    set((s) => {
      const entry = s.wsls.find((w) => w.conn.connId === connId);
      if (!entry || entry.pins.includes(path)) return {};
      const pins = [...entry.pins, path];
      saveConnPins(WSL_PINS_KEY, entry.conn.name, pins);
      return wslMirror(
        s.wsls.map((w) => (w.conn.connId === connId ? { ...w, pins } : w)),
      );
    }),
  removeWslPin: (connId, path) =>
    set((s) => {
      const entry = s.wsls.find((w) => w.conn.connId === connId);
      if (!entry) return {};
      const pins = entry.pins.filter((p) => p !== path);
      saveConnPins(WSL_PINS_KEY, entry.conn.name, pins);
      return wslMirror(
        s.wsls.map((w) => (w.conn.connId === connId ? { ...w, pins } : w)),
      );
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
  openPassphrasePrompt: (passphrasePrompt) => set({ passphrasePrompt }),
  closePassphrasePrompt: () => set({ passphrasePrompt: null }),
  openHostKeyPrompt: (hostKeyPrompt) => set({ hostKeyPrompt }),
  closeHostKeyPrompt: () => set({ hostKeyPrompt: null }),
  setFinderOpen: (finderOpen) => set({ finderOpen }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setPortsOpen: (portsOpen) => set({ portsOpen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setSettingsIssues: (settingsIssues) => set({ settingsIssues }),
  settingsRev: 0,
  bumpSettingsRev: () => set((s) => ({ settingsRev: s.settingsRev + 1 })),
  editorFocusSeq: 0,
  requestEditorFocus: () =>
    set((s) => ({ editorFocusSeq: s.editorFocusSeq + 1 })),
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
  toggleHiddenWsl: (connId) =>
    set((s) =>
      wslMirror(
        s.wsls.map((w) =>
          w.conn.connId === connId ? { ...w, showHidden: !w.showHidden } : w,
        ),
      ),
    ),
  swapRemotes: (a, b) =>
    set((s) => {
      if (
        a === b ||
        a < 0 ||
        b < 0 ||
        a >= s.remotes.length ||
        b >= s.remotes.length
      ) {
        return {};
      }
      const remotes = [...s.remotes];
      [remotes[a], remotes[b]] = [remotes[b], remotes[a]];
      return { remotes };
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
  refreshWsl: (connId) =>
    set((s) =>
      wslMirror(
        s.wsls.map((w) =>
          connId === undefined || w.conn.connId === connId
            ? { ...w, refreshToken: w.refreshToken + 1 }
            : w,
        ),
      ),
    ),
  refreshConn: (connId) =>
    set((s) =>
      connId === s.localConnId
        ? { refreshTokenLocal: s.refreshTokenLocal + 1 }
        : s.wsls.some((w) => w.conn.connId === connId)
          ? wslMirror(
              s.wsls.map((w) =>
                w.conn.connId === connId
                  ? { ...w, refreshToken: w.refreshToken + 1 }
                  : w,
              ),
            )
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
        : s.wsls.some((w) => w.conn.connId === connId)
          ? wslMirror(
              s.wsls.map((w) =>
                w.conn.connId === connId ? { ...w, lastRefresh: Date.now() } : w,
              ),
            )
          : remoteMirror(
              s.remotes.map((r) =>
                r.conn.connId === connId ? { ...r, lastRefresh: Date.now() } : r,
              ),
            ),
    ),

  openTerminal: (connId, label, command = null, initialInput = null) =>
    set((s) => {
      const id = crossWindowId("term");
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

  openTerminalInChat: (connId, label, opts) => {
    const id = crossWindowId("term");
    set((s) => {
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
        command: null,
        initialInput: null,
        ...opts,
        epoch: 0,
        inChat: true,
      };
      // Born a resident: the panel's active terminal is untouched.
      persistChatVisible(true);
      return {
        terminals: [...s.terminals, term],
        chatActiveId: id,
        chatVisible: true,
      };
    });
    return id;
  },

  openAgentInChat: async (connId, label, opts) => {
    const s = get();
    // Lazy import — settings.ts imports this store, so a static import here
    // would be a module cycle.
    const { sessionConnConfig } = await import("../lib/settings");
    // Local agents have no SSH; max 0 = "always share" (documented setting).
    if (connId === s.localConnId || sessionConnConfig.max === 0) {
      return s.openTerminalInChat(connId, label, opts);
    }
    try {
      const laneId = await sessionLaneConnect(connId, label, sessionConnConfig.max);
      // No toast: a dedicated lane is internal plumbing. Whether this agent got
      // its own connection or shares the main one shows on demand in the
      // status-bar host tooltip, not as an interruption.
      return get().openTerminalInChat(connId, label, { ...opts, laneConnId: laneId });
    } catch (e) {
      const msg = String(e);
      if (msg.includes("SESSION_LANE_LIMIT:")) {
        const host =
          s.wsls.find((w) => w.conn.connId === connId)?.conn.name ??
          s.remotes.find((r) => r.conn.connId === connId)?.conn.name ??
          "this host";
        get().pushNotice(
          "warn",
          `New session "${label}" opened on ${host}'s shared connection — all ${sessionConnConfig.max} dedicated session connections are already taken by other sessions. It works normally; to give more sessions their own connection, raise Preferences → Session connections.`,
        );
        return get().openTerminalInChat(connId, label, opts);
      }
      get().pushNotice(
        "error",
        `Couldn't open a dedicated connection for "${label}": ${msg} — try again, or open a terminal from the terminal panel (it shares the main connection).`,
      );
      return null;
    }
  },

  closeTerminal: (id) => {
    const sess = get().terminals.find((t) => t.id === id);
    // A session-lane agent owns its connection — closing the agent hangs the
    // dedicated SSH connection up with it (the backend frees the sshd slot).
    const lane = sess?.laneConnId;
    if (lane && lane.includes("::session-")) {
      void sshDisconnect(lane).catch(() => {});
    }
    // The terminal's view no longer closes its PTY on unmount (the PTY outlives
    // the view — docs/dev/multi-window.md), so closing the terminal is what
    // closes the shell. Harmless if the lane disconnect above already killed it.
    if (sess?.ptyId) void ptyClose(sess.ptyId).catch(() => {});
    set((s) => {
      const sess = s.terminals.find((t) => t.id === id);
      if (!sess) return {};
      const terminals = s.terminals.filter((t) => t.id !== id);
      // Each home picks its own successor: the panel from the panel ring, the
      // chat column from its residents — position-preserving like forceCloseTab.
      let activeTerminalId = s.activeTerminalId;
      if (!sess.inChat && s.activeTerminalId === id) {
        // The successor stays on the SAME host — closing a group's last
        // terminal keeps you in that group (its empty state shows), never
        // jumping the bar to another host.
        const ring = s.terminals.filter(
          (t) => !t.inChat && t.connId === sess.connId,
        );
        const rIdx = ring.findIndex((t) => t.id === id);
        const rest = ring.filter((t) => t.id !== id);
        activeTerminalId = rest[rIdx - 1]?.id ?? rest[rIdx]?.id ?? null;
      }
      let chatActiveId = s.chatActiveId;
      if (sess.inChat && s.chatActiveId === id) {
        // Usage probes are never AUTO-selected (only "check usage" shows
        // one) — closing the last real session lands on the splash, not
        // the hidden usage terminal.
        const residents = s.terminals.filter((t) => t.inChat && !t.usageProbe);
        const cIdx = residents.findIndex((t) => t.id === id);
        const rest = residents.filter((t) => t.id !== id);
        chatActiveId =
          cIdx >= 0
            ? (rest[cIdx - 1]?.id ?? rest[cIdx]?.id ?? null)
            : (rest[0]?.id ?? null);
      }
      let belled = s.belled;
      if (belled[id]) {
        belled = { ...belled };
        delete belled[id];
      }
      let busy = s.busy;
      if (busy[id]) {
        busy = { ...busy };
        delete busy[id];
      }
      let ptyDead = s.ptyDead;
      if (ptyDead[id]) {
        ptyDead = { ...ptyDead };
        delete ptyDead[id];
      }
      // Drop the closed agent from any purpose group it belonged to.
      const chatPurposes = s.chatPurposes.some((p) => p.termIds.includes(id))
        ? s.chatPurposes.map((p) => ({
            ...p,
            termIds: p.termIds.filter((t) => t !== id),
          }))
        : s.chatPurposes;
      return {
        terminals,
        activeTerminalId,
        chatActiveId,
        belled,
        busy,
        ptyDead,
        chatPurposes,
      };
    });
  },

  setActiveTerminal: (activeTerminalId) =>
    set({ activeTerminalId, terminalView: "terminals" }),

  setUpdateAvailable: (updateAvailable) => set({ updateAvailable }),

  pickHostTerminal: (connId) =>
    set((s) => {
      const mem = { ...s.lastActiveByHost };
      // The current active terminal already reflects the last one focused on
      // the host we're leaving — remember it before we switch away.
      const cur = s.terminals.find(
        (t) => t.id === s.activeTerminalId && !t.inChat,
      );
      if (cur) mem[cur.connId] = cur.id;
      // Restore this host's last-used terminal; if it was closed while away,
      // fall back to its newest (list order).
      const hostTerms = s.terminals.filter(
        (t) => !t.inChat && t.connId === connId,
      );
      const target =
        hostTerms.find((t) => t.id === mem[connId]) ??
        hostTerms[hostTerms.length - 1];
      if (target) mem[connId] = target.id;
      return {
        lastActiveByHost: mem,
        activeTerminalId: target?.id ?? null,
        terminalView: "terminals" as const,
      };
    }),

  setTerminalView: (terminalView) => set({ terminalView }),

  termGroupOrder: [],
  setTermGroupOrder: (termGroupOrder) => set({ termGroupOrder }),
  chatHostOrder: [],
  setChatHostOrder: (chatHostOrder) => set({ chatHostOrder }),

  chatPurposes: [],
  addPurpose: (name) => {
    const id = crossWindowId("grp");
    set((s) => {
      const color = PURPOSE_COLORS[s.chatPurposes.length % PURPOSE_COLORS.length];
      return {
        chatPurposes: [
          ...s.chatPurposes,
          {
            id,
            name: name?.trim() || `IN PROGRESS ${s.chatPurposes.length + 1}`,
            color,
            termIds: [],
          },
        ],
      };
    });
    return id;
  },
  renamePurpose: (id, name) =>
    set((s) => ({
      chatPurposes: s.chatPurposes.map((p) =>
        p.id === id ? { ...p, name: name.trim() || p.name } : p,
      ),
    })),
  deletePurpose: (id) =>
    set((s) => ({ chatPurposes: s.chatPurposes.filter((p) => p.id !== id) })),
  addToPurpose: (purposeId, termId) =>
    set((s) => ({
      chatPurposes: s.chatPurposes.map((p) =>
        p.id === purposeId
          ? { ...p, termIds: [...p.termIds.filter((t) => t !== termId), termId] }
          : { ...p, termIds: p.termIds.filter((t) => t !== termId) },
      ),
    })),
  removeFromPurpose: (termId) =>
    set((s) => ({
      chatPurposes: s.chatPurposes.map((p) => ({
        ...p,
        termIds: p.termIds.filter((t) => t !== termId),
      })),
    })),
  movePurpose: (dragId, targetId, after) =>
    set((s) => {
      if (dragId === targetId) return {};
      const order = [...s.chatPurposes];
      const from = order.findIndex((p) => p.id === dragId);
      if (from < 0) return {};
      const [moved] = order.splice(from, 1);
      let to = order.findIndex((p) => p.id === targetId);
      if (to < 0) return { chatPurposes: [...order, moved] };
      if (after) to += 1;
      order.splice(to, 0, moved);
      return { chatPurposes: order };
    }),
  reorderInPurpose: (purposeId, dragId, targetId) =>
    set((s) => ({
      chatPurposes: s.chatPurposes.map((p) => {
        if (p.id !== purposeId) return p;
        const ids = [...p.termIds];
        const from = ids.indexOf(dragId);
        const to = ids.indexOf(targetId);
        if (from < 0 || to < 0 || from === to) return p;
        ids.splice(from, 1);
        ids.splice(ids.indexOf(targetId), 0, dragId);
        return { ...p, termIds: ids };
      }),
    })),
  termGroup: null,
  setTermGroup: (termGroup) => set({ termGroup }),
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
  setTerminalTitle: (id, oscTitle) =>
    set((s) => {
      // Store the raw OSC title; whether it's shown is decided at display time
      // (cleanOscTitle), so a shell dropping back to path noise reverts the
      // name to its default label instead of freezing on the last tool name.
      const sess = s.terminals.find((t) => t.id === id);
      if (!sess || sess.oscTitle === oscTitle) return {};
      return {
        terminals: s.terminals.map((t) =>
          t.id === id ? { ...t, oscTitle } : t,
        ),
      };
    }),

  renameTerminal: (id, name) =>
    set((s) => {
      const clean = name.trim();
      return {
        terminals: s.terminals.map((t) => {
          if (t.id !== id) return t;
          // Renaming to the current auto name (or to nothing) clears the
          // override, so the name keeps following the shell again.
          const auto = cleanOscTitle(t.oscTitle) ?? t.title;
          return { ...t, customName: clean && clean !== auto ? clean : undefined };
        }),
      };
    }),

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
      // Chat residents aren't part of the panel's ring.
      const ring = s.terminals.filter((t) => !t.inChat);
      if (ring.length === 0) return {};
      const idx = ring.findIndex((t) => t.id === s.activeTerminalId);
      const next = ring[(idx + direction + ring.length) % ring.length];
      return { activeTerminalId: next.id };
    }),

  restartConnTerminals: (connId) => {
    // Match by the lane actually carrying the PTY: a main-lane reconnect
    // restarts only the shared terminals (agents on their own session lanes
    // never died with it), and a session-lane reconnect restarts just its
    // one agent.
    const affected = (t: TerminalSession) =>
      (t.laneConnId ?? t.connId) === connId;
    // The view no longer closes the PTY on unmount, so the restart owns it:
    // hang up each dead PTY, then bump epoch (remount) with its id cleared so
    // the fresh view opens a new shell instead of re-attaching a corpse.
    for (const t of get().terminals) {
      if (affected(t) && t.ptyId) void ptyClose(t.ptyId).catch(() => {});
    }
    set((s) => ({
      terminals: s.terminals.map((t) =>
        affected(t) ? { ...t, epoch: t.epoch + 1, ptyId: null } : t,
      ),
    }));
  },

  closeConnTerminals: (connId) => {
    // The view no longer closes PTYs on unmount, so hang up each removed
    // terminal's shell here (usually already dead if the host dropped — this
    // reclaims the backend handle either way).
    for (const t of get().terminals) {
      if (t.connId === connId && t.ptyId) void ptyClose(t.ptyId).catch(() => {});
    }
    set((s) => {
      const terminals = s.terminals.filter((t) => t.connId !== connId);
      const panel = terminals.filter((t) => !t.inChat);
      const activeTerminalId = terminals.some((t) => t.id === s.activeTerminalId)
        ? s.activeTerminalId
        : (panel[panel.length - 1]?.id ?? null);
      const chatActiveId = terminals.some(
        (t) => t.id === s.chatActiveId && t.inChat,
      )
        ? s.chatActiveId
        : (terminals.find((t) => t.inChat && !t.usageProbe)?.id ?? null);
      return { terminals, activeTerminalId, chatActiveId };
    });
  },

  openAppTab: (kind) =>
    set((s) => {
      const id = `app::${kind}`;
      if (s.tabs.some((t) => t.id === id)) return groupsPatch(s, s.tabs, id);
      const tab: EditorTab = {
        id,
        connId: s.localConnId ?? "",
        path: id,
        name:
          kind === "settings"
            ? "Preferences"
            : kind === "themes"
              ? "Theme"
              : kind === "pins"
                ? "Pinned files"
                : kind === "autoconnect"
                  ? "Auto-connect"
                  : "Drafts",
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
        (t) => t.connId === tab.connId && t.path === tab.path,
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

  addEmptyGroup: () => {
    let created: number | null = null;
    set((s) => {
      if (s.editorGroups.length >= MAX_EDITOR_GROUPS) return {};
      const gid = Math.max(0, ...s.editorGroups) + 1;
      created = gid;
      const editorGroups = [...s.editorGroups];
      const at = editorGroups.indexOf(s.activeGroupId);
      editorGroups.splice(at < 0 ? editorGroups.length : at + 1, 0, gid);
      return { editorGroups, activeGroupId: gid, activeTabId: null };
    });
    return created;
  },

  closeGroup: (gid) =>
    set((s) => {
      if (
        !s.editorGroups.includes(gid) ||
        s.editorGroups.length <= 1 ||
        s.tabs.some((t) => (t.groupId ?? 0) === gid)
      ) {
        return {};
      }
      const editorGroups = s.editorGroups.filter((g) => g !== gid);
      let activeGroupId = s.activeGroupId;
      if (activeGroupId === gid) {
        const oldIdx = s.editorGroups.indexOf(gid);
        activeGroupId =
          editorGroups[Math.max(0, Math.min(oldIdx - 1, editorGroups.length - 1))] ??
          editorGroups[0];
      }
      return {
        editorGroups,
        activeGroupId,
        activeTabId: s.groupActive[activeGroupId] ?? null,
      };
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

  focusView: false,
  setFocusView: (focusView) => set({ focusView }),
  chatVisible: localStorage.getItem(CHAT_VIS_KEY) === "1",
  setChatVisible: (chatVisible) => {
    persistChatVisible(chatVisible);
    set({ chatVisible });
  },
  toggleChat: () =>
    set((s) => {
      persistChatVisible(!s.chatVisible);
      return { chatVisible: !s.chatVisible };
    }),
  chatActiveId: null,
  setChatActive: (chatActiveId) => set({ chatActiveId }),

  moveTerminalToChat: (terminalId) =>
    set((s) => {
      const sess = s.terminals.find((t) => t.id === terminalId);
      if (!sess || sess.inChat) return {};
      const terminals = s.terminals.map((t) =>
        t.id === terminalId ? { ...t, inChat: true } : t,
      );
      // The panel's active slot moves on to a remaining terminal of the SAME
      // host (or the group's empty state) — never another host's group.
      const panelLeft = terminals.filter((t) => !t.inChat);
      const activeTerminalId =
        s.activeTerminalId === terminalId
          ? (panelLeft.find((t) => t.connId === sess.connId)?.id ?? null)
          : s.activeTerminalId;
      persistChatVisible(true);
      return {
        terminals,
        activeTerminalId,
        chatActiveId: terminalId,
        chatVisible: true,
      };
    }),

  returnTerminalFromChat: (terminalId) =>
    set((s) => {
      const sess = s.terminals.find((t) => t.id === terminalId);
      if (!sess?.inChat) return {};
      const terminals = s.terminals.map((t) =>
        t.id === terminalId ? { ...t, inChat: false } : t,
      );
      let chatActiveId = s.chatActiveId;
      if (chatActiveId === terminalId) {
        // Never auto-fall to a hidden usage probe (see closeTerminal).
        const before = s.terminals.filter((t) => t.inChat && !t.usageProbe);
        const cIdx = before.findIndex((t) => t.id === terminalId);
        const rest = before.filter((t) => t.id !== terminalId);
        chatActiveId =
          cIdx >= 0
            ? (rest[cIdx - 1]?.id ?? rest[cIdx]?.id ?? null)
            : (rest[0]?.id ?? null);
      }
      // The returned shell becomes the panel's active terminal so it lands
      // somewhere visible instead of vanishing into the list.
      return {
        terminals,
        chatActiveId,
        activeTerminalId: terminalId,
        terminalView: "terminals" as const,
      };
    }),

  dockOrder: loadDockOrder(),
  stepDock: (panel, dir) =>
    set((s) => {
      const order = [...s.dockOrder];
      const i = order.indexOf(panel);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= order.length) return {};
      // Swap with the neighbor — the editor or the other column.
      [order[i], order[j]] = [order[j], order[i]];
      try {
        localStorage.setItem(DOCK_KEY, JSON.stringify(order));
      } catch {
        /* prefs only */
      }
      return { dockOrder: order };
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
      // Persist the pin per host — pinned files reopen on every connect
      // (lib/pinnedTabs; closing a pinned tab does not unpin the file).
      if (!tab.kind || tab.kind === "file") {
        const wslOwner = s.wsls.find((w) => w.conn.connId === tab.connId);
        const remoteOwner = s.remotes.find((r) => r.conn.connId === tab.connId);
        const connKey =
          tab.connId === s.localConnId
            ? "local"
            : wslOwner
              ? `wsl:${wslOwner.conn.name}`
              : remoteOwner
                ? remoteHostKey(remoteOwner.conn)
                : null;
        if (connKey) setTabPinned(connKey, tab.path, pinned);
      }
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
        // Just the repo name — the ⎇ glyph marks it as history, and the
        // view's own head line says which lens (git/jj).
        name: d.label,
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

  setLogTabBackend: (connId, root, backend) =>
    set((s) => ({
      // Matched by the tab's own fields (not a rebuilt id string) so the
      // patch can't silently drift from the id format.
      tabs: s.tabs.map((t) =>
        t.kind === "log" && t.connId === connId && t.path === root
          ? { ...t, vcsBackend: backend }
          : t,
      ),
    })),

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

  setTabDraft: (id, d) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...d } : t)),
    })),

  setTabLineEnding: (id, eol) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, lineEnding: eol } : t)),
    })),

  markTabSaved: (id, modified, content) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              dirty: false,
              modified,
              conflict: false,
              ...(content !== undefined ? { content } : {}),
            }
          : t,
      ),
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
              lossy: file.lossy,
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

  setTabConflict: (id, on) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, conflict: on } : t)),
    })),
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
    total,
    kind,
    destLabel,
    mode,
  }) => {
    set({
      activeTransfer: {
        id: transferId,
        label,
        doneBytes: 0,
        // Seed the total from the pre-flight so the bar shows "X / total"
        // straight away; 0 (unknown) makes the bar read "Preparing…" until the
        // backend's own measure lands.
        totalBytes: total?.bytes ?? 0,
        doneFiles: 0,
        totalFiles: total?.files ?? 0,
        current: "",
        waiting: false,
      },
    });
    try {
      // Speed: the sheet's pick, or the Preferences default (downloads).
      // Lazy import — settings.ts imports this store (module cycle).
      const { transfersConfig } = await import("../lib/settings");
      const speed = mode ?? transfersConfig.default;
      const limitBps =
        speed === "background"
          ? transfersConfig.backgroundLimitMBps * 1_000_000
          : 0;
      const outcome = await fsTransferBatch(
        transferId,
        srcConnId,
        srcPaths,
        destConnId,
        destDir,
        rename,
        total,
        speed,
        limitBps,
      );
      // Refresh whichever section owns the destination (explorer + any panel).
      get().refreshConn(destConnId);
      const noun = kind === "download" ? "Download" : "Transfer";
      const did = kind === "download" ? "downloaded" : "copied";
      if (outcome.cancelled) {
        get().pushNotice(
          "info",
          `${noun} cancelled — ${outcome.files} file${outcome.files === 1 ? "" : "s"} ${did}`,
        );
      } else {
        // Report anything skipped rather than passing off a silent partial
        // copy: symlinked dirs (link cycles) and unreadable entries (dangling
        // links, broken gitlinks) both get named.
        const parts: string[] = [];
        if (outcome.skippedLinks)
          parts.push(
            `${outcome.skippedLinks} linked folder${outcome.skippedLinks === 1 ? "" : "s"}`,
          );
        if (outcome.skippedErrors)
          parts.push(
            `${outcome.skippedErrors} unreadable item${outcome.skippedErrors === 1 ? "" : "s"}`,
          );
        const skipped = parts.length ? ` (${parts.join(", ")} skipped)` : "";
        const to = kind === "download" && destLabel ? ` to ${destLabel}` : "";
        get().pushNotice(
          "info",
          (outcome.files === 1
            ? `${kind === "download" ? "Downloaded" : "Copied"} ${firstName}${to}`
            : `${kind === "download" ? "Downloaded" : "Copied"} ${outcome.files} files${to}`) +
            skipped,
        );
      }
    } catch (e) {
      get().pushNotice(
        "error",
        `${kind === "download" ? "Download" : "Transfer"} failed: ${String(e)}`,
      );
    } finally {
      set({ activeTransfer: null });
    }
  },
  updateTransferProgress: (p) => {
    const cur = get().activeTransfer;
    if (!cur || cur.id !== p.id) return;
    // No pause/resume toast: the progress bar already owns this state
    // prominently ("waiting for connection… resumes by itself"), so a toast on
    // top is the redundancy this trim removes.
    set({
      activeTransfer: {
        ...cur,
        doneBytes: p.doneBytes,
        totalBytes: p.totalBytes,
        doneFiles: p.doneFiles,
        totalFiles: p.totalFiles,
        current: p.current,
        waiting: p.waiting,
      },
    });
  },
  cancelActiveTransfer: () => {
    const t = get().activeTransfer;
    if (t) void fsTransferCancel(t.id);
  },
  startRename: (connId, path, scope) =>
    set({ renaming: { connId, path, scope }, contextMenu: null }),
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
    set((s) => {
      const id = (noticeId += 1);
      return {
        notices: [...s.notices, { id, kind, text }],
        noticeLog: [
          { id, kind, text, time: Date.now() },
          ...s.noticeLog,
        ].slice(0, NOTICE_LOG_CAP),
        noticeUnread: s.bellOpen ? 0 : s.noticeUnread + 1,
      };
    }),
  dismissNotice: (id) =>
    set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),

  noticeLog: [],
  noticeUnread: 0,
  bellOpen: false,
  setBellOpen: (bellOpen) =>
    set((s) => ({ bellOpen, noticeUnread: bellOpen ? 0 : s.noticeUnread })),
  clearNoticeLog: () => set({ noticeLog: [], noticeUnread: 0 }),

  belled: {},
  markBell: (terminalId) =>
    set((s) => ({
      // The BEL is the reliable "finished / your turn" moment — stamp the
      // completion time here (stable) so the focus view's "Ns ago" doesn't
      // reset on redraws, and mark it belled (unread) unless already so.
      belled: s.belled[terminalId]
        ? s.belled
        : { ...s.belled, [terminalId]: true },
      finishedAt: { ...s.finishedAt, [terminalId]: Date.now() },
    })),
  clearBell: (terminalId) =>
    set((s) => {
      if (!s.belled[terminalId]) return {};
      const belled = { ...s.belled };
      delete belled[terminalId];
      return { belled };
    }),

  busy: {},
  thinking: {},
  thinkingSince: {},
  finishedAt: {},
  setBusy: (terminalId, on) =>
    set((s) => {
      if (on) {
        return s.busy[terminalId]
          ? {}
          : { busy: { ...s.busy, [terminalId]: true } };
      }
      if (!s.busy[terminalId]) return {};
      const busy = { ...s.busy };
      delete busy[terminalId];
      return { busy };
    }),
  setThinking: (terminalId, on) =>
    set((s) => {
      if (on) {
        return s.thinking[terminalId]
          ? {}
          : {
              thinking: { ...s.thinking, [terminalId]: true },
              thinkingSince: { ...s.thinkingSince, [terminalId]: Date.now() },
            };
      }
      if (!s.thinking[terminalId]) return {};
      const thinking = { ...s.thinking };
      delete thinking[terminalId];
      // A real work spell just ended — a completion moment (the BEL, if one
      // rings, restamps the same instant). Redraws never set thinking, so
      // this can't fire on a click/resize.
      return {
        thinking,
        finishedAt: { ...s.finishedAt, [terminalId]: Date.now() },
      };
    }),

  ptyDead: {},
  setPtyDead: (terminalId, on) =>
    set((s) => {
      if (on) {
        return s.ptyDead[terminalId]
          ? {}
          : { ptyDead: { ...s.ptyDead, [terminalId]: true } };
      }
      if (!s.ptyDead[terminalId]) return {};
      const ptyDead = { ...s.ptyDead };
      delete ptyDead[terminalId];
      return { ptyDead };
    }),

  setTerminalPtyId: (terminalId, ptyId) =>
    set((s) => {
      const terminals = s.terminals.map((t) =>
        t.id === terminalId ? { ...t, ptyId } : t,
      );
      return { terminals };
    }),
}));
