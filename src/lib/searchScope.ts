/** Shared scope model for the fuzzy finder and search-in-files overlays:
 *  which connection's pinned folders to look in. Persisted (last-used wins). */
import { useAppStore } from "../store/appStore";

export type SearchScope = "local" | "wsl" | "remote" | "all";

export const SCOPES: { id: SearchScope; label: string }[] = [
  { id: "local", label: "Local" },
  { id: "wsl", label: "WSL" },
  { id: "remote", label: "Remote" },
  { id: "all", label: "All" },
];

const KEY = "straylight.searchScope";

export function loadScope(): SearchScope {
  const v = localStorage.getItem(KEY);
  return v === "local" || v === "wsl" || v === "remote" || v === "all" ? v : "local";
}

export function saveScope(scope: SearchScope): void {
  try {
    localStorage.setItem(KEY, scope);
  } catch {
    /* ignore */
  }
}

export interface SearchRoot {
  connId: string;
  root: string;
  /** Short label for the root (its folder name). */
  tag: string;
  kind: Exclude<SearchScope, "all">;
}

/** Every pinned folder across the active connections, tagged by kind. */
export function collectRoots(): SearchRoot[] {
  const s = useAppStore.getState();
  const out: SearchRoot[] = [];
  const base = (p: string) => {
    const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
    const i = norm.lastIndexOf("/");
    return i >= 0 ? norm.slice(i + 1) || norm : norm;
  };
  const add = (
    connId: string | null | undefined,
    pins: string[],
    kind: SearchRoot["kind"],
  ) => {
    if (!connId) return;
    for (const p of pins) out.push({ connId, root: p, tag: base(p), kind });
  };
  add(s.localConnId, s.pinnedFolders, "local");
  add(s.wsl?.connId, s.wslPins, "wsl");
  for (const r of s.remotes) add(r.conn.connId, r.pins, "remote");
  return out;
}

export function rootsForScope(roots: SearchRoot[], scope: SearchScope): SearchRoot[] {
  return scope === "all" ? roots : roots.filter((r) => r.kind === scope);
}

/** Which kinds have an active connection (for disabling chips). */
export function availableKinds(): Set<SearchRoot["kind"]> {
  const s = useAppStore.getState();
  const out = new Set<SearchRoot["kind"]>();
  if (s.localConnId) out.add("local");
  if (s.wsl) out.add("wsl");
  if (s.remotes.length > 0) out.add("remote");
  return out;
}
