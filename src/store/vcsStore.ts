/**
 * Version-control state (Phase 3). Tracked repos are opened explicitly into the
 * right-side Source Control panel; each one persists by **connection identity**
 * (so it survives reconnect/relaunch) and carries a cached status snapshot.
 * Nothing auto-refreshes until a repo is toggled "eager"; even then there are no
 * automatic timeouts — a per-repo running indicator doubles as a manual cancel.
 */
import { create } from "zustand";

import { basename } from "../lib/format";
import {
  fsRemove,
  vcsAmend,
  vcsCommit,
  vcsCreateBranch,
  vcsDiscard,
  vcsOpen,
  vcsRemote,
  vcsRemoteCancel,
  vcsStage,
  vcsStash,
  vcsStatus,
  vcsSwitch,
  vcsUnstage,
  vcsUnwatch,
  vcsUpdate,
  vcsWatch,
  type VcsChange,
  type VcsStatus,
} from "../lib/ipc";
import { confirmEnabled } from "../lib/settings";
import { useAppStore } from "./appStore";

export interface TrackedRepo {
  /** Stable identity across sessions (local / user@host:port / wsl:<distro>). */
  connKey: string;
  /** Live session id, resolved when that connection is active (else null). */
  connId: string | null;
  root: string;
  backend: string;
  label: string;
  eager: boolean;
  status: VcsStatus | null;
  /** "polling" = a silent background refresh (no spinner, no stamp flip). */
  activity: "idle" | "loading" | "polling" | "error";
  error: string | null;
  /** Last time the status actually CHANGED — drives the "updated … ago"
   *  stamp and the history refetch. A no-op refresh does not advance it. */
  lastUpdated: number | null;
  /** Last time a refresh ran, changed or not — drives poll/focus throttles. */
  lastChecked?: number | null;
  /** The most recent check failed (transient link blip, moved repo…). Silent
   *  polls surface this only in the stamp tooltip — never as a red card. */
  lastCheckFailed?: boolean;
  /** The remote op currently running, or null. */
  remoteBusy?: "fetch" | "pull" | "push" | "update" | null;
  /** UI: the commit box is expanded (persisted per repo). */
  uiCommitOpen?: boolean;
  /** A stash pop hit conflicts — offer "drop stash" once resolved (transient). */
  stashConflict?: boolean;
  /** Colocated jj+git repo — the backend badge toggles which view drives. */
  colocated?: boolean;
}

/** The fixed "this is a tracked repo" color in the explorer (green). Host
 *  identity uses a different channel — frames/bars/tabs via the positional
 *  host slots (lib/hostColors). */
export const REPO_COLOR_DEFAULT = "var(--green)";

/** Color for a tree path: green when the path IS a tracked repo's root (or a
 *  pin inside one, for root labels) — else null. */
export function repoColorForPath(
  repos: TrackedRepo[],
  connId: string,
  path: string,
  containment: "exact" | "within" = "exact",
): string | null {
  const p = path.replace(/\\/g, "/").replace(/\/+$/, "");
  for (const r of repos) {
    if (r.connId !== connId) continue;
    const root = r.root.replace(/\\/g, "/").replace(/\/+$/, "");
    if (p === root) return REPO_COLOR_DEFAULT;
    if (containment === "within" && p.startsWith(`${root}/`))
      return REPO_COLOR_DEFAULT;
  }
  return null;
}

interface VcsState {
  repos: TrackedRepo[];
  scmVisible: boolean;
  /** Repo card (`connKey::root`) the panel should scroll into view — set when
   *  the explorer's ⑂ opens/adds a repo; the panel consumes and clears it. */
  revealRepo: string | null;
  clearReveal: () => void;
  /** Which repo's history is shown in the left-of-SCM history panel (or null). */
  historyRepo: { connKey: string; root: string } | null;
  /** Pending discard awaiting confirmation. */
  pendingDiscard: { connKey: string; root: string; changes: VcsChange[] } | null;
  /** A VC action awaiting user confirmation (update/push/pop/amend-pushed…). */
  vcsConfirm: { title: string; body: string; run: () => void; id?: string } | null;
  /** Normalized absolute path → change kind ("child" marks an ancestor folder). */
  decorations: Record<string, string>;

  openRepo: (connId: string, dir: string) => Promise<void>;
  /** Explorer ⑂ button: reveal the panel scrolled to the repo covering the
   *  folder, else track the folder directly (a non-repo just toasts). */
  openRepoFromExplorer: (connId: string, path: string) => void;
  removeRepo: (connKey: string, root: string) => void;
  toggleEager: (connKey: string, root: string) => void;
  refreshRepo: (
    connKey: string,
    root: string,
    opts?: { silent?: boolean; forceStamp?: boolean },
  ) => Promise<void>;
  cancelRefresh: (connKey: string, root: string) => void;
  stage: (connKey: string, root: string, paths: string[]) => Promise<void>;
  unstage: (connKey: string, root: string, paths: string[]) => Promise<void>;
  commit: (connKey: string, root: string, message: string) => Promise<boolean>;
  remoteOp: (connKey: string, root: string, op: "fetch" | "pull" | "push") => Promise<void>;
  /** Cancel the in-flight fetch/push/update (kills the remote command). */
  cancelRemoteOp: (connKey: string, root: string) => void;
  requestDiscard: (connKey: string, root: string, changes: VcsChange[]) => void;
  confirmDiscard: () => Promise<void>;
  cancelDiscard: () => void;
  switchBranch: (connKey: string, root: string, target: string) => Promise<void>;
  createBranch: (connKey: string, root: string, name: string) => Promise<void>;
  amend: (connKey: string, root: string, message: string) => Promise<boolean>;
  stash: (connKey: string, root: string, op: "push" | "pop" | "drop", message: string) => Promise<void>;
  /** Merge onto the fetched upstream (git; the Incoming block's action). */
  updateFromRemote: (connKey: string, root: string) => Promise<void>;
  toggleCommitOpen: (connKey: string, root: string) => void;
  /** Reorder cards: move the repo with id `fromId` to `toId`'s position. Ids
   *  are `${connKey}::${root}` (the card drag payload). */
  moveRepo: (fromId: string, toId: string, after?: boolean) => void;
  /** Colocated repos: flip the driving backend (jj ⇄ git) and refresh. */
  toggleBackend: (connKey: string, root: string) => void;
  /** Incoming block dismissals (session-only; ⇣ un-dismisses). */
  incomingHidden: Record<string, boolean>;
  dismissIncoming: (connKey: string, root: string) => void;
  unhideIncoming: (connKey: string, root: string) => void;
  /** Show a confirm dialog. With an `id` it gains a "don't ask again"
   *  checkbox (silenced via settings.json `confirms`; silenced = run now). */
  askConfirm: (title: string, body: string, run: () => void, id?: string) => void;
  clearConfirm: () => void;
  /** Re-resolve each repo's live connId from the active connections. */
  resolveConns: () => void;
  /** A file changed under `connId`: refresh eager repos that contain it. */
  onFileChanged: (connId: string, path: string) => void;
  /** Refresh every connected repo. `throttleMs` skips repos refreshed more
   *  recently than that (0 = force). */
  refreshAll: (
    throttleMs: number,
    opts?: { silent?: boolean; skipLocal?: boolean },
  ) => void;
  /** Poll tick for ◉ WSL/remote repos (local repos are watcher-live). */
  pollEagerRemotes: () => void;
  /** A watched local repo's files changed on disk (debounced burst). */
  onFsChange: (connId: string, root: string) => void;
  /** Start/stop backend filesystem watchers to match the tracked local repos. */
  syncWatchers: () => void;
  setScmVisible: (v: boolean) => void;
  toggleScm: () => void;
  showHistory: (connKey: string, root: string) => void;
  closeHistory: () => void;
}

const KEY = "straylight.vcsRepos";

// ---- connection identity <-> live connId ---------------------------------

function connKeyFor(connId: string): string | null {
  const s = useAppStore.getState();
  if (connId === s.localConnId) return "local";
  const remote = s.remotes.find((r) => r.conn.connId === connId);
  if (remote)
    return `${remote.conn.user}@${remote.conn.host}:${remote.conn.port}`;
  const wsl = s.wsls.find((w) => w.conn.connId === connId);
  if (wsl) return `wsl:${wsl.conn.name}`;
  return null;
}

function connIdForKey(connKey: string): string | null {
  const s = useAppStore.getState();
  if (connKey === "local") return s.localConnId;
  const remote = s.remotes.find(
    (r) => connKey === `${r.conn.user}@${r.conn.host}:${r.conn.port}`,
  );
  if (remote) return remote.conn.connId;
  const wsl = s.wsls.find((w) => connKey === `wsl:${w.conn.name}`);
  if (wsl) return wsl.conn.connId;
  return null;
}

// ---- persistence ----------------------------------------------------------

function persist(repos: TrackedRepo[]): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify(
        repos.map((r) => ({
          connKey: r.connKey,
          root: r.root,
          backend: r.backend,
          label: r.label,
          eager: r.eager,
          status: r.status,
          lastUpdated: r.lastUpdated,
          uiCommitOpen: r.uiCommitOpen,
          colocated: r.colocated ?? false,
        })),
      ),
    );
  } catch {
    /* ignore */
  }
}

// One-time migration (2026-07-14): ◉ changed meaning from "eager refresh"
// to "monitor" and its default flipped to ON — reset every stored repo to
// the new default once; user toggles persist normally afterwards.
const MONITOR_MIGRATED_KEY = "straylight.monitorDefaultOn";

function load(): TrackedRepo[] {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(arr)) return [];
    const migrate = !localStorage.getItem(MONITOR_MIGRATED_KEY);
    if (migrate) localStorage.setItem(MONITOR_MIGRATED_KEY, "1");
    return arr.map((d) => ({
      connKey: String(d.connKey),
      connId: null,
      root: String(d.root),
      backend: String(d.backend ?? "git"),
      label: String(d.label ?? basename(String(d.root))),
      eager: migrate ? true : !!d.eager,
      status: d.status ?? null,
      activity: "idle" as const,
      error: null,
      lastUpdated: d.lastUpdated ?? null,
      uiCommitOpen: !!d.uiCommitOpen,
      colocated: !!d.colocated,
    }));
  } catch {
    return [];
  }
}

// ---- decorations ----------------------------------------------------------

const norm = (p: string) => p.replace(/\\/g, "/");
const parentDir = (p: string) => {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "";
};

function buildDecorations(repos: TrackedRepo[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const r of repos) {
    if (!r.connId || !r.status) continue;
    const root = norm(r.root).replace(/\/+$/, "");
    for (const c of r.status.changes) map[`${root}/${c.path}`] = c.kind;
  }
  // Mark ancestor folders that aren't themselves a direct change. Ignored
  // entries don't roll up — a folder full of ignored files isn't "changed".
  for (const r of repos) {
    if (!r.connId || !r.status) continue;
    const root = norm(r.root).replace(/\/+$/, "");
    for (const c of r.status.changes) {
      if (c.kind === "ignored") continue;
      let p = parentDir(`${root}/${c.path}`);
      while (p.length > root.length) {
        if (!map[p]) map[p] = "child";
        p = parentDir(p);
      }
    }
  }
  return map;
}

// ---- helpers --------------------------------------------------------------

const stripSlash = (p: string) => norm(p).replace(/\/+$/, "");

/** The tracked repo containing `path` on `connId` (or containing/contained-by —
 *  a pin may sit above or below the resolved repo root), if any. */
export function findRepoForPath(
  repos: TrackedRepo[],
  connId: string,
  path: string,
): TrackedRepo | undefined {
  const p = stripSlash(path);
  return repos.find((r) => {
    if (r.connId !== connId) return false;
    const root = stripSlash(r.root);
    return p === root || p.startsWith(`${root}/`) || root.startsWith(`${p}/`);
  });
}

/** The tracked repo whose working copy COVERS `path` (its root, or a folder
 *  inside it). Unlike [`findRepoForPath`] this does NOT match a folder that
 *  merely contains a repo deeper down — such a folder is not itself in Source
 *  Control, so its ⑂ stays gray and clicking tries to track it. */
export function findRepoContaining(
  repos: TrackedRepo[],
  connId: string,
  path: string,
): TrackedRepo | undefined {
  const p = stripSlash(path);
  return repos.find((r) => {
    if (r.connId !== connId) return false;
    const root = stripSlash(r.root);
    return p === root || p.startsWith(`${root}/`);
  });
}

const repoId = (connKey: string, root: string) => `${connKey}::${root}`;
const mapRepo = (
  repos: TrackedRepo[],
  connKey: string,
  root: string,
  fn: (r: TrackedRepo) => TrackedRepo,
) => repos.map((r) => (r.connKey === connKey && r.root === root ? fn(r) : r));

/** A remote op against a repo that simply has no remote configured — kept to
 *  the phrases that mean exactly that (a missing UPSTREAM or a bad remote URL
 *  are different problems and keep their raw errors). */
function isNoRemoteError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("no remote repository specified") || // git fetch/pull
    m.includes("no configured push destination") || // git push
    m.includes("no git remotes") // jj git fetch/push
  );
}

// Per-repo monotonic token: a refresh whose token is superseded (newer refresh,
// or a cancel) discards its result. This is the frontend-side "cancel".
const tokens = new Map<string, number>();

// Consecutive failed refreshes per repo (cleared on success). The ◉ poll backs
// off exponentially on these, so a broken repo isn't re-polled every tick.
const refreshFailures = new Map<string, number>();

// Repo keys (`connId::root`) currently watched by the backend fs watcher.
const watchedRepos = new Set<string>();

export const useVcsStore = create<VcsState>()((set, get) => ({
  repos: load(),
  scmVisible: false,
  revealRepo: null,
  clearReveal: () => set({ revealRepo: null }),
  historyRepo: null,
  pendingDiscard: null,
  vcsConfirm: null,
  decorations: {},

  openRepo: async (connId, dir) => {
    const connKey = connKeyFor(connId);
    if (!connKey) {
      useAppStore.getState().pushNotice("error", "Unknown connection for repo");
      return;
    }
    let info;
    try {
      info = await vcsOpen(connId, dir);
    } catch (e) {
      // Not a repo (or unreachable): toast and leave the panel closed. The
      // not-a-repo case points at the terminal — no Init button by design
      // (git vs jj vs colocate is the user's call, not ours).
      const msg = String(e);
      const name = basename(dir) || dir;
      useAppStore
        .getState()
        .pushNotice(
          "error",
          /not a git or jj repository/i.test(msg)
            ? `${name} isn't a repository yet — run git init (or jj git init) in a terminal there to create one.`
            : `${name}: ${msg}`,
        );
      return;
    }
    const root = info.root;
    let added = false;
    set((s) => {
      if (s.repos.some((r) => r.connKey === connKey && r.root === root))
        return { scmVisible: true, revealRepo: repoId(connKey, root) };
      added = true;
      const repos = [
        ...s.repos,
        {
          connKey,
          connId,
          root,
          backend: info.backend,
          label: basename(root) || root,
          eager: true, // monitored by default (◉ = monitor, 2026-07-14)
          status: null,
          activity: "idle" as const,
          error: null,
          lastUpdated: null,
        },
      ];
      persist(repos);
      return { repos, scmVisible: true, revealRepo: repoId(connKey, root) };
    });
    if (added) {
      get().syncWatchers();
      await get().refreshRepo(connKey, root); // first populate
    }
  },

  openRepoFromExplorer: (connId, path) => {
    // A repo COVERING the folder → just reveal its card. A folder that only
    // contains a repo deeper down doesn't count — tracking it is attempted
    // like any other folder (vcs_open resolves or refuses with a toast).
    const existing = findRepoContaining(get().repos, connId, path);
    if (existing) {
      set({ scmVisible: true, revealRepo: repoId(existing.connKey, existing.root) });
      return;
    }
    void get().openRepo(connId, path);
  },

  removeRepo: (connKey, root) => {
    set((s) => {
      const repos = s.repos.filter((r) => !(r.connKey === connKey && r.root === root));
      persist(repos);
      return { repos, decorations: buildDecorations(repos) };
    });
    get().syncWatchers();
  },

  toggleEager: (connKey, root) => {
    set((s) => {
      const repos = mapRepo(s.repos, connKey, root, (r) => ({ ...r, eager: !r.eager }));
      persist(repos);
      return { repos };
    });
    if (get().repos.find((r) => r.connKey === connKey && r.root === root)?.eager)
      void get().refreshRepo(connKey, root);
  },

  refreshRepo: async (connKey, root, opts) => {
    const repo = get().repos.find((r) => r.connKey === connKey && r.root === root);
    if (!repo) return;
    const connId = repo.connId ?? connIdForKey(connKey);
    if (!connId) {
      // A background check racing a disconnect stays quiet; only an explicit
      // refresh paints the card into the error state.
      if (opts?.silent) return;
      set((s) => ({
        repos: mapRepo(s.repos, connKey, root, (r) => ({
          ...r,
          activity: "error",
          error: "Connection not active",
        })),
      }));
      return;
    }
    const id = repoId(connKey, root);
    const token = (tokens.get(id) ?? 0) + 1;
    tokens.set(id, token);
    set((s) => ({
      repos: mapRepo(s.repos, connKey, root, (r) => ({
        ...r,
        connId,
        // Silent (poll / focus / watcher) refreshes don't show the spinner
        // or flip the stamp to "updating…" — only explicit ones do.
        activity: opts?.silent ? "polling" : "loading",
        error: null,
      })),
    }));
    try {
      const status = await vcsStatus(connId, root, repo.backend);
      if (tokens.get(id) !== token) return; // superseded or cancelled
      refreshFailures.delete(id);
      set((s) => {
        const now = Date.now();
        const repos = mapRepo(s.repos, connKey, root, (r) => {
          // "Checked" always advances; the stamp ("changed … ago", which the
          // history also keys off) only when the result differs — a no-op
          // poll must not reset the counter or refetch the history. An
          // in-app save/file-op forces the stamp (we witnessed the change,
          // even when the status SHAPE is identical — e.g. an already-M
          // file re-saved).
          const differs =
            !r.status || JSON.stringify(r.status) !== JSON.stringify(status);
          const stamp = differs || !!opts?.forceStamp;
          return {
            ...r,
            status: differs ? status : r.status,
            activity: "idle" as const,
            error: null,
            lastChecked: now,
            lastCheckFailed: false,
            lastUpdated: stamp ? now : (r.lastUpdated ?? now),
          };
        });
        persist(repos);
        return { repos, decorations: buildDecorations(repos) };
      });
    } catch (e) {
      if (tokens.get(id) !== token) return;
      refreshFailures.set(id, (refreshFailures.get(id) ?? 0) + 1);
      if (opts?.silent) {
        // A silent check failing must stay silent: keep the cached status and
        // a calm card, note the failure for the stamp tooltip, and let the
        // next (backed-off) poll retry. Only explicit refreshes go red.
        set((s) => ({
          repos: mapRepo(s.repos, connKey, root, (r) => ({
            ...r,
            activity: "idle" as const,
            lastChecked: Date.now(),
            lastCheckFailed: true,
          })),
        }));
        return;
      }
      set((s) => ({
        repos: mapRepo(s.repos, connKey, root, (r) => ({
          ...r,
          activity: "error",
          error: String(e),
        })),
      }));
    }
  },

  cancelRefresh: (connKey, root) => {
    const id = repoId(connKey, root);
    tokens.set(id, (tokens.get(id) ?? 0) + 1); // invalidate the in-flight result
    set((s) => ({
      repos: mapRepo(s.repos, connKey, root, (r) => ({ ...r, activity: "idle" })),
    }));
  },

  stage: async (connKey, root, paths) => {
    const connId = get().repos.find((r) => r.connKey === connKey && r.root === root)?.connId;
    if (!connId) return;
    try {
      await vcsStage(connId, root, paths);
    } catch (e) {
      useAppStore.getState().pushNotice("error", `Stage failed: ${String(e)}`);
    }
    await get().refreshRepo(connKey, root);
  },

  unstage: async (connKey, root, paths) => {
    const connId = get().repos.find((r) => r.connKey === connKey && r.root === root)?.connId;
    if (!connId) return;
    try {
      await vcsUnstage(connId, root, paths);
    } catch (e) {
      useAppStore.getState().pushNotice("error", `Unstage failed: ${String(e)}`);
    }
    await get().refreshRepo(connKey, root);
  },

  commit: async (connKey, root, message) => {
    const repo = get().repos.find((r) => r.connKey === connKey && r.root === root);
    const connId = repo?.connId;
    if (!repo || !connId) return false;
    try {
      await vcsCommit(connId, root, repo.backend, message);
    } catch (e) {
      useAppStore.getState().pushNotice("error", `Commit failed: ${String(e)}`);
      return false;
    }
    useAppStore.getState().pushNotice("info", "Committed.");
    await get().refreshRepo(connKey, root);
    return true;
  },

  remoteOp: async (connKey, root, op) => {
    const repo = get().repos.find((r) => r.connKey === connKey && r.root === root);
    const connId = repo?.connId;
    if (!repo || !connId) return;
    // One remote op per repo — a second one would spuriously cancel the first.
    if (repo.remoteBusy) {
      useAppStore
        .getState()
        .pushNotice("info", `A ${repo.remoteBusy} is already running — cancel it first.`);
      return;
    }
    set((s) => ({
      repos: mapRepo(s.repos, connKey, root, (r) => ({ ...r, remoteBusy: op })),
    }));
    try {
      const msg = await vcsRemote(connId, root, repo.backend, op);
      const first = msg.split("\n").find((l) => l.trim()) ?? `${op} complete`;
      useAppStore.getState().pushNotice("info", `${op}: ${first}`);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("cancelled")) {
        useAppStore.getState().pushNotice("info", `${op} cancelled.`);
      } else if (isNoRemoteError(msg)) {
        // A repo with no remote is a normal state, not a fatal — say what to
        // do instead of relaying git/jj's error-speak.
        useAppStore
          .getState()
          .pushNotice(
            "info",
            `This repository has no remote — add one first (git remote add origin <url>) to ${op}.`,
          );
      } else {
        useAppStore.getState().pushNotice("error", `${op} failed: ${msg}`);
      }
    } finally {
      set((s) => ({
        repos: mapRepo(s.repos, connKey, root, (r) => ({ ...r, remoteBusy: null })),
      }));
    }
    await get().refreshRepo(connKey, root);
  },

  cancelRemoteOp: (connKey, root) => {
    const repo = get().repos.find((r) => r.connKey === connKey && r.root === root);
    if (repo?.connId) void vcsRemoteCancel(repo.connId, repo.root).catch(() => {});
  },

  switchBranch: async (connKey, root, target) => {
    const repo = get().repos.find((r) => r.connKey === connKey && r.root === root);
    const connId = repo?.connId;
    if (!repo || !connId) return;
    try {
      await vcsSwitch(connId, root, repo.backend, target);
      useAppStore.getState().pushNotice("info", `Switched to ${target}`);
    } catch (e) {
      useAppStore.getState().pushNotice("error", `Switch failed: ${String(e)}`);
    }
    await get().refreshRepo(connKey, root);
  },

  createBranch: async (connKey, root, name) => {
    const repo = get().repos.find((r) => r.connKey === connKey && r.root === root);
    const connId = repo?.connId;
    if (!repo || !connId) return;
    try {
      await vcsCreateBranch(connId, root, repo.backend, name);
      useAppStore.getState().pushNotice("info", `Created ${name}`);
    } catch (e) {
      useAppStore.getState().pushNotice("error", `Create failed: ${String(e)}`);
    }
    await get().refreshRepo(connKey, root);
  },

  amend: async (connKey, root, message) => {
    const repo = get().repos.find((r) => r.connKey === connKey && r.root === root);
    const connId = repo?.connId;
    if (!repo || !connId) return false;
    try {
      await vcsAmend(connId, root, message);
    } catch (e) {
      useAppStore.getState().pushNotice("error", `Amend failed: ${String(e)}`);
      return false;
    }
    useAppStore.getState().pushNotice("info", "Amended last commit.");
    await get().refreshRepo(connKey, root);
    return true;
  },

  stash: async (connKey, root, op, message) => {
    const repo = get().repos.find((r) => r.connKey === connKey && r.root === root);
    const connId = repo?.connId;
    if (!repo || !connId) return;
    try {
      const out = await vcsStash(connId, root, op, message);
      useAppStore.getState().pushNotice("info", out || `stash ${op} ok`);
      if (op === "pop" || op === "drop") {
        set((s) => ({
          repos: mapRepo(s.repos, connKey, root, (r) => ({ ...r, stashConflict: false })),
        }));
      }
    } catch (e) {
      const msg = String(e);
      useAppStore.getState().pushNotice("error", `Stash ${op} failed: ${msg}`);
      if (op === "pop" && /conflict/i.test(msg)) {
        // git keeps the stash on a conflicted pop; the card offers Drop once
        // the conflicts are resolved.
        set((s) => ({
          repos: mapRepo(s.repos, connKey, root, (r) => ({ ...r, stashConflict: true })),
        }));
      }
    }
    await get().refreshRepo(connKey, root);
  },

  updateFromRemote: async (connKey, root) => {
    const repo = get().repos.find((r) => r.connKey === connKey && r.root === root);
    const connId = repo?.connId;
    if (!repo || !connId) return;
    // One remote op per repo — a second one would spuriously cancel the first.
    if (repo.remoteBusy) {
      useAppStore
        .getState()
        .pushNotice("info", `A ${repo.remoteBusy} is already running — cancel it first.`);
      return;
    }
    set((s) => ({
      repos: mapRepo(s.repos, connKey, root, (r) => ({ ...r, remoteBusy: "update" })),
    }));
    try {
      const msg = await vcsUpdate(connId, root, repo.backend, repo.status?.ref ?? "");
      const first = msg.split("\n").find((l) => l.trim()) ?? "Updated.";
      useAppStore.getState().pushNotice("info", first);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("cancelled")) {
        useAppStore.getState().pushNotice("info", "Update cancelled.");
      } else {
        useAppStore.getState().pushNotice("error", `Update failed: ${msg}`);
      }
    } finally {
      set((s) => ({
        repos: mapRepo(s.repos, connKey, root, (r) => ({ ...r, remoteBusy: null })),
      }));
    }
    await get().refreshRepo(connKey, root);
  },

  toggleCommitOpen: (connKey, root) =>
    set((s) => {
      const repos = mapRepo(s.repos, connKey, root, (r) => ({
        ...r,
        uiCommitOpen: !r.uiCommitOpen,
      }));
      persist(repos);
      return { repos };
    }),

  toggleBackend: (connKey, root) => {
    let next: string | null = null;
    let liveConnId: string | null = null;
    set((s) => {
      const repos = mapRepo(s.repos, connKey, root, (r) => {
        const flipped = r.backend === "jj" ? "git" : "jj";
        next = flipped;
        liveConnId = r.connId;
        return {
          ...r,
          backend: flipped,
          colocated: true,
          status: null,
          lastUpdated: null,
        };
      });
      persist(repos);
      return { repos };
    });
    // Keep an open editor log tab on the same lens — the tab's own swap
    // button already flips the card, so the sync is two-way.
    if (next && liveConnId) {
      useAppStore.getState().setLogTabBackend(liveConnId, root, next);
    }
    void get().refreshRepo(connKey, root);
  },

  incomingHidden: {},
  dismissIncoming: (connKey, root) =>
    set((s) => ({
      incomingHidden: { ...s.incomingHidden, [repoId(connKey, root)]: true },
    })),
  unhideIncoming: (connKey, root) =>
    set((s) => ({
      incomingHidden: { ...s.incomingHidden, [repoId(connKey, root)]: false },
    })),

  moveRepo: (fromId, toId, after) =>
    set((s) => {
      const id = (r: TrackedRepo) => `${r.connKey}::${r.root}`;
      const from = s.repos.findIndex((r) => id(r) === fromId);
      if (from < 0 || id(s.repos[from]) === toId) return s;
      const repos = [...s.repos];
      const [moved] = repos.splice(from, 1);
      // Recompute the target AFTER removal so the insert index is right in
      // both drag directions; `after` = the drop landed past the midpoint.
      const to = repos.findIndex((r) => id(r) === toId);
      if (to < 0) return s;
      repos.splice(after ? to + 1 : to, 0, moved);
      persist(repos);
      return { repos };
    }),

  askConfirm: (title, body, run, id) => {
    if (id && !confirmEnabled(id)) {
      run(); // silenced in settings.json — skip the dialog
      return;
    }
    set({ vcsConfirm: { title, body, run, id } });
  },
  clearConfirm: () => set({ vcsConfirm: null }),

  requestDiscard: (connKey, root, changes) =>
    set({ pendingDiscard: { connKey, root, changes } }),
  cancelDiscard: () => set({ pendingDiscard: null }),
  confirmDiscard: async () => {
    const pd = get().pendingDiscard;
    if (!pd) return;
    set({ pendingDiscard: null });
    const repo = get().repos.find(
      (r) => r.connKey === pd.connKey && r.root === pd.root,
    );
    const connId = repo?.connId;
    if (!repo || !connId) return;
    const norm = repo.root.replace(/\\/g, "/").replace(/\/+$/, "");
    try {
      if (repo.backend === "jj") {
        await vcsDiscard(connId, repo.root, "jj", pd.changes.map((c) => c.path));
      } else {
        // git: restore tracked changes; for added/untracked, unstage + delete.
        const tracked = pd.changes
          .filter((c) => c.kind !== "untracked" && c.kind !== "added")
          .map((c) => c.path);
        const fresh = pd.changes.filter(
          (c) => c.kind === "untracked" || c.kind === "added",
        );
        if (tracked.length) await vcsDiscard(connId, repo.root, "git", tracked);
        for (const c of fresh) {
          if (c.kind === "added") {
            try {
              await vcsUnstage(connId, repo.root, [c.path]);
            } catch {
              /* ignore */
            }
          }
          try {
            await fsRemove(connId, `${norm}/${c.path}`);
          } catch {
            /* ignore */
          }
        }
      }
      useAppStore.getState().pushNotice("info", "Discarded changes.");
    } catch (e) {
      useAppStore.getState().pushNotice("error", `Discard failed: ${String(e)}`);
    }
    await get().refreshRepo(pd.connKey, pd.root);
  },

  resolveConns: () => {
    const newlyConnected: { connKey: string; root: string }[] = [];
    const repos = get().repos.map((r) => {
      const connId = connIdForKey(r.connKey);
      if (connId && !r.connId) newlyConnected.push({ connKey: r.connKey, root: r.root });
      return { ...r, connId };
    });
    set({ repos, decorations: buildDecorations(repos) });
    get().syncWatchers();
    // Populate repos that just came online (startup / reconnect), unless their
    // cache is seconds old (e.g. a quick relaunch).
    for (const n of newlyConnected) {
      const r = get().repos.find((x) => x.connKey === n.connKey && x.root === n.root);
      if (r && (!r.lastUpdated || Date.now() - r.lastUpdated > 5_000))
        void get().refreshRepo(n.connKey, n.root);
    }
  },

  refreshAll: (throttleMs, opts) => {
    const local = useAppStore.getState().localConnId;
    const now = Date.now();
    for (const r of get().repos) {
      if (!r.connId) continue;
      // Local repos are watcher-live — an automatic catch-up (window focus)
      // can't tell them anything new, so it skips them entirely.
      if (opts?.skipLocal && r.connId === local) continue;
      if (r.activity === "loading" || r.activity === "polling") continue;
      const checked = r.lastChecked ?? r.lastUpdated;
      if (throttleMs > 0 && checked && now - checked < throttleMs) continue;
      void get().refreshRepo(r.connKey, r.root, { silent: opts?.silent });
    }
  },

  pollEagerRemotes: () => {
    const local = useAppStore.getState().localConnId;
    const now = Date.now();
    for (const r of get().repos) {
      if (!r.connId || r.connId === local) continue; // local = fs watcher
      if (!r.eager) continue; // ◉ is the opt-in
      if (r.activity === "loading" || r.activity === "polling") continue;
      // Base wait sits slightly under the 5 s tick so a refresh from another
      // trigger (save, focus) doesn't double up with the poll. Consecutive
      // failures back the wait off exponentially (8 s, 16 s, … capped at
      // 60 s), so a broken repo isn't hammered every tick; one success
      // resets it.
      const fails = refreshFailures.get(repoId(r.connKey, r.root)) ?? 0;
      const wait = Math.min(4_000 * 2 ** fails, 60_000);
      const checked = r.lastChecked ?? r.lastUpdated;
      if (checked && now - checked < wait) continue;
      void get().refreshRepo(r.connKey, r.root, { silent: true });
    }
  },

  onFsChange: (connId, root) => {
    const target = norm(root).replace(/\/+$/, "");
    const r = get().repos.find(
      (x) => x.connId === connId && norm(x.root).replace(/\/+$/, "") === target,
    );
    if (!r || r.activity === "loading" || r.activity === "polling") return;
    // Our own status call touches `.git/index` (stat-cache refresh) right after
    // it completes — ignore the echo so watch → refresh can't self-loop.
    const checked = r.lastChecked ?? r.lastUpdated;
    if (checked && Date.now() - checked < 1_000) return;
    // Watcher-driven = background: no spinner/stamp flash; the stamp still
    // resets when the refresh finds real changes.
    void get().refreshRepo(r.connKey, r.root, { silent: true });
  },

  syncWatchers: () => {
    const localId = useAppStore.getState().localConnId;
    const desired = new Map<string, { connId: string; root: string }>();
    if (localId) {
      for (const r of get().repos) {
        if (r.connId === localId)
          desired.set(`${r.connId}::${r.root}`, { connId: r.connId, root: r.root });
      }
    }
    for (const key of [...watchedRepos]) {
      if (!desired.has(key)) {
        watchedRepos.delete(key);
        const sep = key.indexOf("::");
        void vcsUnwatch(key.slice(0, sep), key.slice(sep + 2)).catch(() => {});
      }
    }
    for (const [key, v] of desired) {
      if (!watchedRepos.has(key)) {
        watchedRepos.add(key);
        vcsWatch(v.connId, v.root).catch(() => watchedRepos.delete(key));
      }
    }
  },

  onFileChanged: (connId, path) => {
    const np = norm(path);
    for (const r of get().repos) {
      if (
        r.connId === connId &&
        np.startsWith(norm(r.root).replace(/\/+$/, "") + "/")
      ) {
        // In-app saves/file-ops ALWAYS refresh the containing repo — even
        // unmonitored (◉ off) ones: the user's own action is the one change
        // source we always know about. Silent (no spinner), but the stamp
        // resets unconditionally (forceStamp — we witnessed the change).
        void get().refreshRepo(r.connKey, r.root, {
          silent: true,
          forceStamp: true,
        });
      }
    }
  },

  setScmVisible: (scmVisible) => set({ scmVisible }),
  toggleScm: () => set((s) => ({ scmVisible: !s.scmVisible })),
  showHistory: (connKey, root) =>
    set({ historyRepo: { connKey, root }, scmVisible: true }),
  closeHistory: () => set({ historyRepo: null }),
}));
