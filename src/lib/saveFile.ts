/** Saving tabs, with save-conflict handling. Local files write directly;
 *  WSL/remote files go through the STAGED protocol (docs/atomic-save.md):
 *  upload-to-temp → detached server-side commit → verified ack — so a
 *  connection drop can never tear the file. If the staged path can't even
 *  start (jailed SFTP-only host), it degrades to the direct write.
 *
 *  Conflicts (the file changed under us) are per-tab (`tab.conflict`): Ctrl+S
 *  is BLOCKED while set, and the only way out is the conflict bar's Overwrite
 *  / Discard (each confirmed) — see the resolution actions at the bottom and
 *  the bars in EditorArea. */
import { deleteDraftFor, updateStub } from "./drafts";
import { fsReadFile, fsWriteFile } from "./ipc";
import { stagedOverwrite, stagedSaveTab } from "./stagedSave";
import {
  getTabContent,
  getTabVersionId,
  markTabSavedVersion,
  setTabContentInPlace,
} from "./activeEditor";
import { useAppStore } from "../store/appStore";
import { useVcsStore } from "../store/vcsStore";

export type SaveOutcome = "saved" | "conflict" | "noop" | "error";

/** Save a specific tab. A tab in conflict is blocked (resolve via the bar). */
export async function saveTab(tabId: string): Promise<SaveOutcome> {
  const store = useAppStore.getState();
  const tab = store.tabs.find((t) => t.id === tabId);
  if (!tab || (tab.kind && tab.kind !== "file") || tab.isBinary || !tab.dirty)
    return "noop";

  // A conflicted tab must be resolved explicitly — never let a stray Ctrl+S
  // save "through" the bar (that could clobber someone else's change).
  if (tab.conflict) {
    store.pushNotice(
      "warn",
      `${tab.name} changed on the server — resolve it in the bar (Overwrite / Discard) before saving.`,
    );
    return "error";
  }

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

  // WSL/remote: the staged protocol (optimistic — "queued" means uploaded +
  // dispatched and the tab is already finalized; a later guard refusal
  // surfaces the conflict on its own). "fallback" = couldn't start, file
  // untouched — degrade to the direct write below.
  if (tab.connId !== store.localConnId) {
    const outcome = await stagedSaveTab(tab.id, content, versionId);
    if (outcome === "queued") return "saved";
    if (outcome === "error") return "error";
    // "fallback" → fall through to the direct write.
  }

  try {
    const result = await fsWriteFile(tab.connId, tab.path, content, tab.modified);
    if (result.conflict) {
      store.setTabConflict(tab.id, true);
      return "conflict";
    }
    // Passing `content` keeps the tab's seed in sync, so the file watcher
    // recognizes our own write and skips the reload (which would reset undo).
    store.markTabSaved(tab.id, result.modified, content);
    if (versionId !== null) markTabSavedVersion(tab.id, versionId);
    // Saved = the hot-exit draft is resolved; the stub records the new mtime.
    deleteDraftFor(tab.connId, tab.path);
    store.setTabDraft(tab.id, { draftApplied: false, draftAvailable: false });
    updateStub(tab.connId, tab.path, result.modified, content.length);
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

// ---- conflict-bar resolution (Overwrite / Discard) -------------------------

/** Conflict bar "Overwrite": force the buffer over the server's newer version
 *  (guard skipped). Confirmed by the caller. */
export async function overwriteConflict(tabId: string): Promise<void> {
  const store = useAppStore.getState();
  const tab = store.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const content = getTabContent(tabId);
  if (content === null) return;
  const versionId = getTabVersionId(tabId);

  if (tab.connId !== store.localConnId) {
    const outcome = await stagedOverwrite(tabId, content);
    if (outcome === "queued") {
      store.setTabConflict(tabId, false);
      return;
    }
    if (outcome === "error") return;
    // "fallback" → direct write below.
  }
  try {
    const result = await fsWriteFile(tab.connId, tab.path, content, null);
    store.markTabSaved(tab.id, result.modified, content); // clears conflict too
    if (versionId !== null) markTabSavedVersion(tab.id, versionId);
    deleteDraftFor(tab.connId, tab.path);
    store.setTabDraft(tab.id, { draftApplied: false, draftAvailable: false });
    updateStub(tab.connId, tab.path, result.modified, content.length);
    useVcsStore.getState().onFileChanged(tab.connId, tab.path);
  } catch (error) {
    store.pushNotice("error", `Couldn't save ${tab.name}: ${String(error)}`);
  }
}

/** Conflict bar "Compare": read-only diff of the current buffer (your version)
 *  against the file as it is on disk right now. */
export async function compareWithDisk(tabId: string): Promise<void> {
  const store = useAppStore.getState();
  const tab = store.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const content = getTabContent(tabId);
  if (content === null) return;
  try {
    const file = await fsReadFile(tab.connId, tab.path);
    store.openDiffTab({
      connId: tab.connId,
      name: `${tab.name} (yours ⇄ server)`,
      path: tab.path,
      relPath: `${tab.path}#conflict`,
      base: file.content,
      baseExists: true,
      content,
      language: tab.language,
      isBinary: false,
    });
  } catch (error) {
    store.pushNotice("error", `Couldn't read ${tab.name} to compare: ${String(error)}`);
  }
}

/** Conflict bar "Discard": drop the buffer's changes and load the server's
 *  version (also deletes the draft). Confirmed by the caller. */
export async function discardToServer(tabId: string): Promise<void> {
  const store = useAppStore.getState();
  const tab = store.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  try {
    const file = await fsReadFile(tab.connId, tab.path);
    store.reloadTabContent(tabId, file); // dirty:false, seed = disk
    setTabContentInPlace(tabId, file.content); // model = disk, marks saved-version
    store.setTabConflict(tabId, false);
    deleteDraftFor(tab.connId, tab.path);
    store.setTabDraft(tabId, { draftApplied: false, draftAvailable: false });
    updateStub(tab.connId, tab.path, file.modified, file.size);
  } catch (error) {
    store.pushNotice("error", `Couldn't reload ${tab.name}: ${String(error)}`);
  }
}
