/** Right-click menu for editor tabs: close variants (with the shared one-dialog
 *  unsaved check), pin/unpin, and copy path. Pinned tabs are spared by
 *  Others / Right / Saved — only an explicit Close All takes them. */
import { useEffect, useRef } from "react";

import { copyPath } from "../../lib/fileOps";
import {
  closeAllTabs,
  closeOtherTabs,
  closeSavedTabs,
  closeTabsToRight,
} from "../../lib/tabActions";
import { useAppStore } from "../../store/appStore";

export function TabContextMenu() {
  const menu = useAppStore((s) => s.tabMenu);
  const closeTabMenu = useAppStore((s) => s.closeTabMenu);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeTabMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeTabMenu();
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
  }, [menu, closeTabMenu]);

  const tab = useAppStore((s) =>
    s.tabMenu ? s.tabs.find((t) => t.id === s.tabMenu?.tabId) : undefined,
  );
  if (!menu || !tab) return null;

  const left = Math.min(menu.x, window.innerWidth - 196);
  const top = Math.min(menu.y, window.innerHeight - 260);
  const act = (fn: () => void) => () => {
    closeTabMenu();
    fn();
  };
  const store = useAppStore.getState();

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        className="context-menu__item"
        onClick={act(() => store.closeTab(tab.id, true))}
      >
        Close
      </button>
      <button
        className="context-menu__item"
        onClick={act(() => closeOtherTabs(tab.id))}
      >
        Close Others
      </button>
      <button
        className="context-menu__item"
        onClick={act(() => closeTabsToRight(tab.id))}
      >
        Close to the Right
      </button>
      <button className="context-menu__item" onClick={act(closeSavedTabs)}>
        Close Saved
      </button>
      <button className="context-menu__item" onClick={act(closeAllTabs)}>
        Close All
      </button>
      <div className="context-menu__sep" />
      <button
        className="context-menu__item"
        onClick={act(() => store.pinTab(tab.id, !tab.pinned))}
      >
        {tab.pinned ? "Unpin" : "Pin"}
      </button>
      {tab.previewTab && (
        <button
          className="context-menu__item"
          onClick={act(() => store.promoteTab(tab.id))}
        >
          Keep Open
        </button>
      )}
      <div className="context-menu__sep" />
      <button
        className="context-menu__item"
        onClick={act(() => void copyPath(tab.path))}
      >
        Copy Path
      </button>
    </div>
  );
}
