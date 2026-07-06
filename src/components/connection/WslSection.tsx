/** Sidebar WSL section. Lists installed distros and connects to one by
 *  provisioning an sshd inside it (see docs/wsl-connection.md). A connected
 *  distro shows its file tree with its own per-section toolbar, like Local and
 *  Remote. */
import { useCallback, useEffect, useState } from "react";

import { basename, dirname } from "../../lib/format";
import {
  fsListDir,
  sshDisconnect,
  wslConnect,
  wslListDistros,
  type WslDistro,
} from "../../lib/ipc";
import { useAppStore, type RemoteConnection } from "../../store/appStore";
import { FolderBrowser } from "../FolderBrowser";
import { RelativeTime } from "../RelativeTime";
import { RootTree } from "../filetree/RootTree";
import {
  IconEye,
  IconEyeOff,
  IconFilePlus,
  IconFolderPlus,
  IconLogout,
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
  const setWsl = useAppStore((s) => s.setWsl);
  const clearWsl = useAppStore((s) => s.clearWsl);
  const openTerminal = useAppStore((s) => s.openTerminal);
  const pushNotice = useAppStore((s) => s.pushNotice);
  const showHiddenWsl = useAppStore((s) => s.showHiddenWsl);
  const toggleHiddenWsl = useAppStore((s) => s.toggleHiddenWsl);
  const refreshTokenWsl = useAppStore((s) => s.refreshTokenWsl);
  const refreshWsl = useAppStore((s) => s.refreshWsl);
  const lastRefreshWsl = useAppStore((s) => s.lastRefreshWsl);
  const selected = useAppStore((s) => s.selected);
  const openNewEntry = useAppStore((s) => s.openNewEntry);

  const [distros, setDistros] = useState<WslDistro[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [installFor, setInstallFor] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);

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
    if (wsl) return; // the distro list only matters while picking
    load();
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [wsl, load]);

  const connect = useCallback(
    async (distro: string, allowInstall: boolean) => {
      setConnecting(distro);
      setInstallFor(null);
      try {
        const { connId, user } = await wslConnect(distro, allowInstall);
        const listing = await fsListDir(connId, "");
        const conn: RemoteConnection = {
          connId,
          name: distro,
          host: "127.0.0.1",
          user,
          port: 0,
          color: WSL_COLOR,
          authType: "auto",
          identityFile: null,
          proxyJump: null,
        };
        setWsl(conn, listing.path);
        openTerminal(connId, distro);
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
    [setWsl, openTerminal, pushNotice],
  );

  async function disconnect() {
    if (wsl) {
      try {
        await sshDisconnect(wsl.connId);
      } catch {
        /* ignore */
      }
    }
    clearWsl();
  }

  // Connected: the distro's tree with a per-section toolbar (like Local/Remote).
  if (wsl && wslRootPath) {
    const newParent =
      selected && selected.connId === wsl.connId
        ? selected.isDir
          ? selected.path
          : dirname(selected.path)
        : (wslPins[0] ?? wslRootPath);
    return (
      <>
        <div className="sidebar__section-head sidebar__section-head--wsl">
          <span className="sidebar__section-label" title={wsl.name}>
            {wsl.user ? `${wsl.user}@${wsl.name}` : `WSL: ${wsl.name}`}
          </span>
          <button
            className={`icon-btn ${showHiddenWsl ? "icon-btn--active" : ""}`}
            title={showHiddenWsl ? "Hide hidden files" : "Show hidden files"}
            onClick={() => toggleHiddenWsl()}
          >
            {showHiddenWsl ? <IconEye /> : <IconEyeOff />}
          </button>
          <button
            className="icon-btn"
            title="Open a folder"
            onClick={() => setBrowsing(true)}
          >
            <IconPlus />
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
          <button
            className="icon-btn"
            title="Refresh WSL"
            onClick={() => refreshWsl()}
          >
            <IconRefresh />
          </button>
          <RelativeTime at={lastRefreshWsl} />
          <button
            className="icon-btn icon-btn--danger sidebar__section-action"
            title="Disconnect"
            onClick={() => void disconnect()}
          >
            <IconLogout />
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
    );
  }

  // Not connected: hide the section entirely on machines without WSL.
  if (distros !== null && distros.length === 0 && !error) return null;

  return (
    <>
      <div className="sidebar__section-head sidebar__section-head--wsl">
        <span className="sidebar__section-label">WSL</span>
        <button
          className="icon-btn sidebar__section-action"
          title="Refresh WSL distros"
          onClick={() => load()}
        >
          <IconRefresh />
        </button>
      </div>

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
      ) : (
        <div className="conn-list">
          {distros.map((d) => (
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
  );
}
