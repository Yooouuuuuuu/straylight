/** Auto-reload open files that change on disk (VS Code-style — enables
 *  watching a growing log). Only **clean** tabs reload; dirty tabs keep their
 *  edits and rely on the save-conflict flow.
 *
 *  Local tabs: a filesystem watcher per open file (instant). Remote/WSL tabs:
 *  no watcher without an agent, so their mtime is polled every ~3 s and they
 *  reload on change. The editor stays where it was — unless it was scrolled to
 *  the bottom, in which case it follows the tail. */
import { setTabContentInPlace } from "./activeEditor";
import { updateStub } from "./drafts";
import {
  fileUnwatch,
  fileWatch,
  fsReadFile,
  fsStat,
  onFileFsChange,
} from "./ipc";
import { hasPendingSave } from "./stagedSave";
import { useAppStore } from "../store/appStore";

/** Re-read a tab from disk and swap its content in place, if it's safe to. */
export async function reloadCleanTab(tabId: string): Promise<void> {
  const tab = useAppStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab || tab.dirty || tab.isBinary || tab.truncated) return;
  if (tab.kind && tab.kind !== "file") return;
  // A staged save's own commit bumps the mtime — don't reload the tab from
  // our in-flight write (it would flicker and reset undo).
  if (hasPendingSave(tab.connId, tab.path)) return;
  try {
    const file = await fsReadFile(tab.connId, tab.path);
    const cur = useAppStore.getState().tabs.find((t) => t.id === tabId);
    // Skip if closed or edited meanwhile, unreadable as text, or unchanged.
    if (!cur || cur.dirty || file.isBinary) return;
    if (file.modified === cur.modified && file.content === cur.content) return;
    useAppStore.getState().reloadTabContent(tabId, file);
    setTabContentInPlace(tabId, file.content);
    updateStub(cur.connId, cur.path, file.modified, file.size);
  } catch {
    /* unreadable right now (deleted?) — leave the tab as-is */
  }
}

const watched = new Set<string>();

/** Keep one backend watcher per open, local, clean-able file tab. */
function syncFileWatchers(): void {
  const s = useAppStore.getState();
  const local = s.localConnId;
  const desired = new Map<string, { connId: string; path: string }>();
  if (local) {
    for (const t of s.tabs) {
      if ((!t.kind || t.kind === "file") && t.connId === local && !t.isBinary) {
        desired.set(`${t.connId}::${t.path}`, { connId: t.connId, path: t.path });
      }
    }
  }
  for (const key of [...watched]) {
    if (!desired.has(key)) {
      watched.delete(key);
      const sep = key.indexOf("::");
      void fileUnwatch(key.slice(0, sep), key.slice(sep + 2)).catch(() => {});
    }
  }
  for (const [key, v] of desired) {
    if (!watched.has(key)) {
      watched.add(key);
      fileWatch(v.connId, v.path).catch(() => watched.delete(key));
    }
  }
}

const POLL_MS = 3000;

/** Start file watching + remote polling. Returns a cleanup function. */
export function initFileWatching(): () => void {
  syncFileWatchers();
  const unsubscribe = useAppStore.subscribe(syncFileWatchers);

  const unlistenPromise = onFileFsChange((c) => {
    const tab = useAppStore
      .getState()
      .tabs.find((t) => t.connId === c.connId && t.path === c.path);
    if (tab) void reloadCleanTab(tab.id);
  });

  // Remote/WSL tabs: poll mtime and reload on change.
  let polling = false;
  const timer = window.setInterval(() => {
    if (polling) return;
    polling = true;
    void (async () => {
      try {
        const s = useAppStore.getState();
        const tabs = s.tabs.filter(
          (t) =>
            (!t.kind || t.kind === "file") &&
            !t.dirty &&
            !t.isBinary &&
            !t.truncated &&
            t.connId !== s.localConnId,
        );
        for (const t of tabs) {
          try {
            const st = await fsStat(t.connId, t.path);
            if (st.modified !== t.modified) await reloadCleanTab(t.id);
          } catch {
            /* transient (reconnect etc.) — try again next tick */
          }
        }
      } finally {
        polling = false;
      }
    })();
  }, POLL_MS);

  return () => {
    unsubscribe();
    window.clearInterval(timer);
    void unlistenPromise.then((unlisten) => unlisten());
  };
}
