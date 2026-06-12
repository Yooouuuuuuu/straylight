/** A single row in the file tree: twisty, icon, name, symlink marker, and a
 *  trailing size (or spinner while a directory loads). */
import { formatSize, formatTimestamp } from "../../lib/format";
import type { FileEntry } from "../../lib/ipc";
import { IconChevron } from "../icons";
import { FileIcon } from "./FileIcons";

function tooltip(entry: FileEntry): string {
  const typeChar = entry.isDir ? "d" : entry.isSymlink ? "l" : "-";
  const parts = [`${typeChar}${entry.permissions}`, `${entry.owner}:${entry.group}`];
  if (!entry.isDir) parts.push(formatSize(entry.size));
  parts.push(formatTimestamp(entry.modified));
  if (entry.isSymlink && entry.symlinkTarget) {
    parts.push(`→ ${entry.symlinkTarget}`);
  }
  return parts.join("   ");
}

export function FileNode({
  entry,
  depth,
  expanded,
  loading,
  active,
  onToggle,
  onOpen,
}: {
  entry: FileEntry;
  depth: number;
  expanded: boolean;
  loading: boolean;
  active: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const handleClick = () => {
    if (entry.isDir) onToggle();
    else onOpen();
  };

  const twistyClass = entry.isDir
    ? `file-node__twisty ${expanded ? "file-node__twisty--open" : ""}`
    : "file-node__twisty file-node__twisty--leaf";

  return (
    <div
      className={`file-node ${active ? "file-node--active" : ""}`}
      style={{ paddingLeft: 6 + depth * 14 }}
      onClick={handleClick}
      title={tooltip(entry)}
    >
      <span className={twistyClass}>
        {entry.isDir ? <IconChevron size={14} /> : null}
      </span>
      <span className="file-node__icon">
        <FileIcon name={entry.name} isDir={entry.isDir} isOpen={expanded} />
      </span>
      <span
        className={`file-node__name ${entry.isDir ? "file-node__name--dir" : ""}`}
      >
        {entry.name}
      </span>
      {entry.isSymlink && (
        <span
          className="file-node__symlink"
          title={entry.symlinkTarget ?? undefined}
        >
          ↪
        </span>
      )}
      {loading ? (
        <span className="file-node__spinner">
          <span className="spinner spinner--sm" />
        </span>
      ) : (
        !entry.isDir && (
          <span className="file-node__meta">{formatSize(entry.size)}</span>
        )
      )}
    </div>
  );
}
