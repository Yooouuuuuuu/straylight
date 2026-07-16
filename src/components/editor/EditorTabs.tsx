/** The editor tab bar. Click to switch, middle-click or × to close; a dirty tab
 *  shows a dot (which becomes × on hover). WSL/remote tabs carry a host-color
 *  top stripe so "whose file is this" reads at a glance (local stays plain;
 *  the bottom line is reserved for the picked mark).
 *  Tabs are draggable: within a strip to reorder, onto another strip to move
 *  groups, or onto the editor's right edge to create a new split. */
import { useEffect, useRef, useState } from "react";

import { tabHostColor } from "../../lib/hostColors";
import { TAB_DRAG_MIME, useAppStore } from "../../store/appStore";
import { FileIcon } from "../filetree/FileIcons";
import { IconClose } from "../icons";

export function EditorTabs({ groupId }: { groupId: number }) {
  const allTabs = useAppStore((s) => s.tabs);
  const tabs = allTabs.filter((t) => (t.groupId ?? 0) === groupId);
  const activeTabId = useAppStore((s) => s.groupActive[groupId] ?? null);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const promoteTab = useAppStore((s) => s.promoteTab);
  const pinTab = useAppStore((s) => s.pinTab);
  const openTabMenu = useAppStore((s) => s.openTabMenu);
  const moveTabToPosition = useAppStore((s) => s.moveTabToPosition);
  // Subscribed so tab markers re-render when hosts/colors change.
  useAppStore((s) => s.hostColors);
  useAppStore((s) => s.remotes);
  useAppStore((s) => s.wsls);
  /** Tab currently hovered by a tab drag (insertion indicator). */
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // The scroll lane exists only when tabs actually overflow — the strip grows
  // 12px (below the rail) instead of squeezing the tabs.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const check = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs]);

  if (tabs.length === 0) return null;

  return (
    <div
      ref={stripRef}
      className={`editor-tabs ${overflowing ? "editor-tabs--overflow" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(TAB_DRAG_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(TAB_DRAG_MIME);
        setDropTarget(null);
        if (id) {
          e.preventDefault();
          moveTabToPosition(id, groupId, null); // strip background = group end
        }
      }}
    >
      {tabs.map((tab) => {
        const hostColor = tabHostColor(tab.connId);
        return (
        <div
          key={tab.id}
          className={[
            "editor-tab",
            tab.id === activeTabId ? "editor-tab--active" : "",
            tab.dirty ? "editor-tab--dirty" : "",
            tab.pinned ? "editor-tab--pinned" : "",
            hostColor ? "editor-tab--host" : "",
            dropTarget === tab.id ? "editor-tab--drop" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          style={
            {
              // The picked-mark is always the tab's HOST color (local = the
              // Local section color) — one rule for files and terminals alike.
              "--tab-mark": hostColor ?? "var(--section-local)",
              ...(hostColor ? { "--tab-host-color": hostColor } : {}),
            } as React.CSSProperties
          }
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(TAB_DRAG_MIME, tab.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes(TAB_DRAG_MIME)) {
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = "move";
              setDropTarget(tab.id);
            }
          }}
          onDragLeave={() =>
            setDropTarget((cur) => (cur === tab.id ? null : cur))
          }
          onDrop={(e) => {
            const id = e.dataTransfer.getData(TAB_DRAG_MIME);
            setDropTarget(null);
            if (id && id !== tab.id) {
              e.preventDefault();
              e.stopPropagation();
              moveTabToPosition(id, groupId, tab.id);
            }
          }}
          onClick={() => setActiveTab(tab.id)}
          onDoubleClick={() => promoteTab(tab.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            openTabMenu(event.clientX, event.clientY, tab.id);
          }}
          onMouseDown={(event) => {
            if (event.button === 1) {
              event.preventDefault();
              closeTab(tab.id);
            }
          }}
          title={
            tab.kind === "diff"
              ? `${tab.path} (changes)`
              : tab.kind === "merge"
                ? `${tab.path} (merge)`
                : tab.path
          }
        >
          <span
            className="editor-tab__icon"
            onClick={
              tab.pinned
                ? (e) => {
                    e.stopPropagation();
                    pinTab(tab.id, false);
                  }
                : undefined
            }
            title={tab.pinned ? "Pinned — click the icon to unpin" : undefined}
          >
            {tab.pinned && (
              <svg
                className="editor-tab__pinbadge"
                width="11"
                height="11"
                viewBox="0 0 12 12"
                aria-hidden
              >
                <circle cx="6" cy="6" r="5.5" fill="var(--bg-secondary)" />
                <circle cx="6" cy="6" r="3" stroke="var(--pin, var(--pink))" strokeWidth="1.2" fill="none" />
                <path
                  d="M6 0.8v2.2M6 9v2.2M0.8 6h2.2M9 6h2.2"
                  stroke="var(--pin, var(--pink))"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
                <circle cx="6" cy="6" r="0.9" fill="var(--pin, var(--pink))" />
              </svg>
            )}
            {tab.kind === "diff" ? (
              <span className="editor-tab__diff">±</span>
            ) : tab.kind === "log" ? (
              <span className="editor-tab__diff">⎇</span>
            ) : tab.kind === "merge" ? (
              <span className="editor-tab__diff">⚔</span>
            ) : tab.kind === "preview" ? (
              <span className="editor-tab__diff">¶</span>
            ) : tab.kind === "settings" || tab.kind === "themes" ? (
              <span className="editor-tab__diff">⚙</span>
            ) : (
              <FileIcon name={tab.name} isDir={false} isOpen={false} />
            )}
          </span>
          <span
            className={`editor-tab__name ${tab.previewTab ? "editor-tab__name--preview" : ""}`}
          >
            {tab.name}
            {tab.kind === "diff" ? " (changes)" : tab.kind === "merge" ? " (merge)" : ""}
          </span>
          {tab.pinned ? (
            // Pinned tabs have no close button, but a dirty pinned tab still
            // needs its unsaved dot — same slot, non-interactive.
            tab.dirty ? (
              <span
                className="editor-tab__close editor-tab__close--pinned"
                aria-hidden
              >
                <span className="editor-tab__dot" />
              </span>
            ) : null
          ) : (
            <button
              className="editor-tab__close"
              title="Close"
              onClick={(event) => {
                event.stopPropagation();
                closeTab(tab.id);
              }}
            >
              <span className="editor-tab__dot" />
              <span className="editor-tab__x">
                <IconClose size={12} />
              </span>
            </button>
          )}
        </div>
        );
      })}
    </div>
  );
}
