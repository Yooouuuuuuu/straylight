/** Center editor region: the tab bar, and the body which shows the Monaco
 *  editor (for the active text tab), a binary info card, or an empty state.
 *  The editor stays mounted so per-tab models survive switching. */
import { useAppStore } from "../../store/appStore";
import { BinaryFileCard } from "../editor/BinaryFileCard";
import { EditorTabs } from "../editor/EditorTabs";
import { MonacoWrapper } from "../editor/MonacoWrapper";
import { MonacoDiffWrapper } from "../editor/MonacoDiffWrapper";
import { VcsLogView } from "../vcs/VcsLogView";

function EmptyState() {
  const busyPath = useAppStore((s) => s.busyPath);
  const openDialog = useAppStore((s) => s.openDialog);
  const remote = useAppStore((s) => s.remote);

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
      <div className="empty-state__title">Straylight</div>
      <div className="empty-state__hint">
        Open a local folder or connect to a server in the sidebar, then pick a
        file to view it.
        {remote ? (
          <>
            {" "}
            Toggle the terminal with <kbd>Ctrl</kbd> <kbd>`</kbd>.
          </>
        ) : null}
      </div>
      {!remote && (
        <button className="btn btn--primary" onClick={() => openDialog()}>
          Connect to a server
        </button>
      )}
    </div>
  );
}

export function EditorArea() {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const active = tabs.find((t) => t.id === activeTabId) ?? null;

  return (
    <div className="editor-area">
      <EditorTabs />
      <div className="editor-area__body">
        {active && !active.isBinary && active.truncated && (
          <div className="editor-banner">
            ⚠ This file was truncated to 50 MB.
          </div>
        )}
        <div className="editor-area__content">
          {tabs.length === 0 ? (
            <EmptyState />
          ) : (
            <>
              <MonacoWrapper />
              {active?.kind === "diff" ? (
                <MonacoDiffWrapper tab={active} />
              ) : active?.kind === "log" ? (
                <VcsLogView
                  connId={active.connId}
                  root={active.path}
                  backend={active.vcsBackend ?? "git"}
                />
              ) : (
                active?.isBinary && <BinaryFileCard file={active} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
