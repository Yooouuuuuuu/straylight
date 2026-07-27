/** Bottom terminal panel, group-bar edition. The TOP bar lists one draggable
 *  group per connection (Local, WSL, remotes — host colors); each group owns
 *  its terminals, and + opens a terminal on the active group (a shell menu
 *  only for Local). The RIGHT side of the bar holds the tool groups (Ports ·
 *  Containers · Forwarding) and the collapse chevron. The right-side terminal
 *  list shows the active group's terminals — draggable to reorder,
 *  collapsible to an icon-only rail. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { remoteColor, SECTION_LOCAL, SECTION_WSL } from "../../lib/hostColors";
import { listTerminalProfiles, type TerminalProfile } from "../../lib/ipc";
import { useWindowSize } from "../../lib/layoutBudget";
import { panelsConfig, uiConfig } from "../../lib/settings";
import { keyLabelFor } from "../../lib/shortcuts";
import { remoteHostKey, termDisplayName, useAppStore } from "../../store/appStore";
import { ForwardingView } from "../PortForwards";
import { ContainersView } from "../terminal/ContainersView";
import { PortsView } from "../terminal/PortsView";
import { Terminal } from "../terminal/Terminal";
import { TransfersView } from "../transfer/TransfersView";
import {
  IconBell,
  IconChevron,
  IconClose,
  IconCube,
  IconEthernet,
  IconPanelHide,
  IconPlus,
  IconToChat,
  IconTransfer,
  IconTunnel,
} from "../icons";
import { Tip } from "../Tooltip";

const GROUP_MIME = "application/x-straylight-termgroup";
const TERM_MIME = "application/x-straylight-termentry";

export function TerminalPanel() {
  const remotes = useAppStore((s) => s.remotes);
  const wsls = useAppStore((s) => s.wsls);
  const localConnId = useAppStore((s) => s.localConnId);
  const terminals = useAppStore((s) => s.terminals);
  const activeTerminalId = useAppStore((s) => s.activeTerminalId);
  const openTerminal = useAppStore((s) => s.openTerminal);
  const closeTerminal = useAppStore((s) => s.closeTerminal);
  const setActiveTerminal = useAppStore((s) => s.setActiveTerminal);
  const pickHostTerminal = useAppStore((s) => s.pickHostTerminal);
  const setTerminalVisible = useAppStore((s) => s.setTerminalVisible);
  const terminalView = useAppStore((s) => s.terminalView);
  const setTerminalView = useAppStore((s) => s.setTerminalView);
  const moveTerminalToChat = useAppStore((s) => s.moveTerminalToChat);
  const moveTerminal = useAppStore((s) => s.moveTerminal);
  const termGroupOrder = useAppStore((s) => s.termGroupOrder);
  const setTermGroupOrder = useAppStore((s) => s.setTermGroupOrder);

  const renameTerminal = useAppStore((s) => s.renameTerminal);
  const belled = useAppStore((s) => s.belled);
  useAppStore((s) => s.settingsRev); // re-render when settings.json changes

  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  // In the store (not component state) so Ctrl+Shift+` can target the
  // selected group even when no terminal is focused (empty group).
  const selGroup = useAppStore((s) => s.termGroup);
  const setSelGroup = useAppStore((s) => s.setTermGroup);
  /** Inline rename on an entry (double-click its label). */
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(
    null,
  );
  /** Terminal-list width, drag-resizable; narrow enough = icon-only. A
   *  narrow WINDOW also forces icon-only, leaving the shell its room. */
  const [listWidth, setListWidth] = useState(168);
  const winSize = useWindowSize();
  const listMini = listWidth <= 56 || winSize.w < 900;

  /** Group-bar density, driven by ACTUAL collision (the rightmost host chip
   *  touching the Ports button = the bar overflows): level 1 = the four tool
   *  chips go icon-only; touch again → level 2 = host chips go letter-only
   *  (and drop their terminal counts). De-escalates once the bar has grown
   *  a comfortable margin past where it collided. */
  const barRef = useRef<HTMLDivElement | null>(null);
  const [barSlim, setBarSlim] = useState(0);
  const barMarks = useRef<number[]>([]);

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
        color: SECTION_WSL,
      });
    for (const r of remotes)
      all.push({
        connId: r.conn.connId,
        key: remoteHostKey(r.conn),
        label: r.conn.name,
        color: remoteColor(r.conn),
      });
    const rank = (id: string) => {
      const i = termGroupOrder.indexOf(id);
      return i < 0 ? termGroupOrder.length : i;
    };
    return [...all].sort((a, b) => rank(a.connId) - rank(b.connId));
  }, [localConnId, wsls, remotes, termGroupOrder]);

  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const check = () => {
      const overflow = el.scrollWidth > el.clientWidth + 1;
      setBarSlim((lvl) => {
        if (overflow && lvl < 2) {
          barMarks.current[lvl + 1] = el.clientWidth;
          return lvl + 1;
        }
        if (!overflow && lvl > 0 && el.clientWidth > (barMarks.current[lvl] ?? 0) + 64) {
          return lvl - 1;
        }
        return lvl;
      });
    };
    check();
    const obs = new ResizeObserver(check);
    obs.observe(el);
    return () => obs.disconnect();
    // Re-check after every density change (cascade 0→1→2 without a resize)
    // and when the chip set itself changes.
  }, [barSlim, groups.length, terminals.length]);

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
    (t) => !t.inChat && t.connId === activeGroup,
  );

  const pickGroup = (connId: string) => {
    // Restore the terminal you were last in on this host (falling back to its
    // newest shell when that one's gone). pickHostTerminal also records the
    // terminal we're leaving, and clears the active slot for an empty host so
    // another group's terminal can't keep showing (Ctrl+` then plain-hides).
    setSelGroup(connId);
    pickHostTerminal(connId);
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
      className={`termgroup__chip termgroup__chip--tool${terminalView === view ? " termgroup__chip--active" : ""}${barSlim >= 1 ? " termgroup__chip--slim" : ""}`}
      onClick={() => setTerminalView(view)}
    >
      <span className="termgroup__toolicon">{icon}</span>
      {/* Level 1 (rightmost host chip touched Ports): icon-only tools. */}
      {barSlim < 1 && label}
      {barSlim < 1 && digits && <span className="termgroup__count">{digits}</span>}
    </button>
  );

  return (
    <div
      className={`terminal-panel terminal-panel--grouped${terminalView !== "terminals" ? " terminal-panel--toolmode" : ""}`}
      // Focusable so the panel-tab cycle (Ctrl+PageDown/Up) can park the
      // keyboard here after switching to a tool view (no xterm to focus).
      tabIndex={-1}
    >
      <div className="termgroup__bar" ref={barRef}>
        {groups.map((g) => (
          <button
            key={g.connId}
            className={`termgroup__chip${terminalView === "terminals" && activeGroup === g.connId ? " termgroup__chip--active" : ""}${barSlim >= 2 ? " termgroup__chip--slim" : ""}`}
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
            {terminals.some((t) => t.connId === g.connId && belled[t.id]) && (
              <IconBell size={10} className="termgroup__bellicon" />
            )}
            {/* Level 2 (bar collided twice): letter-only chips, counts
                dropped — the host color + L/W/R letter identify the chip
                (no hover tooltip by design). */}
            {barSlim < 2 && g.label}
            {barSlim < 2 &&
              (() => {
                // "x+y" — x shells here, y living in the CHAT column.
                const mine = terminals.filter((t) => t.connId === g.connId);
                const n = mine.filter((t) => !t.inChat).length;
                const y = mine.length - n;
                if (n === 0 && y === 0) return null;
                return (
                  <span className="termgroup__count">
                    {y > 0 ? `${n}+${y}` : n}
                  </span>
                );
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
        <Tip label="Hide TERMINAL (Ctrl+`)">
          <button
            className="icon-btn termgroup__collapse panel-head__hide"
            onClick={() => setTerminalVisible(false)}
          >
            <IconPanelHide size={14} />
          </button>
        </Tip>
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
              {(() => {
                const r = remotes.find((x) => x.conn.connId === activeGroup);
                const w = wsls.find((x) => x.conn.connId === activeGroup);
                const ident = r
                  ? `${r.conn.user}@${r.conn.host}`
                  : (w?.conn.name ?? "local");
                const inChat = terminals.filter(
                  (t) => t.inChat && t.connId === activeGroup,
                ).length;
                return inChat > 0
                  ? `No terminals here — ${ident} has ${inChat} in CHAT.`
                  : `No terminals on ${ident} yet.`;
              })()}
              <button className="btn btn--ghost" onClick={() => newTerminal()}>
                New terminal
              </button>
              <kbd>{keyLabelFor("terminal.new") ?? "Ctrl+Shift+`"}</kbd>
            </div>
          )}
          {terminals.map((t) => (
            <div
              key={t.id}
              className="terminal-instance"
              style={{
                // The group filter matters: picking a group with no panel
                // terminals leaves activeTerminalId on the previous group —
                // without it the stale terminal would keep showing over the
                // empty-state message.
                display:
                  terminalView === "terminals" &&
                  t.id === activeTerminalId &&
                  t.connId === activeGroup &&
                  !t.inChat
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
                scriptedInput={t.scriptedInput ?? null}
                locked={!!t.locked}
                ptyConnId={t.laneConnId ?? null}
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
            <Tip label="Drag to resize">
              <div className="terminal-sidebar__grip" onMouseDown={startListDrag} />
            </Tip>
            <div className="terminal-sidebar__actions">
              <Tip
                label={
                  activeGroup === localConnId
                    ? "New pwsh terminal (Ctrl+Shift+`)"
                    : "New terminal (Ctrl+Shift+`)"
                }
              >
                <button className="icon-btn" onClick={() => newTerminal()}>
                  <IconPlus size={14} />
                </button>
              </Tip>
              {activeGroup === localConnId && (
                <Tip label="Select a shell…">
                  <button
                    className="icon-btn terminal-new__caret"
                    onClick={() => setMenuOpen((v) => !v)}
                  >
                    <IconChevron size={12} dir="down" />
                  </button>
                </Tip>
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
                  className={`terminal-entry${t.id === activeTerminalId ? " terminal-entry--active" : ""}${belled[t.id] ? " terminal-entry--bell" : ""}`}
                  draggable={renaming?.id !== t.id}
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
                      {renaming?.id === t.id ? (
                        <input
                          className="terminal-entry__rename"
                          value={renaming.value}
                          autoFocus
                          spellCheck={false}
                          onFocus={(e) => e.target.select()}
                          onChange={(e) =>
                            setRenaming({ id: t.id, value: e.target.value })
                          }
                          onClick={(e) => e.stopPropagation()}
                          onMouseDown={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter") {
                              renameTerminal(t.id, renaming.value);
                              setRenaming(null);
                            } else if (e.key === "Escape") {
                              setRenaming(null);
                            }
                          }}
                          onBlur={() => {
                            renameTerminal(t.id, renaming.value);
                            setRenaming(null);
                          }}
                        />
                      ) : (
                        <Tip label={termDisplayName(t)}>
                          <span
                            className="terminal-entry__label"
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              setRenaming({ id: t.id, value: termDisplayName(t) });
                            }}
                          >
                            {termDisplayName(t)}
                          </span>
                        </Tip>
                      )}
                      {(!uiConfig.disableChat ||
                        terminals.some((x) => x.inChat)) && (
                        <Tip label="Move to Sessions (shell keeps running)">
                          <button
                            className="terminal-entry__close terminal-entry__move"
                            onClick={(e) => {
                              e.stopPropagation();
                              moveTerminalToChat(t.id);
                            }}
                          >
                            <IconToChat size={12} />
                          </button>
                        </Tip>
                      )}
                      <Tip label="Close terminal">
                        <button
                          className="terminal-entry__close terminal-entry__kill"
                          onClick={(e) => {
                            e.stopPropagation();
                            closeTerminal(t.id);
                          }}
                        >
                          <IconClose size={11} />
                        </button>
                      </Tip>
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
