/** Explorer auto-refresh for LOCAL pinned folders — the VS Code model: every
 *  pinned root gets a recursive filesystem watcher (backend `dir_watch`,
 *  debounced per burst), and a change anywhere under one refreshes the local
 *  trees (root + expanded dirs re-list via the refresh token). External
 *  creates/deletes/renames show up without touching F5.
 *
 *  WSL/remote trees have no agent to watch with — they stay manual refresh
 *  plus the window-refocus sweep (opt-in polling remains future work). */
import { dirUnwatch, dirWatch, onDirFsChange } from "./ipc";
import { useAppStore } from "../store/appStore";

let started = false;
let watched = new Set<string>();
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

function syncWatches(): void {
  const s = useAppStore.getState();
  const connId = s.localConnId;
  if (!connId) return;
  const want = new Set(s.pinnedFolders);
  for (const root of want) {
    if (!watched.has(root)) {
      void dirWatch(connId, root).catch(() => {
        /* unwatchable (gone/permissions) — the tree shows its own error */
      });
    }
  }
  for (const root of watched) {
    if (!want.has(root)) void dirUnwatch(connId, root).catch(() => {});
  }
  watched = want;
}

/** Idempotent; call once the local session exists. */
export function initTreeWatching(): void {
  if (started) return;
  started = true;

  // One refresh per event burst, even when several roots fire together —
  // refreshLocal re-lists the root + every expanded dir of each local tree.
  void onDirFsChange(() => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      useAppStore.getState().refreshLocal();
    }, 200);
  });

  syncWatches();
  useAppStore.subscribe((s, prev) => {
    if (s.pinnedFolders !== prev.pinnedFolders || s.localConnId !== prev.localConnId) {
      syncWatches();
    }
  });
}
