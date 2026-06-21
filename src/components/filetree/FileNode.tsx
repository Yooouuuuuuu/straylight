/** A single row in the file tree: twisty, icon, name (or rename input), symlink
 *  marker, and a trailing size. Handles selection, right-click, and inline
 *  rename. */
import { useEffect, useRef, useState } from "react";

import { formatSize, formatTimestamp } from "../../lib/format";
import type { FileEntry } from "../../lib/ipc";
import { useVcsStore } from "../../store/vcsStore";
import { vcsClass, vcsLetter } from "../../lib/vcsDecorations";
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

export function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    // Select the basename without the extension, like VS Code.
    const dot = initial.lastIndexOf(".");
    if (dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  }, [initial]);

  const commit = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCommit(value);
  };
  const cancel = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCancel();
  };

  return (
    <input
      ref={ref}
      className="file-node__rename input--mono"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") cancel();
      }}
      onBlur={commit}
    />
  );
}

export function FileNode({
  entry,
  depth,
  expanded,
  loading,
  active,
  renaming,
  onToggle,
  onOpen,
  onSelect,
  onContextMenu,
  onCommitRename,
  onCancelRename,
}: {
  entry: FileEntry;
  depth: number;
  expanded: boolean;
  loading: boolean;
  active: boolean;
  renaming: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onSelect: (mods: { ctrl: boolean; shift: boolean }) => void;
  onContextMenu: (x: number, y: number) => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  // VCS decoration for this path (tracked repos publish a normalized map).
  const vcsKind = useVcsStore((s) => s.decorations[entry.path.replace(/\\/g, "/")]);
  const vcsDirect = vcsKind && vcsKind !== "child" ? vcsKind : null;

  // Keep the selected row visible when the selection moves by keyboard.
  useEffect(() => {
    if (active) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // Single click selects (and toggles a folder); a file opens only on
  // double-click (or Enter / →). Ctrl/Shift click multi-selects without toggling.
  const handleClick = (e: React.MouseEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    onSelect({ ctrl, shift });
    if (!ctrl && !shift && entry.isDir) onToggle();
  };
  const handleDoubleClick = () => {
    if (!entry.isDir) onOpen();
  };

  const twistyClass = entry.isDir
    ? `file-node__twisty ${expanded ? "file-node__twisty--open" : ""}`
    : "file-node__twisty file-node__twisty--leaf";

  return (
    <div
      ref={rowRef}
      className={`file-node ${active ? "file-node--active" : ""}`}
      style={{ paddingLeft: 6 + depth * 14 }}
      onClick={renaming ? undefined : handleClick}
      onDoubleClick={renaming ? undefined : handleDoubleClick}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
      title={renaming ? undefined : tooltip(entry)}
    >
      <span className={twistyClass}>
        {entry.isDir ? <IconChevron size={14} /> : null}
      </span>
      <span className="file-node__icon">
        <FileIcon name={entry.name} isDir={entry.isDir} isOpen={expanded} />
      </span>
      {renaming ? (
        <RenameInput
          initial={entry.name}
          onCommit={onCommitRename}
          onCancel={onCancelRename}
        />
      ) : (
        <>
          <span
            className={`file-node__name ${entry.isDir ? "file-node__name--dir" : ""} ${
              vcsKind ? vcsClass(vcsKind) : ""
            }`}
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
          {vcsDirect ? (
            <span className={`file-node__vcs ${vcsClass(vcsDirect)}`}>
              {vcsLetter(vcsDirect)}
            </span>
          ) : vcsKind === "child" ? (
            <span className="file-node__vcs vcs--child">•</span>
          ) : null}
          {loading ? (
            <span className="file-node__spinner">
              <span className="spinner spinner--sm" />
            </span>
          ) : (
            !entry.isDir && (
              <span className="file-node__meta">{formatSize(entry.size)}</span>
            )
          )}
        </>
      )}
    </div>
  );
}
