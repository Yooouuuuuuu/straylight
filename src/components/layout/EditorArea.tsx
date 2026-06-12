/** Center editor region: the header (file name + path), and the body which
 *  shows the Monaco editor, a binary info card, or an empty state. */
import { useAppStore } from "../../store/appStore";
import { BinaryFileCard } from "../editor/BinaryFileCard";
import { MonacoWrapper } from "../editor/MonacoWrapper";

function EmptyState() {
  const connection = useAppStore((s) => s.connection);
  const busyPath = useAppStore((s) => s.busyPath);
  const openDialog = useAppStore((s) => s.openDialog);

  if (busyPath) {
    return (
      <div className="empty-state">
        <span className="spinner" />
        <div className="empty-state__hint">Opening file…</div>
      </div>
    );
  }

  return (
    <div className="empty-state">
      <svg
        className="empty-state__logo"
        viewBox="0 0 16 16"
        width="64"
        height="64"
        aria-hidden
      >
        <rect width="16" height="16" rx="4" fill="#bd93f9" />
        <path
          d="M10.4 5.4c-.5-.6-1.3-1-2.3-1-1.4 0-2.4.7-2.4 1.8 0 1 .7 1.5 2 1.8l.8.2c.7.2 1 .4 1 .8 0 .5-.5.8-1.2.8-.8 0-1.4-.3-1.8-.9l-1.2.8c.6.9 1.6 1.4 2.9 1.4 1.6 0 2.7-.8 2.7-2 0-1-.6-1.6-2-1.9l-.8-.2c-.7-.2-1-.4-1-.8 0-.4.4-.7 1.1-.7.7 0 1.2.3 1.5.8l1.2-.8Z"
          fill="#282A36"
        />
      </svg>
      {connection ? (
        <>
          <div className="empty-state__title">No file open</div>
          <div className="empty-state__hint">
            Select a file in the explorer to view it. Toggle the terminal with{" "}
            <kbd>Ctrl</kbd> <kbd>`</kbd>.
          </div>
        </>
      ) : (
        <>
          <div className="empty-state__title">Welcome to Straylight</div>
          <div className="empty-state__hint">
            Connect to a server to browse files, read code, and use a terminal.
          </div>
          <button className="btn btn--primary" onClick={() => openDialog()}>
            Connect to a server
          </button>
        </>
      )}
    </div>
  );
}

export function EditorArea() {
  const openFile = useAppStore((s) => s.openFile);

  return (
    <div className="editor-area">
      <div className="editor-area__header">
        {openFile ? (
          <>
            <span className="editor-area__name">{openFile.name}</span>
            <span className="editor-area__path">{openFile.path}</span>
          </>
        ) : (
          <span className="editor-area__path">No file open</span>
        )}
      </div>
      <div className="editor-area__body">
        {openFile?.truncated && (
          <div className="editor-banner">
            ⚠ This file was truncated to 50 MB.
          </div>
        )}
        <div className="editor-area__content">
          {!openFile ? (
            <EmptyState />
          ) : openFile.isBinary ? (
            <BinaryFileCard file={openFile} />
          ) : (
            <MonacoWrapper file={openFile} />
          )}
        </div>
      </div>
    </div>
  );
}
