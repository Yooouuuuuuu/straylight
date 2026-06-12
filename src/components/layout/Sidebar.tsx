/** Left sidebar. Shows the connection manager when disconnected and the remote
 *  file tree once connected, with hidden-file and refresh controls. */
import { useAppStore } from "../../store/appStore";
import { useSSH } from "../../hooks/useSSH";
import { ConnectionManager } from "../connection/ConnectionManager";
import { FileTree } from "../filetree/FileTree";
import { IconEye, IconEyeOff, IconLogout, IconPlug, IconRefresh } from "../icons";

export function Sidebar() {
  const connection = useAppStore((s) => s.connection);
  const showHidden = useAppStore((s) => s.showHidden);
  const toggleHidden = useAppStore((s) => s.toggleHidden);
  const refreshTree = useAppStore((s) => s.refreshTree);
  const openDialog = useAppStore((s) => s.openDialog);
  const { disconnect } = useSSH();

  return (
    <div className="sidebar">
      <div className="sidebar__header">
        <span className="sidebar__title">
          {connection ? `Explorer — ${connection.name}` : "Connections"}
        </span>
        <div className="sidebar__actions">
          {connection ? (
            <>
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
              <button
                className="icon-btn icon-btn--danger"
                title="Disconnect"
                onClick={() => void disconnect()}
              >
                <IconLogout />
              </button>
            </>
          ) : (
            <button
              className="icon-btn"
              title="New connection"
              onClick={() => openDialog()}
            >
              <IconPlug />
            </button>
          )}
        </div>
      </div>
      <div className="sidebar__content">
        {connection ? <FileTree /> : <ConnectionManager />}
      </div>
    </div>
  );
}
