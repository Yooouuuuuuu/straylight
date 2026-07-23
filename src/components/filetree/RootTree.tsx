/** One root in the sidebar (a pinned local folder, or the remote host). Renders
 *  a collapsible header plus its lazily-loaded tree. Multiple of these stack to
 *  form the multi-root explorer. */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { commitRename, dropIntoDir } from "../../lib/fileOps";
import { fsEntryMeta, fsListDir, type FileEntry } from "../../lib/ipc";
import { openRemoteFile } from "../../lib/openFile";
import { canDropInto, getTreeDrag, setTreeDrag } from "../../lib/treeDrag";
import type { DragItem } from "../../lib/transferDrag";
import {
  registerTreeRoot,
  selectionRange,
  unregisterTreeRoot,
  updateTreeRows,
  type TreeRow,
} from "../../lib/treeNav";
import { remoteHostKey, useAppStore } from "../../store/appStore";
import { findRepoContaining, repoColorForPath, useVcsStore } from "../../store/vcsStore";

// Root collapse/expand persists per host+path (stable across reconnects —
// connIds change per session, so the key uses the host identity instead).
const COLLAPSED_KEY = "straylight.rootCollapsed";

function stableRootKey(connId: string, rootPath: string): string {
  const s = useAppStore.getState();
  const wsl = s.wsls.find((w) => w.conn.connId === connId);
  const host =
    connId === s.localConnId
      ? "local"
      : wsl
        ? `wsl:${wsl.conn.name}`
        : (() => {
            const r = s.remotes.find((x) => x.conn.connId === connId);
            return r ? remoteHostKey(r.conn) : connId;
          })();
  return `${host}::${rootPath}`;
}

function loadCollapsedMap(): Record<string, boolean> {
  try {
    const parsed = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "null");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveCollapsed(key: string, collapsed: boolean): void {
  try {
    const map = loadCollapsedMap();
    map[key] = collapsed;
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}
import { entryTooltip, FileNode } from "./FileNode";
import {
  EXPLORER_EXPANSION,
  loadExpanded,
  saveExpanded,
} from "../../lib/treeExpansion";
import { IconBranch, IconChevron, IconClose } from "../icons";
import { Tip } from "../Tooltip";

interface DirState {
  entries: FileEntry[] | null;
  loading: boolean;
  error: string | null;
}

export function RootTree({
  connId,
  rootPath,
  label,
  removable,
  onRemove,
  defaultCollapsed,
  showHidden,
  refreshToken,
  rootId,
  order,
}: {
  connId: string;
  rootPath: string;
  label: string;
  removable?: boolean;
  onRemove?: () => void;
  /** Start the root collapsed (and don't load it until first expanded). */
  defaultCollapsed?: boolean;
  /** Per-section hidden-files toggle, owned by the sidebar section. */
  showHidden: boolean;
  /** Per-section refresh token; bumping it reloads this root and its open dirs. */
  refreshToken: number;
  /** Stable id for the keyboard-nav registry (connId + rootPath). */
  rootId: string;
  /** Sidebar order, so ↑/↓ cross roots in the on-screen sequence. */
  order: number;
}) {
  const selected = useAppStore((s) => s.selected);
  const selection = useAppStore((s) => s.selection);
  const renaming = useAppStore((s) => s.renaming);
  const setSelected = useAppStore((s) => s.setSelected);
  const toggleSelected = useAppStore((s) => s.toggleSelected);
  const setSelection = useAppStore((s) => s.setSelection);
  const openContextMenu = useAppStore((s) => s.openContextMenu);
  const cancelRename = useAppStore((s) => s.cancelRename);
  const markRefreshed = useAppStore((s) => s.markRefreshed);

  const [collapsed, setCollapsedRaw] = useState<boolean>(
    () => loadCollapsedMap()[stableRootKey(connId, rootPath)] ?? defaultCollapsed ?? false,
  );
  const setCollapsed = useCallback(
    (v: boolean | ((c: boolean) => boolean)) => {
      setCollapsedRaw((prev) => {
        const next = typeof v === "function" ? v(prev) : v;
        saveCollapsed(stableRootKey(connId, rootPath), next);
        return next;
      });
    },
    [connId, rootPath],
  );
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  // In-host drag/drop: the Move/Copy/Cancel popup, and the root-header highlight.
  const [dropMenu, setDropMenu] = useState<{
    x: number;
    y: number;
    destDir: string;
    destName: string;
    nodes: DragItem[];
  } | null>(null);
  const [dropOverRoot, setDropOverRoot] = useState(false);

  // Record the drag set on drag start: the whole selection if this row is part
  // of it (same host), else just this row.
  const startNodeDrag = useCallback(
    (entry: FileEntry) => {
      const sel = useAppStore.getState().selection;
      const inSel = sel.some((n) => n.connId === connId && n.path === entry.path);
      const set: DragItem[] =
        inSel && sel.length
          ? sel
              .filter((n) => n.connId === connId)
              .map((n) => ({ connId, path: n.path, name: n.name, isDir: n.isDir }))
          : [{ connId, path: entry.path, name: entry.name, isDir: entry.isDir }];
      setTreeDrag(set);
    },
    [connId],
  );
  // The root's own metadata, so its header tip shows the same file info as
  // every row (path + mode/ownership + date). Best-effort; path-only until it
  // arrives.
  const [rootMeta, setRootMeta] = useState<FileEntry | null>(null);
  useEffect(() => {
    let live = true;
    fsEntryMeta(connId, rootPath)
      .then((m) => {
        if (live) setRootMeta(m);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [connId, rootPath]);
  // Expansion persists per host+root and is reloaded (dirs re-listed) on
  // mount — remembered folders come back open across restarts/reconnects.
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(loadExpanded(EXPLORER_EXPANSION, stableRootKey(connId, rootPath))),
  );
  const restoredExpansion = useRef(false);

  const openRepoFromExplorer = useVcsStore((s) => s.openRepoFromExplorer);
  const askConfirm = useVcsStore((s) => s.askConfirm);
  // "Tracked" = a Source Control card covers this folder (its root, or a pin
  // inside one). A pin that merely CONTAINS a repo deeper down stays gray.
  const repoTracked = useVcsStore(
    (s) => findRepoContaining(s.repos, connId, rootPath) !== undefined,
  );
  // Tracked pins take the repo's color (default green; editable on the card).
  const rootRepoColor = useVcsStore((s) =>
    repoColorForPath(s.repos, connId, rootPath, "within"),
  );

  const loadDir = useCallback(
    async (path: string) => {
      setDirs((prev) => ({
        ...prev,
        [path]: { entries: prev[path]?.entries ?? null, loading: true, error: null },
      }));
      try {
        // 10s backstop so a hung listing (dead share, removed folder holding a
        // lock, unresponsive host) can't spin forever.
        const listing = await Promise.race([
          fsListDir(connId, path),
          new Promise<never>((_, reject) =>
            window.setTimeout(
              () => reject(new Error("timed out after 10 s")),
              10_000,
            ),
          ),
        ]);
        setDirs((prev) => ({
          ...prev,
          [path]: { entries: listing.entries, loading: false, error: null },
        }));
      } catch (error) {
        setDirs((prev) => ({
          ...prev,
          [path]: { entries: null, loading: false, error: String(error) },
        }));
      }
    },
    [connId],
  );

  useEffect(() => {
    setDirs({});
    setExpanded(
      new Set(loadExpanded(EXPLORER_EXPANSION, stableRootKey(connId, rootPath))),
    );
    restoredExpansion.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath, connId]);

  // Persist expansion as it changes (cheap: a small array per root).
  useEffect(() => {
    saveExpanded(EXPLORER_EXPANSION, stableRootKey(connId, rootPath), expanded);
  }, [expanded, connId, rootPath]);

  // Load the remembered-open dirs once the root is visible (all levels — the
  // set holds absolute paths, so nested dirs list in the same sweep).
  useEffect(() => {
    if (collapsed || restoredExpansion.current) return;
    restoredExpansion.current = true;
    expanded.forEach((p) => void loadDir(p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed]);

  // Lazily load the root's children the first time it's expanded. A collapsed
  // root does no I/O until you open it — which matters for slow roots (network
  // shares, WSL paths) the user hasn't asked to browse yet.
  useEffect(() => {
    if (collapsed) return;
    const state = dirs[rootPath];
    // `error` must stop the effect too — otherwise a failed listing (deleted
    // folder, dead host) re-loads immediately and forever, so the
    // "unavailable + Retry" row never gets a frame to render.
    if (state?.entries || state?.loading || state?.error) return;
    void loadDir(rootPath).then(() => markRefreshed(connId));
  }, [collapsed, rootPath, dirs, loadDir, markRefreshed, connId]);

  useEffect(() => {
    if (refreshToken === 0) return;
    void loadDir(rootPath).then(() => markRefreshed(connId));
    expanded.forEach((path) => void loadDir(path));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  const toggleDir = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          void loadDir(path);
        }
        return next;
      });
    },
    [loadDir],
  );

  // Expand/collapse used by keyboard navigation. The root itself collapses via
  // its header (`collapsed`); descendants via the `expanded` set.
  const expand = useCallback(
    (path: string) => {
      if (path === rootPath) {
        setCollapsed(false);
        return;
      }
      setExpanded((prev) => {
        if (prev.has(path)) return prev;
        const next = new Set(prev);
        next.add(path);
        void loadDir(path);
        return next;
      });
    },
    [rootPath, loadDir],
  );
  const collapse = useCallback(
    (path: string) => {
      if (path === rootPath) {
        setCollapsed(true);
        return;
      }
      setExpanded((prev) => {
        if (!prev.has(path)) return prev;
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    },
    [rootPath],
  );

  // Flatten the visible tree (root row first, then expanded descendants) for the
  // shared keyboard-nav registry. Depth is internal to nav, not the render.
  const navRows = useMemo<TreeRow[]>(() => {
    const root: TreeRow = {
      connId,
      rootId,
      path: rootPath,
      name: label,
      isDir: true,
      depth: 0,
      expanded: !collapsed,
      parentPath: null,
    };
    if (collapsed) return [root];
    const out: TreeRow[] = [root];
    const walk = (path: string, depth: number) => {
      const entries = dirs[path]?.entries;
      if (!entries) return;
      const visible = showHidden
        ? entries
        : entries.filter((e) => !e.name.startsWith("."));
      for (const e of visible) {
        out.push({
          connId,
          rootId,
          path: e.path,
          name: e.name,
          isDir: e.isDir,
          depth,
          expanded: expanded.has(e.path),
          parentPath: path,
        });
        if (e.isDir && expanded.has(e.path)) walk(e.path, depth + 1);
      }
    };
    walk(rootPath, 1);
    return out;
  }, [connId, rootId, rootPath, label, collapsed, dirs, expanded, showHidden]);

  useEffect(() => {
    registerTreeRoot(rootId, { order, expand, collapse });
    return () => unregisterTreeRoot(rootId);
  }, [rootId, order, expand, collapse]);

  useEffect(() => {
    updateTreeRows(rootId, navRows);
  }, [rootId, navRows]);

  // Esc dismisses the drag-drop Move/Copy popup (backdrop click does too).
  useEffect(() => {
    if (!dropMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDropMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dropMenu]);

  const rootSelected =
    selected?.connId === connId && selected?.path === rootPath;
  const headerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (rootSelected) headerRef.current?.scrollIntoView({ block: "nearest" });
  }, [rootSelected]);

  const renderDir = (path: string, depth: number): ReactNode[] => {
    const state = dirs[path];
    if (!state?.entries) return [];
    const visible = showHidden
      ? state.entries
      : state.entries.filter((entry) => !entry.name.startsWith("."));

    const rows: ReactNode[] = [];
    for (const entry of visible) {
      const isExpanded = expanded.has(entry.path);
      rows.push(
        <FileNode
          key={entry.path}
          connId={connId}
          entry={entry}
          depth={depth}
          expanded={isExpanded}
          loading={dirs[entry.path]?.loading ?? false}
          active={selection.some(
            (n) => n.connId === connId && n.path === entry.path,
          )}
          renaming={
            renaming?.connId === connId && renaming?.path === entry.path
          }
          onToggle={() => toggleDir(entry.path)}
          onOpen={(opts) => void openRemoteFile(connId, entry, opts)}
          onSelect={(mods) => {
            const node = {
              connId,
              path: entry.path,
              name: entry.name,
              isDir: entry.isDir,
            };
            if (mods.shift) {
              const anchor = selected?.connId === connId ? selected.path : null;
              const range = selectionRange(connId, anchor, entry.path).map((r) => ({
                connId: r.connId,
                path: r.path,
                name: r.name,
                isDir: r.isDir,
              }));
              if (range.length) setSelection(range, node);
              else setSelected(node);
            } else if (mods.ctrl) {
              toggleSelected(node);
            } else {
              setSelected(node);
            }
          }}
          onContextMenu={(x, y) =>
            openContextMenu(
              {
                connId,
                path: entry.path,
                name: entry.name,
                isDir: entry.isDir,
              },
              x,
              y,
            )
          }
          onCommitRename={(name) => void commitRename(connId, entry.path, name)}
          onCancelRename={() => cancelRename()}
          onDragStartNode={() => startNodeDrag(entry)}
          onDropInto={(x, y) =>
            setDropMenu({
              x,
              y,
              destDir: entry.path,
              destName: entry.name,
              nodes: getTreeDrag(),
            })
          }
        />,
      );
      if (entry.isDir && isExpanded) {
        rows.push(...renderDir(entry.path, depth + 1));
      }
    }
    return rows;
  };

  const rootState = dirs[rootPath];

  return (
    <div className="root-tree">
      <div
        ref={headerRef}
        className={`root-tree__header ${rootSelected ? "root-tree__header--active" : ""} ${
          dropOverRoot ? "root-tree__header--dropinto" : ""
        }`}
        onClick={() => {
          setSelected({ connId, path: rootPath, name: label, isDir: true });
          setCollapsed((c) => !c);
        }}
        onDragOver={(e) => {
          if (canDropInto(connId, rootPath)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (!dropOverRoot) setDropOverRoot(true);
          } else {
            e.dataTransfer.dropEffect = "none";
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropOverRoot(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDropOverRoot(false);
          if (canDropInto(connId, rootPath)) {
            setDropMenu({
              x: e.clientX,
              y: e.clientY,
              destDir: rootPath,
              destName: label,
              nodes: getTreeDrag(),
            });
          }
        }}
      >
        <span
          className={`root-tree__twisty ${collapsed ? "" : "root-tree__twisty--open"}`}
        >
          <IconChevron size={14} />
        </span>
        <Tip label={rootMeta ? entryTooltip(rootMeta) : rootPath}>
          <span
            className="root-tree__label"
            style={rootRepoColor ? { color: rootRepoColor } : undefined}
          >
            {label}
          </span>
        </Tip>
        <Tip
          label={
            repoTracked
              ? "In Source Control — open the panel"
              : "Add to Source Control"
          }
        >
          <button
            className={`root-tree__remove root-tree__vcs ${repoTracked ? "root-tree__vcs--tracked" : ""}`}
            style={rootRepoColor ? { color: rootRepoColor } : undefined}
            onClick={(event) => {
              event.stopPropagation();
              openRepoFromExplorer(connId, rootPath);
            }}
          >
            <IconBranch size={13} />
          </button>
        </Tip>
        {removable && (
          <Tip label="Remove from sidebar">
            <button
              className="root-tree__remove"
              onClick={(event) => {
                event.stopPropagation();
                askConfirm(
                  "Unpin folder?",
                  `Remove "${label}" from the sidebar? Nothing on disk is touched — you can pin it again any time.`,
                  () => onRemove?.(),
                  "unpin-folder",
                );
              }}
            >
              <IconClose size={13} />
            </button>
          </Tip>
        )}
      </div>

      {!collapsed && (
        <div className="root-tree__body">
          {!rootState || (rootState.loading && !rootState.entries) ? (
            <div className="filetree__message">
              <span className="spinner spinner--sm" /> Loading…
            </div>
          ) : rootState.error ? (
            <div className="filetree__message filetree__message--stack">
              <span>Folder unavailable — it may have been removed, or the host
              isn't responding. Refresh (F5) to try again.</span>
              <span className="filetree__error-detail">{rootState.error}</span>
            </div>
          ) : (
            renderDir(rootPath, 0)
          )}
        </div>
      )}

      {dropMenu && (
        <>
          <div
            className="drop-menu__backdrop"
            onMouseDown={() => setDropMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setDropMenu(null);
            }}
          />
          <div className="context-menu" style={{ left: dropMenu.x, top: dropMenu.y }}>
            <div className="context-menu__head">
              Into “{dropMenu.destName}”
            </div>
            <button
              className="context-menu__item"
              onClick={() => {
                const m = dropMenu;
                setDropMenu(null);
                void dropIntoDir("move", connId, m.nodes, m.destDir);
              }}
            >
              Move here
              {dropMenu.nodes.length > 1 && ` (${dropMenu.nodes.length})`}
            </button>
            <button
              className="context-menu__item"
              onClick={() => {
                const m = dropMenu;
                setDropMenu(null);
                void dropIntoDir("copy", connId, m.nodes, m.destDir);
              }}
            >
              Copy here
              {dropMenu.nodes.length > 1 && ` (${dropMenu.nodes.length})`}
            </button>
            <div className="context-menu__sep" />
            <button className="context-menu__item" onClick={() => setDropMenu(null)}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
