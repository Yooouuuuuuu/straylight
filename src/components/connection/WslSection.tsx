/** Sidebar WSL section, mirroring the Remote section's shape: a permanent
 *  "WSL" bar; the connected distro appears as a colored host bar underneath
 *  (`user@distro`, toolbar, right-click color menu), with the distro list
 *  behind the bar's + for switching. Connecting provisions an sshd inside the
 *  distro (see docs/wsl-connection.md). */
import { useCallback, useEffect, useState } from "react";

import { PALETTE, paletteName } from "../../lib/connectionColor";
import { basename, dirname } from "../../lib/format";
import { sshDisconnect, wslListDistros, type WslDistro } from "../../lib/ipc";
import { clearDesiredWsl } from "../../lib/session";
import { connectWslDistro } from "../../lib/wslSession";
import { HOST_COLOR_RAMP, useAppStore } from "../../store/appStore";
import { FolderBrowser } from "../FolderBrowser";
import { RelativeTime } from "../RelativeTime";
import { RootTree } from "../filetree/RootTree";
import {
  IconEye,
  IconEyeOff,
  IconFilePlus,
  IconFolderPlus,
  IconLogout,
  IconPlug,
  IconPlus,
  IconRefresh,
} from "../icons";

const WSL_COLOR = "var(--section-wsl)";

export function WslSection() {
  const wsl = useAppStore((s) => s.wsl);
  const wslRootPath = useAppStore((s) => s.wslRootPath);
  const wslPins = useAppStore((s) => s.wslPins);
  const addWslPin = useAppStore((s) => s.addWslPin);
  const removeWslPin = useAppStore((s) => s.removeWslPin);
  const clearWsl = useAppStore((s) => s.clearWsl);
  const pushNotice = useAppStore((s) => s.pushNotice);
  const showHiddenWsl = useAppStore((s) => s.showHiddenWsl);
  const toggleHiddenWsl = useAppStore((s) => s.toggleHiddenWsl);
  const refreshTokenWsl = useAppStore((s) => s.refreshTokenWsl);
  const refreshWsl = useAppStore((s) => s.refreshWsl);
  const lastRefreshWsl = useAppStore((s) => s.lastRefreshWsl);
  const selected = useAppStore((s) => s.selected);
  const openNewEntry = useAppStore((s) => s.openNewEntry);
  const hostColors = useAppStore((s) => s.hostColors);
  const setHostColor = useAppStore((s) => s.setHostColor);

  const [distros, setDistros] = useState<WslDistro[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [installFor, setInstallFor] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  /** Show the distro list while connected (the bar's +). */
  const [listOpen, setListOpen] = useState(false);
  const [colorMenu, setColorMenu] = useState(false);

  const load = useCallback(() => {
    setError(null);
    wslListDistros()
      .then(setDistros)
      .catch((e) => {
        setDistros([]);
        setError(String(e));
      });
  }, []);

  useEffect(() => {
    if (wsl && !listOpen) return; // the distro list only matters while picking
    load();
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [wsl, listOpen, load]);

  // A successful connect (or a disconnect) closes the switch panel.
  useEffect(() => {
    setListOpen(false);
    setColorMenu(false);
  }, [wsl?.connId]);

  const connect = useCallback(
    async (distro: string, allowInstall: boolean) => {
      setConnecting(distro);
      setInstallFor(null);
      try {
        await connectWslDistro(distro, allowInstall);
      } catch (e) {
        const msg = String(e);
        if (msg.includes("WSL_NEEDS_INSTALL:")) {
          setInstallFor(distro); // ask to install, then retry with allowInstall
        } else {
          pushNotice("error", `WSL connect failed: ${msg}`);
        }
      } finally {
        setConnecting(null);
      }
    },
    [pushNotice],
  );

  async function disconnect() {
    if (wsl) {
      try {
        await sshDisconnect(wsl.connId);
      } catch {
        /* ignore */
      }
    }
    // Explicit disconnect: don't offer this distro at next launch.
    clearDesiredWsl();
    clearWsl();
  }

  // No WSL on this machine: hide the section entirely.
  if (!wsl && distros !== null && distros.length === 0 && !error) return null;

  const connected = wsl && wslRootPath;
  const newParent =
    connected && selected && selected.connId === wsl.connId
      ? selected.isDir
        ? selected.path
        : dirname(selected.path)
      : (wslPins[0] ?? wslRootPath ?? "");
  const wslKey = wsl ? `wsl:${wsl.name}` : "";
  const hostColor = wsl ? (hostColors[wslKey] ?? WSL_COLOR) : WSL_COLOR;

  return (
    <>
      <div className="sidebar__section-head sidebar__section-head--wsl">
        <span className="sidebar__section-label">WSL</span>
        {connected ? (
          <button
            className={`icon-btn sidebar__section-action ${listOpen ? "icon-btn--active" : ""}`}
            title="Connect a different distro (replaces the current one)"
            onClick={() => setListOpen((o) => !o)}
          >
            <IconPlug size={13} />
          </button>
        ) : (
          <button
            className="icon-btn sidebar__section-action"
            title="Refresh WSL distros"
            onClick={() => load()}
          >
            <IconRefresh />
          </button>
        )}
      </div>

      {(!connected || listOpen) && (
        <>
          {installFor && (
            <div className="wsl-install">
              <div className="wsl-install__text">
                <strong className="mono">{installFor}</strong> has no SSH server.
                Install OpenSSH so Straylight can connect?
              </div>
              <div className="wsl-install__actions">
                <button
                  className="btn btn--ghost"
                  onClick={() => setInstallFor(null)}
                >
                  Cancel
                </button>
                <button
                  className="btn btn--primary"
                  onClick={() => void connect(installFor, true)}
                >
                  Install
                </button>
              </div>
            </div>
          )}

          {distros === null ? (
            <div className="conn-empty">
              <span className="spinner" /> Listing distros…
            </div>
          ) : error ? (
            <div className="conn-empty">Couldn’t list WSL distros.</div>
          ) : distros.every((d) => d.name === wsl?.name) ? (
            <div className="conn-empty">No other distros installed.</div>
          ) : (
            <div className="conn-list">
              {/* The connected distro doesn't belong in the switch list. */}
              {distros.filter((d) => d.name !== wsl?.name).map((d) => (
                <div
                  key={d.name}
                  className="conn-item"
                  style={{ borderLeftColor: WSL_COLOR }}
                  title={`Connect to ${d.name}`}
                  onClick={() => void connect(d.name, false)}
                >
                  <div className="conn-item__name">
                    {d.name}
                    {d.isDefault && <span className="wsl-tag">default</span>}
                  </div>
                  <div className="conn-item__detail">
                    {connecting === d.name
                      ? "connecting…"
                      : d.running
                        ? "running"
                        : "stopped"}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {connected && (
        <>
          <div
            className="host-bar"
            style={{ "--host-color": hostColor } as React.CSSProperties}
            title={`${wsl.name} — right-click: host color`}
            onContextMenu={(e) => {
              e.preventDefault();
              setColorMenu((o) => !o);
            }}
          >
            {colorMenu && (
              <div className="color-menu">
                <span className="color-menu__label">{wslKey}</span>
                {[...HOST_COLOR_RAMP, ...PALETTE].map((c) => (
                  <button
                    key={c}
                    className="color-menu__swatch"
                    style={{ background: c }}
                    title={c.startsWith("var(") ? paletteName(c) : c}
                    onClick={() => {
                      setHostColor(wslKey, c);
                      setColorMenu(false);
                    }}
                  />
                ))}
                <button
                  className="color-menu__reset"
                  title="Back to the WSL section color"
                  onClick={() => {
                    setHostColor(wslKey, null);
                    setColorMenu(false);
                  }}
                >
                  Auto
                </button>
              </div>
            )}
            <span className="dot dot--connected" />
            <span className="host-bar__label" title={wsl.name}>
              {wsl.user ? `${wsl.user}@${wsl.name}` : wsl.name}
            </span>
            <button
              className="icon-btn icon-btn--danger sidebar__section-action"
              title="Disconnect"
              onClick={() => void disconnect()}
            >
              <IconLogout />
            </button>
          </div>
          <div
            className="host-tools"
            style={{ "--host-color": hostColor } as React.CSSProperties}
          >
            <button
              className="icon-btn"
              title="Pin a folder"
              onClick={() => setBrowsing(true)}
            >
              <IconPlus />
            </button>
            <button
              className={`icon-btn ${showHiddenWsl ? "icon-btn--active" : ""}`}
              title={showHiddenWsl ? "Hide hidden files" : "Show hidden files"}
              onClick={() => toggleHiddenWsl()}
            >
              {showHiddenWsl ? <IconEye /> : <IconEyeOff />}
            </button>
            <button
              className="icon-btn"
              title="New file"
              onClick={() => openNewEntry(wsl.connId, newParent, false)}
            >
              <IconFilePlus />
            </button>
            <button
              className="icon-btn"
              title="New folder"
              onClick={() => openNewEntry(wsl.connId, newParent, true)}
            >
              <IconFolderPlus />
            </button>
            <span className="host-tools__spacer" />
            <RelativeTime at={lastRefreshWsl} />
            <button
              className="icon-btn"
              title="Refresh WSL"
              onClick={() => refreshWsl()}
            >
              <IconRefresh />
            </button>
          </div>
          {wslPins.length > 0 ? (
            wslPins.map((path, index) => (
              <RootTree
                key={path}
                connId={wsl.connId}
                rootPath={path}
                label={basename(path) || path}
                removable
                defaultCollapsed
                showHidden={showHiddenWsl}
                refreshToken={refreshTokenWsl}
                rootId={`${wsl.connId}::${path}`}
                order={1000 + index}
                onRemove={() => removeWslPin(path)}
              />
            ))
          ) : (
            <div className="filetree__message">
              No folders yet — click + to open one.
            </div>
          )}
          {browsing && (
            <FolderBrowser
              connId={wsl.connId}
              title={`Open a folder on ${wsl.name}`}
              onPick={(path) => {
                addWslPin(path);
                setBrowsing(false);
              }}
              onClose={() => setBrowsing(false)}
            />
          )}
        </>
      )}
    </>
  );
}
