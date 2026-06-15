/** One root in the sidebar (a pinned local folder, or the remote host). Renders
 *  a collapsible header plus its lazily-loaded tree. Multiple of these stack to
 *  form the multi-root explorer. */
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { commitRename } from "../../lib/fileOps";
import { fsListDir, type FileEntry } from "../../lib/ipc";
import { openRemoteFile } from "../../lib/openFile";
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
}: {
  connId: string;
  rootPath: string;
  label: string;
  color?: string;
  removable?: boolean;
  onRemove?: () => void;
}) {
  const showHidden = useAppStore((s) => s.showHidden);
  const refreshToken = useAppStore((s) => s.treeRefreshToken);
  const selected = useAppStore((s) => s.selected);
  const renaming = useAppStore((s) => s.renaming);
  const setSelected = useAppStore((s) => s.setSelected);
  const openContextMenu = useAppStore((s) => s.openContextMenu);
  const cancelRename = useAppStore((s) => s.cancelRename);

  const [collapsed, setCollapsed] = useState(false);
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
    void loadDir(rootPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath, connId]);

  useEffect(() => {
    if (refreshToken === 0) return;
    void loadDir(rootPath);
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
        className="root-tree__header"
        onClick={() => setCollapsed((c) => !c)}
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
