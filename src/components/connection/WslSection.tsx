/** Sidebar WSL section, mirroring the Remote section's shape: a permanent
 *  "WSL" bar; every connected distro (up to MAX_WSLS) appears as a colored
 *  host bar underneath (`user@distro`, toolbar), with the distro list behind
 *  the bar's + for attaching more. All distros share the WSL section color.
 *  Connecting provisions an sshd inside the distro (see
 *  docs/wsl-connection.md). */
import { useCallback, useEffect, useState } from "react";

import { connStateTip } from "../../lib/hostColors";
import { basename, dirname } from "../../lib/format";
import {
  sshDisconnect,
  wslListDistros,
  wslProbeSsh,
  type WslDistro,
} from "../../lib/ipc";
import { connectWslDistro } from "../../lib/wslSession";
import {
  MAX_WSLS,
  useAppStore,
  type RemoteWorkspace,
} from "../../store/appStore";
import { FolderBrowser } from "../FolderBrowser";
import { RootTree } from "../filetree/RootTree";
import { Tip } from "../Tooltip";
import {
  IconEye,
  IconEyeOff,
  IconFilePlus,
  IconFolderPlus,
  IconPlug,
  IconPlus,
  IconRefresh,
  IconUnplug,
} from "../icons";

const WSL_COLOR = "var(--section-wsl)";

/** One connected distro: host bar (state dot, disconnect), host-tools line,
 *  and its pinned-folder trees. All distros share the WSL section color —
 *  edit it in the Theme UI. */
function WslHost({ ws, order }: { ws: RemoteWorkspace; order: number }) {
  const addWslPin = useAppStore((s) => s.addWslPin);
  const removeWslPin = useAppStore((s) => s.removeWslPin);
  const removeWsl = useAppStore((s) => s.removeWsl);
  const toggleHiddenWsl = useAppStore((s) => s.toggleHiddenWsl);
  const refreshWsl = useAppStore((s) => s.refreshWsl);
  const selected = useAppStore((s) => s.selected);
  const openNewEntry = useAppStore((s) => s.openNewEntry);

  const [browsing, setBrowsing] = useState(false);

  const conn = ws.conn;
  const hostColor = WSL_COLOR;
  const newParent =
    selected && selected.connId === conn.connId
      ? selected.isDir
        ? selected.path
        : dirname(selected.path)
      : (ws.pins[0] ?? ws.rootPath ?? "");

  async function disconnect() {
    try {
      await sshDisconnect(conn.connId);
    } catch {
      /* ignore */
    }
    // The session snapshot persists connected distros only, so removing it
    // here is all "don't offer at next launch" takes.
    removeWsl(conn.connId);
  }

  return (
    <>
      <div
        className="host-bar"
        style={{ "--host-color": hostColor } as React.CSSProperties}
      >
        <span className="host-bar__label">
          {conn.user ? `${conn.user}@${conn.name}` : conn.name}
        </span>
        <Tip label="Disconnect">
          <button
            className="icon-btn icon-btn--danger sidebar__section-action"
            onClick={() => void disconnect()}
          >
            <IconUnplug />
          </button>
        </Tip>
      </div>
      <div
        className="host-tools"
        style={{ "--host-color": hostColor } as React.CSSProperties}
      >
        <Tip label="Pin a folder">
          <button className="icon-btn" onClick={() => setBrowsing(true)}>
            <IconPlus />
          </button>
        </Tip>
        <Tip label={ws.showHidden ? "Hide hidden files" : "Show hidden files"}>
          <button
            className={`icon-btn ${ws.showHidden ? "icon-btn--active" : ""}`}
            onClick={() => toggleHiddenWsl(conn.connId)}
          >
            {ws.showHidden ? <IconEye /> : <IconEyeOff />}
          </button>
        </Tip>
        <Tip label="New file">
          <button
            className="icon-btn"
            onClick={() => openNewEntry(conn.connId, newParent, false)}
          >
            <IconFilePlus />
          </button>
        </Tip>
        <Tip label="New folder">
          <button
            className="icon-btn"
            onClick={() => openNewEntry(conn.connId, newParent, true)}
          >
            <IconFolderPlus />
          </button>
        </Tip>
        <span className="host-tools__spacer" />
        {/* Issue light: near-invisible while fine, colored on trouble (same
            rule as the status bar). */}
        <Tip label={connStateTip(ws.state)}>
          <span
            className={`dot ${ws.state === "connected" ? "dot--fine" : `dot--${ws.state}`}`}
          />
        </Tip>
        <Tip label="Refresh">
          <button className="icon-btn" onClick={() => refreshWsl(conn.connId)}>
            <IconRefresh />
          </button>
        </Tip>
      </div>
      {ws.pins.length > 0 ? (
        ws.pins.map((path, index) => (
          <RootTree
            key={path}
            connId={conn.connId}
            rootPath={path}
            label={basename(path) || path}
            removable
            defaultCollapsed
            showHidden={ws.showHidden}
            refreshToken={ws.refreshToken}
            rootId={`${conn.connId}::${path}`}
            order={order * 100 + index}
            onRemove={() => removeWslPin(conn.connId, path)}
          />
        ))
      ) : (
        <div className="filetree__message">
          No folders yet — click + to open one.
        </div>
      )}
      {browsing && (
        <FolderBrowser
          connId={conn.connId}
          title={`Open a folder on ${conn.name}`}
          onPick={(path) => {
            addWslPin(conn.connId, path);
            setBrowsing(false);
          }}
          onClose={() => setBrowsing(false)}
        />
      )}
    </>
  );
}

export function WslSection() {
  const wsls = useAppStore((s) => s.wsls);
  const pushNotice = useAppStore((s) => s.pushNotice);

  const [distros, setDistros] = useState<WslDistro[] | null>(null);
  /** Per-distro sshd probe result (true = port answers → instant connect). */
  const [sshReady, setSshReady] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [installFor, setInstallFor] = useState<string | null>(null);
  /** Show the distro list while connected (the bar's +). */
  const [listOpen, setListOpen] = useState(false);

  const load = useCallback(() => {
    setError(null);
    wslListDistros()
      .then(setDistros)
      .catch((e) => {
        setDistros([]);
        setError(String(e));
      });
  }, []);

  const anyConnected = wsls.length > 0;

  useEffect(() => {
    if (anyConnected && !listOpen) return; // the list only matters while picking
    load();
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [anyConnected, listOpen, load]);

  // Readiness lights: probe each RUNNING distro's ssh port (green = sshd up →
  // instant connect; yellow = running, ssh starts on connect; gray = stopped).
  useEffect(() => {
    if (!distros) return;
    let active = true;
    for (const d of distros) {
      if (!d.running) continue;
      void wslProbeSsh(d.name)
        .then((ok) => {
          if (active) setSshReady((prev) => ({ ...prev, [d.name]: ok }));
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [distros]);

  // A successful connect closes the pick panel.
  useEffect(() => {
    setListOpen(false);
  }, [wsls.length]);

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

  // No WSL on this machine: hide the section entirely.
  if (!anyConnected && distros !== null && distros.length === 0 && !error)
    return null;

  const connectedNames = new Set(wsls.map((w) => w.conn.name));

  return (
    <>
      <div className="sidebar__section-head sidebar__section-head--wsl">
        <span className="sidebar__section-label">WSL</span>
        {anyConnected ? (
          wsls.length < MAX_WSLS && (
            <Tip label="Connect another distro">
              <button
                className={`icon-btn sidebar__section-action ${listOpen ? "icon-btn--active" : ""}`}
                onClick={() => setListOpen((o) => !o)}
              >
                <IconPlug size={13} />
              </button>
            </Tip>
          )
        ) : (
          <Tip label="Refresh WSL distros">
            <button
              className="icon-btn sidebar__section-action"
              onClick={() => load()}
            >
              <IconRefresh />
            </button>
          </Tip>
        )}
      </div>

      {(!anyConnected || listOpen) && (
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
          ) : distros.every((d) => connectedNames.has(d.name)) ? (
            <div className="conn-empty">No other distros installed.</div>
          ) : (
            <div className="conn-list">
              {/* Connected distros don't belong in the pick list. */}
              {distros
                .filter((d) => !connectedNames.has(d.name))
                .map((d) => {
                  const light = !d.running
                    ? "stopped"
                    : sshReady[d.name]
                      ? "ready"
                      : "running";
                  return (
                    <Tip
                      key={d.name}
                      label={
                        light === "ready"
                          ? "sshd up — connects instantly"
                          : light === "running"
                            ? "Running — ssh starts on connect"
                            : "Stopped — boots on connect"
                      }
                    >
                    <div
                      className="conn-item"
                      style={{ borderLeftColor: WSL_COLOR }}
                      onClick={() => void connect(d.name, false)}
                    >
                      <div className="conn-item__name">
                        <span
                          className={`dot wsl-light ${
                            light === "ready"
                              ? "dot--connected"
                              : light === "running"
                                ? "dot--warm"
                                : "dot--off"
                          }`}
                        />
                        {d.name}
                        {d.isDefault && <span className="wsl-tag">default</span>}
                      </div>
                      <div className="conn-item__detail">
                        {connecting === d.name ? "connecting…" : light}
                      </div>
                    </div>
                    </Tip>
                  );
                })}
            </div>
          )}
        </>
      )}

      {wsls.map((ws, i) => (
        <WslHost key={ws.conn.connId} ws={ws} order={10 + i} />
      ))}
    </>
  );
}
