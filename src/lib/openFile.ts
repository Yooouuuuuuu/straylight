/** Read a file (remote SFTP or local) and load it into the editor store,
 *  applying language detection and large/binary-file handling. */
import { fsReadFile, type FileEntry } from "./ipc";
import { languageForFile } from "./language";
import { basename } from "./format";
import { useAppStore } from "../store/appStore";

const LARGE_FILE_BYTES = 10 * 1024 * 1024;
const LIGHTWEIGHT_BYTES = 50 * 1024 * 1024;

export async function openRemoteFile(
  connId: string,
  entry: FileEntry,
): Promise<void> {
  if (entry.isDir) return;

  const store = useAppStore.getState();
  store.setBusyPath(entry.path);
  try {
    const file = await fsReadFile(connId, entry.path);
    const lineEnding: "LF" | "CRLF" = file.content.includes("\r\n")
      ? "CRLF"
      : "LF";

    const language = file.isBinary
      ? "plaintext"
      : languageForFile(entry.name);

    store.setOpenFile({
      connId,
      path: file.path,
      name: entry.name,
      content: file.content,
      language,
      isBinary: file.isBinary,
      encoding: file.encoding,
      size: file.size,
      modified: file.modified,
      truncated: file.truncated,
      lineEnding,
    });

    // Only warn for files actually opened in the editor (not shown as a card).
    if (!file.isBinary) {
      if (file.truncated) {
        store.pushNotice(
          "warn",
          `${entry.name} exceeds 50 MB and was opened truncated.`,
        );
      } else if (file.size >= LIGHTWEIGHT_BYTES) {
        store.pushNotice(
          "warn",
          `${entry.name} is very large — opened in lightweight mode.`,
        );
      } else if (file.size >= LARGE_FILE_BYTES) {
        store.pushNotice(
          "warn",
          `${entry.name} is large — some editor features are disabled.`,
        );
      }
    }
  } catch (error) {
    store.pushNotice("error", `Couldn't open ${entry.name}: ${String(error)}`);
  } finally {
    store.setBusyPath(null);
  }
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
