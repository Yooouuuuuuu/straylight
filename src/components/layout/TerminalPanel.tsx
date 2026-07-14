/** Bottom terminal panel, group-bar edition. The TOP bar lists one draggable
 *  group per connection (Local, WSL, remotes — host colors); each group owns
 *  its terminals, and + opens a terminal on the active group (a shell menu
 *  only for Local). The RIGHT side of the bar holds the tool groups (Ports ·
 *  Containers · Forwarding) and the »-down collapse. The right-side terminal
 *  list shows the active group's terminals — draggable to reorder,
 *  collapsible to an icon-only rail. */
import { useEffect, useMemo, useState } from "react";

import { remoteColor, SECTION_LOCAL, SECTION_WSL } from "../../lib/hostColors";
import { listTerminalProfiles, type TerminalProfile } from "../../lib/ipc";
import { panelsConfig } from "../../lib/settings";
import { remoteHostKey, useAppStore } from "../../store/appStore";
import { ForwardingView } from "../PortForwards";
import { ContainersView } from "../terminal/ContainersView";
import { PortsView } from "../terminal/PortsView";
import { Terminal } from "../terminal/Terminal";
import { TransfersView } from "../transfer/TransfersView";
import {
  IconClose,
  IconCube,
  IconEthernet,
  IconPlus,
  IconTransfer,
  IconTunnel,
} from "../icons";

const GROUP_MIME = "application/x-straylight-termgroup";
const TERM_MIME = "application/x-straylight-termentry";

export function TerminalPanel() {
  const remotes = useAppStore((s) => s.remotes);
  const wsls = useAppStore((s) => s.wsls);
  const localConnId = useAppStore((s) => s.localConnId);
  const hostColors = useAppStore((s) => s.hostColors);
  const terminals = useAppStore((s) => s.terminals);
  const activeTerminalId = useAppStore((s) => s.activeTerminalId);
  const openTerminal = useAppStore((s) => s.openTerminal);
  const closeTerminal = useAppStore((s) => s.closeTerminal);
  const setActiveTerminal = useAppStore((s) => s.setActiveTerminal);
  const setTerminalVisible = useAppStore((s) => s.setTerminalVisible);
  const terminalView = useAppStore((s) => s.terminalView);
  const setTerminalView = useAppStore((s) => s.setTerminalView);
  const moveTerminalToEditor = useAppStore((s) => s.moveTerminalToEditor);
  const moveTerminal = useAppStore((s) => s.moveTerminal);
  const termGroupOrder = useAppStore((s) => s.termGroupOrder);
  const setTermGroupOrder = useAppStore((s) => s.setTermGroupOrder);

  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [selGroup, setSelGroup] = useState<string | null>(null);
  /** Terminal-list width, drag-resizable; narrow enough = icon-only. */
  const [listWidth, setListWidth] = useState(168);
  const listMini = listWidth <= 56;

  const startListDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = listWidth;
    const move = (ev: MouseEvent) => {
      setListWidth(Math.min(320, Math.max(36, startW + (startX - ev.clientX))));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  useEffect(() => {
    let live = true;
    listTerminalProfiles()
      .then((p) => live && setProfiles(p))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // Connection groups: Local + WSL + remotes, in the user's dragged order.
  const groups = useMemo(() => {
    const all: { connId: string; key: string; label: string; color: string }[] = [];
    if (localConnId)
      all.push({ connId: localConnId, key: "local", label: "Local", color: SECTION_LOCAL });
    for (const w of wsls)
      all.push({
        connId: w.conn.connId,
        key: `wsl:${w.conn.name}`,
        label: w.conn.name,
        color: hostColors[`wsl:${w.conn.name}`] ?? SECTION_WSL,
      });
    for (const r of remotes)
      all.push({
        connId: r.conn.connId,
        key: remoteHostKey(r.conn),
        label: r.conn.name,
        color: remoteColor(hostColors, r.conn),
      });
    const rank = (id: string) => {
      const i = termGroupOrder.indexOf(id);
      return i < 0 ? termGroupOrder.length : i;
    };
    return [...all].sort((a, b) => rank(a.connId) - rank(b.connId));
  }, [localConnId, wsls, remotes, hostColors, termGroupOrder]);

  const activeConn =
    terminals.find((t) => t.id === activeTerminalId)?.connId ?? null;
  // Keep the group bar in step when the active terminal changes from outside
  // (the Ctrl+Tab switcher, session restore) — not just via chip clicks.
  useEffect(() => {
    if (activeConn) setSelGroup(activeConn);
  }, [activeConn]);
  const activeGroup =
    (selGroup && groups.some((g) => g.connId === selGroup) && selGroup) ||
    activeConn ||
    localConnId;
  const groupTerminals = terminals.filter(
    (t) => !t.inEditor && t.connId === activeGroup,
  );

  const pickGroup = (connId: string) => {
    setSelGroup(connId);
    setTerminalView("terminals");
    const first = terminals.find((t) => !t.inEditor && t.connId === connId);
    if (first) setActiveTerminal(first.id);
  };

  const newTerminal = (command?: string[] | null, label?: string) => {
    setMenuOpen(false);
    const g = groups.find((x) => x.connId === activeGroup);
    if (!g) return;
    openTerminal(g.connId, label ?? (g.connId === localConnId ? "pwsh" : g.label), command ?? null);
  };

  const dropGroup = (fromId: string, toId: string) => {
    const order = groups.map((g) => g.connId);
    const from = order.indexOf(fromId);
    const to = order.indexOf(toId);
    if (from < 0 || to < 0 || from === to) return;
    order.splice(to, 0, ...order.splice(from, 1));
    setTermGroupOrder(order);
  };

  const portCounts = useAppStore((s) => s.portCounts);
  const containerCounts = useAppStore((s) => s.containerCounts);
  const forwardCount = useAppStore((s) => s.forwardCount);
  useAppStore((s) => s.settingsIssues); // ignore-list changes re-render

  /** "- 4 2" — one digit per (monitored) connection, in group order; "-" = 0.
   *  Nothing until that tab has polled at least once. */
  const digitsFor = (counts: Record<string, number>, respectIgnores: boolean) => {
    const ignored = new Set(panelsConfig.portsIgnoreHosts);
    const list = respectIgnores ? groups.filter((g) => !ignored.has(g.key)) : groups;
    if (list.length === 0 || list.every((g) => counts[g.connId] === undefined))
      return null;
    return list
      .map((g) => (counts[g.connId] ? String(counts[g.connId]) : "-"))
      .join(" ");
  };

  const tool = (
    view: "ports" | "containers" | "forwarding" | "transfers",
    icon: React.ReactNode,
    label: string,
    digits: string | null,
  ) => (
    <button
      key={view}
      className={`termgroup__chip termgroup__chip--tool${terminalView === view ? " termgroup__chip--active" : ""}`}
      onClick={() => setTerminalView(view)}
    >
      <span className="termgroup__toolicon">{icon}</span>
      {label}
      {digits && <span className="termgroup__count">{digits}</span>}
    </button>
  );

  return (
    <div
      className={`terminal-panel terminal-panel--grouped${terminalView !== "terminals" ? " terminal-panel--toolmode" : ""}`}
    >
      <div className="termgroup__bar">
        {groups.map((g) => (
          <button
            key={g.connId}
            className={`termgroup__chip${terminalView === "terminals" && activeGroup === g.connId ? " termgroup__chip--active" : ""}`}
            style={{ "--host-color": g.color } as React.CSSProperties}
            draggable
            onDragStart={(e) => e.dataTransfer.setData(GROUP_MIME, g.connId)}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(GROUP_MIME)) e.preventDefault();
            }}
            onDrop={(e) => {
              const id = e.dataTransfer.getData(GROUP_MIME);
              if (id) dropGroup(id, g.connId);
            }}
            onClick={() => pickGroup(g.connId)}
          >
            <span className="termgroup__letter">
              {g.connId === localConnId
                ? "L"
                : wsls.some((w) => w.conn.connId === g.connId)
                  ? "W"
                  : "R"}
            </span>
            {g.label}
            {(() => {
              const n = terminals.filter(
                (t) => !t.inEditor && t.connId === g.connId,
              ).length;
              return n > 0 ? <span className="termgroup__count">{n}</span> : null;
            })()}
          </button>
        ))}
        <span className="termgroup__spacer" />
        {panelsConfig.ports &&
          tool("ports", <IconEthernet size={13} />, "Ports", digitsFor(portCounts, true))}
        {panelsConfig.containers &&
          tool("containers", <IconCube size={13} />, "Containers", digitsFor(containerCounts, false))}
        {panelsConfig.forwarding &&
          tool(
            "forwarding",
            <IconTunnel size={13} />,
            "Forwarding",
            forwardCount > 0 ? String(forwardCount) : null,
          )}
        {panelsConfig.transfers &&
          tool("transfers", <IconTransfer size={13} />, "Transfers", null)}
        <button
          className="icon-btn termgroup__collapse"
          title="Hide terminal (Ctrl+`)"
          onClick={() => setTerminalVisible(false)}
        >
          »
        </button>
      </div>

      <div className="terminal-panel__split">
        <div className="terminal-panel__body">
          {terminalView !== "terminals" && (
            <div className="tool-inset">
              {terminalView === "containers" && <ContainersView />}
              {terminalView === "ports" && <PortsView />}
              {terminalView === "forwarding" && <ForwardingView />}
              {terminalView === "transfers" && <TransfersView />}
            </div>
          )}
          {terminalView === "terminals" && groupTerminals.length === 0 && (
            <div className="terminal-message">
              No terminals in this group — click + to start one.
            </div>
          )}
          {terminals.map((t) => (
            <div
              key={t.id}
              className="terminal-instance"
              style={{
                display:
                  terminalView === "terminals" &&
                  t.id === activeTerminalId &&
                  !t.inEditor
                    ? "block"
                    : "none",
              }}
            >
              <Terminal
                key={`${t.id}:${t.epoch}`}
                id={t.id}
                connId={t.connId}
                active={terminalView === "terminals" && t.id === activeTerminalId}
                command={t.command}
                initialInput={t.initialInput ?? null}
              />
            </div>
          ))}
        </div>

        {terminalView === "terminals" && (
          <div
            className={`terminal-sidebar${listMini ? " terminal-sidebar--mini" : ""}`}
            style={
              {
                flex: `0 0 ${listMini ? 36 : listWidth}px`,
                "--host-color": groups.find((g) => g.connId === activeGroup)?.color,
              } as React.CSSProperties
            }
          >
            <div
              className="terminal-sidebar__grip"
              title="Drag to resize — all the way right leaves just the icons"
              onMouseDown={startListDrag}
            />
            <div className="terminal-sidebar__actions">
              <button
                className="icon-btn"
                title={
                  activeGroup === localConnId
                    ? "New pwsh terminal (Ctrl+Shift+`)"
                    : "New terminal in this group (Ctrl+Shift+`)"
                }
                onClick={() => newTerminal()}
              >
                <IconPlus size={14} />
              </button>
              {activeGroup === localConnId && (
                <button
                  className="icon-btn terminal-new__caret"
                  title="Select a shell…"
                  onClick={() => setMenuOpen((v) => !v)}
                >
                  ▾
                </button>
              )}
              {menuOpen && (
                <>
                  <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
                  <div className="terminal-menu" role="menu">
                    {profiles.length === 0 ? (
                      <button className="terminal-menu__item" onClick={() => newTerminal()}>
                        Default shell
                      </button>
                    ) : (
                      profiles.map((p) => (
                        <button
                          key={p.id}
                          className="terminal-menu__item"
                          onClick={() => newTerminal(p.command, p.label)}
                        >
                          {p.label}
                        </button>
                      ))
                    )}
                  </div>
                </>
              )}
            </div>
            <div className="terminal-sidebar__list" role="tablist">
              {groupTerminals.map((t) => (
                <div
                  key={t.id}
                  role="tab"
                  aria-selected={t.id === activeTerminalId}
                  className={`terminal-entry${t.id === activeTerminalId ? " terminal-entry--active" : ""}`}
                  title={t.title}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData(TERM_MIME, t.id)}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes(TERM_MIME)) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    const id = e.dataTransfer.getData(TERM_MIME);
                    if (id && id !== t.id) moveTerminal(id, t.id);
                  }}
                  onClick={() => setActiveTerminal(t.id)}
                  onMouseDown={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      closeTerminal(t.id);
                    }
                  }}
                >
                  <span className="terminal-entry__icon">{">_"}</span>
                  {!listMini && (
                    <>
                      <span className="terminal-entry__label">{t.title}</span>
                      <button
                        className="terminal-entry__close terminal-entry__move"
                        title="Move to the editor area (the shell keeps running)"
                        onClick={(e) => {
                          e.stopPropagation();
                          moveTerminalToEditor(t.id);
                        }}
                      >
                        ⇱
                      </button>
                      <button
                        className="terminal-entry__close"
                        title="Close terminal"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTerminal(t.id);
                        }}
                      >
                        <IconClose size={11} />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
