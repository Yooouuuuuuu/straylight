/** Left sidebar: a multi-root explorer with a Local section (pinned folders) and
 *  a Remote section (the attached SSH host, or connect controls). */
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";

import { basename } from "../../lib/format";
import { useAppStore } from "../../store/appStore";
import { useSSH } from "../../hooks/useSSH";
import { ConnectionManager } from "../connection/ConnectionManager";
import { RootTree } from "../filetree/RootTree";
import {
  IconEye,
  IconEyeOff,
  IconLogout,
  IconPlus,
  IconRefresh,
} from "../icons";

export function Sidebar() {
  const showHidden = useAppStore((s) => s.showHidden);
  const toggleHidden = useAppStore((s) => s.toggleHidden);
  const refreshTree = useAppStore((s) => s.refreshTree);
  const localConnId = useAppStore((s) => s.localConnId);
  const pinnedFolders = useAppStore((s) => s.pinnedFolders);
  const addPinnedFolder = useAppStore((s) => s.addPinnedFolder);
  const removePinnedFolder = useAppStore((s) => s.removePinnedFolder);
  const remote = useAppStore((s) => s.remote);
  const remoteRootPath = useAppStore((s) => s.remoteRootPath);
  const { disconnect } = useSSH();

  async function openFolder() {
    const picked = await openFolderDialog({
      directory: true,
      multiple: false,
      title: "Open folder",
    });
    if (typeof picked === "string") addPinnedFolder(picked);
  }

  return (
    <div className="sidebar">
      <div className="sidebar__header">
        <span className="sidebar__title">Explorer</span>
        <div className="sidebar__actions">
          <button
            className={`icon-btn ${showHidden ? "icon-btn--active" : ""}`}
            title={showHidden ? "Hide hidden files" : "Show hidden files"}
            onClick={() => toggleHidden()}
          >
            {showHidden ? <IconEye /> : <IconEyeOff />}
          </button>
          <button
            className="icon-btn"
            title="Refresh (Ctrl+Shift+R)"
            onClick={() => refreshTree()}
          >
            <IconRefresh />
          </button>
        </div>
      </div>

      <div className="sidebar__content">
        {/* Local roots */}
        <div className="sidebar__section-head">
          <span>Local</span>
          <button
            className="icon-btn"
            title="Open a local folder"
            onClick={() => void openFolder()}
          >
            <IconPlus />
          </button>
        </div>
        {localConnId && pinnedFolders.length > 0 ? (
          pinnedFolders.map((path) => (
            <RootTree
              key={path}
              connId={localConnId}
              rootPath={path}
              label={basename(path) || path}
              color="#8be9fd"
              removable
              onRemove={() => removePinnedFolder(path)}
            />
          ))
        ) : (
          <div className="filetree__message">
            No folders yet — click + to open one.
          </div>
        )}

        {/* Remote root */}
        <div className="sidebar__section-head sidebar__section-head--remote">
          <span>Remote</span>
          {remote && (
            <button
              className="icon-btn icon-btn--danger"
              title="Disconnect"
              onClick={() => void disconnect()}
            >
              <IconLogout />
            </button>
          )}
        </div>
        {remote && remoteRootPath ? (
          <RootTree
            connId={remote.connId}
            rootPath={remoteRootPath}
            label={remote.name}
            color={remote.color}
          />
        ) : (
          <ConnectionManager />
        )}
      </div>
    </div>
  );
}
