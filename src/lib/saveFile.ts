/** Saving tabs (local or remote), with save-conflict detection. */
import { fsWriteFile } from "./ipc";
import {
  getTabContent,
  getTabVersionId,
  markTabSavedVersion,
} from "./activeEditor";
import { useAppStore } from "../store/appStore";
import { useVcsStore } from "../store/vcsStore";

export type SaveOutcome = "saved" | "conflict" | "noop" | "error";

/** Save a specific tab. On a conflict, stashes the pending content so the
 *  conflict dialog can offer Overwrite/Reload. */
export async function saveTab(tabId: string): Promise<SaveOutcome> {
  const store = useAppStore.getState();
  const tab = store.tabs.find((t) => t.id === tabId);
  if (!tab || (tab.kind && tab.kind !== "file") || tab.isBinary || !tab.dirty)
    return "noop";

  // Never write back a buffer that is not the whole, faithful file: a truncated
  // tab holds only the first 50 MB, and a lossy tab holds �-replacements where
  // the original (non-UTF-8) bytes were — saving either would corrupt the file.
  if (tab.truncated || tab.lossy) {
    store.pushNotice(
      "error",
      tab.truncated
        ? `${tab.name} was opened truncated (>50 MB) — saving would cut the file. Edit it in the terminal instead.`
        : `${tab.name} isn't valid UTF-8 — saving would replace the original bytes with �. Edit it in the terminal instead.`,
    );
    return "error";
  }

  // Capture the version we're about to save, so edits made during the write
  // still count as dirty afterwards.
  const versionId = getTabVersionId(tabId);
  const content = getTabContent(tabId);
  if (content === null) return "noop";

  try {
    const result = await fsWriteFile(tab.connId, tab.path, content, tab.modified);
    if (result.conflict) {
      store.setConflict(tab.id, content);
      return "conflict";
    }
    // Passing `content` keeps the tab's seed in sync, so the file watcher
    // recognizes our own write and skips the reload (which would reset undo).
    store.markTabSaved(tab.id, result.modified, content);
    if (versionId !== null) markTabSavedVersion(tab.id, versionId);
    // An eager repo containing this file re-checks its status.
    useVcsStore.getState().onFileChanged(tab.connId, tab.path);
    return "saved";
  } catch (error) {
    store.pushNotice("error", `Couldn't save ${tab.name}: ${String(error)}`);
    return "error";
  }
}

export async function saveActiveFile(): Promise<void> {
  const id = useAppStore.getState().activeTabId;
  if (id) await saveTab(id);
}

/** Force-write the pending (conflicting) content, overwriting the disk version. */
export async function overwritePendingFile(): Promise<void> {
  const store = useAppStore.getState();
  const pending = store.conflict;
  if (!pending) return;
  const tab = store.tabs.find((t) => t.id === pending.tabId);
  if (!tab) {
    store.clearConflict();
    return;
  }
  const versionId = getTabVersionId(tab.id);
  try {
    const result = await fsWriteFile(tab.connId, tab.path, pending.content, null);
    store.markTabSaved(tab.id, result.modified, pending.content);
    if (versionId !== null) markTabSavedVersion(tab.id, versionId);
    useVcsStore.getState().onFileChanged(tab.connId, tab.path);
  } catch (error) {
    store.pushNotice("error", `Couldn't save ${tab.name}: ${String(error)}`);
    store.clearConflict();
  }
}
