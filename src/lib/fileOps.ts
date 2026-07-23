/** File-tree operations: rename, create, delete, copy path, download. Each
 *  updates open tabs and refreshes the tree as needed. */
import { basename, dirname } from "./format";
import {
  fsCopy,
  fsCreate,
  fsMove,
  fsRemove,
  fsRename,
  fsTransferBatch,
} from "./ipc";
import { openFileByPath } from "./openFile";
import { downloadConfig } from "./settings";
import { useAppStore } from "../store/appStore";
import { useVcsStore } from "../store/vcsStore";

/** Download remote/WSL files to the local machine — to the configured folder
 *  (settings `download.dir`), or the OS Downloads folder when unset. No
 *  prompt; a toast reports the result. Shared by the explorer and quick-open. */
export async function downloadToLocal(
  connId: string,
  paths: string[],
): Promise<void> {
  const store = useAppStore.getState();
  if (!store.localConnId || paths.length === 0) return;
  try {
    let dest = downloadConfig.dir.trim();
    if (!dest) {
      const { downloadDir } = await import("@tauri-apps/api/path");
      dest = await downloadDir();
    }
    const now = Date.now();
    const outcome = await fsTransferBatch(
      `dl-${now}`,
      connId,
      paths,
      store.localConnId,
      dest,
      true,
    );
    const parts: string[] = [];
    if (outcome.skippedLinks)
      parts.push(
        `${outcome.skippedLinks} linked folder${outcome.skippedLinks === 1 ? "" : "s"}`,
      );
    if (outcome.skippedErrors)
      parts.push(
        `${outcome.skippedErrors} unreadable item${outcome.skippedErrors === 1 ? "" : "s"}`,
      );
    const skipped = parts.length ? ` (${parts.join(", ")} skipped)` : "";
    const where = downloadConfig.dir.trim() ? dest : "Downloads";
    store.pushNotice(
      "info",
      `Downloaded ${paths.length} item(s) to ${where}.${skipped}`,
    );
  } catch (e) {
    store.pushNotice("error", `Download failed: ${String(e)}`);
  }
}

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
    useVcsStore.getState().onFileChanged(connId, newPath);
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
    useVcsStore.getState().onFileChanged(connId, newPath);
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


/** Delete several entries, refreshing each affected connection once at the end. */
export async function deleteEntries(
  nodes: { connId: string; path: string; name: string }[],
): Promise<void> {
  const store = useAppStore.getState();
  store.closeConfirmDelete();
  const conns = new Set<string>();
  for (const n of nodes) {
    try {
      await fsRemove(n.connId, n.path);
      store.applyDelete(n.connId, n.path);
      conns.add(n.connId);
      useVcsStore.getState().onFileChanged(n.connId, n.path);
    } catch (error) {
      store.pushNotice("error", `Couldn't delete ${n.name}: ${String(error)}`);
    }
  }
  store.setSelected(null); // the deleted items are gone — drop the selection
  conns.forEach((c) => store.refreshConn(c));
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
    useVcsStore.getState().onFileChanged(connId, newPath);
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

/** Move or copy nodes into `destDir` on the SAME connection — the drag-and-drop
 *  equivalent of cut/copy + paste (same `fsMove`/`fsCopy`). Skips a no-op move
 *  (already in the folder) and an into-itself drop, refreshes the tree, and
 *  selects the last item that landed. */
export async function dropIntoDir(
  mode: "move" | "copy",
  connId: string,
  nodes: { path: string; name: string; isDir: boolean }[],
  destDir: string,
): Promise<void> {
  const store = useAppStore.getState();
  const vcs = useVcsStore.getState();
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const dest = norm(destDir);
  let landed: { path: string; isDir: boolean } | null = null;

  for (const node of nodes) {
    const src = norm(node.path);
    if (mode === "move" && norm(dirname(node.path)) === dest) continue; // already here
    if (node.isDir && (dest === src || dest.startsWith(src + "/"))) {
      store.pushNotice("error", `Can't ${mode} "${node.name}" into itself.`);
      continue;
    }
    try {
      const newPath =
        mode === "move"
          ? await fsMove(connId, node.path, destDir)
          : await fsCopy(connId, node.path, destDir);
      if (mode === "move") store.applyRename(connId, node.path, newPath); // follow open tabs
      vcs.onFileChanged(connId, newPath);
      if (mode === "move") vcs.onFileChanged(connId, node.path);
      landed = { path: newPath, isDir: node.isDir };
    } catch (e) {
      store.pushNotice("error", `Couldn't ${mode} "${node.name}": ${String(e)}`);
    }
  }
  store.refreshConn(connId);
  if (landed) {
    store.setSelected({
      connId,
      path: landed.path,
      name: basename(landed.path),
      isDir: landed.isDir,
    });
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
