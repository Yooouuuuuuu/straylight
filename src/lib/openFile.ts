/** Read a file (remote SFTP or local) and open it as an editor tab, applying
 *  language detection and large/binary-file handling. An already-open file is
 *  just focused. */
import { maybeAttachDraft, updateStub } from "./drafts";
import { fsReadFile, type FileEntry } from "./ipc";
import { languageForFile } from "./language";
import { basename } from "./format";
import { useAppStore, type NewTab } from "../store/appStore";

const LARGE_FILE_BYTES = 10 * 1024 * 1024;
const LIGHTWEIGHT_BYTES = 50 * 1024 * 1024;

export async function openRemoteFile(
  connId: string,
  entry: FileEntry,
  opts?: { preview?: boolean; pinned?: boolean; focusEditor?: boolean },
): Promise<void> {
  if (entry.isDir) return;

  const store = useAppStore.getState();

  // VS Code model: a preview open (explorer single click) leaves focus where
  // it is — the tree keeps the keyboard; a permanent open (double click,
  // Enter, quick open) hands the editor the cursor.
  const wantFocus = opts?.focusEditor ?? !opts?.preview;

  // Already open → focus its tab (a permanent open promotes a preview).
  const existing = store.tabs.find(
    (t) => t.connId === connId && t.path === entry.path,
  );
  if (existing) {
    store.setActiveTab(existing.id);
    if (!opts?.preview && existing.previewTab) store.promoteTab(existing.id);
    if (wantFocus) store.requestEditorFocus();
    return;
  }

  store.setBusyPath(entry.path);
  try {
    const file = await fsReadFile(connId, entry.path);
    const lineEnding: "LF" | "CRLF" = file.content.includes("\r\n")
      ? "CRLF"
      : "LF";

    const tab: NewTab = {
      connId,
      path: file.path,
      name: entry.name,
      content: file.content,
      language: file.isBinary ? "plaintext" : languageForFile(entry.name),
      isBinary: file.isBinary,
      encoding: file.encoding,
      size: file.size,
      modified: file.modified,
      truncated: file.truncated,
      lossy: file.lossy,
      lineEnding,
    };
    store.openTab(tab, opts);
    if (wantFocus) useAppStore.getState().requestEditorFocus();

    if (!file.isBinary) {
      // Hot exit: remember where this tab last saw the file, and surface (or
      // auto-restore) an unsaved draft from a previous session.
      updateStub(connId, file.path, file.modified, file.size);
      const opened = useAppStore
        .getState()
        .tabs.find(
          (t) =>
            t.connId === connId && t.path === file.path && (!t.kind || t.kind === "file"),
        );
      if (opened) void maybeAttachDraft(opened.id);
    }

    if (!file.isBinary) {
      if (file.truncated) {
        store.pushNotice("warn", `${entry.name} exceeds 50 MB and was opened truncated.`);
      } else if (file.lossy) {
        store.pushNotice(
          "warn",
          `${entry.name} isn't valid UTF-8 — shown with � replacements; saving is disabled.`,
        );
      } else if (file.size >= LIGHTWEIGHT_BYTES) {
        store.pushNotice("warn", `${entry.name} is very large — opened in lightweight mode.`);
      } else if (file.size >= LARGE_FILE_BYTES) {
        store.pushNotice("warn", `${entry.name} is large — some editor features are disabled.`);
      }
    }
  } catch (error) {
    store.pushNotice("error", `Couldn't open ${entry.name}: ${String(error)}`);
  } finally {
    store.setBusyPath(null);
  }
}

/** Open a file and reveal a specific line (used by search-in-files). */
export async function openFileAtLine(
  connId: string,
  path: string,
  name: string,
  line: number,
): Promise<void> {
  await openFileByPath(connId, path, name);
  useAppStore.getState().setRevealTarget({ connId, path, line });
}

/** Open a file by path (used for e.g. the SSH config). */
export async function openFileByPath(
  connId: string,
  path: string,
  name?: string,
  opts?: { preview?: boolean; pinned?: boolean; focusEditor?: boolean },
): Promise<void> {
  const entry: FileEntry = {
    name: name ?? basename(path),
    path,
    size: 0,
    isDir: false,
    isSymlink: false,
    symlinkTarget: null,
    permissions: "",
    owner: "",
    group: "",
    modified: 0,
  };
  await openRemoteFile(connId, entry, opts);
}
