/** Center editor region: up to MAX_EDITOR_GROUPS side-by-side editor groups
 *  (splits), each with its own tab bar and body — Monaco, a diff, a merge
 *  editor, a Markdown preview, a repo history, a terminal, or a binary card.
 *  Tab models are global (lib/editorModels), so moving a tab between groups
 *  keeps its content, undo history, and dirty state. */
import { Fragment, useEffect, useRef } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

import appIcon from "../../assets/icon.png";

import { pruneModels } from "../../lib/editorModels";
import { focusTerminal } from "../../lib/terminalFocus";
import { mountTerminalIn, parkTerminal } from "../../lib/terminalSlots";
import { useAppStore } from "../../store/appStore";
import { BinaryFileCard } from "../editor/BinaryFileCard";
import { EditorTabs } from "../editor/EditorTabs";
import { MonacoWrapper } from "../editor/MonacoWrapper";
import { MonacoDiffWrapper } from "../editor/MonacoDiffWrapper";
import { MergeEditor } from "../editor/MergeEditor";
import { MarkdownPreview } from "../editor/MarkdownPreview";
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
      <img
        className="empty-state__logo"
        src={appIcon}
        width="64"
        height="64"
        alt=""
        aria-hidden
      />
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
      <div className="empty-state__keys">
        <div>
          <span>Show all commands</span>
          <kbd>Ctrl+Shift+P</kbd>
        </div>
        <div>
          <span>Quick-open a file</span>
          <kbd>Ctrl+P</kbd>
        </div>
        <div>
          <span>Search in files</span>
          <kbd>Ctrl+Shift+F</kbd>
        </div>
        <div>
          <span>Toggle terminal</span>
          <kbd>Ctrl+`</kbd>
        </div>
      </div>
    </div>
  );
}

/** Hosts a terminal session inside an editor pane by reparenting its live
 *  xterm DOM (see lib/terminalSlots) — the shell never restarts. */
function TerminalTabHost({ terminalId }: { terminalId: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (ref.current) mountTerminalIn(terminalId, ref.current);
    focusTerminal(terminalId);
    return () => parkTerminal(terminalId);
  }, [terminalId]);
  return <div className="terminal-editor-host" ref={ref} />;
}

function GroupPane({ gid }: { gid: number }) {
  const activeId = useAppStore((s) => s.groupActive[gid] ?? null);
  const active = useAppStore(
    (s) => s.tabs.find((t) => t.id === activeId) ?? null,
  );
  const isFocused = useAppStore(
    (s) => s.activeGroupId === gid && s.editorGroups.length > 1,
  );
  const setActiveGroup = useAppStore((s) => s.setActiveGroup);

  return (
    <div
      className={`editor-group ${isFocused ? "editor-group--focused" : ""}`}
      onMouseDownCapture={() => setActiveGroup(gid)}
      onFocusCapture={() => setActiveGroup(gid)}
    >
      <EditorTabs groupId={gid} />
      <div className="editor-area__body">
        {active && !active.isBinary && active.truncated && (
          <div className="editor-banner">
            ⚠ This file was truncated to 50 MB.
          </div>
        )}
        <div className="editor-area__content">
          <MonacoWrapper groupId={gid} />
          {active?.kind === "diff" ? (
            <MonacoDiffWrapper tab={active} />
          ) : active?.kind === "merge" ? (
            <MergeEditor key={active.id} tab={active} />
          ) : active?.kind === "preview" ? (
            <MarkdownPreview key={active.id} tab={active} />
          ) : active?.kind === "log" ? (
            <VcsLogView
              connId={active.connId}
              root={active.path}
              backend={active.vcsBackend ?? "git"}
            />
          ) : active?.kind === "terminal" && active.terminalId ? (
            <TerminalTabHost terminalId={active.terminalId} />
          ) : (
            active?.isBinary && <BinaryFileCard file={active} />
          )}
        </div>
      </div>
    </div>
  );
}

export function EditorArea() {
  const groups = useAppStore((s) => s.editorGroups);
  const tabs = useAppStore((s) => s.tabs);

  // Dispose Monaco models whose tabs are gone (the registry is global).
  useEffect(() => {
    pruneModels(new Set(tabs.map((t) => t.id)));
  }, [tabs]);

  if (tabs.length === 0) {
    return (
      <div className="editor-area">
        <div className="editor-area__body">
          <div className="editor-area__content">
            <EmptyState />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="editor-area">
      <PanelGroup direction="horizontal" className="editor-area__groups">
        {groups.map((gid, i) => (
          <Fragment key={gid}>
            {i > 0 && <PanelResizeHandle className="resize-handle" />}
            <Panel id={`group-${gid}`} order={i + 1} minSize={15}>
              <GroupPane gid={gid} />
            </Panel>
          </Fragment>
        ))}
      </PanelGroup>
    </div>
  );
}
