/** Right-click menu for editor tabs: close variants (with the shared one-dialog
 *  unsaved check), pin/unpin, and copy path. Pinned tabs are spared by EVERY
 *  bulk close (Others / Right / Saved / All) — unpin to close one. */
import { useEffect, useRef } from "react";

import { copyPath } from "../../lib/fileOps";
import {
  closeAllTabs,
  closeOtherTabs,
  closeSavedTabs,
  closeTabsToRight,
} from "../../lib/tabActions";
import { MAX_EDITOR_GROUPS, useAppStore } from "../../store/appStore";

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
  const editorGroups = useAppStore((s) => s.editorGroups);
  const groupSize = useAppStore(
    (s) =>
      s.tabs.filter((t) => (t.groupId ?? 0) === ((tab?.groupId ?? 0))).length,
  );
  if (!menu || !tab) return null;

  const gid = tab.groupId ?? 0;
  const gIdx = editorGroups.indexOf(gid);
  // Splitting the only tab of the only group would be a no-op layout.
  const canSplit =
    editorGroups.length < MAX_EDITOR_GROUPS &&
    (groupSize > 1 || editorGroups.length > 1);
  const leftGroup = gIdx > 0 ? editorGroups[gIdx - 1] : null;
  const rightGroup =
    gIdx >= 0 && gIdx < editorGroups.length - 1 ? editorGroups[gIdx + 1] : null;

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
      {canSplit && (
        <button
          className="context-menu__item"
          onClick={act(() => store.splitRight(tab.id))}
        >
          Split Right
        </button>
      )}
      {leftGroup !== null && (
        <button
          className="context-menu__item"
          onClick={act(() => store.moveTabToGroup(tab.id, leftGroup))}
        >
          Move to Left Group
        </button>
      )}
      {rightGroup !== null && (
        <button
          className="context-menu__item"
          onClick={act(() => store.moveTabToGroup(tab.id, rightGroup))}
        >
          Move to Right Group
        </button>
      )}
      {(canSplit || leftGroup !== null || rightGroup !== null) && (
        <div className="context-menu__sep" />
      )}
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
