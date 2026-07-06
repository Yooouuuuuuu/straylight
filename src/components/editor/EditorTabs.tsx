/** The editor tab bar. Click to switch, middle-click or × to close; a dirty tab
 *  shows a dot (which becomes × on hover). WSL/remote tabs carry a host-color
 *  underline so "whose file is this" reads at a glance (local stays plain). */
import { tabHostColor } from "../../lib/hostColors";
import { useAppStore } from "../../store/appStore";
import { FileIcon } from "../filetree/FileIcons";
import { IconClose } from "../icons";

const MD_RE = /\.(md|markdown)$/i;

export function EditorTabs({ groupId }: { groupId: number }) {
  const allTabs = useAppStore((s) => s.tabs);
  const tabs = allTabs.filter((t) => (t.groupId ?? 0) === groupId);
  const activeTabId = useAppStore((s) => s.groupActive[groupId] ?? null);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const openPreviewTab = useAppStore((s) => s.openPreviewTab);
  const promoteTab = useAppStore((s) => s.promoteTab);
  const pinTab = useAppStore((s) => s.pinTab);
  const openTabMenu = useAppStore((s) => s.openTabMenu);
  // Subscribed so tab markers re-render when hosts/colors change.
  useAppStore((s) => s.hostColors);
  useAppStore((s) => s.remote?.connId);
  useAppStore((s) => s.wsl?.connId);

  if (tabs.length === 0) return null;

  const active = tabs.find((t) => t.id === activeTabId);
  const canPreview =
    active && (!active.kind || active.kind === "file") && MD_RE.test(active.name);

  return (
    <div className="editor-tabs">
      {tabs.map((tab) => {
        const hostColor = tabHostColor(tab.connId);
        return (
        <div
          key={tab.id}
          className={[
            "editor-tab",
            tab.id === activeTabId ? "editor-tab--active" : "",
            tab.dirty ? "editor-tab--dirty" : "",
            hostColor ? "editor-tab--host" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          style={
            hostColor
              ? ({ "--tab-host-color": hostColor } as React.CSSProperties)
              : undefined
          }
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
                : tab.kind === "terminal"
                  ? `${tab.name} — terminal (closing returns it to the panel)`
                  : tab.path
          }
        >
          <span className="editor-tab__icon">
            {tab.kind === "diff" ? (
              <span className="editor-tab__diff">±</span>
            ) : tab.kind === "log" ? (
              <span className="editor-tab__diff">⎇</span>
            ) : tab.kind === "merge" ? (
              <span className="editor-tab__diff">⚔</span>
            ) : tab.kind === "preview" ? (
              <span className="editor-tab__diff">¶</span>
            ) : tab.kind === "terminal" ? (
              <span className="editor-tab__diff">{">_"}</span>
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
            <button
              className="editor-tab__close editor-tab__pin"
              title="Pinned — click to unpin"
              onClick={(event) => {
                event.stopPropagation();
                pinTab(tab.id, false);
              }}
            >
              ⊙
            </button>
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
      {canPreview && active && (
        <button
          className="editor-tabs__action"
          title="Open Markdown preview (Ctrl+Shift+V)"
          onClick={() =>
            openPreviewTab({
              connId: active.connId,
              path: active.path,
              name: `${active.name} (preview)`,
              content: active.content,
            })
          }
        >
          ¶ Preview
        </button>
      )}
    </div>
  );
}
