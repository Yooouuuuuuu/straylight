/** Left sidebar: a multi-root explorer with a Local section (pinned folders) and
 *  a Remote section (the attached SSH host, or connect controls). Each section
 *  carries its own hidden-files toggle, refresh, and "last refreshed" stamp. */
import { useEffect, useRef, useState } from "react";

import { clipboardShortcut } from "../../lib/fileOps";
import { basename, dirname } from "../../lib/format";
import { connStateTip, laneSummary, remoteColor } from "../../lib/hostColors";
import { sshConfigPath } from "../../lib/ipc";
import { openFileByPath } from "../../lib/openFile";
import { uiConfig } from "../../lib/settings";
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
import { RootTree } from "../filetree/RootTree";
import { Tip } from "../Tooltip";
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
  useAppStore((s) => s.settingsRev); // re-render when settings.json changes
  const wsls = useAppStore((s) => s.wsls);
  // Honored only while nothing non-local is connected — connecting anything
  // (e.g. via the palette) brings the full explorer back until it's gone.
  const localOnly =
    uiConfig.localOnly && wsls.length === 0 && remotes.length === 0;
  const swapRemotes = useAppStore((s) => s.swapRemotes);
  const { disconnect, reconnect } = useSSH();
  // "Connect to another server" while one is already attached (the + on the
  // Remote bar); connecting replaces the current remote, as before.
  const [connectOpen, setConnectOpen] = useState(false);
  /** Which host bar's position menu is open (connId), if any. */
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
          {!localOnly && (
            <div className="sidebar__lwr">
              {(
                [
                  ["local", "L", "var(--section-local)"],
                  ["wsl", "W", "var(--section-wsl)"],
                  ["remote", "R", "var(--section-remote)"],
                ] as const
              ).map(([key, letter, color]) => (
                <Tip
                  key={key}
                  label={`${sections[key] ? "Hide" : "Show"} the ${
                    letter === "L" ? "Local" : letter === "W" ? "WSL" : "Remote"
                  } section`}
                >
                  <button
                    className={`section-toggle ${sections[key] ? "" : "section-toggle--off"}`}
                    style={sections[key] ? { color } : undefined}
                    onClick={() => toggleSection(key)}
                  >
                    {letter}
                  </button>
                </Tip>
              ))}
            </div>
          )}
          <Tip label="Minimize EXPLORER (Ctrl+B)">
            <button
              className="icon-btn panel-head__hide"
              onClick={() => useAppStore.getState().setSidebarVisible(false)}
            >
              <IconPanelHide size={14} />
            </button>
          </Tip>
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
          <Tip label="Pin a folder">
            <button
              className="icon-btn"
              disabled={!localConnId}
              onClick={openLocalFolder}
            >
              <IconPlus />
            </button>
          </Tip>
          <Tip label={showHiddenLocal ? "Hide hidden files" : "Show hidden files"}>
            <button
              className={`icon-btn ${showHiddenLocal ? "icon-btn--active" : ""}`}
              onClick={() => toggleHiddenLocal()}
            >
              {showHiddenLocal ? <IconEye /> : <IconEyeOff />}
            </button>
          </Tip>
          <Tip label="New file">
            <button
              className="icon-btn"
              disabled={!localConnId || !localNewParent}
              onClick={() => {
                if (localConnId && localNewParent)
                  openNewEntry(localConnId, localNewParent, false);
              }}
            >
              <IconFilePlus />
            </button>
          </Tip>
          <Tip label="New folder">
            <button
              className="icon-btn"
              disabled={!localConnId || !localNewParent}
              onClick={() => {
                if (localConnId && localNewParent)
                  openNewEntry(localConnId, localNewParent, true);
              }}
            >
              <IconFolderPlus />
            </button>
          </Tip>
          <span className="host-tools__spacer" />
          <Tip label="Refresh">
            <button className="icon-btn" onClick={() => refreshLocal()}>
              <IconRefresh />
            </button>
          </Tip>
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
        {!localOnly && sections.wsl && <WslSection />}

        {/* Remote: a permanent section bar; each connection gets a host bar
            under it (the multi-remote shape, currently capped at one). */}
        {!localOnly && sections.remote && (
        <>
        <div className="sidebar__section-head sidebar__section-head--remote">
          <span className="sidebar__section-label">Remote</span>
          <Tip label="Edit ~/.ssh/config">
          <button
            className="icon-btn sidebar__section-action"
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
          </Tip>
          {remotes.length > 0 && remotes.length < 3 && (
            <Tip label="Connect to a server">
              <button
                className={`icon-btn ${connectOpen ? "icon-btn--active" : ""}`}
                onClick={() => setConnectOpen((o) => !o)}
              >
                <IconPlug size={13} />
              </button>
            </Tip>
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
              style={{ "--host-color": remoteColor(conn) } as React.CSSProperties}
              onContextMenu={(e) => {
                e.preventDefault();
                // Only with 2+ remotes is there a position to move to.
                if (remotes.length > 1)
                  setHostMenu((o) => (o === conn.connId ? null : conn.connId));
              }}
            >
              {hostMenu === conn.connId && (
                <div className="color-menu">
                  <span className="color-menu__label">{key}</span>
                  {remotes.map((_, slot) =>
                    slot === rIdx ? null : (
                      <Tip key={slot} label={`Swap positions (and colors) with Remote ${slot + 1}`}>
                        <button
                          className="color-menu__slot"
                          onClick={() => {
                            swapRemotes(rIdx, slot);
                            setHostMenu(null);
                          }}
                        >
                          <span
                            className="color-menu__dot"
                            style={{ background: HOST_COLOR_RAMP[slot] }}
                          />
                          Make this Remote {slot + 1}
                        </button>
                      </Tip>
                    ),
                  )}
                </div>
              )}
              <Tip
                label={
                  remotes.length > 1
                    ? `${key} — right-click: change remote position/color`
                    : key
                }
              >
                <span className="host-bar__label">
                  {conn.user}@{conn.host}
                </span>
              </Tip>
              {(r.state === "disconnected" || r.state === "failed") && (
                <Tip label="Reconnect">
                  <button
                    className="icon-btn"
                    onClick={() => void reconnect(conn.connId)}
                  >
                    <IconRefresh />
                  </button>
                </Tip>
              )}
              <Tip label="Disconnect">
                <button
                  className="icon-btn icon-btn--danger sidebar__section-action"
                  onClick={() => void disconnect(conn.connId)}
                >
                  <IconUnplug />
                </button>
              </Tip>
            </div>
            <div
              className="host-tools"
              style={{ "--host-color": remoteColor(conn) } as React.CSSProperties}
            >
              <Tip label="Pin a folder">
                <button
                  className="icon-btn"
                  onClick={() => openRemoteFolder(conn.connId, conn.name)}
                >
                  <IconPlus />
                </button>
              </Tip>
              <Tip label={r.showHidden ? "Hide hidden files" : "Show hidden files"}>
                <button
                  className={`icon-btn ${r.showHidden ? "icon-btn--active" : ""}`}
                  onClick={() => toggleHiddenRemote(conn.connId)}
                >
                  {r.showHidden ? <IconEye /> : <IconEyeOff />}
                </button>
              </Tip>
              <Tip label="New file">
                <button
                  className="icon-btn"
                  disabled={!newParent}
                  onClick={() => {
                    if (newParent) openNewEntry(conn.connId, newParent, false);
                  }}
                >
                  <IconFilePlus />
                </button>
              </Tip>
              <Tip label="New folder">
                <button
                  className="icon-btn"
                  disabled={!newParent}
                  onClick={() => {
                    if (newParent) openNewEntry(conn.connId, newParent, true);
                  }}
                >
                  <IconFolderPlus />
                </button>
              </Tip>
              <span className="host-tools__spacer" />
              {/* Issue light: near-invisible while fine, colored on trouble
                  (same rule as the status bar). */}
              <Tip label={`${connStateTip(r.state)} · ${laneSummary(conn.connId)}`}>
                <span
                  className={`dot ${r.state === "connected" ? "dot--fine" : `dot--${r.state}`}`}
                />
              </Tip>
              <Tip label="Refresh">
                <button
                  className="icon-btn"
                  onClick={() => refreshRemote(conn.connId)}
                >
                  <IconRefresh />
                </button>
              </Tip>
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
