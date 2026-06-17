/** File-tree operations: rename, create, delete, copy path. Each updates open
 *  tabs and refreshes the tree as needed. */
import { basename, dirname } from "./format";
import { fsCopy, fsCreate, fsMove, fsRemove, fsRename } from "./ipc";
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
    store.refreshConn(connId);
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
    store.refreshConn(connId);
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
    store.refreshConn(connId);
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

/** Paste the cut/copied entry into `destDir` on the same connection. */
export async function pasteInto(connId: string, destDir: string): Promise<void> {
  const store = useAppStore.getState();
  const clip = store.clipboard;
  if (!clip) return;
  if (clip.node.connId !== connId) {
    store.pushNotice("error", "Can't paste across connections yet.");
    return;
  }
  try {
    const newPath =
      clip.mode === "cut"
        ? await fsMove(connId, clip.node.path, destDir)
        : await fsCopy(connId, clip.node.path, destDir);
    if (clip.mode === "cut") {
      store.applyRename(connId, clip.node.path, newPath); // follow open tabs
      store.clearClipboard();
    }
    store.refreshConn(connId);
    store.setSelected({
      connId,
      path: newPath,
      name: basename(newPath),
      isDir: clip.node.isDir,
    });
  } catch (error) {
    store.pushNotice("error", `Couldn't paste: ${String(error)}`);
  }
}

/** Ctrl+X / Ctrl+C / Ctrl+V on the focused explorer selection. Returns whether
 *  the key was consumed. */
export function clipboardShortcut(key: "x" | "c" | "v"): boolean {
  const store = useAppStore.getState();
  const sel = store.selected;
  if (!sel) return false;
  if (key === "c") {
    store.setClipboard("copy", sel);
    return true;
  }
  if (key === "x") {
    store.setClipboard("cut", sel);
    return true;
  }
  // Paste lands in the selected folder, or the selected file's parent.
  const destDir = sel.isDir ? sel.path : dirname(sel.path);
  void pasteInto(sel.connId, destDir);
  return true;
}
