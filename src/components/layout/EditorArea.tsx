/** Center editor region: up to MAX_EDITOR_GROUPS side-by-side editor groups
 *  (splits), each with its own tab bar and body — Monaco, a diff, a merge
 *  editor, a Markdown preview, a repo history, a terminal, or a binary card.
 *  Tab models are global (lib/editorModels), so moving a tab between groups
 *  keeps its content, undo history, and dirty state. */
import { Fragment, useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

import appIcon from "../../assets/icon.png";
import {
  MAX_EDITOR_GROUPS,
  TAB_DRAG_MIME,
  type EditorTab,
} from "../../store/appStore";

import { pruneModels } from "../../lib/editorModels";
import { focusTerminal } from "../../lib/terminalFocus";
import { mountTerminalIn, parkTerminal } from "../../lib/terminalSlots";
import { useAppStore } from "../../store/appStore";
import { SettingsView } from "../settings/SettingsView";
import { ThemesView } from "../settings/ThemesView";
import { BinaryFileCard } from "../editor/BinaryFileCard";
import { EditorTabs } from "../editor/EditorTabs";
import { MonacoWrapper } from "../editor/MonacoWrapper";
import { MonacoDiffWrapper } from "../editor/MonacoDiffWrapper";
import { MergeEditor } from "../editor/MergeEditor";
import { MarkdownPreview } from "../editor/MarkdownPreview";
import { VcsLogTabHead, VcsLogView } from "../vcs/VcsLogView";

function EmptyState() {
  const busyPath = useAppStore((s) => s.busyPath);

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
      <div className="empty-state__title">Welcome to Straylight</div>
      <div className="empty-state__hint">
        Pin a folder in the explorer — Local, WSL, or a remote server — then
        open a file to start.
      </div>
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
        <div>
          <span>Toggle the sidebar</span>
          <kbd>Ctrl+B</kbd>
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

/** VS Code-style breadcrumb: the file's path relative to its pinned folder
 *  (`pin › sub › file`), falling back to the full path for unpinned files.
 *  Doubles as the home of per-file actions (¶ Preview for Markdown). The
 *  symbol trail VS Code appends needs LSP symbols — sticky scroll covers the
 *  "which block am I in" need instead. */
const MD_RE = /\.(md|markdown)$/i;

function EditorBreadcrumbs({ tab }: { tab: EditorTab }) {
  const openPreviewTab = useAppStore((s) => s.openPreviewTab);
  const { connId, path } = tab;
  const pins = useAppStore((s) => {
    if (connId === s.localConnId) return s.pinnedFolders;
    const w = s.wsls.find((x) => x.conn.connId === connId);
    if (w) return w.pins;
    return s.remotes.find((r) => r.conn.connId === connId)?.pins ?? [];
  });

  const norm = path.replace(/\\/g, "/").replace(/\/+$/, "");
  let segments: string[] | null = null;
  // Longest matching pin wins (a pin inside another pin).
  const candidates = pins
    .map((p) => p.replace(/\\/g, "/").replace(/\/+$/, ""))
    .filter((p) => norm === p || norm.startsWith(`${p}/`))
    .sort((a, b) => b.length - a.length);
  if (candidates.length > 0) {
    const pin = candidates[0];
    const pinName = pin.slice(pin.lastIndexOf("/") + 1) || pin;
    const rel = norm.slice(pin.length).replace(/^\//, "");
    segments = [pinName, ...(rel ? rel.split("/") : [])];
  } else {
    segments = norm.split("/").filter(Boolean);
  }
  if (segments.length === 0) return null;

  const canPreview =
    (!tab.kind || tab.kind === "file") && MD_RE.test(tab.name);

  return (
    <div className="editor-crumbs" title={path}>
      {segments.map((seg, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="editor-crumbs__sep">›</span>}
          <span
            className={
              i === segments.length - 1 ? "editor-crumbs__leaf" : undefined
            }
          >
            {seg}
          </span>
        </Fragment>
      ))}
      {canPreview && (
        <button
          className="editor-crumbs__action"
          title="Open Markdown preview (Ctrl+Shift+V)"
          onClick={() =>
            openPreviewTab({
              connId: tab.connId,
              path: tab.path,
              name: `${tab.name} (preview)`,
              content: tab.content,
            })
          }
        >
          ¶ Preview
        </button>
      )}
    </div>
  );
}

function GroupPane({ gid, splitDrop }: { gid: number; splitDrop: boolean }) {
  const activeId = useAppStore((s) => s.groupActive[gid] ?? null);
  const active = useAppStore(
    (s) => s.tabs.find((t) => t.id === activeId) ?? null,
  );
  const multi = useAppStore((s) => s.editorGroups.length > 1);
  const isFocused = useAppStore((s) => s.activeGroupId === gid);
  const setActiveGroup = useAppStore((s) => s.setActiveGroup);
  const splitRight = useAppStore((s) => s.splitRight);

  return (
    <div
      className={[
        "editor-group",
        multi ? "editor-group--multi" : "",
        multi && isFocused ? "editor-group--focused" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onMouseDownCapture={() => setActiveGroup(gid)}
      onFocusCapture={() => setActiveGroup(gid)}
    >
      {splitDrop && (
        <div
          className="editor-split-drop"
          title="Drop to open in a new split"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={(e) => {
            const id = e.dataTransfer.getData(TAB_DRAG_MIME);
            if (id) {
              e.preventDefault();
              splitRight(id, { end: true });
            }
          }}
        >
          ⧉
        </div>
      )}
      <EditorTabs groupId={gid} />
      {active && (!active.kind || active.kind === "file" || active.kind === "diff" || active.kind === "merge") && (
        <EditorBreadcrumbs tab={active} />
      )}
      <div className="editor-area__body">
        {active && !active.isBinary && active.truncated && (
          <div className="editor-banner">
            ⚠ This file was truncated to 50 MB — saving is disabled to protect it.
          </div>
        )}
        {active && !active.isBinary && !active.truncated && active.lossy && (
          <div className="editor-banner">
            ⚠ Not valid UTF-8 — shown with � replacements; saving is disabled to
            protect the original bytes.
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
            <div className="vcs-logtab">
              <VcsLogTabHead
                connId={active.connId}
                root={active.path}
                backend={active.vcsBackend ?? "git"}
              />
              <div className="vcs-logtab__body">
                <VcsLogView
                  connId={active.connId}
                  root={active.path}
                  backend={active.vcsBackend ?? "git"}
                />
              </div>
            </div>
          ) : active?.kind === "terminal" && active.terminalId ? (
            <TerminalTabHost terminalId={active.terminalId} />
          ) : active?.kind === "settings" ? (
            <SettingsView />
          ) : active?.kind === "themes" ? (
            <ThemesView />
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
  /** A tab drag is in flight — show the "drop to split" zone. */
  const [tabDrag, setTabDrag] = useState(false);

  // Dispose Monaco models whose tabs are gone (the registry is global).
  useEffect(() => {
    pruneModels(new Set(tabs.map((t) => t.id)));
  }, [tabs]);

  // Track tab drags globally (dragstart bubbles from the tab element); the
  // drop zone must not exist outside a drag or it would block clicks.
  useEffect(() => {
    const start = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes(TAB_DRAG_MIME)) setTabDrag(true);
    };
    const end = () => setTabDrag(false);
    window.addEventListener("dragstart", start);
    window.addEventListener("dragend", end);
    window.addEventListener("drop", end);
    return () => {
      window.removeEventListener("dragstart", start);
      window.removeEventListener("dragend", end);
      window.removeEventListener("drop", end);
    };
  }, []);

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
            {i > 0 && (
              <PanelResizeHandle
                id={`group-handle-${gid}`}
                className="resize-handle"
              />
            )}
            <Panel id={`group-${gid}`} order={i + 1} minSize={15}>
              <GroupPane
                gid={gid}
                // The split target lives on the LAST group's right half.
                splitDrop={
                  tabDrag &&
                  groups.length < MAX_EDITOR_GROUPS &&
                  i === groups.length - 1
                }
              />
            </Panel>
          </Fragment>
        ))}
      </PanelGroup>
    </div>
  );
}
