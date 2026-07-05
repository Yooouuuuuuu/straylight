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
    store.markTabSaved(tab.id, result.modified);
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
    store.markTabSaved(tab.id, result.modified);
    if (versionId !== null) markTabSavedVersion(tab.id, versionId);
    useVcsStore.getState().onFileChanged(tab.connId, tab.path);
  } catch (error) {
    store.pushNotice("error", `Couldn't save ${tab.name}: ${String(error)}`);
    store.clearConflict();
  }
}
