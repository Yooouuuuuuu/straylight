/**
 * Session persistence: remember the open tabs, the attached remotes (identity
 * only — never passwords), editor splits, and panel visibility across
 * restarts, and restore them on launch.
 *
 * Storage is `localStorage` (consistent with pinned folders). On startup each
 * saved host is offered back via a startup ask — hosts marked in settings
 * `autoConnect` (per-host keys) reconnect silently instead. Password remotes
 * get the connect dialog pre-filled (first one) — their tabs reopen once the
 * user connects. Files are reloaded from disk by path — unsaved buffers are
 * not cached.
 */
import { filesWithDraft, whenDraftsReady } from "./drafts";
import { openFileByPath } from "./openFile";
import { pinnedTabsFor } from "./pinnedTabs";
import { reconcilePendingSaves } from "./stagedSave";
import { autoConnectHosts, uiConfig } from "./settings";
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

// --- Writing ---------------------------------------------------------------
// Persistence is deliberately simple (2026-07-20): the snapshot records the
// hosts CONNECTED at write time — "what was up when the app closed". A host
// whose startup ask was skipped, or whose password dialog was cancelled, was
// never connected, so it just isn't in the next snapshot: cancel once, not
// asked again. No union bookkeeping, nothing to clear on disconnect.

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

  const session: PersistedSession = {
    version: VERSION,
    sidebarVisible: s.sidebarVisible,
    terminalVisible: s.terminalVisible,
    remotes: s.remotes.map((r) => ({
      name: r.conn.name,
      host: r.conn.host,
      user: r.conn.user,
      port: r.conn.port,
      color: r.conn.color,
      authType: r.conn.authType,
      identityFile: r.conn.identityFile,
      proxyJump: r.conn.proxyJump,
    })),
    wsls: s.wsls.map((w) => w.conn.name),
    tabs: [...localTabs],
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
  return useAppStore.subscribe((state, prev) => {
    // Snapshot INPUTS only (docs/dev/code-scan-2026-08.md E2): the hot store
    // churn — terminal busy flips, titles, selections — never touches these,
    // so it no longer schedules rewrites of an identical snapshot.
    if (
      state.tabs === prev.tabs &&
      state.remotes === prev.remotes &&
      state.wsls === prev.wsls &&
      state.activeTabId === prev.activeTabId &&
      state.editorGroups === prev.editorGroups &&
      state.sidebarVisible === prev.sidebarVisible &&
      state.terminalVisible === prev.terminalVisible &&
      state.localConnId === prev.localConnId
    )
      return;
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
    await openFileByPath(connId, p, undefined, { pinned: true, focusEditor: false });
  }
}

/** Open a host's files that have an unresolved draft (Issue 1) — on every
 *  connect, so unsaved work always comes back with its host instead of only
 *  surfacing if you happen to reopen the file. Opening runs maybeAttachDraft,
 *  which auto-restores the draft into the tab (dirty). Idempotent. */
async function openDraftedFiles(connId: string, connKey: string): Promise<void> {
  for (const p of filesWithDraft(connKey)) {
    await openFileByPath(connId, p, undefined, { focusEditor: false });
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
      focusEditor: false,
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
      focusEditor: false,
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
        focusEditor: false,
      });
    }
    await openPinnedFiles(localConnId, "local");
    await openDraftedFiles(localConnId, "local");
    applyPersistedGroups();

    // WSL first (matching the sidebar order), then the remotes. Every host
    // asks by default; hosts marked in settings `autoConnect` (per-host keys,
    // written by the ask dialog's "don't ask again" checkbox) connect
    // silently. Under ui.localOnly nothing non-local restores — the sections
    // it would land in aren't rendered.
    const savedWsls = uiConfig.localOnly ? [] : (s.wsls ?? (s.wsl ? [s.wsl] : []));
    for (const distro of savedWsls) {
      const doConnect = () =>
        connectWslDistro(distro).catch((e) =>
          useAppStore
            .getState()
            .pushNotice("error", `WSL reconnect failed: ${String(e)}`),
        );
      if (autoConnectHosts.includes(`wsl:${distro}`)) {
        await doConnect();
      } else {
        store.pushConnectAsk({
          kind: "wsl",
          label: distro,
          hostKey: `wsl:${distro}`,
          run: () => void doConnect(),
          // Declining needs no bookkeeping: an unconnected distro simply
          // isn't in the next snapshot.
        });
      }
    }

    let dialogShown = false;
    for (const r of uiConfig.localOnly ? [] : s.remotes) {
      const hostKey = remoteHostKey(r);
      const marked = autoConnectHosts.includes(hostKey);

      if (r.authType === "auto") {
        const doConnect = () =>
          connect(profileFromRemote(r)).catch(() => {
            /* failure surfaced as a toast by connect() */
          });
        if (marked) {
          await doConnect();
        } else
          store.pushConnectAsk({
            kind: "remote",
            label: r.name,
            hostKey,
            run: () => void doConnect(),
          });
      } else {
        // Password host: we never stored the password. Pre-fill the dialog so
        // the user connects — pinned + drafted files reopen once they do.
        const openPrefilled = () => {
          useAppStore.getState().openDialog({
            name: r.name,
            hostName: r.host,
            user: r.user,
            port: r.port,
            identityFile: null,
            proxyJump: r.proxyJump,
          });
        };
        // A marked password host can't silently connect (no stored password)
        // — "don't ask again" skips the ask and goes straight to the
        // pre-filled dialog. Only one dialog can open; later ones get a note.
        if (marked) {
          if (!dialogShown) {
            dialogShown = true;
            openPrefilled();
          } else {
            store.pushNotice(
              "info",
              `Reconnect to ${r.name} (password host) to restore it.`,
            );
          }
        } else {
          store.pushConnectAsk({
            kind: "remote",
            label: r.name,
            hostKey,
            run: () => openPrefilled(),
          });
        }
      }
    }

    restoreActiveTab();
  } finally {
    restoring = false;
    // NOTE deliberately no snapshot here: hosts with asks still pending
    // aren't connected yet, and writing now would drop them before the user
    // answers. The debounced subscriber writes on the next state change —
    // by then answered hosts are connected (kept) and skipped ones aren't
    // (forgotten), which is exactly the contract.
  }
}
