/** Read a file (remote SFTP or local) and open it as an editor tab, applying
 *  language detection and large/binary-file handling. An already-open file is
 *  just focused. */
import { fsReadFile, type FileEntry } from "./ipc";
import { languageForFile } from "./language";
import { basename } from "./format";
import { useAppStore, type NewTab } from "../store/appStore";

const LARGE_FILE_BYTES = 10 * 1024 * 1024;
const LIGHTWEIGHT_BYTES = 50 * 1024 * 1024;

export async function openRemoteFile(
  connId: string,
  entry: FileEntry,
): Promise<void> {
  if (entry.isDir) return;

  const store = useAppStore.getState();

  // Already open → focus its tab.
  const existing = store.tabs.find(
    (t) => t.connId === connId && t.path === entry.path,
  );
  if (existing) {
    store.setActiveTab(existing.id);
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
      lineEnding,
    };
    store.openTab(tab);

    if (!file.isBinary) {
      if (file.truncated) {
        store.pushNotice("warn", `${entry.name} exceeds 50 MB and was opened truncated.`);
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
  await openRemoteFile(connId, entry);
}
