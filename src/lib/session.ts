/**
 * Session persistence: remember the open tabs, the attached remotes (identity
 * only — never passwords), editor splits, and panel visibility across
 * restarts, and restore them on launch.
 *
 * Storage is `localStorage` (consistent with pinned folders). On startup each
 * key-based remote is auto-reconnected and its tabs reopened; password remotes
 * get the connect dialog pre-filled (first one) — their tabs reopen once the
 * user connects. Files are reloaded from disk by path — unsaved buffers are
 * not cached.
 */
import {
  draftAskCount,
  filesWithDraft,
  resolveHostDrafts,
  whenDraftsReady,
} from "./drafts";
import { openFileByPath } from "./openFile";
import { pinnedTabsFor } from "./pinnedTabs";
import { reconcilePendingSaves } from "./stagedSave";
import { autoConnectConfig } from "./settings";
import { connectWslDistro, setOnWslConnected } from "./wslSession";
import {
  remoteHostKey,
  useAppStore,
  type RemoteConnection,
} from "../store/appStore";
import type { ConnectProfile } from "../hooks/useSSH";

const SESSION_KEY = "straylight.session";
const VERSION = 2;

type Scope = "local" | "remote" | "wsl";

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
  /** Which host owns the tab — `user@host:port` for remotes, the distro name
   *  for WSL; absent for local tabs. */
  host?: string;
  /** Pinned tabs restore pinned (leftmost, spared by bulk closes). */
  pinned?: boolean;
  /** The one preview (italic) tab restores as a preview. */
  preview?: boolean;
  /** Editor-group index (splits), left to right. Absent = the first group. */
  group?: number;
}

interface PersistedSession {
  version: number;
  sidebarVisible: boolean;
  terminalVisible: boolean;
  remotes: PersistedRemote[];
  /** Legacy (≤ one distro) — migrated into `wsls` on load. */
  wsl?: string | null;
  /** The connected WSL distros' names, for startup reconnect. */
  wsls?: string[];
  tabs: PersistedTab[];
  active: PersistedTab | null;
}

function persistedKey(r: PersistedRemote): string {
  return `${r.user}@${r.host}:${r.port}`;
}

function loadSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSession & {
      remote?: PersistedRemote | null; // v1 shape
    };
    if (!parsed || !Array.isArray(parsed.tabs)) return null;
    if (parsed.version === VERSION && Array.isArray(parsed.remotes)) {
      return parsed;
    }
    if (parsed.version === 1) {
      // v1 → v2: one remote becomes a list; its tabs get the host key.
      const remotes = parsed.remote ? [parsed.remote] : [];
      const key = parsed.remote ? persistedKey(parsed.remote) : undefined;
      const tabs = parsed.tabs.map((t) =>
        t.scope === "remote" ? { ...t, host: key } : t,
      );
      const active =
        parsed.active?.scope === "remote"
          ? { ...parsed.active, host: key }
          : parsed.active;
      return { ...parsed, version: VERSION, remotes, tabs, active };
    }
    return null;
  } catch {
    return null;
  }
}

/** The session as it was on launch — captured before anything can overwrite it. */
const savedAtStartup = loadSession();

// Remote tabs that should reopen once their host connects (auto or manual),
// keyed by `user@host:port`.
const pendingRemoteRestore = new Map<string, PersistedTab[]>();

// WSL tabs waiting for their distro to connect, keyed by distro name.
const pendingWslRestore = new Map<string, PersistedTab[]>();

// While a restore is in progress, persistence is suppressed so a partial
// snapshot can't be written mid-restore (e.g. before a slow reconnect lands).
let restoring = false;

// The remotes we intend to persist/restore, kept separate from the live
// connections so a transient drop or a failed launch-time reconnect doesn't
// forget a server. An entry is cleared only on an explicit disconnect.
const desiredRemotes = new Map<string, PersistedRemote>(
  (savedAtStartup?.remotes ?? []).map((r) => [persistedKey(r), r]),
);

// The WSL distros to restore, kept like desiredRemotes (survive transient
// disconnects; an entry is cleared only by an explicit disconnect).
const desiredWsls = new Set<string>(
  savedAtStartup?.wsls ?? (savedAtStartup?.wsl ? [savedAtStartup.wsl] : []),
);

/** Forget one saved WSL distro (on its explicit disconnect). */
export function clearDesiredWsl(distro: string): void {
  desiredWsls.delete(distro);
  pendingWslRestore.delete(distro);
}

/** Remember a connected remote as one to restore next launch. */
export function setDesiredRemote(remote: RemoteConnection): void {
  desiredRemotes.set(remoteHostKey(remote), {
    name: remote.name,
    host: remote.host,
    user: remote.user,
    port: remote.port,
    color: remote.color,
    authType: remote.authType,
    identityFile: remote.identityFile,
    proxyJump: remote.proxyJump,
  });
}

/** Forget one saved remote (on its explicit disconnect). */
export function clearDesiredRemote(hostKey: string): void {
  desiredRemotes.delete(hostKey);
  pendingRemoteRestore.delete(hostKey);
}

// --- Writing ---------------------------------------------------------------

function writeSnapshot(): void {
  const s = useAppStore.getState();

  // Only real file tabs persist; diff/log/terminal tabs are ephemeral.
  const fileTabs = s.tabs.filter((t) => !t.kind || t.kind === "file");

  const persistTab = (
    t: (typeof fileTabs)[number],
    scope: Scope,
    host?: string,
  ): PersistedTab => {
    // Persist the group as its left-to-right index (ids are session-local).
    const group = s.editorGroups.indexOf(t.groupId ?? 0);
    return {
      scope,
      path: t.path,
      ...(host ? { host } : {}),
      ...(t.pinned ? { pinned: true } : {}),
      ...(t.previewTab ? { preview: true } : {}),
      ...(group > 0 ? { group } : {}),
    };
  };

  const localTabs: PersistedTab[] = fileTabs
    .filter((t) => t.connId === s.localConnId)
    .map((t) => persistTab(t, "local"));

  // Remote tabs: per connected host, the open ones; for hosts still waiting to
  // (re)connect, the pending set — so an unconnected or failed-to-reconnect
  // remote keeps its tab list for the next launch.
  const remoteTabs: PersistedTab[] = [];
  const connectedKeys = new Set<string>();
  for (const r of s.remotes) {
    const key = remoteHostKey(r.conn);
    connectedKeys.add(key);
    remoteTabs.push(
      ...fileTabs
        .filter((t) => t.connId === r.conn.connId)
        .map((t) => persistTab(t, "remote", key)),
    );
  }
  for (const [key, tabs] of pendingRemoteRestore) {
    if (!connectedKeys.has(key)) {
      remoteTabs.push(...tabs.map((t) => ({ ...t, scope: "remote" as const, host: key })));
    }
  }

  // WSL tabs, mirroring the remote handling (host = the distro name).
  const wslTabs: PersistedTab[] = [];
  const connectedWsls = new Set<string>();
  for (const w of s.wsls) {
    connectedWsls.add(w.conn.name);
    wslTabs.push(
      ...fileTabs
        .filter((t) => t.connId === w.conn.connId)
        .map((t) => persistTab(t, "wsl", w.conn.name)),
    );
  }
  for (const [name, tabs] of pendingWslRestore) {
    if (!connectedWsls.has(name)) {
      wslTabs.push(...tabs.map((t) => ({ ...t, scope: "wsl" as const, host: name })));
    }
  }

  const activeTab = fileTabs.find((t) => t.id === s.activeTabId);
  let active: PersistedTab | null = null;
  if (activeTab) {
    if (activeTab.connId === s.localConnId) {
      active = { scope: "local", path: activeTab.path };
    } else {
      const owner = s.remotes.find((r) => r.conn.connId === activeTab.connId);
      const wslOwner = s.wsls.find((w) => w.conn.connId === activeTab.connId);
      if (owner) {
        active = {
          scope: "remote",
          path: activeTab.path,
          host: remoteHostKey(owner.conn),
        };
      } else if (wslOwner) {
        active = { scope: "wsl", path: activeTab.path, host: wslOwner.conn.name };
      }
    }
  }

  for (const w of s.wsls) desiredWsls.add(w.conn.name);

  const session: PersistedSession = {
    version: VERSION,
    sidebarVisible: s.sidebarVisible,
    terminalVisible: s.terminalVisible,
    remotes: [...desiredRemotes.values()],
    wsls: [...desiredWsls],
    tabs: [...localTabs, ...wslTabs, ...remoteTabs],
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

/** Open a host's pinned files — runs on EVERY connect (launch restore, manual
 *  connect, mid-session reconnect), because a pin means "always part of my
 *  workspace on this host". Idempotent: already-open files are just focused. */
async function openPinnedFiles(connId: string, connKey: string): Promise<void> {
  for (const p of pinnedTabsFor(connKey)) {
    await openFileByPath(connId, p, undefined, { pinned: true });
  }
}

/** Open a host's files that have an unresolved draft (Issue 1) — on every
 *  connect, so unsaved work always comes back with its host instead of only
 *  surfacing if you happen to reopen the file. Opening runs maybeAttachDraft
 *  (banner or auto-restore per the host's decision). Idempotent. */
async function openDraftedFiles(connId: string, connKey: string): Promise<void> {
  for (const p of filesWithDraft(connKey)) {
    await openFileByPath(connId, p);
  }
}

/** Reopen the remote tabs that were waiting for this host to connect, plus its
 *  pinned files. Called after every connection (auto-reconnect or manual). */
export async function consumePendingRemoteTabs(
  remote: RemoteConnection,
): Promise<void> {
  const key = remoteHostKey(remote);
  const tabs = pendingRemoteRestore.get(key);
  pendingRemoteRestore.delete(key);
  for (const t of tabs ?? []) {
    await openFileByPath(remote.connId, t.path, undefined, {
      preview: t.preview,
      pinned: t.pinned,
    });
  }
  await openPinnedFiles(remote.connId, key);
  await openDraftedFiles(remote.connId, key);
  // Group/focus restoration only belongs to the launch restore — a
  // mid-session reconnect (pinned/drafted files only) must not yank the focus.
  if (tabs) {
    applyPersistedGroups();
    restoreActiveTab();
  }
  // Staged saves left pending on this host (atomic-save.md S5).
  await reconcilePendingSaves(remote.connId, key);
}

/** Reopen the WSL tabs waiting for this distro (keyed by its name), plus its
 *  pinned files. Wired into connectWslDistro via the registration hook below —
 *  wslSession can't import this module (session already imports it). */
export async function consumePendingWslTabs(
  conn: RemoteConnection,
): Promise<void> {
  const tabs = pendingWslRestore.get(conn.name);
  pendingWslRestore.delete(conn.name);
  for (const t of tabs ?? []) {
    await openFileByPath(conn.connId, t.path, undefined, {
      preview: t.preview,
      pinned: t.pinned,
    });
  }
  await openPinnedFiles(conn.connId, `wsl:${conn.name}`);
  await openDraftedFiles(conn.connId, `wsl:${conn.name}`);
  if (tabs) {
    applyPersistedGroups();
    restoreActiveTab();
  }
  await reconcilePendingSaves(conn.connId, `wsl:${conn.name}`);
}

setOnWslConnected(consumePendingWslTabs);

/** Reassign restored tabs to their saved editor groups (splits). Runs after
 *  each batch of reopens — local at launch, each remote once it connects. */
function applyPersistedGroups(): void {
  const saved = savedAtStartup;
  if (!saved) return;
  const s = useAppStore.getState();
  const map: Record<string, number> = {};
  for (const p of saved.tabs) {
    if (!p.group) continue;
    const tab = s.tabs.find((t) => {
      if (t.path !== p.path) return false;
      if (p.scope === "local") return t.connId === s.localConnId;
      if (p.scope === "wsl") {
        const w = s.wsls.find((x) => x.conn.name === p.host);
        return !!w && t.connId === w.conn.connId;
      }
      const owner = s.remotes.find((r) => remoteHostKey(r.conn) === p.host);
      return !!owner && t.connId === owner.conn.connId;
    });
    if (tab) map[tab.id] = p.group;
  }
  if (Object.keys(map).length > 0) s.setTabGroups(map);
}

function restoreActiveTab(): void {
  const want = savedAtStartup?.active;
  if (!want) return;
  const s = useAppStore.getState();
  const tab = s.tabs.find((t) => {
    if (t.path !== want.path) return false;
    if (want.scope === "local") return t.connId === s.localConnId;
    if (want.scope === "wsl") {
      const w = s.wsls.find((x) => x.conn.name === want.host);
      return !!w && t.connId === w.conn.connId;
    }
    const owner = s.remotes.find((r) => remoteHostKey(r.conn) === want.host);
    return !!owner && t.connId === owner.conn.connId;
  });
  if (tab) s.setActiveTab(tab.id);
}

/** Restore the saved session: panel visibility, local tabs, and the saved
 *  remotes (auto-reconnect for key hosts; pre-fill the dialog for the first
 *  password host). Runs once, after the local session id is available. */
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

    // Hot exit: the draft index must be loaded before any tab reopens —
    // draft decisions are made PER HOST as each host comes up.
    await whenDraftsReady();

    for (const t of s.tabs.filter((t) => t.scope === "local")) {
      await openFileByPath(localConnId, t.path, undefined, {
        preview: t.preview,
        pinned: t.pinned,
      });
    }
    await openPinnedFiles(localConnId, "local");
    await openDraftedFiles(localConnId, "local");
    applyPersistedGroups();

    // Local is "connected" from the start — its drafts ask goes first.
    const localDrafts = draftAskCount("local");
    if (localDrafts > 0) {
      store.pushConnectAsk({
        kind: "drafts",
        label: `Local — ${localDrafts} file${localDrafts === 1 ? "" : "s"}`,
        run: () => resolveHostDrafts("local", true),
        onSkip: () => resolveHostDrafts("local", false),
      });
    }

    // WSL first (matching the sidebar order), then the remotes. Policy per
    // kind from settings: "always" connects silently, "ask" queues a startup
    // dialog (its checkbox flips the setting to "always"), "never" skips.
    const auto = autoConnectConfig;
    const savedWsls = s.wsls ?? (s.wsl ? [s.wsl] : []);
    for (const distro of savedWsls) {
      // Queue the distro's tabs regardless of policy, so a later manual
      // connect still restores them (mirrors the remote pending sets).
      const wslTabs = s.tabs.filter((t) => t.scope === "wsl" && t.host === distro);
      if (wslTabs.length) pendingWslRestore.set(distro, wslTabs);
      if (auto.wsl === "never") continue;
      const wslKey = `wsl:${distro}`;
      const wslDrafts = draftAskCount(wslKey);
      const doConnect = () =>
        connectWslDistro(distro).catch((e) =>
          useAppStore
            .getState()
            .pushNotice("error", `WSL reconnect failed: ${String(e)}`),
        );
      if (auto.wsl === "always") {
        await doConnect();
        // Silent connect → the drafts question stands alone, after the host
        // is up (its tabs opened with banners; approval sweeps them).
        if (wslDrafts > 0) {
          store.pushConnectAsk({
            kind: "drafts",
            label: `${distro} — ${wslDrafts} file${wslDrafts === 1 ? "" : "s"}`,
            run: () => resolveHostDrafts(wslKey, true),
            onSkip: () => resolveHostDrafts(wslKey, false),
          });
        }
      } else {
        store.pushConnectAsk({
          kind: "wsl",
          label: distro,
          // The connect ask carries the drafts question as a checkbox
          // (default checked); the decision lands before the connect runs.
          draftsCount: wslDrafts,
          run: (restoreDrafts) => {
            if (wslDrafts > 0) resolveHostDrafts(wslKey, restoreDrafts !== false);
            void doConnect();
          },
          // Declining forgets the distro — no ghost ask on the next launch.
          onSkip: () => clearDesiredWsl(distro),
        });
      }
    }

    let dialogShown = false;
    for (const r of s.remotes) {
      const key = persistedKey(r);
      const remoteTabs = s.tabs.filter(
        (t) => t.scope === "remote" && t.host === key,
      );
      pendingRemoteRestore.set(key, remoteTabs);
      if (auto.remote === "never") continue;

      const remoteDrafts = draftAskCount(key);
      const pushRemoteDraftsAsk = () => {
        if (remoteDrafts > 0) {
          store.pushConnectAsk({
            kind: "drafts",
            label: `${r.name} — ${remoteDrafts} file${remoteDrafts === 1 ? "" : "s"}`,
            run: () => resolveHostDrafts(key, true),
            onSkip: () => resolveHostDrafts(key, false),
          });
        }
      };
      if (r.authType === "auto") {
        const doConnect = () =>
          connect(profileFromRemote(r)).catch(() => {
            /* failure surfaced as a toast by connect(); the pending set is
               kept so a later reconnect to the same host still restores tabs */
          });
        if (auto.remote === "always") {
          await doConnect();
          pushRemoteDraftsAsk();
        } else
          store.pushConnectAsk({
            kind: "remote",
            label: r.name,
            draftsCount: remoteDrafts,
            run: (restoreDrafts) => {
              if (remoteDrafts > 0)
                resolveHostDrafts(key, restoreDrafts !== false);
              void doConnect();
            },
            onSkip: () => clearDesiredRemote(key),
          });
      } else {
        // Password host: we never stored the password. The best we can do is
        // pre-fill the dialog; under "ask" that too goes through the queue.
        const openPrefilled = () => {
          useAppStore.getState().openDialog({
            name: r.name,
            hostName: r.host,
            user: r.user,
            port: r.port,
            identityFile: null,
            proxyJump: r.proxyJump,
          });
          if (remoteTabs.length) {
            useAppStore
              .getState()
              .pushNotice(
                "info",
                `Reconnect to ${r.name} to restore ${remoteTabs.length} tab(s).`,
              );
          }
        };
        if (auto.remote === "always") {
          if (!dialogShown) {
            dialogShown = true;
            openPrefilled();
          } else {
            store.pushNotice(
              "info",
              `Reconnect to ${r.name} (password host) to restore it.`,
            );
          }
          // The decision is recorded now; it applies once the password
          // connect completes and the host's tabs reopen.
          pushRemoteDraftsAsk();
        } else {
          store.pushConnectAsk({
            kind: "remote",
            label: r.name,
            draftsCount: remoteDrafts,
            run: (restoreDrafts) => {
              if (remoteDrafts > 0)
                resolveHostDrafts(key, restoreDrafts !== false);
              openPrefilled();
            },
            onSkip: () => clearDesiredRemote(key),
          });
        }
      }
    }

    restoreActiveTab();
  } finally {
    restoring = false;
    // Persist the restored state once (desiredRemotes keep servers whose
    // launch reconnect failed; their tabs fall back to the pending sets).
    writeSnapshot();
  }
}
