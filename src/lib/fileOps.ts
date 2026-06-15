/** File-tree operations: rename, create, delete, copy path. Each updates open
 *  tabs and refreshes the tree as needed. */
import { basename } from "./format";
import { fsCreate, fsRemove, fsRename } from "./ipc";
import { openFileByPath } from "./openFile";
import { useAppStore } from "../store/appStore";

export async function commitRename(
  connId: string,
  oldPath: string,
  newName: string,
): Promise<void> {
  const store = useAppStore.getState();
  store.cancelRename();

  const trimmed = newName.trim();
  if (!trimmed || trimmed === basename(oldPath)) return;

  try {
    const newPath = await fsRename(connId, oldPath, trimmed);
    store.applyRename(connId, oldPath, newPath);
    store.refreshTree();
  } catch (error) {
    store.pushNotice("error", `Couldn't rename: ${String(error)}`);
  }
}

export async function createEntry(
  connId: string,
  parent: string,
  name: string,
  isDir: boolean,
): Promise<void> {
  const store = useAppStore.getState();
  store.closeNewEntry();

  const trimmed = name.trim();
  if (!trimmed) return;

  try {
    const newPath = await fsCreate(connId, parent, trimmed, isDir);
    store.refreshTree();
    if (!isDir) {
      await openFileByPath(connId, newPath, trimmed);
    }
  } catch (error) {
    store.pushNotice(
      "error",
      `Couldn't create ${isDir ? "folder" : "file"}: ${String(error)}`,
    );
  }
}

export async function deleteEntry(connId: string, path: string): Promise<void> {
  const store = useAppStore.getState();
  store.closeConfirmDelete();
  try {
    await fsRemove(connId, path);
    store.applyDelete(connId, path);
    store.refreshTree();
  } catch (error) {
    store.pushNotice("error", `Couldn't delete: ${String(error)}`);
  }
}

export async function copyPath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
  } catch {
    /* clipboard unavailable */
  }
}
