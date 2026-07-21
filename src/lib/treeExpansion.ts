/** Persisted folder-expansion sets for the explorer and transfer trees.
 *  Keyed by host identity (+ root), never by connId — connIds are per-session,
 *  and expansion should survive restarts and reconnects. */
import { remoteHostKey, useAppStore } from "../store/appStore";

export const EXPLORER_EXPANSION = "straylight.treeExpanded";
export const TRANSFER_EXPANSION = "straylight.transferExpanded";

/** Stable host identity for a live connId ("local" / "wsl:<name>" /
 *  "user@host:port"; falls back to the raw id for unknowns). */
export function expansionHostKey(connId: string): string {
  const s = useAppStore.getState();
  if (connId === s.localConnId) return "local";
  const w = s.wsls.find((x) => x.conn.connId === connId);
  if (w) return `wsl:${w.conn.name}`;
  const r = s.remotes.find((x) => x.conn.connId === connId);
  return r ? remoteHostKey(r.conn) : connId;
}

function loadMap(storageKey: string): Record<string, string[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function loadExpanded(storageKey: string, id: string): string[] {
  const list = loadMap(storageKey)[id];
  return Array.isArray(list)
    ? list.filter((p): p is string => typeof p === "string")
    : [];
}

export function saveExpanded(
  storageKey: string,
  id: string,
  paths: Iterable<string>,
): void {
  try {
    const map = loadMap(storageKey);
    const list = [...paths];
    if (list.length > 0) map[id] = list;
    else delete map[id];
    localStorage.setItem(storageKey, JSON.stringify(map));
  } catch {
    /* prefs only */
  }
}
