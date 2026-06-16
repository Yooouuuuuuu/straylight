/**
 * Session persistence: remember the open tabs, the last remote connection
 * (identity only — never the password), and panel visibility across restarts,
 * and restore them on launch.
 *
 * Storage is `localStorage` (consistent with pinned folders). On startup a
 * key-based remote is auto-reconnected and its tabs reopened; a password remote
 * has its connect dialog pre-filled (its tabs reopen once the user connects).
 * Files are reloaded from disk by path — unsaved buffers are not cached.
 */
import { openFileByPath } from "./openFile";
import { useAppStore, type RemoteConnection } from "../store/appStore";
import type { ConnectProfile } from "../hooks/useSSH";

const SESSION_KEY = "straylight.session";
const VERSION = 1;

type Scope = "local" | "remote";

interface PersistedRemote {
  name: string;
  host: string;
  user: string;
  port: number;
  color: string;
  authType: "auto" | "password";
  identityFile: string | null;
  proxyJump: string | null;
}

interface PersistedTab {
  scope: Scope;
  path: string;
}

interface PersistedSession {
  version: number;
  sidebarVisible: boolean;
  terminalVisible: boolean;
  remote: PersistedRemote | null;
  tabs: PersistedTab[];
  active: PersistedTab | null;
}

function loadSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSession;
    if (!parsed || parsed.version !== VERSION || !Array.isArray(parsed.tabs)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** The session as it was on launch — captured before anything can overwrite it. */
const savedAtStartup = loadSession();

function hostKey(host: string, user: string, port: number): string {
  return `${user}@${host}:${port}`;
}

// Remote tabs that should reopen once their host connects (auto or manual).
let pendingRemoteRestore: { hostKey: string; paths: string[] } | null = null;

// While a restore is in progress, persistence is suppressed so a partial
// snapshot can't be written mid-restore (e.g. before a slow reconnect lands).
let restoring = false;

// The remote we intend to persist/restore, kept separate from the live
// connection so a transient drop or a failed launch-time reconnect doesn't
// forget the server. Cleared only on an explicit disconnect.
let desiredRemote: PersistedRemote | null = savedAtStartup?.remote ?? null;

/** Remember the connected remote as the one to restore next launch. */
export function setDesiredRemote(remote: RemoteConnection): void {
  desiredRemote = {
    name: remote.name,
    host: remote.host,
    user: remote.user,
    port: remote.port,
    color: remote.color,
    authType: remote.authType,
    identityFile: remote.identityFile,
    proxyJump: remote.proxyJump,
  };
}

/** Forget the saved remote (on an explicit disconnect). */
export function clearDesiredRemote(): void {
  desiredRemote = null;
}

// --- Writing ---------------------------------------------------------------

function scopeOf(connId: string): Scope | null {
  const s = useAppStore.getState();
  if (connId === s.localConnId) return "local";
  if (s.remote && connId === s.remote.connId) return "remote";
  return null;
}

function writeSnapshot(): void {
  const s = useAppStore.getState();

  const localTabs: PersistedTab[] = s.tabs
    .filter((t) => t.connId === s.localConnId)
    .map((t) => ({ scope: "local", path: t.path }));

  // Remote tabs: the open ones while connected, otherwise the set still waiting
  // to be restored — so an unconnected or failed-to-reconnect remote keeps its
  // tab list for the next launch.
  let remoteTabs: PersistedTab[];
  if (s.remote) {
    remoteTabs = s.tabs
      .filter((t) => t.connId === s.remote!.connId)
      .map((t) => ({ scope: "remote", path: t.path }));
  } else if (pendingRemoteRestore) {
    remoteTabs = pendingRemoteRestore.paths.map((p) => ({ scope: "remote", path: p }));
  } else {
    remoteTabs = [];
  }

  const activeTab = s.tabs.find((t) => t.id === s.activeTabId);
  const activeScope = activeTab ? scopeOf(activeTab.connId) : null;
  const active =
    activeTab && activeScope ? { scope: activeScope, path: activeTab.path } : null;

  const session: PersistedSession = {
    version: VERSION,
    sidebarVisible: s.sidebarVisible,
    terminalVisible: s.terminalVisible,
    remote: desiredRemote,
    tabs: [...localTabs, ...remoteTabs],
    active,
  };

  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* storage full / unavailable — ignore */
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Subscribe to the store and persist a debounced snapshot on change. Returns
 *  the unsubscribe function. Writes are suppressed while a restore is running. */
export function initSessionPersistence(): () => void {
  return useAppStore.subscribe(() => {
    if (saveTimer != null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (restoring) return;
      writeSnapshot();
    }, 400);
  });
}

// --- Restoring -------------------------------------------------------------

function profileFromRemote(r: PersistedRemote): ConnectProfile {
  return {
    name: r.name,
    host: r.host,
    port: r.port,
    user: r.user,
    auth:
      r.authType === "auto"
        ? { type: "auto", identityFile: r.identityFile }
        : { type: "password", password: "" },
    proxyJump: r.proxyJump,
    color: r.color,
  };
}

/** Reopen the remote tabs that were waiting for this host to connect. Called
 *  after a connection is established (whether auto-reconnect or manual). */
export async function consumePendingRemoteTabs(
  remote: RemoteConnection,
): Promise<void> {
  if (!pendingRemoteRestore) return;
  if (pendingRemoteRestore.hostKey !== hostKey(remote.host, remote.user, remote.port)) {
    // Connected somewhere else — abandon the one-shot restore.
    pendingRemoteRestore = null;
    return;
  }
  const paths = pendingRemoteRestore.paths;
  pendingRemoteRestore = null;
  for (const path of paths) {
    await openFileByPath(remote.connId, path);
  }
  restoreActiveTab();
}

function restoreActiveTab(): void {
  const want = savedAtStartup?.active;
  if (!want) return;
  const s = useAppStore.getState();
  const tab = s.tabs.find((t) => {
    if (t.path !== want.path) return false;
    if (want.scope === "local") return t.connId === s.localConnId;
    return !!s.remote && t.connId === s.remote.connId;
  });
  if (tab) s.setActiveTab(tab.id);
}

/** Restore the saved session: panel visibility, local tabs, and the last remote
 *  (auto-reconnect for key hosts; pre-fill the dialog for password hosts). Runs
 *  once, after the local session id is available. */
export async function restoreSession(
  localConnId: string,
  connect: (profile: ConnectProfile) => Promise<void>,
): Promise<void> {
  const s = savedAtStartup;
  if (!s) return;
  const store = useAppStore.getState();

  restoring = true;
  try {
    store.setSidebarVisible(s.sidebarVisible);
    store.setTerminalVisible(s.terminalVisible);

    for (const t of s.tabs.filter((t) => t.scope === "local")) {
      await openFileByPath(localConnId, t.path);
    }

    if (s.remote) {
      const remotePaths = s.tabs.filter((t) => t.scope === "remote").map((t) => t.path);
      pendingRemoteRestore = {
        hostKey: hostKey(s.remote.host, s.remote.user, s.remote.port),
        paths: remotePaths,
      };

      if (s.remote.authType === "auto") {
        try {
          // connect() establishes the remote and (via consumePendingRemoteTabs)
          // reopens its tabs.
          await connect(profileFromRemote(s.remote));
        } catch {
          /* failure surfaced as a toast by connect(); pendingRemoteRestore is
             kept so a later reconnect to the same host still restores tabs */
        }
      } else {
        // Password host: we never stored the password. Pre-fill the dialog so
        // the user can reconnect; tabs reopen on a successful connect.
        store.openDialog({
          name: s.remote.name,
          hostName: s.remote.host,
          user: s.remote.user,
          port: s.remote.port,
          identityFile: null,
          proxyJump: s.remote.proxyJump,
        });
        if (remotePaths.length) {
          store.pushNotice(
            "info",
            `Reconnect to ${s.remote.name} to restore ${remotePaths.length} tab(s).`,
          );
        }
      }
    }

    restoreActiveTab();
  } finally {
    restoring = false;
    // Persist the restored state once (desiredRemote keeps the server even if
    // its launch reconnect failed; remoteTabs fall back to the pending set).
    writeSnapshot();
  }
}
