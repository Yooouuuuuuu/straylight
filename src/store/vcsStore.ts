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
  vcsCommit,
  vcsDiscard,
  vcsOpen,
  vcsRemote,
  vcsStage,
  vcsStatus,
  vcsUnstage,
  type VcsChange,
  type VcsStatus,
} from "../lib/ipc";
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
  activity: "idle" | "loading" | "error";
  error: string | null;
  lastUpdated: number | null;
  /** The fetch/pull/push op currently running, or null. */
  remoteBusy?: "fetch" | "pull" | "push" | null;
}

interface VcsState {
  repos: TrackedRepo[];
  scmVisible: boolean;
  /** Which repo's history is shown in the left-of-SCM history panel (or null). */
  historyRepo: { connKey: string; root: string } | null;
  /** Pending discard awaiting confirmation. */
  pendingDiscard: { connKey: string; root: string; changes: VcsChange[] } | null;
  /** Normalized absolute path → change kind ("child" marks an ancestor folder). */
  decorations: Record<string, string>;

  openRepo: (connId: string, dir: string) => Promise<void>;
  removeRepo: (connKey: string, root: string) => void;
  toggleEager: (connKey: string, root: string) => void;
  refreshRepo: (connKey: string, root: string) => Promise<void>;
  cancelRefresh: (connKey: string, root: string) => void;
  stage: (connKey: string, root: string, paths: string[]) => Promise<void>;
  unstage: (connKey: string, root: string, paths: string[]) => Promise<void>;
  commit: (connKey: string, root: string, message: string) => Promise<boolean>;
  remoteOp: (connKey: string, root: string, op: "fetch" | "pull" | "push") => Promise<void>;
  requestDiscard: (connKey: string, root: string, changes: VcsChange[]) => void;
  confirmDiscard: () => Promise<void>;
  cancelDiscard: () => void;
  /** Re-resolve each repo's live connId from the active connections. */
  resolveConns: () => void;
  /** A file changed under `connId`: refresh eager repos that contain it. */
  onFileChanged: (connId: string, path: string) => void;
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
  if (s.remote && connId === s.remote.connId)
    return `${s.remote.user}@${s.remote.host}:${s.remote.port}`;
  if (s.wsl && connId === s.wsl.connId) return `wsl:${s.wsl.name}`;
  return null;
}

function connIdForKey(connKey: string): string | null {
  const s = useAppStore.getState();
  if (connKey === "local") return s.localConnId;
  if (s.remote && connKey === `${s.remote.user}@${s.remote.host}:${s.remote.port}`)
    return s.remote.connId;
  if (s.wsl && connKey === `wsl:${s.wsl.name}`) return s.wsl.connId;
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
        })),
      ),
    );
  } catch {
    /* ignore */
  }
}

function load(): TrackedRepo[] {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(arr)) return [];
    return arr.map((d) => ({
      connKey: String(d.connKey),
      connId: null,
      root: String(d.root),
      backend: String(d.backend ?? "git"),
      label: String(d.label ?? basename(String(d.root))),
      eager: !!d.eager,
      status: d.status ?? null,
      activity: "idle" as const,
      error: null,
      lastUpdated: d.lastUpdated ?? null,
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
  // Mark ancestor folders that aren't themselves a direct change.
  for (const r of repos) {
    if (!r.connId || !r.status) continue;
    const root = norm(r.root).replace(/\/+$/, "");
    for (const c of r.status.changes) {
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

const repoId = (connKey: string, root: string) => `${connKey}::${root}`;
const mapRepo = (
  repos: TrackedRepo[],
  connKey: string,
  root: string,
  fn: (r: TrackedRepo) => TrackedRepo,
) => repos.map((r) => (r.connKey === connKey && r.root === root ? fn(r) : r));

// Per-repo monotonic token: a refresh whose token is superseded (newer refresh,
// or a cancel) discards its result. This is the frontend-side "cancel".
const tokens = new Map<string, number>();

export const useVcsStore = create<VcsState>()((set, get) => ({
  repos: load(),
  scmVisible: false,
  historyRepo: null,
  pendingDiscard: null,
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
      useAppStore.getState().pushNotice("error", String(e));
      return;
    }
    const root = info.root;
    let added = false;
    set((s) => {
      if (s.repos.some((r) => r.connKey === connKey && r.root === root))
        return { scmVisible: true };
      added = true;
      const repos = [
        ...s.repos,
        {
          connKey,
          connId,
          root,
          backend: info.backend,
          label: basename(root) || root,
          eager: false,
          status: null,
          activity: "idle" as const,
          error: null,
          lastUpdated: null,
        },
      ];
      persist(repos);
      return { repos, scmVisible: true };
    });
    if (added) await get().refreshRepo(connKey, root); // first populate
  },

  removeRepo: (connKey, root) =>
    set((s) => {
      const repos = s.repos.filter((r) => !(r.connKey === connKey && r.root === root));
      persist(repos);
      return { repos, decorations: buildDecorations(repos) };
    }),

  toggleEager: (connKey, root) => {
    set((s) => {
      const repos = mapRepo(s.repos, connKey, root, (r) => ({ ...r, eager: !r.eager }));
      persist(repos);
      return { repos };
    });
    if (get().repos.find((r) => r.connKey === connKey && r.root === root)?.eager)
      void get().refreshRepo(connKey, root);
  },

  refreshRepo: async (connKey, root) => {
    const repo = get().repos.find((r) => r.connKey === connKey && r.root === root);
    if (!repo) return;
    const connId = repo.connId ?? connIdForKey(connKey);
    if (!connId) {
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
        activity: "loading",
        error: null,
      })),
    }));
    try {
      const status = await vcsStatus(connId, root, repo.backend);
      if (tokens.get(id) !== token) return; // superseded or cancelled
      set((s) => {
        const repos = mapRepo(s.repos, connKey, root, (r) => ({
          ...r,
          status,
          activity: "idle" as const,
          error: null,
          lastUpdated: Date.now(),
        }));
        persist(repos);
        return { repos, decorations: buildDecorations(repos) };
      });
    } catch (e) {
      if (tokens.get(id) !== token) return;
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
    set((s) => ({
      repos: mapRepo(s.repos, connKey, root, (r) => ({ ...r, remoteBusy: op })),
    }));
    try {
      const msg = await vcsRemote(connId, root, repo.backend, op);
      const first = msg.split("\n").find((l) => l.trim()) ?? `${op} complete`;
      useAppStore.getState().pushNotice("info", `${op}: ${first}`);
    } catch (e) {
      useAppStore.getState().pushNotice("error", `${op} failed: ${String(e)}`);
    } finally {
      set((s) => ({
        repos: mapRepo(s.repos, connKey, root, (r) => ({ ...r, remoteBusy: null })),
      }));
    }
    await get().refreshRepo(connKey, root);
  },

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

  resolveConns: () =>
    set((s) => {
      const repos = s.repos.map((r) => ({ ...r, connId: connIdForKey(r.connKey) }));
      return { repos, decorations: buildDecorations(repos) };
    }),

  onFileChanged: (connId, path) => {
    const np = norm(path);
    for (const r of get().repos) {
      if (
        r.connId === connId &&
        r.eager &&
        np.startsWith(norm(r.root).replace(/\/+$/, "") + "/")
      ) {
        void get().refreshRepo(r.connKey, r.root);
      }
    }
  },

  setScmVisible: (scmVisible) => set({ scmVisible }),
  toggleScm: () => set((s) => ({ scmVisible: !s.scmVisible })),
  showHistory: (connKey, root) =>
    set({ historyRepo: { connKey, root }, scmVisible: true }),
  closeHistory: () => set({ historyRepo: null }),
}));
