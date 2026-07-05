/** The editor tab bar. Click to switch, middle-click or × to close; a dirty tab
 *  shows a dot (which becomes × on hover). */
import { useAppStore } from "../../store/appStore";
import { FileIcon } from "../filetree/FileIcons";
import { IconClose } from "../icons";

const MD_RE = /\.(md|markdown)$/i;

export function EditorTabs() {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const openPreviewTab = useAppStore((s) => s.openPreviewTab);

  if (tabs.length === 0) return null;

  const active = tabs.find((t) => t.id === activeTabId);
  const canPreview =
    active && (!active.kind || active.kind === "file") && MD_RE.test(active.name);

  return (
    <div className="editor-tabs">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={[
            "editor-tab",
            tab.id === activeTabId ? "editor-tab--active" : "",
            tab.dirty ? "editor-tab--dirty" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={() => setActiveTab(tab.id)}
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
          <span className="editor-tab__icon">
            {tab.kind === "diff" ? (
              <span className="editor-tab__diff">±</span>
            ) : tab.kind === "log" ? (
              <span className="editor-tab__diff">⎇</span>
            ) : tab.kind === "merge" ? (
              <span className="editor-tab__diff">⚔</span>
            ) : tab.kind === "preview" ? (
              <span className="editor-tab__diff">¶</span>
            ) : (
              <FileIcon name={tab.name} isDir={false} isOpen={false} />
            )}
          </span>
          <span className="editor-tab__name">
            {tab.name}
            {tab.kind === "diff" ? " (changes)" : tab.kind === "merge" ? " (merge)" : ""}
          </span>
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
        </div>
      ))}
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
