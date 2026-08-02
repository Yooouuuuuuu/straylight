/** Right-click menu for a file-tree node. Closes on outside click / Escape. */
import { useEffect } from "react";

import {
  clipboardNodes,
  copyPath,
  downloadToLocal,
  pasteInto,
} from "../../lib/fileOps";
import { dirname } from "../../lib/format";
import { revealPath } from "../../lib/ipc";
import { openSessionAt, openTerminalAt } from "../../lib/terminalTarget";
import { useMenuClamp } from "../../hooks/useMenuClamp";
import { useAppStore } from "../../store/appStore";
import { Tip } from "../Tooltip";

export function ContextMenu() {
  const menu = useAppStore((s) => s.contextMenu);
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);
  const startRename = useAppStore((s) => s.startRename);
  const openNewEntry = useAppStore((s) => s.openNewEntry);
  const openConfirmDelete = useAppStore((s) => s.openConfirmDelete);
  const openProperties = useAppStore((s) => s.openProperties);
  const selection = useAppStore((s) => s.selection);
  const setClipboard = useAppStore((s) => s.setClipboard);
  const clipboard = useAppStore((s) => s.clipboard);
  // Anchor at the cursor, measured back on-screen (the menu's height varies —
  // remote items add a Download entry).
  const { ref, left, top } = useMenuClamp(menu?.x ?? 0, menu?.y ?? 0, !!menu);

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
  // A pinned root: no cut/copy/rename/delete (moving or deleting the folder
  // a pin points at strands the pin) — Unpin sits in the danger slot instead.
  const isRoot = !!menu.root;

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
      {!isRoot && (
        <button
          className="context-menu__item"
          onClick={() => {
            setClipboard("cut", clipboardNodes(node));
            closeContextMenu();
          }}
        >
          Cut<span className="context-menu__key">Ctrl+X</span>
        </button>
      )}
      {!isRoot && (
        <button
          className="context-menu__item"
          onClick={() => {
            setClipboard("copy", clipboardNodes(node));
            closeContextMenu();
          }}
        >
          Copy<span className="context-menu__key">Ctrl+C</span>
        </button>
      )}
      <button
        className="context-menu__item"
        disabled={!clipboard || clipboard.nodes[0]?.connId !== menu.connId}
        onClick={() => {
          closeContextMenu();
          void pasteInto(menu.connId, parent);
        }}
      >
        Paste
        {clipboard && clipboard.nodes.length > 1
          ? ` (${clipboard.nodes.length})`
          : ""}
        <span className="context-menu__key">Ctrl+V</span>
      </button>
      {menu.isDir && (
        <>
          <div className="context-menu__sep" />
          <button
            className="context-menu__item"
            onClick={() => {
              closeContextMenu();
              openTerminalAt(menu.connId, menu.path);
            }}
          >
            Open in Terminal
          </button>
          <button
            className="context-menu__item"
            onClick={() => {
              closeContextMenu();
              openSessionAt(menu.connId, menu.path);
            }}
          >
            Open in Session
          </button>
        </>
      )}
      {!isRoot && (
        <>
          <div className="context-menu__sep" />
          <button
            className="context-menu__item"
            disabled={selection.length > 1}
            title={selection.length > 1 ? "Rename works on one item at a time" : undefined}
            onClick={() => startRename(menu.connId, menu.path, "explorer")}
          >
            Rename<span className="context-menu__key">F2</span>
          </button>
          <button
            className="context-menu__item context-menu__item--danger"
            onClick={() => openConfirmDelete(selection.length ? selection : [node])}
          >
            Delete
            {selection.length > 1 && ` (${selection.length})`}
            <span className="context-menu__key">Del</span>
          </button>
        </>
      )}
      <div className="context-menu__sep" />
      {menu.connId !== useAppStore.getState().localConnId && (
        <Tip label="Downloads to your local machine (Preferences → Download folder)">
        <button
          className="context-menu__item"
          onClick={() => {
            closeContextMenu();
            const sel = selection.filter((n) => n.connId === menu.connId);
            const paths = sel.length ? sel.map((n) => n.path) : [menu.path];
            void downloadToLocal(menu.connId, paths);
          }}
        >
          Download{selection.length > 1 && ` (${selection.length})`}
        </button>
        </Tip>
      )}
      <button
        className="context-menu__item"
        disabled={selection.length > 1}
        title={
          selection.length > 1 ? "Copy Path works on one item at a time" : undefined
        }
        onClick={() => {
          closeContextMenu();
          void copyPath(menu.path);
        }}
      >
        Copy Path
      </button>
      {menu.connId === useAppStore.getState().localConnId && (
        <button
          className="context-menu__item"
          onClick={() => {
            closeContextMenu();
            void revealPath(menu.path);
          }}
        >
          Reveal in file manager
        </button>
      )}
      <div className="context-menu__sep" />
      <button
        className="context-menu__item"
        onClick={() => openProperties(selection.length ? selection : [node])}
      >
        Properties
        {selection.length > 1 && ` (${selection.length})`}
      </button>
      {isRoot && menu.unpin && (
        <>
          <div className="context-menu__sep" />
          <button
            className="context-menu__item context-menu__item--danger"
            onClick={() => {
              closeContextMenu();
              menu.unpin?.();
            }}
          >
            Unpin…
          </button>
        </>
      )}
    </div>
  );
}
