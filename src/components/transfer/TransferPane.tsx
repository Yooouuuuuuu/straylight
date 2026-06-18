/** One side of the transfer panel: a connection's tree. Rows are draggable and
 *  folders are drop targets; Ctrl+C / Ctrl+V copy between panes; Ctrl/Shift click
 *  multi-select; and a right-click menu offers the explorer's file operations
 *  (Cut is locked — transfers are copy-only; Rename / Copy Path lock when more
 *  than one item is selected). Selection is local (files don't open here). */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { commitRename, copyPath } from "../../lib/fileOps";
import { dirname } from "../../lib/format";
import { fsListDir, type FileEntry } from "../../lib/ipc";
import {
  getDragItems,
  getTransferClipboard,
  setDragItems,
  setTransferClipboard,
  type DragItem,
} from "../../lib/transferDrag";
import { useAppStore } from "../../store/appStore";
import { RenameInput } from "../filetree/FileNode";
import { FileIcon } from "../filetree/FileIcons";
import { IconChevron } from "../icons";

interface DirState {
  entries: FileEntry[] | null;
  loading: boolean;
  error: string | null;
}

interface Menu {
  x: number;
  y: number;
  entry: FileEntry | null;
}

export function TransferPane({
  connId,
  rootPath,
  label,
  color,
  onDropInto,
}: {
  connId: string;
  /** Pass "" to resolve to the connection's home/root. */
  rootPath: string;
  label: string;
  color?: string;
  onDropInto: (items: DragItem[], destDir: string) => void;
}) {
  const renaming = useAppStore((s) => s.renaming);
  const openNewEntry = useAppStore((s) => s.openNewEntry);
  const openConfirmDelete = useAppStore((s) => s.openConfirmDelete);
  const startRename = useAppStore((s) => s.startRename);
  const cancelRename = useAppStore((s) => s.cancelRename);
  const refreshToken = useAppStore((s) =>
    connId === s.localConnId
      ? s.refreshTokenLocal
      : connId === s.wsl?.connId
        ? s.refreshTokenWsl
        : connId === s.remote?.connId
          ? s.refreshTokenRemote
          : 0,
  );

  const [root, setRoot] = useState<string | null>(null);
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<FileEntry | null>(null);
  const [selection, setSelection] = useState<FileEntry[]>([]);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const toItem = (e: FileEntry): DragItem => ({
    connId,
    path: e.path,
    name: e.name,
    isDir: e.isDir,
  });

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
      } catch (e) {
        setDirs((prev) => ({
          ...prev,
          [path]: { entries: null, loading: false, error: String(e) },
        }));
      }
    },
    [connId],
  );

  useEffect(() => {
    let active = true;
    fsListDir(connId, rootPath)
      .then((listing) => {
        if (!active) return;
        setRoot(listing.path);
        setDirs({
          [listing.path]: { entries: listing.entries, loading: false, error: null },
        });
        setExpanded(new Set([listing.path]));
        setSelection([]);
        setAnchor(null);
      })
      .catch(() => {
        if (active) setRoot("");
      });
    return () => {
      active = false;
    };
  }, [connId, rootPath]);

  useEffect(() => {
    if (refreshToken === 0 || !root) return;
    void loadDir(root);
    expanded.forEach((p) => void loadDir(p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    const t = window.setTimeout(() => {
      window.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        void loadDir(path);
      }
      return next;
    });

  // Flat list of visible rows, for Shift-click range selection.
  const visibleRows = useCallback((): FileEntry[] => {
    const out: FileEntry[] = [];
    const walk = (path: string) => {
      const entries = dirs[path]?.entries;
      if (!entries) return;
      for (const e of entries) {
        out.push(e);
        if (e.isDir && expanded.has(e.path)) walk(e.path);
      }
    };
    if (root) walk(root);
    return out;
  }, [dirs, expanded, root]);

  const isSelected = (e: FileEntry) => selection.some((s) => s.path === e.path);

  const select = (e: FileEntry, mods: { ctrl: boolean; shift: boolean }) => {
    if (mods.shift && anchor) {
      const rows = visibleRows();
      const i = rows.findIndex((r) => r.path === anchor.path);
      const j = rows.findIndex((r) => r.path === e.path);
      if (i >= 0 && j >= 0) {
        const [lo, hi] = i <= j ? [i, j] : [j, i];
        setSelection(rows.slice(lo, hi + 1));
        return;
      }
    }
    if (mods.ctrl) {
      setSelection((prev) =>
        prev.some((s) => s.path === e.path)
          ? prev.filter((s) => s.path !== e.path)
          : [...prev, e],
      );
      setAnchor(e);
      return;
    }
    setSelection([e]);
    setAnchor(e);
  };

  const fromOther = () => {
    const items = getDragItems();
    return items.length > 0 && items[0].connId !== connId;
  };

  const drop = (destDir: string) => {
    const items = getDragItems();
    setDropTarget(null);
    if (items.length && items[0].connId !== connId) onDropInto(items, destDir);
  };

  const targetDir = (entry: FileEntry | null) =>
    entry ? (entry.isDir ? entry.path : dirname(entry.path)) : (root ?? "");

  const clip = getTransferClipboard();
  const canPaste = clip.length > 0 && clip[0].connId !== connId;

  const paste = (entry: FileEntry | null) => {
    if (canPaste && root) onDropInto(clip, targetDir(entry));
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    const k = event.key.toLowerCase();
    if (k === "c" && selection.length) {
      setTransferClipboard(selection.map(toItem));
      event.preventDefault();
    } else if (k === "v") {
      paste(anchor);
      event.preventDefault();
    }
  };

  const onDragStartRow = (e: FileEntry, ev: React.DragEvent) => {
    const items =
      isSelected(e) && selection.length > 1 ? selection.map(toItem) : [toItem(e)];
    if (!isSelected(e)) {
      setSelection([e]);
      setAnchor(e);
    }
    setDragItems(items);
    ev.dataTransfer.effectAllowed = "copy";
    ev.dataTransfer.setData("text/plain", e.path);
  };

  const renderDir = (path: string, depth: number): ReactNode[] => {
    const entries = dirs[path]?.entries;
    if (!entries) return [];
    const rows: ReactNode[] = [];
    for (const e of entries) {
      const isExp = expanded.has(e.path);
      const isRenaming =
        renaming?.connId === connId && renaming?.path === e.path;
      rows.push(
        <div
          key={e.path}
          className={`transfer-row${isSelected(e) ? " transfer-row--active" : ""}${
            dropTarget === e.path ? " transfer-row--drop" : ""
          }`}
          style={{ paddingLeft: 6 + depth * 14 }}
          draggable={!isRenaming}
          onDragStart={(ev) => onDragStartRow(e, ev)}
          onDragEnd={() => setDragItems([])}
          onClick={
            isRenaming
              ? undefined
              : (ev) => {
                  const mods = {
                    ctrl: ev.ctrlKey || ev.metaKey,
                    shift: ev.shiftKey,
                  };
                  select(e, mods);
                  if (!mods.ctrl && !mods.shift && e.isDir) toggle(e.path);
                }
          }
          onContextMenu={(ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            if (!isSelected(e)) {
              setSelection([e]);
              setAnchor(e);
            }
            setMenu({ x: ev.clientX, y: ev.clientY, entry: e });
          }}
          onDragOver={
            e.isDir
              ? (ev) => {
                  if (fromOther()) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    ev.dataTransfer.dropEffect = "copy";
                    setDropTarget(e.path);
                  }
                }
              : undefined
          }
          onDragLeave={
            e.isDir ? () => setDropTarget((t) => (t === e.path ? null : t)) : undefined
          }
          onDrop={
            e.isDir
              ? (ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  drop(e.path);
                }
              : undefined
          }
        >
          <span
            className={`transfer-twisty${
              e.isDir
                ? isExp
                  ? " transfer-twisty--open"
                  : ""
                : " transfer-twisty--leaf"
            }`}
          >
            {e.isDir ? <IconChevron size={13} /> : null}
          </span>
          <span className="transfer-icon">
            <FileIcon name={e.name} isDir={e.isDir} isOpen={isExp} />
          </span>
          {isRenaming ? (
            <RenameInput
              initial={e.name}
              onCommit={(name) => void commitRename(connId, e.path, name)}
              onCancel={() => cancelRename()}
            />
          ) : (
            <span className="transfer-name">{e.name}</span>
          )}
        </div>,
      );
      if (e.isDir && isExp) rows.push(...renderDir(e.path, depth + 1));
    }
    return rows;
  };

  const rootState = root ? dirs[root] : null;
  const multi = selection.length > 1;

  return (
    <div
      className={`transfer-pane${dropTarget === root ? " transfer-pane--drop" : ""}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onContextMenu={(ev) => {
        ev.preventDefault();
        setMenu({ x: ev.clientX, y: ev.clientY, entry: null });
      }}
      onDragOver={(ev) => {
        if (fromOther() && root) {
          ev.preventDefault();
          ev.dataTransfer.dropEffect = "copy";
          setDropTarget(root);
        }
      }}
      onDragLeave={() => setDropTarget((t) => (t === root ? null : t))}
      onDrop={(ev) => {
        ev.preventDefault();
        if (root) drop(root);
      }}
    >
      <div className="transfer-pane__head" style={color ? { color } : undefined}>
        {label}
      </div>
      <div className="transfer-pane__body">
        {!root || !rootState || (rootState.loading && !rootState.entries) ? (
          <div className="transfer-msg">
            <span className="spinner spinner--sm" /> Loading…
          </div>
        ) : rootState.error ? (
          <div className="transfer-msg">{rootState.error}</div>
        ) : (
          renderDir(root, 0)
        )}
      </div>

      {menu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 200),
            top: Math.min(menu.y, window.innerHeight - 260),
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            className="context-menu__item"
            onClick={() => {
              setMenu(null);
              openNewEntry(connId, targetDir(menu.entry), false);
            }}
          >
            New File
          </button>
          <button
            className="context-menu__item"
            onClick={() => {
              setMenu(null);
              openNewEntry(connId, targetDir(menu.entry), true);
            }}
          >
            New Folder
          </button>
          {menu.entry ? (
            <>
              <div className="context-menu__sep" />
              <button
                className="context-menu__item"
                disabled
                title="Cut isn't available for transfers — copy only"
              >
                Cut<span className="context-menu__key">Ctrl+X</span>
              </button>
              <button
                className="context-menu__item"
                onClick={() => {
                  setMenu(null);
                  setTransferClipboard(
                    selection.length ? selection.map(toItem) : [toItem(menu.entry!)],
                  );
                }}
              >
                Copy{multi ? ` (${selection.length})` : ""}
                <span className="context-menu__key">Ctrl+C</span>
              </button>
              <button
                className="context-menu__item"
                disabled={!canPaste}
                onClick={() => {
                  const entry = menu.entry;
                  setMenu(null);
                  paste(entry);
                }}
              >
                Paste<span className="context-menu__key">Ctrl+V</span>
              </button>
              <div className="context-menu__sep" />
              <button
                className="context-menu__item"
                disabled={multi}
                title={multi ? "Rename works on one item at a time" : undefined}
                onClick={() => {
                  const e = menu.entry!;
                  setMenu(null);
                  startRename(connId, e.path);
                }}
              >
                Rename<span className="context-menu__key">F2</span>
              </button>
              <button
                className="context-menu__item context-menu__item--danger"
                onClick={() => {
                  const e = menu.entry!;
                  setMenu(null);
                  openConfirmDelete(
                    selection.length
                      ? selection.map((s) => ({
                          connId,
                          path: s.path,
                          name: s.name,
                          isDir: s.isDir,
                        }))
                      : [{ connId, path: e.path, name: e.name, isDir: e.isDir }],
                  );
                }}
              >
                Delete{multi ? ` (${selection.length})` : ""}
                <span className="context-menu__key">Del</span>
              </button>
              <div className="context-menu__sep" />
              <button
                className="context-menu__item"
                disabled={multi}
                title={multi ? "Copy Path works on one item at a time" : undefined}
                onClick={() => {
                  const e = menu.entry!;
                  setMenu(null);
                  void copyPath(e.path);
                }}
              >
                Copy Path
              </button>
            </>
          ) : (
            <>
              <div className="context-menu__sep" />
              <button
                className="context-menu__item"
                disabled={!canPaste}
                onClick={() => {
                  setMenu(null);
                  paste(null);
                }}
              >
                Paste<span className="context-menu__key">Ctrl+V</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
