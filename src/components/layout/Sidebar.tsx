/** Left sidebar: a multi-root explorer with a Local section (pinned folders) and
 *  a Remote section (the attached SSH host, or connect controls). Each section
 *  carries its own hidden-files toggle, refresh, and "last refreshed" stamp. */
import { useEffect, useRef, useState } from "react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";

import { clipboardShortcut } from "../../lib/fileOps";
import { basename, dirname } from "../../lib/format";
import {
  handleExplorerKey,
  registerExplorerFocus,
} from "../../lib/treeNav";
import { useAppStore } from "../../store/appStore";
import { useSSH } from "../../hooks/useSSH";
import { ConnectionManager } from "../connection/ConnectionManager";
import { WslSection } from "../connection/WslSection";
import { RelativeTime } from "../RelativeTime";
import { RootTree } from "../filetree/RootTree";
import { TransferPanel, type TransferConn } from "../transfer/TransferPanel";
import {
  IconEye,
  IconEyeOff,
  IconFilePlus,
  IconFolderPlus,
  IconLogout,
  IconPlus,
  IconRefresh,
  IconTransfer,
} from "../icons";

export function Sidebar() {
  const showHiddenLocal = useAppStore((s) => s.showHiddenLocal);
  const showHiddenRemote = useAppStore((s) => s.showHiddenRemote);
  const toggleHiddenLocal = useAppStore((s) => s.toggleHiddenLocal);
  const toggleHiddenRemote = useAppStore((s) => s.toggleHiddenRemote);
  const refreshLocal = useAppStore((s) => s.refreshLocal);
  const refreshRemote = useAppStore((s) => s.refreshRemote);
  const refreshTokenLocal = useAppStore((s) => s.refreshTokenLocal);
  const refreshTokenRemote = useAppStore((s) => s.refreshTokenRemote);
  const lastRefreshLocal = useAppStore((s) => s.lastRefreshLocal);
  const lastRefreshRemote = useAppStore((s) => s.lastRefreshRemote);
  const localConnId = useAppStore((s) => s.localConnId);
  const pinnedFolders = useAppStore((s) => s.pinnedFolders);
  const addPinnedFolder = useAppStore((s) => s.addPinnedFolder);
  const removePinnedFolder = useAppStore((s) => s.removePinnedFolder);
  const remote = useAppStore((s) => s.remote);
  const remoteRootPath = useAppStore((s) => s.remoteRootPath);
  const wsl = useAppStore((s) => s.wsl);
  const wslRootPath = useAppStore((s) => s.wslRootPath);
  const selected = useAppStore((s) => s.selected);
  const openNewEntry = useAppStore((s) => s.openNewEntry);
  const { disconnect } = useSSH();

  // Transfer panel (drag between two connections). The three buttons in the
  // Explorer header open it for whichever pairs are connected.
  const [transfer, setTransfer] = useState<{
    a: TransferConn;
    b: TransferConn;
  } | null>(null);
  const localConn: TransferConn | null = localConnId
    ? { connId: localConnId, rootPath: "", label: "Local", color: "#8be9fd" }
    : null;
  const remoteConn: TransferConn | null =
    remote && remoteRootPath
      ? {
          connId: remote.connId,
          rootPath: remoteRootPath,
          label: remote.name,
          color: remote.color,
        }
      : null;
  const wslConn: TransferConn | null =
    wsl && wslRootPath
      ? { connId: wsl.connId, rootPath: wslRootPath, label: wsl.name, color: "#bd93f9" }
      : null;

  async function openFolder() {
    const picked = await openFolderDialog({
      directory: true,
      multiple: false,
      title: "Open folder",
    });
    if (typeof picked === "string") addPinnedFolder(picked);
  }

  // New file/folder is created in the selected folder (or the selected file's
  // parent) when the selection belongs to that section, otherwise the section's
  // root — the first pinned folder for Local, the host root for Remote.
  const targetIn = (connId: string | null, fallback: string | null) => {
    if (connId && selected && selected.connId === connId) {
      return selected.isDir ? selected.path : dirname(selected.path);
    }
    return fallback;
  };
  const localNewParent = targetIn(localConnId, pinnedFolders[0] ?? null);
  const remoteNewParent = targetIn(remote?.connId ?? null, remoteRootPath);

  // Arrow-key navigation of the tree, scoped to when the explorer has focus.
  const contentRef = useRef<HTMLDivElement>(null);
  const onExplorerKeyDown = (event: React.KeyboardEvent) => {
    const el = event.target as HTMLElement;
    // Never intercept keys while typing in the rename field or any input.
    if (el.closest("input, textarea")) return;
    // Cut / copy / paste — explorer-scoped Ctrl shortcuts on the selection.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
      const k = event.key.toLowerCase();
      if ((k === "x" || k === "c" || k === "v") && clipboardShortcut(k)) {
        event.preventDefault();
      }
      return; // other Ctrl combos fall through to the global shortcut handler
    }
    if (event.altKey) return;
    // Let a focused control (refresh, new-file buttons) keep its own keys.
    if (el.closest("button")) return;
    if (handleExplorerKey(event.key)) event.preventDefault();
  };

  // Expose a focuser so Ctrl+Shift+E lands focus in the tree (arrows then work).
  useEffect(() => {
    registerExplorerFocus(() =>
      requestAnimationFrame(() => contentRef.current?.focus()),
    );
    return () => registerExplorerFocus(null);
  }, []);

  return (
    <>
    <div className="sidebar">
      <div className="sidebar__header">
        <span className="sidebar__title">Explorer</span>
        <div className="sidebar__actions">
          {localConn && remoteConn && (
            <button
              className="icon-btn"
              title={`Transfer: Local ⇄ ${remoteConn.label}`}
              onClick={() => setTransfer({ a: localConn, b: remoteConn })}
            >
              <IconTransfer />
            </button>
          )}
          {localConn && wslConn && (
            <button
              className="icon-btn"
              title={`Transfer: Local ⇄ ${wslConn.label}`}
              onClick={() => setTransfer({ a: localConn, b: wslConn })}
            >
              <IconTransfer />
            </button>
          )}
          {wslConn && remoteConn && (
            <button
              className="icon-btn"
              title={`Transfer: ${wslConn.label} ⇄ ${remoteConn.label}`}
              onClick={() => setTransfer({ a: wslConn, b: remoteConn })}
            >
              <IconTransfer />
            </button>
          )}
        </div>
      </div>

      <div
        ref={contentRef}
        className="sidebar__content"
        tabIndex={0}
        onKeyDown={onExplorerKeyDown}
        onMouseDown={(event) => {
          // Clicking anywhere in the tree (except an input) focuses it so the
          // arrow keys take over immediately.
          const el = event.target as HTMLElement;
          if (!el.closest("input, .file-node__rename")) {
            contentRef.current?.focus();
          }
        }}
      >
        {/* Local roots */}
        <div className="sidebar__section-head">
          <span className="sidebar__section-label">Local</span>
          <button
            className={`icon-btn ${showHiddenLocal ? "icon-btn--active" : ""}`}
            title={showHiddenLocal ? "Hide hidden files" : "Show hidden files"}
            onClick={() => toggleHiddenLocal()}
          >
            {showHiddenLocal ? <IconEye /> : <IconEyeOff />}
          </button>
          <button
            className="icon-btn"
            title="New file"
            disabled={!localConnId || !localNewParent}
            onClick={() => {
              if (localConnId && localNewParent)
                openNewEntry(localConnId, localNewParent, false);
            }}
          >
            <IconFilePlus />
          </button>
          <button
            className="icon-btn"
            title="New folder"
            disabled={!localConnId || !localNewParent}
            onClick={() => {
              if (localConnId && localNewParent)
                openNewEntry(localConnId, localNewParent, true);
            }}
          >
            <IconFolderPlus />
          </button>
          <button
            className="icon-btn"
            title="Refresh local"
            onClick={() => refreshLocal()}
          >
            <IconRefresh />
          </button>
          <RelativeTime at={lastRefreshLocal} />
          <button
            className="icon-btn sidebar__section-action"
            title="Open a local folder"
            onClick={() => void openFolder()}
          >
            <IconPlus />
          </button>
        </div>
        {localConnId && pinnedFolders.length > 0 ? (
          pinnedFolders.map((path, index) => (
            <RootTree
              key={path}
              connId={localConnId}
              rootPath={path}
              label={basename(path) || path}
              color="#8be9fd"
              removable
              defaultCollapsed
              showHidden={showHiddenLocal}
              refreshToken={refreshTokenLocal}
              rootId={`${localConnId}::${path}`}
              order={index}
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
          <span className="sidebar__section-label">Remote</span>
          {remote && (
            <>
              <button
                className={`icon-btn ${showHiddenRemote ? "icon-btn--active" : ""}`}
                title={
                  showHiddenRemote ? "Hide hidden files" : "Show hidden files"
                }
                onClick={() => toggleHiddenRemote()}
              >
                {showHiddenRemote ? <IconEye /> : <IconEyeOff />}
              </button>
              <button
                className="icon-btn"
                title="New file"
                disabled={!remoteNewParent}
                onClick={() => {
                  if (remote && remoteNewParent)
                    openNewEntry(remote.connId, remoteNewParent, false);
                }}
              >
                <IconFilePlus />
              </button>
              <button
                className="icon-btn"
                title="New folder"
                disabled={!remoteNewParent}
                onClick={() => {
                  if (remote && remoteNewParent)
                    openNewEntry(remote.connId, remoteNewParent, true);
                }}
              >
                <IconFolderPlus />
              </button>
              <button
                className="icon-btn"
                title="Refresh remote"
                onClick={() => refreshRemote()}
              >
                <IconRefresh />
              </button>
              <RelativeTime at={lastRefreshRemote} />
              <button
                className="icon-btn icon-btn--danger sidebar__section-action"
                title="Disconnect"
                onClick={() => void disconnect()}
              >
                <IconLogout />
              </button>
            </>
          )}
        </div>
        {remote && remoteRootPath ? (
          <RootTree
            connId={remote.connId}
            rootPath={remoteRootPath}
            label={remote.name}
            color={remote.color}
            showHidden={showHiddenRemote}
            refreshToken={refreshTokenRemote}
            rootId={`${remote.connId}::${remoteRootPath}`}
            order={pinnedFolders.length}
          />
        ) : (
          <ConnectionManager />
        )}

        {/* WSL distros (their own slot, alongside Local and Remote) */}
        <WslSection />
      </div>
    </div>
    {transfer && (
      <TransferPanel
        a={transfer.a}
        b={transfer.b}
        onClose={() => setTransfer(null)}
      />
    )}
    </>
  );
}
