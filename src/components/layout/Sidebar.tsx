/** Left sidebar: a multi-root explorer with a Local section (pinned folders) and
 *  a Remote section (the attached SSH host, or connect controls). Each section
 *  carries its own hidden-files toggle, refresh, and "last refreshed" stamp. */
import { useEffect, useRef, useState } from "react";

import { PALETTE, paletteName } from "../../lib/connectionColor";
import { clipboardShortcut } from "../../lib/fileOps";
import { basename, dirname } from "../../lib/format";
import { remoteColor } from "../../lib/hostColors";
import { sshConfigPath } from "../../lib/ipc";
import { openFileByPath } from "../../lib/openFile";
import {
  handleExplorerKey,
  registerExplorerFocus,
} from "../../lib/treeNav";
import {
  HOST_COLOR_RAMP,
  remoteHostKey,
  useAppStore,
} from "../../store/appStore";
import { useSSH } from "../../hooks/useSSH";
import { ConnectionManager } from "../connection/ConnectionManager";
import { WslSection } from "../connection/WslSection";
import { FolderBrowser } from "../FolderBrowser";
import { RelativeTime } from "../RelativeTime";
import { RootTree } from "../filetree/RootTree";
import {
  IconExternal,
  IconEye,
  IconEyeOff,
  IconFilePlus,
  IconFolderPlus,
  IconPanelHide,
  IconPlug,
  IconPlus,
  IconRefresh,
  IconUnplug,
} from "../icons";

export function Sidebar() {
  const showHiddenLocal = useAppStore((s) => s.showHiddenLocal);
  const toggleHiddenLocal = useAppStore((s) => s.toggleHiddenLocal);
  const toggleHiddenRemote = useAppStore((s) => s.toggleHiddenRemote);
  const refreshLocal = useAppStore((s) => s.refreshLocal);
  const refreshRemote = useAppStore((s) => s.refreshRemote);
  const refreshTokenLocal = useAppStore((s) => s.refreshTokenLocal);
  const lastRefreshLocal = useAppStore((s) => s.lastRefreshLocal);
  const localConnId = useAppStore((s) => s.localConnId);
  const pinnedFolders = useAppStore((s) => s.pinnedFolders);
  const addPinnedFolder = useAppStore((s) => s.addPinnedFolder);
  const removePinnedFolder = useAppStore((s) => s.removePinnedFolder);
  const remotes = useAppStore((s) => s.remotes);
  const addRemotePin = useAppStore((s) => s.addRemotePin);
  const removeRemotePin = useAppStore((s) => s.removeRemotePin);
  const selected = useAppStore((s) => s.selected);
  const openNewEntry = useAppStore((s) => s.openNewEntry);
  const sections = useAppStore((s) => s.sections);
  const toggleSection = useAppStore((s) => s.toggleSection);
  const hostColors = useAppStore((s) => s.hostColors);
  const setHostColor = useAppStore((s) => s.setHostColor);
  const { disconnect, reconnect } = useSSH();
  // "Connect to another server" while one is already attached (the + on the
  // Remote bar); connecting replaces the current remote, as before.
  const [connectOpen, setConnectOpen] = useState(false);
  /** Which host bar's color menu is open (connId), if any. */
  const [hostMenu, setHostMenu] = useState<string | null>(null);
  // A successful connect (or a disconnect) closes the connect panel.
  useEffect(() => {
    setConnectOpen(false);
    setHostMenu(null);
  }, [remotes.length]);

  // In-app folder picker (replaces the OS dialog so local matches WSL/remote).
  const [browse, setBrowse] = useState<{
    connId: string;
    title: string;
    onPick: (path: string) => void;
  } | null>(null);

  const openLocalFolder = () => {
    if (!localConnId) return;
    setBrowse({
      connId: localConnId,
      title: "Open a local folder",
      onPick: (path) => {
        addPinnedFolder(path);
        setBrowse(null);
      },
    });
  };

  const openRemoteFolder = (connId: string, name: string) => {
    setBrowse({
      connId,
      title: `Open a folder on ${name}`,
      onPick: (path) => {
        addRemotePin(connId, path);
        setBrowse(null);
      },
    });
  };

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
          {(
            [
              ["local", "L", "var(--section-local)"],
              ["wsl", "W", "var(--section-wsl)"],
              ["remote", "R", "var(--section-remote)"],
            ] as const
          ).map(([key, letter, color]) => (
            <button
              key={key}
              className={`section-toggle ${sections[key] ? "" : "section-toggle--off"}`}
              style={sections[key] ? { color } : undefined}
              title={
                sections[key]
                  ? `Hide the ${letter === "L" ? "Local" : letter === "W" ? "WSL" : "Remote"} section (connections stay)`
                  : `Show the ${letter === "L" ? "Local" : letter === "W" ? "WSL" : "Remote"} section`
              }
              onClick={() => toggleSection(key)}
            >
              {letter}
            </button>
          ))}
          <button
            className="icon-btn panel-head__hide"
            title="Minimize the explorer (Ctrl+B, or the status bar, to bring it back)"
            onClick={() => useAppStore.getState().setSidebarVisible(false)}
          >
            <IconPanelHide size={14} />
          </button>
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
        {sections.local && (
        <>
        <div className="sidebar__section-head sidebar__section-head--local">
          <span className="sidebar__section-label">Local</span>
        </div>
        {/* Per-host function line: same shape for every host. */}
        <div
          className="host-tools"
          style={{ "--host-color": "var(--section-local)" } as React.CSSProperties}
        >
          <button
            className="icon-btn"
            title="Pin a local folder"
            disabled={!localConnId}
            onClick={openLocalFolder}
          >
            <IconPlus />
          </button>
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
          <span className="host-tools__spacer" />
          <RelativeTime at={lastRefreshLocal} />
          <button
            className="icon-btn"
            title="Refresh local"
            onClick={() => refreshLocal()}
          >
            <IconRefresh />
          </button>
        </div>
        {localConnId && pinnedFolders.length > 0 ? (
          pinnedFolders.map((path, index) => (
            <RootTree
              key={path}
              connId={localConnId}
              rootPath={path}
              label={basename(path) || path}
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
        </>
        )}

        {/* WSL distros (second section — Local, WSL, then Remote) */}
        {sections.wsl && <WslSection />}

        {/* Remote: a permanent section bar; each connection gets a host bar
            under it (the multi-remote shape, currently capped at one). */}
        {sections.remote && (
        <>
        <div className="sidebar__section-head sidebar__section-head--remote">
          <span className="sidebar__section-label">Remote</span>
          <button
            className="icon-btn sidebar__section-action"
            title="Edit ~/.ssh/config in the editor"
            onClick={() =>
              void (async () => {
                try {
                  const path = await sshConfigPath();
                  if (localConnId) await openFileByPath(localConnId, path, "config");
                } catch (error) {
                  useAppStore
                    .getState()
                    .pushNotice("error", `Couldn't open SSH config: ${String(error)}`);
                }
              })()
            }
          >
            <IconExternal size={13} />
          </button>
          {remotes.length > 0 && remotes.length < 3 && (
            <button
              className={`icon-btn ${connectOpen ? "icon-btn--active" : ""}`}
              title="Connect a new server (up to 3)"
              onClick={() => setConnectOpen((o) => !o)}
            >
              <IconPlug size={13} />
            </button>
          )}
        </div>
        {(remotes.length === 0 || connectOpen) && <ConnectionManager />}
        {remotes.map((r, rIdx) => {
          const conn = r.conn;
          const key = remoteHostKey(conn);
          const newParent = targetIn(conn.connId, r.pins[0] ?? r.rootPath);
          return (
          <div key={conn.connId}>
            <div
              className="host-bar"
              style={{ "--host-color": remoteColor(hostColors, conn) } as React.CSSProperties}
              title={`${conn.name} (${key}) — right-click: host color`}
              onContextMenu={(e) => {
                e.preventDefault();
                setHostMenu((o) => (o === conn.connId ? null : conn.connId));
              }}
            >
              {hostMenu === conn.connId && (
                <div className="color-menu">
                  <span className="color-menu__label">{key}</span>
                  {[...HOST_COLOR_RAMP, ...PALETTE].map((c) => (
                    <button
                      key={c}
                      className="color-menu__swatch"
                      style={{ background: c }}
                      title={c.startsWith("var(") ? paletteName(c) : c}
                      onClick={() => {
                        setHostColor(key, c);
                        setHostMenu(null);
                      }}
                    />
                  ))}
                  <button
                    className="color-menu__reset"
                    title="Back to the default host color"
                    onClick={() => {
                      setHostColor(key, null);
                      setHostMenu(null);
                    }}
                  >
                    Auto
                  </button>
                </div>
              )}
              <span className={`dot dot--${r.state}`} />
              <span className="host-bar__label" title={key}>
                {conn.user}@{conn.host}
              </span>
              {r.state === "disconnected" && (
                <button
                  className="icon-btn"
                  title="Reconnect"
                  onClick={() => void reconnect(conn.connId)}
                >
                  <IconRefresh />
                </button>
              )}
              <button
                className="icon-btn icon-btn--danger sidebar__section-action"
                title={`Disconnect ${conn.name}`}
                onClick={() => void disconnect(conn.connId)}
              >
                <IconUnplug />
              </button>
            </div>
            <div
              className="host-tools"
              style={{ "--host-color": remoteColor(hostColors, conn) } as React.CSSProperties}
            >
              <button
                className="icon-btn"
                title="Pin a folder"
                onClick={() => openRemoteFolder(conn.connId, conn.name)}
              >
                <IconPlus />
              </button>
              <button
                className={`icon-btn ${r.showHidden ? "icon-btn--active" : ""}`}
                title={r.showHidden ? "Hide hidden files" : "Show hidden files"}
                onClick={() => toggleHiddenRemote(conn.connId)}
              >
                {r.showHidden ? <IconEye /> : <IconEyeOff />}
              </button>
              <button
                className="icon-btn"
                title="New file"
                disabled={!newParent}
                onClick={() => {
                  if (newParent) openNewEntry(conn.connId, newParent, false);
                }}
              >
                <IconFilePlus />
              </button>
              <button
                className="icon-btn"
                title="New folder"
                disabled={!newParent}
                onClick={() => {
                  if (newParent) openNewEntry(conn.connId, newParent, true);
                }}
              >
                <IconFolderPlus />
              </button>
              <span className="host-tools__spacer" />
              <RelativeTime at={r.lastRefresh} />
              <button
                className="icon-btn"
                title={`Refresh ${conn.name}`}
                onClick={() => refreshRemote(conn.connId)}
              >
                <IconRefresh />
              </button>
            </div>
            {r.pins.length > 0 ? (
              r.pins.map((path, index) => (
                <RootTree
                  key={path}
                  connId={conn.connId}
                  rootPath={path}
                  label={basename(path) || path}
                  removable
                  defaultCollapsed
                  showHidden={r.showHidden}
                  refreshToken={r.refreshToken}
                  rootId={`${conn.connId}::${path}`}
                  order={2000 + rIdx * 100 + index}
                  onRemove={() => removeRemotePin(conn.connId, path)}
                />
              ))
            ) : (
              <div className="filetree__message">
                No folders yet — click + to open one.
              </div>
            )}
          </div>
          );
        })}
        </>
        )}
      </div>
    </div>
    {browse && (
      <FolderBrowser
        connId={browse.connId}
        title={browse.title}
        showDrives={browse.connId === localConnId}
        onPick={browse.onPick}
        onClose={() => setBrowse(null)}
      />
    )}
    </>
  );
}
