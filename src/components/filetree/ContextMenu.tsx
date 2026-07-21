/** Right-click menu for a file-tree node. Closes on outside click / Escape. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { copyPath, pasteInto } from "../../lib/fileOps";
import { dirname } from "../../lib/format";
import { fsTransferBatch } from "../../lib/ipc";
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
  const ref = useRef<HTMLDivElement>(null);

  // Clamp against the REAL menu size (it varies — remote items add entries),
  // so a click near the bottom edge never pushes items off screen.
  const [nudge, setNudge] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    setNudge({ x: 0, y: 0 });
    if (!menu) return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setNudge({
      x: Math.min(0, window.innerWidth - 8 - (menu.x + r.width)),
      y: Math.min(0, window.innerHeight - 8 - (menu.y + r.height)),
    });
  }, [menu]);

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
  const left = menu.x + nudge.x;
  const top = menu.y + nudge.y;

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
        disabled={selection.length > 1}
        title={selection.length > 1 ? "Rename works on one item at a time" : undefined}
        onClick={() => startRename(menu.connId, menu.path)}
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
      <div className="context-menu__sep" />
      {menu.connId !== useAppStore.getState().localConnId && (
        <Tip label="Copies to your Downloads folder">
        <button
          className="context-menu__item"
          onClick={() => {
            closeContextMenu();
            const sel = selection.filter((n) => n.connId === menu.connId);
            const paths = sel.length ? sel.map((n) => n.path) : [menu.path];
            void (async () => {
              const store = useAppStore.getState();
              try {
                const { downloadDir } = await import("@tauri-apps/api/path");
                const dest = await downloadDir();
                const outcome = await fsTransferBatch(
                  `dl-${Date.now()}`,
                  menu.connId,
                  paths,
                  store.localConnId!,
                  dest,
                  true,
                );
                const skipped = outcome.skippedLinks
                  ? ` (${outcome.skippedLinks} linked folder${outcome.skippedLinks === 1 ? "" : "s"} skipped)`
                  : "";
                store.pushNotice(
                  "info",
                  `Downloaded ${paths.length} item(s) to Downloads.${skipped}`,
                );
              } catch (e) {
                store.pushNotice("error", `Download failed: ${String(e)}`);
              }
            })();
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
      <div className="context-menu__sep" />
      <button
        className="context-menu__item"
        onClick={() => openProperties(selection.length ? selection : [node])}
      >
        Properties
        {selection.length > 1 && ` (${selection.length})`}
      </button>
    </div>
  );
}
