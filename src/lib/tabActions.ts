/** Bulk tab operations shared by the command palette and the tab context menu.
 *  One dialog covers unsaved files ("save all & close"); pinned tabs are spared
 *  by Others/Right/Saved and only fall to an explicit Close All. */
import { saveTab } from "./saveFile";
import { useAppStore } from "../store/appStore";
import { useVcsStore } from "../store/vcsStore";

/** Close the given tabs. Clean ones close immediately; if any are dirty, one
 *  confirm offers to save them all first (a failed save aborts the rest). */
export function closeTabs(ids: string[]): void {
  const s = useAppStore.getState();
  const targets = s.tabs.filter((t) => ids.includes(t.id));
  const dirty = targets.filter((t) => t.dirty);
  if (dirty.length === 0) {
    for (const t of targets) s.forceCloseTab(t.id);
    return;
  }
  useVcsStore
    .getState()
    .askConfirm(
      "Close tabs?",
      `${dirty.length} file${dirty.length === 1 ? "" : "s"} ha${dirty.length === 1 ? "s" : "ve"} unsaved changes — save all and close?`,
      () =>
        void (async () => {
          for (const t of dirty) {
            const outcome = await saveTab(t.id);
            if (outcome === "conflict" || outcome === "error") {
              useAppStore
                .getState()
                .pushNotice("error", `Couldn't save ${t.name} — close stopped.`);
              return;
            }
          }
          const store = useAppStore.getState();
          for (const id of ids) store.forceCloseTab(id);
        })(),
    );
}

export function closeAllTabs(): void {
  closeTabs(useAppStore.getState().tabs.map((t) => t.id));
}

export function closeSavedTabs(): void {
  const s = useAppStore.getState();
  for (const t of s.tabs.filter((t) => !t.dirty && !t.pinned)) s.forceCloseTab(t.id);
}

export function closeOtherTabs(keepId: string): void {
  const s = useAppStore.getState();
  closeTabs(s.tabs.filter((t) => t.id !== keepId && !t.pinned).map((t) => t.id));
}

export function closeTabsToRight(fromId: string): void {
  const s = useAppStore.getState();
  const idx = s.tabs.findIndex((t) => t.id === fromId);
  if (idx < 0) return;
  closeTabs(s.tabs.slice(idx + 1).filter((t) => !t.pinned).map((t) => t.id));
}
