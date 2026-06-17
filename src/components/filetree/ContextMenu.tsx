/** Right-click menu for a file-tree node. Closes on outside click / Escape. */
import { useEffect, useRef } from "react";

import { copyPath, pasteInto } from "../../lib/fileOps";
import { dirname } from "../../lib/format";
import { useAppStore } from "../../store/appStore";

export function ContextMenu() {
  const menu = useAppStore((s) => s.contextMenu);
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);
  const startRename = useAppStore((s) => s.startRename);
  const openNewEntry = useAppStore((s) => s.openNewEntry);
  const openConfirmDelete = useAppStore((s) => s.openConfirmDelete);
  const setClipboard = useAppStore((s) => s.setClipboard);
  const clipboard = useAppStore((s) => s.clipboard);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        closeContextMenu();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeContextMenu();
    };
    const timer = window.setTimeout(() => {
      window.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, closeContextMenu]);

  if (!menu) return null;

  const parent = menu.isDir ? menu.path : dirname(menu.path);
  const node = {
    connId: menu.connId,
    path: menu.path,
    name: menu.name,
    isDir: menu.isDir,
  };
  const left = Math.min(menu.x, window.innerWidth - 196);
  const top = Math.min(menu.y, window.innerHeight - 220);

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left, top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        className="context-menu__item"
        onClick={() => openNewEntry(menu.connId, parent, false)}
      >
        New File
      </button>
      <button
        className="context-menu__item"
        onClick={() => openNewEntry(menu.connId, parent, true)}
      >
        New Folder
      </button>
      <div className="context-menu__sep" />
      <button
        className="context-menu__item"
        onClick={() => {
          setClipboard("cut", node);
          closeContextMenu();
        }}
      >
        Cut<span className="context-menu__key">Ctrl+X</span>
      </button>
      <button
        className="context-menu__item"
        onClick={() => {
          setClipboard("copy", node);
          closeContextMenu();
        }}
      >
        Copy<span className="context-menu__key">Ctrl+C</span>
      </button>
      <button
        className="context-menu__item"
        disabled={!clipboard || clipboard.node.connId !== menu.connId}
        onClick={() => {
          closeContextMenu();
          void pasteInto(menu.connId, parent);
        }}
      >
        Paste<span className="context-menu__key">Ctrl+V</span>
      </button>
      <div className="context-menu__sep" />
      <button
        className="context-menu__item"
        onClick={() => startRename(menu.connId, menu.path)}
      >
        Rename<span className="context-menu__key">F2</span>
      </button>
      <button
        className="context-menu__item context-menu__item--danger"
        onClick={() => openConfirmDelete(node)}
      >
        Delete<span className="context-menu__key">Del</span>
      </button>
      <div className="context-menu__sep" />
      <button
        className="context-menu__item"
        onClick={() => {
          closeContextMenu();
          void copyPath(menu.path);
        }}
      >
        Copy Path
      </button>
    </div>
  );
}
