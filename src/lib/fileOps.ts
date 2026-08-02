/** File-tree operations: rename, create, delete, copy path, download. Each
 *  updates open tabs and refreshes the tree as needed. */
import { basename, dirname } from "./format";
import { fsCopy, fsCreate, fsMove, fsRemoveMany, fsRename } from "./ipc";
import { openFileByPath } from "./openFile";
import { downloadConfig } from "./settings";
import { useAppStore } from "../store/appStore";
import { useVcsStore } from "../store/vcsStore";

/** Download remote/WSL files to the local machine — to the configured folder
 *  (settings `download.dir`), or the OS Downloads folder when unset. Runs as a
 *  full transfer: status-bar progress with ✕ to cancel, pause/auto-resume on
 *  a drop, and a completion toast with the real file count. Shared by the
 *  explorer and quick-open. */
export async function downloadToLocal(
  connId: string,
  paths: string[],
): Promise<void> {
  const store = useAppStore.getState();
  if (!store.localConnId || paths.length === 0) return;
  if (store.activeTransfer) {
    store.pushNotice("info", "A transfer is already running — let it finish first.");
    return;
  }
  try {
    let dest = downloadConfig.dir.trim();
    if (!dest) {
      const { downloadDir } = await import("@tauri-apps/api/path");
      dest = await downloadDir();
    }
    const where = downloadConfig.dir.trim() ? dest : "Downloads";
    const host =
      store.wsls.find((w) => w.conn.connId === connId)?.conn.name ??
      store.remotes.find((r) => r.conn.connId === connId)?.conn.name ??
      "host";
    await store.runTransfer({
      transferId: `dl-${Date.now()}`,
      srcConnId: connId,
      srcPaths: paths,
      destConnId: store.localConnId,
      destDir: dest,
      rename: true,
      label: `${host} → ${where}`,
      firstName: basename(paths[0]),
      kind: "download",
      destLabel: where,
    });
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


/** Drop entries whose selected ANCESTOR folder is also in the set: acting on
 *  the ancestor already covers them. Without this, folder-plus-child selections
 *  delete the child twice ("could not stat …: No such file") or copy it twice
 *  (once inside the folder copy, once beside it). */
function pruneNested<T extends { connId: string; path: string }>(nodes: T[]): T[] {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  return nodes.filter(
    (n) =>
      !nodes.some(
        (a) =>
          a !== n &&
          a.connId === n.connId &&
          norm(n.path).startsWith(norm(a.path) + "/"),
      ),
  );
}

/** Delete several entries — ONE batched call per connection (on SSH, a single
 *  server-side `rm` for the whole selection), refreshing each affected
 *  connection once at the end. */
export async function deleteEntries(
  nodes: { connId: string; path: string; name: string }[],
): Promise<void> {
  const store = useAppStore.getState();
  store.closeConfirmDelete();
  const conns = new Set<string>();
  const targets = pruneNested(nodes);
  const byConn = new Map<string, typeof targets>();
  for (const n of targets) {
    const list = byConn.get(n.connId);
    if (list) list.push(n);
    else byConn.set(n.connId, [n]);
  }
  for (const [connId, list] of byConn) {
    try {
      await fsRemoveMany(
        connId,
        list.map((n) => n.path),
      );
      for (const n of list) {
        store.applyDelete(connId, n.path);
        useVcsStore.getState().onFileChanged(connId, n.path);
      }
    } catch (error) {
      // The transport already retried per path; the message names each
      // failure, and the refresh below shows what actually happened.
      store.pushNotice("error", `Couldn't delete: ${String(error)}`);
    }
    conns.add(connId);
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

/** Paste the cut/copied entries into `destDir` on the same connection — the
 *  SAME engine as drag-and-drop's Move/Copy here (dropIntoDir): one
 *  server-side cp/rename per item, nested selections pruned, a few in
 *  parallel. Single and multi are one code path. */
export async function pasteInto(connId: string, destDir: string): Promise<void> {
  const store = useAppStore.getState();
  const clip = store.clipboard;
  if (!clip || clip.nodes.length === 0) return;
  if (clip.nodes[0].connId !== connId) {
    store.pushNotice("error", "Can't paste across connections yet.");
    return;
  }
  await dropIntoDir(
    clip.mode === "cut" ? "move" : "copy",
    connId,
    clip.nodes,
    destDir,
  );
  // A cut buffer is spent by its paste; a copy buffer can paste again.
  if (clip.mode === "cut") store.clearClipboard();
}

/** The clipboard capture rule — the SAME rule as drag (startNodeDrag): acting
 *  on a node that's part of the multi-selection takes the whole same-host
 *  selection; a node outside it takes just that node. */
export function clipboardNodes(node: {
  connId: string;
  path: string;
  name: string;
  isDir: boolean;
}): { connId: string; path: string; name: string; isDir: boolean }[] {
  const sel = useAppStore.getState().selection;
  const inSel = sel.some(
    (n) => n.connId === node.connId && n.path === node.path,
  );
  return inSel && sel.length
    ? sel.filter((n) => n.connId === node.connId)
    : [node];
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

  // Folder + its child dragged together: moving/copying the folder already
  // carries the child — acting on the child again errors (move) or duplicates
  // it beside the folder (copy).
  const pruned = pruneNested(nodes.map((n) => ({ ...n, connId })));
  // Landing slots by input index — "select the last item that landed" stays
  // deterministic under the parallel workers below.
  const landedAt: ({ path: string; isDir: boolean } | null)[] = pruned.map(
    () => null,
  );
  const runOne = async (node: (typeof pruned)[number], idx: number) => {
    const src = norm(node.path);
    if (mode === "move" && norm(dirname(node.path)) === dest) return; // already here
    if (node.isDir && (dest === src || dest.startsWith(src + "/"))) {
      store.pushNotice("error", `Can't ${mode} "${node.name}" into itself.`);
      return;
    }
    try {
      const newPath =
        mode === "move"
          ? await fsMove(connId, node.path, destDir)
          : await fsCopy(connId, node.path, destDir);
      if (mode === "move") store.applyRename(connId, node.path, newPath); // follow open tabs
      vcs.onFileChanged(connId, newPath);
      if (mode === "move") vcs.onFileChanged(connId, node.path);
      landedAt[idx] = { path: newPath, isDir: node.isDir };
    } catch (e) {
      store.pushNotice("error", `Couldn't ${mode} "${node.name}": ${String(e)}`);
    }
  };
  // A few at a time (each item is one server-side cp / rename round trip),
  // well under the SSH channel budget. Same-basename items from DIFFERENT
  // folders must run serially: their collision picks would race and the
  // second would overwrite the first's copy.
  const names = pruned.map((n) => n.name);
  const workers = new Set(names).size === names.length ? 4 : 1;
  const queue = pruned.map((node, idx) => ({ node, idx }));
  await Promise.all(
    Array.from({ length: Math.min(workers, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        await runOne(next.node, next.idx);
      }
    }),
  );
  store.refreshConn(connId);
  // Completion toast, same shape as the transfer toast ("Copied N files") —
  // counting top-level ITEMS here (a folder is one item; the server-side cp
  // doesn't report a per-file count). Failures/skips already toasted above.
  const doneIdx = landedAt.flatMap((r, i) => (r ? [i] : []));
  if (doneIdx.length > 0) {
    const verb = mode === "move" ? "Moved" : "Copied";
    store.pushNotice(
      "info",
      doneIdx.length === 1
        ? `${verb} ${pruned[doneIdx[0]].name}`
        : `${verb} ${doneIdx.length} items`,
    );
  }
  const landed = [...landedAt].reverse().find((r) => r !== null) ?? null;
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
  if (key === "c" || key === "x") {
    store.setClipboard(key === "c" ? "copy" : "cut", clipboardNodes(sel));
    return true;
  }
  // Paste lands in the selected folder, or the selected file's parent.
  const destDir = sel.isDir ? sel.path : dirname(sel.path);
  void pasteInto(sel.connId, destDir);
  return true;
}
