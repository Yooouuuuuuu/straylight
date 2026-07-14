/** A single row in the file tree: twisty, icon, name (or rename input), symlink
 *  marker, and a trailing size. Handles selection, right-click, and inline
 *  rename. */
import { useEffect, useRef, useState } from "react";

import { formatSize, formatTimestamp } from "../../lib/format";
import type { FileEntry } from "../../lib/ipc";
import { repoColorForPath, useVcsStore } from "../../store/vcsStore";
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
  connId,
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
  connId: string;
  entry: FileEntry;
  depth: number;
  expanded: boolean;
  loading: boolean;
  active: boolean;
  renaming: boolean;
  onToggle: () => void;
  onOpen: (opts?: { preview?: boolean }) => void;
  onSelect: (mods: { ctrl: boolean; shift: boolean }) => void;
  onContextMenu: (x: number, y: number) => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  // VCS decoration for this path (tracked repos publish a normalized map).
  // Ignored state is inherited: anything inside an ignored directory dims too
  // (git collapses fully-ignored dirs to a single entry).
  const vcsKind = useVcsStore((s) => {
    const p = entry.path.replace(/\\/g, "/");
    const own = s.decorations[p];
    if (own) return own;
    let i = p.lastIndexOf("/");
    while (i > 0) {
      const parent = p.slice(0, i);
      if (s.decorations[parent] === "ignored") return "ignored";
      i = parent.lastIndexOf("/");
    }
    return undefined;
  });
  const vcsDirect =
    vcsKind && vcsKind !== "child" && vcsKind !== "ignored" ? vcsKind : null;

  // A folder that IS a tracked repo's root shows the repo's color (default
  // green) — real change letters (M/A/…) still win over it.
  const trackedColor = useVcsStore((s) =>
    entry.isDir ? repoColorForPath(s.repos, connId, entry.path) : null,
  );

  // Keep the selected row visible when the selection moves by keyboard.
  useEffect(() => {
    if (active) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // VS Code model: single click selects and opens a file as a *preview* tab
  // (italic; the next preview replaces it). Double-click opens it permanently
  // (or promotes the preview). Folders still toggle on single click.
  const handleClick = (e: React.MouseEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    onSelect({ ctrl, shift });
    if (!ctrl && !shift) {
      if (entry.isDir) onToggle();
      else onOpen({ preview: true });
    }
  };
  const handleDoubleClick = () => {
    if (!entry.isDir) onOpen({ preview: false });
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
      // Middle-click = open permanently (double-click semantics), VS Code
      // style; preventDefault suppresses the OS autoscroll gesture.
      onMouseDown={
        renaming
          ? undefined
          : (e) => {
              if (e.button === 1) e.preventDefault();
            }
      }
      onAuxClick={
        renaming
          ? undefined
          : (e) => {
              if (e.button === 1 && !entry.isDir) onOpen({ preview: false });
            }
      }
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
            style={!vcsDirect && trackedColor ? { color: trackedColor } : undefined}
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
