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

import { commitRename } from "../../lib/fileOps";
import { fsListDir, type FileEntry } from "../../lib/ipc";
import { openRemoteFile } from "../../lib/openFile";
import {
  registerTreeRoot,
  unregisterTreeRoot,
  updateTreeRows,
  type TreeRow,
} from "../../lib/treeNav";
import { useAppStore } from "../../store/appStore";
import { FileNode } from "./FileNode";
import { IconChevron, IconClose } from "../icons";

interface DirState {
  entries: FileEntry[] | null;
  loading: boolean;
  error: string | null;
}

export function RootTree({
  connId,
  rootPath,
  label,
  color,
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
  color?: string;
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
  const renaming = useAppStore((s) => s.renaming);
  const setSelected = useAppStore((s) => s.setSelected);
  const openContextMenu = useAppStore((s) => s.openContextMenu);
  const cancelRename = useAppStore((s) => s.cancelRename);
  const markRefreshed = useAppStore((s) => s.markRefreshed);

  const [collapsed, setCollapsed] = useState(defaultCollapsed ?? false);
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const loadDir = useCallback(
    async (path: string) => {
      setDirs((prev) => ({
        ...prev,
        [path]: { entries: prev[path]?.entries ?? null, loading: true, error: null },
      }));
      try {
        const listing = await fsListDir(connId, path);
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
    setExpanded(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath, connId]);

  // Lazily load the root's children the first time it's expanded. A collapsed
  // root does no I/O until you open it — which matters for slow roots (network
  // shares, WSL paths) the user hasn't asked to browse yet.
  useEffect(() => {
    if (collapsed) return;
    const state = dirs[rootPath];
    if (state?.entries || state?.loading) return;
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
          entry={entry}
          depth={depth}
          expanded={isExpanded}
          loading={dirs[entry.path]?.loading ?? false}
          active={selected?.connId === connId && selected?.path === entry.path}
          renaming={
            renaming?.connId === connId && renaming?.path === entry.path
          }
          onToggle={() => toggleDir(entry.path)}
          onOpen={() => void openRemoteFile(connId, entry)}
          onSelect={() =>
            setSelected({
              connId,
              path: entry.path,
              name: entry.name,
              isDir: entry.isDir,
            })
          }
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
        className={`root-tree__header ${rootSelected ? "root-tree__header--active" : ""}`}
        onClick={() => {
          setSelected({ connId, path: rootPath, name: label, isDir: true });
          setCollapsed((c) => !c);
        }}
        title={rootPath}
      >
        <span
          className={`root-tree__twisty ${collapsed ? "" : "root-tree__twisty--open"}`}
        >
          <IconChevron size={14} />
        </span>
        <span className="root-tree__label" style={color ? { color } : undefined}>
          {label}
        </span>
        {removable && (
          <button
            className="root-tree__remove"
            title="Remove from sidebar"
            onClick={(event) => {
              event.stopPropagation();
              onRemove?.();
            }}
          >
            <IconClose size={13} />
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="root-tree__body">
          {!rootState || (rootState.loading && !rootState.entries) ? (
            <div className="filetree__message">
              <span className="spinner spinner--sm" /> Loading…
            </div>
          ) : rootState.error ? (
            <div className="filetree__message">{rootState.error}</div>
          ) : (
            renderDir(rootPath, 0)
          )}
        </div>
      )}
    </div>
  );
}
