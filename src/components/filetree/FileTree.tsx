/** Remote file tree. Lazily lists directories over SFTP, caches listings per
 *  session, and re-fetches on refresh or folder re-expansion (per spec). */
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { sftpListDir, type FileEntry } from "../../lib/ipc";
import { openRemoteFile } from "../../lib/openFile";
import { useAppStore } from "../../store/appStore";
import { FileNode } from "./FileNode";

interface DirState {
  entries: FileEntry[] | null;
  loading: boolean;
  error: string | null;
}

export function FileTree() {
  const connection = useAppStore((s) => s.connection);
  const rootPath = useAppStore((s) => s.rootPath);
  const showHidden = useAppStore((s) => s.showHidden);
  const refreshToken = useAppStore((s) => s.treeRefreshToken);
  const openFilePath = useAppStore((s) => s.openFile?.path ?? null);

  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const connId = connection?.connId ?? null;

  const loadDir = useCallback(
    async (path: string) => {
      if (!connId) return;
      setDirs((prev) => ({
        ...prev,
        [path]: { entries: prev[path]?.entries ?? null, loading: true, error: null },
      }));
      try {
        const listing = await sftpListDir(connId, path);
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

  // (Re)load the root when the connection or root path changes.
  useEffect(() => {
    setDirs({});
    setExpanded(new Set());
    if (rootPath) void loadDir(rootPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath, connId]);

  // Refresh: reload the root and every currently-expanded directory.
  useEffect(() => {
    if (refreshToken === 0 || !rootPath) return;
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
          // Re-fetch on (re-)expand so the listing stays fresh.
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
          active={openFilePath === entry.path}
          onToggle={() => toggleDir(entry.path)}
          onOpen={() => {
            if (connId) void openRemoteFile(connId, entry);
          }}
        />,
      );
      if (entry.isDir && isExpanded) {
        rows.push(...renderDir(entry.path, depth + 1));
      }
    }
    return rows;
  };

  if (!rootPath) {
    return (
      <div className="filetree__message">
        <span className="spinner" /> Resolving home directory…
      </div>
    );
  }

  const rootState = dirs[rootPath];

  if (!rootState || (rootState.loading && !rootState.entries)) {
    return (
      <div className="filetree__message">
        <span className="spinner" /> Loading files…
      </div>
    );
  }

  if (rootState.error) {
    return <div className="filetree__message">Failed to load: {rootState.error}</div>;
  }

  return <div className="filetree">{renderDir(rootPath, 0)}</div>;
}
