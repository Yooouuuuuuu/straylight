/** The editor tab bar. Click to switch, middle-click or × to close; a dirty tab
 *  shows a dot (which becomes × on hover). */
import { useAppStore } from "../../store/appStore";
import { FileIcon } from "../filetree/FileIcons";
import { IconClose } from "../icons";

export function EditorTabs() {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const closeTab = useAppStore((s) => s.closeTab);

  if (tabs.length === 0) return null;

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
          title={tab.path}
        >
          <span className="editor-tab__icon">
            <FileIcon name={tab.name} isDir={false} isOpen={false} />
          </span>
          <span className="editor-tab__name">{tab.name}</span>
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
    </div>
  );
}
