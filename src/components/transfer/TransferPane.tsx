/** One side of the transfer panel: the connection's pinned working dirs, shown
 *  collapsed with hidden files off (toggle in the head). The "+" button opens a
 *  folder for this panel session only — it's NOT pinned in the explorer and is
 *  forgotten when the panel closes. Rows are draggable and folders are drop
 *  targets; Ctrl+C / Ctrl+V copy between panes; Ctrl/Shift click multi-select;
 *  right-click offers the file operations (Cut locked — transfers are copy-only;
 *  Rename / Delete are off for the root rows). Selection is local (files don't
 *  open here). */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { commitRename, copyPath } from "../../lib/fileOps";
import { basename, dirname } from "../../lib/format";
import { fsListDir, type FileEntry } from "../../lib/ipc";
import {
  getDragItems,
  getTransferClipboard,
  setDragItems,
  setTransferClipboard,
  type DragItem,
} from "../../lib/transferDrag";
import { useAppStore } from "../../store/appStore";
import { FolderBrowser } from "../FolderBrowser";
import { RenameInput } from "../filetree/FileNode";
import { FileIcon } from "../filetree/FileIcons";
import { IconChevron, IconEye, IconEyeOff, IconPlus } from "../icons";

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
  roots,
  label,
  color,
  onDropInto,
}: {
  connId: string;
  /** The connection's pinned working dirs (absolute paths). */
  roots: string[];
  label: string;
  color?: string;
  onDropInto: (items: DragItem[], destDir: string) => void;
}) {
  const localConnId = useAppStore((s) => s.localConnId);
  const renaming = useAppStore((s) => s.renaming);
  const openNewEntry = useAppStore((s) => s.openNewEntry);
  const openConfirmDelete = useAppStore((s) => s.openConfirmDelete);
  const openProperties = useAppStore((s) => s.openProperties);
  const startRename = useAppStore((s) => s.startRename);
  const cancelRename = useAppStore((s) => s.cancelRename);
  const refreshToken = useAppStore(
    (s) =>
      connId === s.localConnId
        ? s.refreshTokenLocal
        : (s.wsls.find((w) => w.conn.connId === connId)?.refreshToken ??
          s.remotes.find((r) => r.conn.connId === connId)?.refreshToken ??
          0), // (remotes covered per-conn too — not just the primary)
  );

  // Dirs added via the "+" button — one-off, not pinned in the explorer or kept.
  const [extraRoots, setExtraRoots] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<FileEntry | null>(null);
  const [selection, setSelection] = useState<FileEntry[]>([]);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Spring-loaded folders: hovering a collapsed dir during a drag expands it.
  const springTimer = useRef<number | null>(null);
  const springPath = useRef<string | null>(null);

  const allRoots = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of [...roots, ...extraRoots]) {
      if (!seen.has(r)) {
        seen.add(r);
        out.push(r);
      }
    }
    return out;
  }, [roots, extraRoots]);

  const isRoot = (path: string) => allRoots.includes(path);

  const toItem = (e: FileEntry): DragItem => ({
    connId,
    path: e.path,
    name: e.name,
    isDir: e.isDir,
  });

  // A pinned/extra root rendered as a top-level folder row.
  const rootEntry = (path: string): FileEntry => ({
    name: basename(path) || path,
    path,
    size: 0,
    isDir: true,
    isSymlink: false,
    symlinkTarget: null,
    permissions: "",
    owner: "",
    group: "",
    modified: 0,
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

  // Reset when the connection changes (the panel is reused across pairs).
  useEffect(() => {
    setExtraRoots([]);
    setExpanded(new Set());
    setDirs({});
    setSelection([]);
    setAnchor(null);
  }, [connId]);

  useEffect(() => {
    if (refreshToken === 0) return;
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
        if (!dirs[path]?.entries) void loadDir(path);
      }
      return next;
    });

  const addExtraRoot = (path: string) => {
    if (!roots.includes(path)) {
      setExtraRoots((prev) => (prev.includes(path) ? prev : [...prev, path]));
    }
    setExpanded((prev) => new Set(prev).add(path));
    if (!dirs[path]?.entries) void loadDir(path);
    setBrowsing(false);
  };

  const clearSpring = useCallback(() => {
    if (springTimer.current !== null) {
      window.clearTimeout(springTimer.current);
      springTimer.current = null;
    }
    springPath.current = null;
  }, []);

  // Hover a collapsed folder for 0.5s during a drag → expand it, so you can drill
  // in without dropping and re-grabbing.
  const scheduleSpring = (path: string) => {
    if (springPath.current === path) return; // already counting down for this dir
    clearSpring();
    springPath.current = path;
    springTimer.current = window.setTimeout(() => {
      springTimer.current = null;
      springPath.current = null;
      setExpanded((prev) => {
        if (prev.has(path)) return prev;
        const next = new Set(prev);
        next.add(path);
        return next;
      });
      if (!dirs[path]?.entries) void loadDir(path);
    }, 500);
  };

  useEffect(() => clearSpring, [clearSpring]);

  const visibleChildren = useCallback(
    (path: string): FileEntry[] => {
      const entries = dirs[path]?.entries;
      if (!entries) return [];
      return showHidden ? entries : entries.filter((e) => !e.name.startsWith("."));
    },
    [dirs, showHidden],
  );

  // Flat list of visible rows (roots first, then expanded descendants), for
  // Shift-click range selection.
  const visibleRows = useCallback((): FileEntry[] => {
    const out: FileEntry[] = [];
    const walk = (path: string) => {
      for (const e of visibleChildren(path)) {
        out.push(e);
        if (e.isDir && expanded.has(e.path)) walk(e.path);
      }
    };
    for (const r of allRoots) {
      out.push(rootEntry(r));
      if (expanded.has(r)) walk(r);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRoots, expanded, visibleChildren]);

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
    clearSpring();
    setDropTarget(null);
    if (items.length && items[0].connId !== connId) onDropInto(items, destDir);
  };

  const targetDir = (entry: FileEntry | null) =>
    entry ? (entry.isDir ? entry.path : dirname(entry.path)) : (allRoots[0] ?? "");

  const clip = getTransferClipboard();
  const canPaste = clip.length > 0 && clip[0].connId !== connId;

  const paste = (entry: FileEntry | null) => {
    if (canPaste && allRoots.length) onDropInto(clip, targetDir(entry));
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // Don't hijack keys while typing in the rename field.
    const t = event.target as HTMLElement | null;
    if (t?.closest("input, textarea, [contenteditable=true]")) return;

    // F2 / Delete act on THIS pane's selection (not the explorer's). Root rows
    // are pinned-dir views, so they're excluded — manage them in the explorer.
    if (event.key === "F2") {
      if (selection.length === 1 && !isRoot(selection[0].path)) {
        startRename(connId, selection[0].path);
      }
      event.preventDefault();
      return;
    }
    if (event.key === "Delete") {
      const targets = selection.filter((s) => !isRoot(s.path));
      if (targets.length) {
        openConfirmDelete(
          targets.map((s) => ({
            connId,
            path: s.path,
            name: s.name,
            isDir: s.isDir,
          })),
        );
      }
      event.preventDefault();
      return;
    }

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

  const renderRow = (e: FileEntry, depth: number, keyBase: string): ReactNode => {
    const isExp = expanded.has(e.path);
    const isRenaming = renaming?.connId === connId && renaming?.path === e.path;
    // Dropping on a folder drops into it; dropping on a file drops into its
    // parent folder (so there are no "forbidden" dead rows mid-drag).
    const dropDir = e.isDir ? e.path : dirname(e.path);
    return (
      <div
        key={`${keyBase}::${e.path}`}
        className={`transfer-row${isSelected(e) ? " transfer-row--active" : ""}${
          dropTarget === e.path ? " transfer-row--drop" : ""
        }`}
        style={{ paddingLeft: 6 + depth * 14 }}
        draggable={!isRenaming}
        onDragStart={(ev) => onDragStartRow(e, ev)}
        onDragEnd={() => {
          setDragItems([]);
          clearSpring();
        }}
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
        onDragOver={(ev) => {
          if (!fromOther()) return;
          ev.preventDefault();
          ev.stopPropagation();
          ev.dataTransfer.dropEffect = "copy";
          setDropTarget(dropDir);
          if (e.isDir && !expanded.has(e.path)) scheduleSpring(e.path);
          else clearSpring();
        }}
        onDragLeave={() => {
          setDropTarget((t) => (t === dropDir ? null : t));
          if (e.isDir && springPath.current === e.path) clearSpring();
        }}
        onDrop={(ev) => {
          if (!fromOther()) return;
          ev.preventDefault();
          ev.stopPropagation();
          drop(dropDir);
        }}
      >
        <span
          className={`transfer-twisty${
            e.isDir ? (isExp ? " transfer-twisty--open" : "") : " transfer-twisty--leaf"
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
      </div>
    );
  };

  const renderChildren = (path: string, depth: number, keyBase: string): ReactNode[] => {
    const rows: ReactNode[] = [];
    for (const e of visibleChildren(path)) {
      rows.push(renderRow(e, depth, keyBase));
      if (e.isDir && expanded.has(e.path))
        rows.push(...renderChildren(e.path, depth + 1, keyBase));
    }
    return rows;
  };

  // Each row's React key is namespaced by its owning root, so a pinned dir nested
  // under another pinned dir doesn't collide.
  const renderRoot = (path: string): ReactNode[] => {
    const rows: ReactNode[] = [renderRow(rootEntry(path), 0, path)];
    if (!expanded.has(path)) return rows;
    const state = dirs[path];
    if (!state || (state.loading && !state.entries)) {
      rows.push(
        <div key={`${path}::loading`} className="transfer-msg transfer-msg--indent">
          <span className="spinner spinner--sm" /> Loading…
        </div>,
      );
    } else if (state.error) {
      rows.push(
        <div key={`${path}::error`} className="transfer-msg transfer-msg--indent">
          {state.error}
        </div>,
      );
    } else {
      rows.push(...renderChildren(path, 1, path));
    }
    return rows;
  };

  const multi = selection.length > 1;
  const menuOnRoot = menu?.entry ? isRoot(menu.entry.path) : false;

  return (
    <div className="transfer-pane" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="transfer-pane__head">
        <span
          className="transfer-pane__title"
          style={color ? { color } : undefined}
        >
          {label}
        </span>
        <button
          className={`icon-btn ${showHidden ? "icon-btn--active" : ""}`}
          title={showHidden ? "Hide hidden files" : "Show hidden files"}
          onClick={() => setShowHidden((v) => !v)}
        >
          {showHidden ? <IconEye /> : <IconEyeOff />}
        </button>
        <button
          className="icon-btn"
          title="Open a folder (this panel only)"
          onClick={() => setBrowsing(true)}
        >
          <IconPlus />
        </button>
      </div>

      <div
        className="transfer-pane__body"
        onContextMenu={(ev) => {
          ev.preventDefault();
          setMenu({ x: ev.clientX, y: ev.clientY, entry: null });
        }}
        onDragOver={(ev) => {
          // Catch-all so the cursor stays "copy" over gaps, loading rows, and
          // areas revealed by a spring-expand; row handlers stop propagation and
          // set the precise target, so this only runs for the dead space.
          if (fromOther()) {
            ev.preventDefault();
            ev.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={(ev) => {
          if (fromOther() && dropTarget) {
            ev.preventDefault();
            drop(dropTarget);
          }
        }}
      >
        {allRoots.length === 0 ? (
          <div className="transfer-msg">No folders — click + to add one.</div>
        ) : (
          allRoots.flatMap((r) => renderRoot(r))
        )}
      </div>

      {browsing && (
        <FolderBrowser
          connId={connId}
          title={`Open a folder on ${label}`}
          showDrives={connId === localConnId}
          onPick={addExtraRoot}
          onClose={() => setBrowsing(false)}
        />
      )}

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
                disabled={multi || menuOnRoot}
                title={
                  menuOnRoot
                    ? "This is a pinned folder — rename it in its own explorer"
                    : multi
                      ? "Rename works on one item at a time"
                      : undefined
                }
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
                disabled={menuOnRoot}
                title={
                  menuOnRoot ? "This is a pinned folder — delete it from its explorer" : undefined
                }
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
              <div className="context-menu__sep" />
              <button
                className="context-menu__item"
                onClick={() => {
                  const e = menu.entry!;
                  setMenu(null);
                  openProperties(
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
                Properties{multi ? ` (${selection.length})` : ""}
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
