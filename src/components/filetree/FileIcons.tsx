/** File-tree node icons: a folder glyph (open/closed) and a tinted document
 *  glyph colored by file type. */
import {
  DEFAULT_FILE_COLOR,
  FOLDER_COLOR,
  FOLDER_OPEN_COLOR,
  fileIconColor,
} from "../../lib/fileIcons";

function FolderGlyph({ open }: { open: boolean }) {
  const color = open ? FOLDER_OPEN_COLOR : FOLDER_COLOR;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M1.5 4c0-.55.45-1 1-1h3.3c.27 0 .52.1.71.29L7.7 4.5h6.3c.55 0 1 .45 1 1v6.5c0 .55-.45 1-1 1h-12c-.55 0-1-.45-1-1V4Z"
        fill={color}
        fillOpacity={open ? 0.32 : 0.85}
        stroke={color}
        strokeWidth="0.75"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FileGlyph({ name }: { name: string }) {
  const color = fileIconColor(name) || DEFAULT_FILE_COLOR;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M3.5 2.5c0-.41.34-.75.75-.75h4.69c.2 0 .39.08.53.22l3.06 3.06c.14.14.22.33.22.53V13.5c0 .41-.34.75-.75.75H4.25a.75.75 0 0 1-.75-.75v-11Z"
        fill={color}
        fillOpacity="0.16"
        stroke={color}
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <path
        d="M9 1.9v3.1c0 .3.25.55.55.55h3"
        fill="none"
        stroke={color}
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function FileIcon({
  name,
  isDir,
  isOpen,
}: {
  name: string;
  isDir: boolean;
  isOpen: boolean;
}) {
  return isDir ? <FolderGlyph open={isOpen} /> : <FileGlyph name={name} />;
}
