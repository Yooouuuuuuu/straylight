/** Read a remote file via SFTP and load it into the editor store, applying
 *  language detection and large/binary-file handling. */
import { sftpReadFile, type FileEntry } from "./ipc";
import { languageForFile } from "./language";
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
    const file = await sftpReadFile(connId, entry.path);
    const lineEnding: "LF" | "CRLF" = file.content.includes("\r\n")
      ? "CRLF"
      : "LF";

    // Files ≥ 50 MB drop to plaintext (no syntax highlighting) so the editor
    // stays responsive; that's handled in MonacoWrapper via the size, but we
    // also force plaintext here for binary.
    const language = file.isBinary
      ? "plaintext"
      : languageForFile(entry.name);

    store.setOpenFile({
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

    if (file.truncated) {
      store.pushNotice(
        "warn",
        `${entry.name} exceeds 50 MB and was opened truncated.`,
      );
    } else if (!file.isBinary && file.size >= LIGHTWEIGHT_BYTES) {
      store.pushNotice(
        "warn",
        `${entry.name} is very large — opened in lightweight mode.`,
      );
    } else if (!file.isBinary && file.size >= LARGE_FILE_BYTES) {
      store.pushNotice(
        "warn",
        `${entry.name} is large — some editor features are disabled.`,
      );
    }
  } catch (error) {
    store.pushNotice("error", `Couldn't open ${entry.name}: ${String(error)}`);
  } finally {
    store.setBusyPath(null);
  }
}
