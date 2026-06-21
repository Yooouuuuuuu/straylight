/** Open a read-only diff tab for a changed file: its base version (git `HEAD:` /
 *  jj `@-`) vs the working copy. Added/untracked → empty old side; deleted →
 *  empty new side. */
import { basename } from "./format";
import { fsReadFile, vcsFileBase, type VcsChange } from "./ipc";
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
