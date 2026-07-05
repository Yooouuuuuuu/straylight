/** Open a read-only diff tab for a changed file: its base version (git `HEAD:` /
 *  jj `@-`) vs the working copy. Added/untracked → empty old side; deleted →
 *  empty new side. */
import { basename } from "./format";
import { fsReadFile, vcsFileAt, vcsFileBase, type VcsChange } from "./ipc";
import { languageForFile } from "./language";
import { useAppStore } from "../store/appStore";
import type { TrackedRepo } from "../store/vcsStore";

export async function openDiff(repo: TrackedRepo, change: VcsChange): Promise<void> {
  const connId = repo.connId;
  if (!connId) return;
  const store = useAppStore.getState();
  const root = repo.root.replace(/\\/g, "/").replace(/\/+$/, "");
  const workingPath = `${root}/${change.path}`;
  const basePath = change.oldPath ?? change.path; // renames: base holds the old path

  store.setBusyPath(workingPath);
  try {
    let base = "";
    let baseExists = false;
    let baseBinary = false;
    try {
      const b = await vcsFileBase(connId, root, repo.backend, basePath);
      base = b.content;
      baseExists = b.exists;
      baseBinary = b.isBinary;
    } catch {
      /* no base side */
    }

    let content = "";
    let workingBinary = false;
    if (change.kind !== "deleted") {
      try {
        const f = await fsReadFile(connId, workingPath);
        content = f.content;
        workingBinary = f.isBinary;
      } catch {
        /* unreadable / already gone → empty new side */
      }
    }

    store.openDiffTab({
      connId,
      name: basename(change.path),
      path: workingPath,
      relPath: change.path,
      base,
      baseExists,
      content,
      language: languageForFile(basename(change.path)),
      isBinary: baseBinary || workingBinary,
    });
  } finally {
    store.setBusyPath(null);
  }
}

/** Open the 3-way merge editor for a conflicted file. */
export async function openMergeEditor(
  repo: TrackedRepo,
  relPath: string,
): Promise<void> {
  if (!repo.connId) return;
  const store = useAppStore.getState();
  const root = repo.root.replace(/\\/g, "/").replace(/\/+$/, "");
  const path = `${root}/${relPath}`;
  store.setBusyPath(path);
  try {
    const file = await fsReadFile(repo.connId, path);
    if (file.isBinary) {
      store.pushNotice("warn", "Binary file — resolve it outside the merge editor.");
      return;
    }
    store.openMergeTab({
      connId: repo.connId,
      path,
      name: basename(relPath),
      content: file.content,
      modified: file.modified,
      language: languageForFile(basename(relPath)),
    });
  } catch (e) {
    store.pushNotice("error", `Couldn't open merge editor: ${String(e)}`);
  } finally {
    store.setBusyPath(null);
  }
}

/** Open a diff for a file *as changed by a specific commit* (commit vs parent). */
export async function openCommitDiff(
  conn: { connId: string; root: string; backend: string },
  commitId: string,
  change: VcsChange,
): Promise<void> {
  const store = useAppStore.getState();
  const root = conn.root.replace(/\\/g, "/").replace(/\/+$/, "");
  const parentRev = conn.backend === "jj" ? `${commitId}-` : `${commitId}^`;
  const newPath = change.path;
  const oldPath = change.oldPath ?? change.path;

  store.setBusyPath(newPath);
  try {
    let base = "";
    let baseBinary = false;
    try {
      const b = await vcsFileAt(conn.connId, root, conn.backend, parentRev, oldPath);
      base = b.content;
      baseBinary = b.isBinary;
    } catch {
      /* no parent side */
    }
    let content = "";
    let newBinary = false;
    try {
      const f = await vcsFileAt(conn.connId, root, conn.backend, commitId, newPath);
      content = f.content;
      newBinary = f.isBinary;
    } catch {
      /* deleted in this commit */
    }
    store.openDiffTab({
      connId: conn.connId,
      name: `${basename(newPath)} @ ${commitId.slice(0, 7)}`,
      path: newPath,
      relPath: `${commitId}:${newPath}`, // unique tab per commit+file
      base,
      baseExists: base.length > 0,
      content,
      language: languageForFile(basename(newPath)),
      isBinary: baseBinary || newBinary,
    });
  } finally {
    store.setBusyPath(null);
  }
}
