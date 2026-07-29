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
import { Tip } from "../Tooltip";

interface Row extends PortInfo {
  connId: string;
  host: string;
  color: string;
}

/** VS Code-style noise rule: privileged ports plus classic infra services. */
const SYSTEM_PORTS = new Set([1900, 2049, 3389, 5353, 5355]);
const isSystemPort = (p: number) => p < 1024 || SYSTEM_PORTS.has(p);

type SortCol = "port" | "address" | "process" | "pid";

/** Sort within each host group. The group order is a rotation — the Host
 *  header cycles which host sits first — and inside a group the clicked column
 *  decides, with a missing Process/PID always sinking to the bottom whichever
 *  direction is active. */
function sortRows(
  rows: Row[],
  order: string[],
  hostFirst: number,
  col: SortCol,
  dir: "asc" | "desc",
): Row[] {
  const n = order.length || 1;
  const groupRank = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : (((i - hostFirst) % n) + n) % n;
  };
  const d = dir === "asc" ? 1 : -1;
  const within = (a: Row, b: Row): number => {
    switch (col) {
      case "port":
        return (a.port - b.port) * d;
      case "address":
        return a.address.localeCompare(b.address, undefined, { numeric: true }) * d;
      case "process":
        if (!a.process && !b.process) return 0;
        if (!a.process) return 1;
        if (!b.process) return -1;
        return a.process.localeCompare(b.process, undefined, { sensitivity: "base" }) * d;
      case "pid":
        if (a.pid == null && b.pid == null) return 0;
        if (a.pid == null) return 1;
        if (b.pid == null) return -1;
        return (a.pid - b.pid) * d;
    }
    return 0;
  };
  return [...rows].sort(
    (a, b) => groupRank(a.connId) - groupRank(b.connId) || within(a, b),
  );
}

export function PortsView() {
  const localConnId = useAppStore((s) => s.localConnId);
  const wsls = useAppStore((s) => s.wsls);
  const remotes = useAppStore((s) => s.remotes);
  const setTerminalView = useAppStore((s) => s.setTerminalView);
  const setForwardPrefill = useAppStore((s) => s.setForwardPrefill);
  const setPortCounts = useAppStore((s) => s.setPortCounts);
  // Re-render when settings (interval / ignores / hide flag) change.
  useAppStore((s) => s.settingsIssues);

  const [rows, setRows] = useState<Row[]>([]);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  // Ephemeral view sort (resets when the tab unmounts). Host is a group
  // rotation; Port/Address/Process/PID sort within each host group.
  const [hostFirst, setHostFirst] = useState(0);
  const [sortCol, setSortCol] = useState<SortCol>("port");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const hosts: { connId: string; key: string; host: string; color: string }[] = [];
  if (localConnId)
    hosts.push({ connId: localConnId, key: "local", host: "Local", color: SECTION_LOCAL });
  for (const w of wsls)
    hosts.push({
      connId: w.conn.connId,
      key: `wsl:${w.conn.name}`,
      host: w.conn.name,
      color: SECTION_WSL,
    });
  for (const r of remotes)
    hosts.push({
      connId: r.conn.connId,
      key: remoteHostKey(r.conn),
      host: r.conn.name,
      color: hostColorForConnKey(remoteHostKey(r.conn)),
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
        // Raw set in monitor order; the table sorts at render (host groups +
        // the clicked column), so a re-poll never disturbs the chosen order.
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

  const order = monitored.map((h) => h.connId);
  const sortedRows = sortRows(rows, order, hostFirst, sortCol, sortDir);
  const cyclable = monitored.length > 1;

  const sortableTh = (col: SortCol, label: string) => (
    <th
      className="ports-table__th ports-table__th--sort"
      onClick={() => {
        setSortDir((d) => (sortCol === col && d === "asc" ? "desc" : "asc"));
        setSortCol(col);
      }}
    >
      {label}
      {sortCol === col && (
        <span className="ports-table__arrow">{sortDir === "asc" ? "▲" : "▼"}</span>
      )}
    </th>
  );

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
            <Tip key={h.key} label={`Monitor ${h.host}`}>
              <label className="ports-view__host-toggle">
                <input
                  type="checkbox"
                  checked={!ignored.has(h.key)}
                  onChange={() => toggleHost(h.key)}
                />
                <span style={{ color: h.color }}>{h.host}</span>
              </label>
            </Tip>
          ))}
          <Tip label="Hide well-known/system ports (<1024, RDP, mDNS…)">
            <label className="ports-view__host-toggle">
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
          </Tip>
          <Tip label="Poll interval while this tab is open">
          <label className="ports-view__host-toggle">
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
          </Tip>
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
            <th
              className={`ports-table__th ${cyclable ? "ports-table__th--sort" : ""}`}
              onClick={
                cyclable
                  ? () => setHostFirst((i) => (i + 1) % monitored.length)
                  : undefined
              }
              title={cyclable ? "Cycle which host is shown first" : undefined}
            >
              Host
              {cyclable && <span className="ports-table__arrow">⇅</span>}
            </th>
            {sortableTh("port", "Port")}
            {sortableTh("address", "Address")}
            {sortableTh("process", "Process")}
            {sortableTh("pid", "PID")}
            <th />
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((r) => (
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
                  <Tip label="Forward to 127.0.0.1">
                  <button
                    className="btn btn--ghost"
                    onClick={() => {
                      setForwardPrefill({ connId: r.connId, port: r.port });
                      setTerminalView("forwarding");
                    }}
                  >
                    Forward
                  </button>
                  </Tip>
                )}
              </td>
            </tr>
          ))}
          {sortedRows.length === 0 && (
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
