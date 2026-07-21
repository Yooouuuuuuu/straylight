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

import {
  compareWithSaved,
  discardToServer,
  overwriteConflict,
} from "../../lib/saveFile";
import { pruneModels } from "../../lib/editorModels";
import { tabHostColor } from "../../lib/hostColors";
import { useVcsStore } from "../../store/vcsStore";
import { useAppStore } from "../../store/appStore";
import { IconClose } from "../icons";
import { SettingsView } from "../settings/SettingsView";
import { AutoConnectView, DraftsView, PinsView } from "../settings/StorageViews";
import { ThemesView } from "../settings/ThemesView";
import { BinaryFileCard } from "../editor/BinaryFileCard";
import { EditorTabs } from "../editor/EditorTabs";
import { MonacoWrapper } from "../editor/MonacoWrapper";
import { MonacoDiffWrapper } from "../editor/MonacoDiffWrapper";
import { MergeEditor } from "../editor/MergeEditor";
import { MarkdownPreview } from "../editor/MarkdownPreview";
import { VcsLogTabHead, VcsLogView } from "../vcs/VcsLogView";
import { Tip } from "../Tooltip";

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
        width="144"
        height="144"
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
  // Non-local files lead with a host chip (local stays plain, matching the
  // tab-stripe convention) — two hosts' identical paths stop looking alike.
  const host = useAppStore((s) => {
    if (connId === s.localConnId) return null;
    const w = s.wsls.find((x) => x.conn.connId === connId);
    if (w) return w.conn.name;
    return s.remotes.find((r) => r.conn.connId === connId)?.conn.name ?? null;
  });
  const hostColor = host ? tabHostColor(connId) : null;

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
    <div className="editor-crumbs">
      {host && (
        <>
          <span
            className="editor-crumbs__host"
            style={hostColor ? { color: hostColor } : undefined}
          >
            {host}
          </span>
          {/* » — everything after this is relative to the host, not a path
              parent (those use ›). */}
          <span className="editor-crumbs__sep">»</span>
        </>
      )}
      {segments.map((seg, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="editor-crumbs__sep">›</span>}
          {i === segments.length - 1 ? (
            <Tip label={host ? `${host}: ${path}` : path}>
              <span className="editor-crumbs__leaf">{seg}</span>
            </Tip>
          ) : (
            <span>{seg}</span>
          )}
        </Fragment>
      ))}
      {tab.dirty && !tab.conflict && (!tab.kind || tab.kind === "file") && (
        <Tip label="Compare with the saved file">
          <button
            className="editor-crumbs__action"
            onClick={() => void compareWithSaved(tab.id)}
          >
            ⇄ Compare
          </button>
        </Tip>
      )}
      {canPreview && (
        <Tip label="Markdown preview (Ctrl+Shift+V)">
          <button
            className="editor-crumbs__action"
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
        </Tip>
      )}
    </div>
  );
}

function GroupPane({ gid, splitDrop }: { gid: number; splitDrop: boolean }) {
  const activeId = useAppStore((s) => s.groupActive[gid] ?? null);
  const active = useAppStore(
    (s) => s.tabs.find((t) => t.id === activeId) ?? null,
  );
  const askConfirm = useVcsStore((s) => s.askConfirm);
  const multi = useAppStore((s) => s.editorGroups.length > 1);
  const isFocused = useAppStore((s) => s.activeGroupId === gid);
  const setActiveGroup = useAppStore((s) => s.setActiveGroup);
  const splitRight = useAppStore((s) => s.splitRight);
  const isEmpty = useAppStore(
    (s) => !s.tabs.some((t) => (t.groupId ?? 0) === gid),
  );
  const closeGroup = useAppStore((s) => s.closeGroup);
  const requestEditorFocus = useAppStore((s) => s.requestEditorFocus);
  const moveTabToGroup = useAppStore((s) => s.moveTabToGroup);
  const [emptyDragOver, setEmptyDragOver] = useState(false);

  // A focused EMPTY pane must swallow the keyboard — otherwise the previous
  // editor keeps DOM focus and typing lands in another group's file.
  const emptyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (multi && isEmpty && isFocused) emptyRef.current?.focus();
  }, [multi, isEmpty, isFocused]);

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
        {/* An intentionally empty split: just the mark, plus its own close.
            (A lone empty group shows the welcome screen instead.) */}
        {multi && isEmpty && (
          <div
            className={`editor-group__empty${emptyDragOver ? " editor-group__empty--drop" : ""}`}
            ref={emptyRef}
            tabIndex={-1}
            // An empty pane IS a drop target: drag a tab in to move it here.
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(TAB_DRAG_MIME)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setEmptyDragOver(true);
              }
            }}
            onDragLeave={() => setEmptyDragOver(false)}
            onDrop={(e) => {
              setEmptyDragOver(false);
              const id = e.dataTransfer.getData(TAB_DRAG_MIME);
              if (id) {
                e.preventDefault();
                moveTabToGroup(id, gid);
              }
            }}
          >
            <Tip label="Close this split">
              <button
                className="icon-btn editor-group__emptyclose"
                onClick={() => {
                  closeGroup(gid);
                  requestEditorFocus(); // hand the cursor to the neighbor
                }}
              >
                <IconClose size={14} />
              </button>
            </Tip>
            <img src={appIcon} width="96" height="96" alt="" aria-hidden />
          </div>
        )}
        {active && !active.isBinary && active.truncated && (
          <div className="editor-banner">
            ⚠ Showing the first 50 MB — read-only. Edit files this large on the
            host, in the terminal.
          </div>
        )}
        {active && !active.isBinary && !active.truncated && active.lossy && (
          <div className="editor-banner">
            ⚠ Not valid UTF-8 — shown with � replacements; saving is disabled to
            protect the original bytes.
          </div>
        )}
        {/* Conflict bar: your buffer diverges from a server copy that changed
            under you (a save-time conflict, a guard refusal, or a restored
            draft whose file moved). Ctrl+S is blocked; the only ways out are
            Overwrite / Discard, each confirmed. */}
        {active &&
          (!active.kind || active.kind === "file") &&
          active.conflict && (
            <div className="editor-banner">
              ⚠ {active.name} changed on the server since you opened it — saving
              is blocked until you resolve this.
              <span className="editor-banner__spacer" />
              <Tip label="Diff yours ⇄ server">
                <button
                  className="editor-banner__act"
                  onClick={() => void compareWithSaved(active.id)}
                >
                  Compare
                </button>
              </Tip>
              <Tip label="Your version wins">
                <button
                  className="editor-banner__act"
                  onClick={() =>
                    askConfirm(
                      "Overwrite the server's version?",
                      `${active.name} was changed on the server. Overwrite it with your version? Their change will be lost.`,
                      () => void overwriteConflict(active.id),
                    )
                  }
                >
                  Overwrite
                </button>
              </Tip>
              <Tip label="Drop your changes, load the server's">
                <button
                  className="editor-banner__act"
                  onClick={() =>
                    askConfirm(
                      "Discard your changes?",
                      `Throw away your unsaved changes to ${active.name} and load the version on the server?`,
                      () => void discardToServer(active.id),
                    )
                  }
                >
                  Discard
                </button>
              </Tip>
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
          ) : active?.kind === "settings" ? (
            <SettingsView />
          ) : active?.kind === "themes" ? (
            <ThemesView />
          ) : active?.kind === "pins" ? (
            <PinsView />
          ) : active?.kind === "drafts" ? (
            <DraftsView />
          ) : active?.kind === "autoconnect" ? (
            <AutoConnectView />
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
  // drop zone must not exist outside a drag or it would block clicks. The
  // flag also clears on DROP: a drop that moves the tab unmounts the drag
  // SOURCE, whose dragend then never fires — the zone would stick on screen.
  useEffect(() => {
    const start = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes(TAB_DRAG_MIME)) setTabDrag(true);
    };
    // Clear DEFERRED: clearing during capture would flush React between the
    // event's listeners and unmount the drop zone before its own onDrop ever
    // ran (React delivers it at the bubble phase).
    const end = () => window.setTimeout(() => setTabDrag(false), 0);
    window.addEventListener("dragstart", start);
    window.addEventListener("dragend", end);
    // CAPTURE phase: drop handlers (tab strips) stopPropagation, which would
    // eat the bubble — and when that drop closes the source's group, dragend
    // never fires either. Capture runs before any of them can stop it.
    window.addEventListener("drop", end, true);
    return () => {
      window.removeEventListener("dragstart", start);
      window.removeEventListener("dragend", end);
      window.removeEventListener("drop", end, true);
    };
  }, []);

  // The full welcome screen owns the area only while it's a SINGLE empty
  // group — with splits present, empty groups render as panes (app icon + ✕)
  // so Ctrl+2 / Ctrl+\ work from an empty workspace too.
  if (tabs.length === 0 && groups.length === 1) {
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
                // The split target lives on the LAST group's right half. It
                // exists to CREATE — with an empty pane already open, that
                // pane is the drop target and the zone stays away.
                splitDrop={
                  tabDrag &&
                  groups.length < MAX_EDITOR_GROUPS &&
                  i === groups.length - 1 &&
                  !groups.some(
                    (g) => !tabs.some((t) => (t.groupId ?? 0) === g),
                  )
                }
              />
            </Panel>
          </Fragment>
        ))}
      </PanelGroup>
    </div>
  );
}
