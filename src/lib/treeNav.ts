/** Shared model that lets one keyboard handler walk the whole multi-root file
 *  tree. Each RootTree publishes its flattened, in-order visible rows plus
 *  expand/collapse handles; the explorer key handler reads the concatenation of
 *  every root (in sidebar order) so ↑/↓ cross root boundaries seamlessly. */
import { openFileByPath } from "./openFile";
import { useAppStore } from "../store/appStore";

export interface TreeRow {
  connId: string;
  rootId: string;
  path: string;
  name: string;
  isDir: boolean;
  /** 0 for a root row, increasing for descendants — used to find a first child. */
  depth: number;
  expanded: boolean;
  /** Null for a root row. */
  parentPath: string | null;
}

interface RootEntry {
  order: number;
  rows: TreeRow[];
  expand: (path: string) => void;
  collapse: (path: string) => void;
}

const roots = new Map<string, RootEntry>();

export function registerTreeRoot(
  rootId: string,
  entry: Omit<RootEntry, "rows">,
): void {
  const existing = roots.get(rootId);
  roots.set(rootId, { ...entry, rows: existing?.rows ?? [] });
}

export function updateTreeRows(rootId: string, rows: TreeRow[]): void {
  const entry = roots.get(rootId);
  if (entry) entry.rows = rows;
}

export function unregisterTreeRoot(rootId: string): void {
  roots.delete(rootId);
}

// --- Explorer focus -------------------------------------------------------
// Lets keyboard shortcuts (e.g. Ctrl+Shift+E) move focus into the tree so the
// arrow keys take effect immediately.

let explorerFocus: (() => void) | null = null;

export function registerExplorerFocus(fn: (() => void) | null): void {
  explorerFocus = fn;
}

export function focusExplorer(): void {
  explorerFocus?.();
}

function allRows(): TreeRow[] {
  return [...roots.values()]
    .sort((a, b) => a.order - b.order)
    .flatMap((e) => e.rows);
}

const NAV_KEYS = [
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Enter",
  "Home",
  "End",
  "PageUp",
  "PageDown",
];

/** Handle an explorer navigation key. Returns true if it was consumed. */
export function handleExplorerKey(key: string): boolean {
  if (!NAV_KEYS.includes(key)) return false;

  const rows = allRows();
  if (rows.length === 0) return false;

  const store = useAppStore.getState();
  const sel = store.selected;
  const idx = sel
    ? rows.findIndex((r) => r.connId === sel.connId && r.path === sel.path)
    : -1;

  const select = (i: number) => {
    const r = rows[i];
    store.setSelected({
      connId: r.connId,
      path: r.path,
      name: r.name,
      isDir: r.isDir,
    });
  };
  const handle = (r: TreeRow) => roots.get(r.rootId);

  switch (key) {
    case "ArrowDown":
      select(idx < 0 ? 0 : Math.min(idx + 1, rows.length - 1));
      return true;
    case "ArrowUp":
      select(idx < 0 ? rows.length - 1 : Math.max(idx - 1, 0));
      return true;
    case "Home":
      select(0);
      return true;
    case "End":
      select(rows.length - 1);
      return true;
    case "ArrowRight": {
      if (idx < 0) {
        select(0);
        return true;
      }
      const r = rows[idx];
      if (r.isDir && !r.expanded) {
        handle(r)?.expand(r.path);
      } else if (
        r.isDir &&
        r.expanded &&
        idx + 1 < rows.length &&
        rows[idx + 1].depth > r.depth
      ) {
        select(idx + 1);
      }
      return true;
    }
    case "ArrowLeft": {
      if (idx < 0) {
        select(0);
        return true;
      }
      const r = rows[idx];
      if (r.isDir && r.expanded) {
        handle(r)?.collapse(r.path);
      } else if (r.parentPath) {
        const p = rows.findIndex(
          (x) => x.connId === r.connId && x.path === r.parentPath,
        );
        if (p >= 0) select(p);
      }
      return true;
    }
    case "Enter": {
      if (idx < 0) return true;
      const r = rows[idx];
      if (r.isDir) {
        if (r.expanded) handle(r)?.collapse(r.path);
        else handle(r)?.expand(r.path);
      } else {
        void openFileByPath(r.connId, r.path, r.name);
      }
      return true;
    }
    case "PageDown":
    case "PageUp": {
      // Hop to the next/previous root's header (each is that server's top).
      const rootIdx: number[] = [];
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].parentPath === null) rootIdx.push(i);
      }
      if (rootIdx.length === 0) return true;
      if (idx < 0) {
        select(key === "PageDown" ? rootIdx[0] : rootIdx[rootIdx.length - 1]);
        return true;
      }
      // The root that owns the current row = the last root header at/above it.
      let cur = 0;
      for (let k = 0; k < rootIdx.length; k++) {
        if (rootIdx[k] <= idx) cur = k;
      }
      const target = key === "PageDown" ? cur + 1 : cur - 1;
      if (target >= 0 && target < rootIdx.length) select(rootIdx[target]);
      return true;
    }
  }
  return false;
}
