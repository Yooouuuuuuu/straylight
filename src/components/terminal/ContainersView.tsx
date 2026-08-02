/** The Containers tab in the terminal panel: running containers across every
 *  monitored host in one sortable table — podman AND docker (the Engine
 *  column says which runtime owns each row). Click a row to jump into a shell
 *  inside it. Controls mirror the Ports tab: host checkboxes and the poll
 *  interval write straight back to settings.json. Lazy by design: nothing
 *  runs while the tab is closed. */
import { useEffect, useState } from "react";

import { hostColorForConnKey, SECTION_LOCAL, SECTION_WSL } from "../../lib/hostColors";
import { containerList, type ContainerInfo } from "../../lib/ipc";
import { panelsConfig, updateSettings } from "../../lib/settings";
import { remoteHostKey, useAppStore } from "../../store/appStore";
import { Tip } from "../Tooltip";

interface Row extends ContainerInfo {
  connId: string;
  host: string;
  color: string;
}

type SortCol =
  | "engine"
  | "name"
  | "id"
  | "image"
  | "command"
  | "created"
  | "status"
  | "ports";

function fieldOf(r: Row, col: SortCol): string {
  switch (col) {
    case "engine":
      return r.engine;
    case "name":
      return r.name;
    case "id":
      return r.id;
    case "image":
      return r.image;
    case "command":
      return r.command;
    case "created":
      return r.created;
    case "status":
      return r.status;
    case "ports":
      return r.ports;
  }
}

/** Sort within each host group. Like the Ports tab: the group order is a
 *  rotation (the Host header cycles which host sits first); inside a group the
 *  clicked column decides. */
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
  return [...rows].sort(
    (a, b) =>
      groupRank(a.connId) - groupRank(b.connId) ||
      fieldOf(a, col).localeCompare(fieldOf(b, col), undefined, {
        numeric: true,
        sensitivity: "base",
      }) * d,
  );
}

export function ContainersView() {
  const localConnId = useAppStore((s) => s.localConnId);
  const wsls = useAppStore((s) => s.wsls);
  const remotes = useAppStore((s) => s.remotes);
  const openTerminal = useAppStore((s) => s.openTerminal);
  const setContainerCounts = useAppStore((s) => s.setContainerCounts);
  // Re-render when settings (interval / ignores) change.
  useAppStore((s) => s.settingsIssues);

  const [rows, setRows] = useState<Row[]>([]);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  // Ephemeral view sort (resets when the tab unmounts).
  const [hostFirst, setHostFirst] = useState(0);
  const [sortCol, setSortCol] = useState<SortCol>("name");
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

  const ignored = new Set(panelsConfig.containersIgnoreHosts);
  const monitored = hosts.filter((h) => !ignored.has(h.key));
  const interval = panelsConfig.containersInterval;

  useEffect(() => {
    let live = true;
    const poll = async () => {
      const out: Row[] = [];
      const counts: Record<string, number> = {};
      for (const h of monitored) {
        try {
          const containers = await containerList(h.connId);
          counts[h.connId] = containers.length;
          out.push(
            ...containers.map((c) => ({
              ...c,
              connId: h.connId,
              host: h.host,
              color: h.color,
            })),
          );
        } catch {
          /* host busy/disconnected — skip this round */
        }
      }
      if (live) {
        // Raw set in monitor order; the table sorts at render, so a re-poll
        // never disturbs the chosen order.
        setRows(out);
        setContainerCounts(counts);
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
    interval,
    panelsConfig.containersIgnoreHosts.join(","),
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
      ? panelsConfig.containersIgnoreHosts.filter((h) => h !== key)
      : [...panelsConfig.containersIgnoreHosts, key];
    void updateSettings({ panels: { ...panelsConfig, containersIgnoreHosts: next } });
  };

  const enter = (r: Row) => {
    openTerminal(r.connId, r.name || r.id, null, `${r.engine} exec -it ${r.id} /bin/sh`);
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
                    void updateSettings({
                      panels: { ...panelsConfig, containersInterval: v },
                    });
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
            {sortableTh("engine", "Engine")}
            {sortableTh("name", "Names")}
            {sortableTh("id", "Container ID")}
            {sortableTh("image", "Image")}
            {sortableTh("command", "Command")}
            {sortableTh("created", "Created")}
            {sortableTh("status", "Status")}
            {sortableTh("ports", "Ports")}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((r) => (
            <tr
              key={`${r.connId}:${r.id}`}
              className="ports-table__row--click"
              title="Open a shell inside"
              onClick={() => enter(r)}
            >
              <td>
                <span className="ports-table__host" style={{ color: r.color }}>
                  {r.host}
                </span>
              </td>
              <td>{r.engine}</td>
              <td>{r.name || "—"}</td>
              <td className="mono">{r.id.slice(0, 12)}</td>
              <td>{r.image}</td>
              <td className="mono">{r.command || "—"}</td>
              <td>{r.created || "—"}</td>
              <td>{r.status}</td>
              <td className="mono">{r.ports || "—"}</td>
            </tr>
          ))}
          {sortedRows.length === 0 && (
            <tr>
              <td colSpan={9} className="ports-table__empty">
                No running containers on the monitored hosts (podman and docker
                are both checked).
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
