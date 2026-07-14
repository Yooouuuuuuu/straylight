/** The Ports group: listening TCP ports on the monitored hosts, VS Code
 *  style — grouped by host, then by port number. Light by design: nothing
 *  runs while the tab is closed; while open it re-polls every
 *  `panels.portsInterval` seconds. The controls here (hosts to monitor,
 *  interval, hide-system-ports) write straight back to settings.json. */
import { useEffect, useState } from "react";

import { hostColorForConnKey, SECTION_LOCAL, SECTION_WSL } from "../../lib/hostColors";
import { portList, type PortInfo } from "../../lib/ipc";
import { panelsConfig, updateSettings } from "../../lib/settings";
import { remoteHostKey, useAppStore } from "../../store/appStore";

interface Row extends PortInfo {
  connId: string;
  host: string;
  color: string;
}

/** VS Code-style noise rule: privileged ports plus classic infra services. */
const SYSTEM_PORTS = new Set([1900, 2049, 3389, 5353, 5355]);
const isSystemPort = (p: number) => p < 1024 || SYSTEM_PORTS.has(p);

export function PortsView() {
  const localConnId = useAppStore((s) => s.localConnId);
  const wsls = useAppStore((s) => s.wsls);
  const remotes = useAppStore((s) => s.remotes);
  const hostColors = useAppStore((s) => s.hostColors);
  const setTerminalView = useAppStore((s) => s.setTerminalView);
  const setForwardPrefill = useAppStore((s) => s.setForwardPrefill);
  const setPortCounts = useAppStore((s) => s.setPortCounts);
  // Re-render when settings (interval / ignores / hide flag) change.
  useAppStore((s) => s.settingsIssues);

  const [rows, setRows] = useState<Row[]>([]);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const hosts: { connId: string; key: string; host: string; color: string }[] = [];
  if (localConnId)
    hosts.push({ connId: localConnId, key: "local", host: "Local", color: SECTION_LOCAL });
  for (const w of wsls)
    hosts.push({
      connId: w.conn.connId,
      key: `wsl:${w.conn.name}`,
      host: w.conn.name,
      color: hostColors[`wsl:${w.conn.name}`] ?? SECTION_WSL,
    });
  for (const r of remotes)
    hosts.push({
      connId: r.conn.connId,
      key: remoteHostKey(r.conn),
      host: r.conn.name,
      color: hostColorForConnKey(hostColors, remoteHostKey(r.conn)),
    });

  const ignored = new Set(panelsConfig.portsIgnoreHosts);
  const monitored = hosts.filter((h) => !ignored.has(h.key));
  const hideSystem = panelsConfig.hideSystemPorts;
  const interval = panelsConfig.portsInterval;

  useEffect(() => {
    let live = true;
    const poll = async () => {
      const out: Row[] = [];
      const counts: Record<string, number> = {};
      for (const h of monitored) {
        try {
          const ports = await portList(h.connId);
          const visible = ports.filter((p) => !hideSystem || !isSystemPort(p.port));
          counts[h.connId] = visible.length;
          out.push(...visible.map((p) => ({ ...p, connId: h.connId, host: h.host, color: h.color })));
        } catch {
          /* host busy/disconnected — skip this round */
        }
      }
      if (live) {
        // Host groups first (connection order), then by port number.
        const rank = (id: string) => monitored.findIndex((h) => h.connId === id);
        out.sort((a, b) => rank(a.connId) - rank(b.connId) || a.port - b.port);
        setRows(out);
        setPortCounts(counts);
        setCheckedAt(Date.now());
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), interval * 1000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    localConnId,
    wsls,
    remotes,
    hideSystem,
    interval,
    panelsConfig.portsIgnoreHosts.join(","),
  ]);

  const toggleHost = (key: string) => {
    const next = ignored.has(key)
      ? panelsConfig.portsIgnoreHosts.filter((h) => h !== key)
      : [...panelsConfig.portsIgnoreHosts, key];
    void updateSettings({ panels: { ...panelsConfig, portsIgnoreHosts: next } });
  };

  return (
    <div className="ports-view">
      <div className="ports-view__head">
        <span className="ports-view__controls">
          {hosts.map((h) => (
            <label key={h.key} className="ports-view__host-toggle" title={`Monitor ${h.host}`}>
              <input
                type="checkbox"
                checked={!ignored.has(h.key)}
                onChange={() => toggleHost(h.key)}
              />
              <span style={{ color: h.color }}>{h.host}</span>
            </label>
          ))}
          <label className="ports-view__host-toggle" title="Hide well-known/system ports (<1024, RDP, mDNS…)">
            <input
              type="checkbox"
              checked={hideSystem}
              onChange={(e) =>
                void updateSettings({
                  panels: { ...panelsConfig, hideSystemPorts: e.target.checked },
                })
              }
            />
            hide system ports
          </label>
          <label className="ports-view__host-toggle" title="Poll interval while this tab is open (seconds, saved to settings.json)">
            every
            <input
              type="number"
              className="input ports-view__interval"
              min={3}
              max={3600}
              value={interval}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (v >= 3 && v <= 3600)
                  void updateSettings({ panels: { ...panelsConfig, portsInterval: v } });
              }}
            />
            s
          </label>
        </span>
        {checkedAt && (
          <span className="ports-view__stamp">
            checked {new Date(checkedAt).toLocaleTimeString()}
          </span>
        )}
      </div>
      <table className="ports-table">
        <thead>
          <tr>
            <th>Host</th>
            <th>Port</th>
            <th>Address</th>
            <th>Process</th>
            <th>PID</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.connId}:${r.address}:${r.port}`}>
              <td>
                <span className="ports-table__host" style={{ color: r.color }}>
                  {r.host}
                </span>
              </td>
              <td className="mono">{r.port}</td>
              <td className="mono">{r.address}</td>
              <td>{r.process ?? "—"}</td>
              <td className="mono">{r.pid ?? "—"}</td>
              <td>
                {r.connId !== localConnId && (
                  <button
                    className="btn btn--ghost"
                    title="Forward this port to 127.0.0.1"
                    onClick={() => {
                      setForwardPrefill({ connId: r.connId, port: r.port });
                      setTerminalView("forwarding");
                    }}
                  >
                    Forward
                  </button>
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="ports-table__empty">
                No listening ports on the monitored hosts (system ports
                {hideSystem ? " hidden" : " shown"}).
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
