/** The CHAT column — a bare terminal docked beside Source Control, meant for
 *  Claude Code or any other CLI you pair with. Residents are ordinary
 *  terminals (`inChat`); one shows at a time, the 12px dots switch between
 *  them, and hiding the column never evicts anyone. The live xterm DOM is
 *  reparented in (terminalSlots) — the shell never restarts. */
import { useEffect, useRef, useState } from "react";

import { hostColorForConnKey } from "../../lib/hostColors";
import { fitTerminal, focusTerminal } from "../../lib/terminalFocus";
import { mountTerminalIn, parkTerminal } from "../../lib/terminalSlots";
import {
  chatSections,
  cleanOscTitle,
  connectedChatHosts,
  remoteHostKey,
  termDisplayName,
  useAppStore,
} from "../../store/appStore";
import {
  IconChatBubble,
  IconClose,
  IconMinus,
  IconPanelHide,
  IconPlus,
  IconLayers,
  IconToBar,
} from "../icons";
import { Tip } from "../Tooltip";
import { ChatAgentMenu } from "./ChatAgentMenu";

export function ChatPanel() {
  const terminals = useAppStore((s) => s.terminals);
  const chatActiveId = useAppStore((s) => s.chatActiveId);
  const setChatActive = useAppStore((s) => s.setChatActive);
  const setChatVisible = useAppStore((s) => s.setChatVisible);
  const returnTerminalFromChat = useAppStore((s) => s.returnTerminalFromChat);
  const closeTerminal = useAppStore((s) => s.closeTerminal);
  const openAgentInChat = useAppStore((s) => s.openAgentInChat);
  const renameTerminal = useAppStore((s) => s.renameTerminal);
  const dockOrder = useAppStore((s) => s.dockOrder);
  const stepDock = useAppStore((s) => s.stepDock);
  const chatPos = dockOrder.indexOf("chat");
  const busy = useAppStore((s) => s.busy);
  const ptyDead = useAppStore((s) => s.ptyDead);
  const localConnId = useAppStore((s) => s.localConnId);
  const wsls = useAppStore((s) => s.wsls);
  const remotes = useAppStore((s) => s.remotes);
  const focusView = useAppStore((s) => s.focusView);
  const chatHostOrder = useAppStore((s) => s.chatHostOrder);
  const chatPurposes = useAppStore((s) => s.chatPurposes);
  const addPurpose = useAppStore((s) => s.addPurpose);
  const renamePurpose = useAppStore((s) => s.renamePurpose);

  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [purposeRenaming, setPurposeRenaming] = useState<{
    id: string;
    value: string;
  } | null>(null);
  const [dotMenu, setDotMenu] = useState<{
    termId: string;
    x: number;
    y: number;
  } | null>(null);
  const commitPurposeRename = () => {
    if (purposeRenaming) renamePurpose(purposeRenaming.id, purposeRenaming.value);
    setPurposeRenaming(null);
  };
  const hostRef = useRef<HTMLDivElement>(null);

  const residents = terminals.filter((t) => t.inChat);
  const active =
    residents.find((t) => t.id === chatActiveId) ?? residents[0] ?? null;
  const activeId = active?.id ?? null;

  // Reparent the active resident's live xterm into the column — unless the
  // focus view is open, which owns it then (they'd fight over the one DOM
  // node otherwise). Re-runs on the focusView flip so ownership hands back
  // cleanly on exit.
  useEffect(() => {
    if (focusView || !activeId || !hostRef.current) return;
    mountTerminalIn(activeId, hostRef.current);
    // Deterministic refit after the reparent (see FocusView) — the column's
    // width applies immediately instead of via the debounced observer.
    fitTerminal(activeId);
    focusTerminal(activeId);
    return () => parkTerminal(activeId);
  }, [activeId, focusView]);

  const hostKeyOf = (connId: string): string => {
    if (connId === localConnId) return "local";
    const w = wsls.find((x) => x.conn.connId === connId);
    if (w) return `wsl:${w.conn.name}`;
    const r = remotes.find((x) => x.conn.connId === connId);
    return r ? remoteHostKey(r.conn) : "local";
  };

  // ＋ opens on any connected host, in the canonical order.
  const hosts: { connId: string; label: string }[] = [
    ...(localConnId ? [{ connId: localConnId, label: "pwsh" }] : []),
    ...wsls.map((w) => ({ connId: w.conn.connId, label: w.conn.name })),
    ...remotes.map((r) => ({ connId: r.conn.connId, label: r.conn.name })),
  ];

  return (
    <div className="chat-panel" data-tour="sessions">
      <div className="chat-panel__head">
        {/* Line 1: the controls. */}
        <div className="chat-panel__bar">
          <span className="chat-panel__newwrap">
            <Tip label="New session">
              <button className="icon-btn" onClick={() => setMenuOpen((v) => !v)}>
                <IconPlus size={13} />
              </button>
            </Tip>
            {menuOpen && (
              <>
                <div
                  className="menu-backdrop"
                  onClick={() => setMenuOpen(false)}
                />
                <div className="terminal-menu chat-panel__menu" role="menu">
                  {hosts.length === 0 ? (
                    <div className="terminal-menu__item">No hosts connected</div>
                  ) : (
                    hosts.map((h) => (
                      <button
                        key={h.connId}
                        className="terminal-menu__item"
                        onClick={() => {
                          setMenuOpen(false);
                          void openAgentInChat(h.connId, h.label);
                        }}
                      >
                        {h.label}
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </span>
          <Tip label="New group">
            <button
              className="icon-btn"
              onClick={() => {
                const id = addPurpose();
                setPurposeRenaming({ id, value: "" });
              }}
            >
              <IconLayers size={14} />
            </button>
          </Tip>
          <span className="chat-panel__spacer" />
          <Tip label="Move left">
            <button
              className="icon-btn"
              disabled={chatPos <= 0}
              onClick={() => stepDock("chat", -1)}
            >
              <IconToBar size={13} dir="left" />
            </button>
          </Tip>
          <Tip label="Move right">
            <button
              className="icon-btn"
              disabled={chatPos === dockOrder.length - 1}
              onClick={() => stepDock("chat", 1)}
            >
              <IconToBar size={13} dir="right" />
            </button>
          </Tip>
          <Tip label="Hide Sessions">
            <button
              className="icon-btn panel-head__hide"
              onClick={() => setChatVisible(false)}
            >
              <IconPanelHide size={14} />
            </button>
          </Tip>
        </div>

        {/* Line 2: the dot clusters — purpose groups first, then host groups,
            wrapping to more lines when they overflow. Drag a dot into a group
            (or back to its host); right-click for the same. */}
        <div className="chat-panel__dots" role="tablist">
          {chatSections(
            terminals,
            chatPurposes,
            connectedChatHosts({ localConnId, wsls, remotes, chatHostOrder }),
          ).map((section) => {
            const color =
              section.kind === "purpose"
                ? section.color
                : hostColorForConnKey(hostKeyOf(section.connId));
            return (
              <div
                className={`chat-panel__cluster${section.kind === "purpose" ? " chat-panel__cluster--purpose" : ""}`}
                key={section.kind === "purpose" ? `p:${section.id}` : `h:${section.connId}`}
                style={{ "--cluster-color": color } as React.CSSProperties}
              >
                {/* A purpose pill is labeled with its name — click to rename
                    (empty groups are still visible, ready to drop into). */}
                {section.kind === "purpose" &&
                  (purposeRenaming?.id === section.id ? (
                    <input
                      className="chat-panel__prename"
                      autoFocus
                      spellCheck={false}
                      value={purposeRenaming.value}
                      placeholder={section.name}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) =>
                        setPurposeRenaming({
                          id: section.id,
                          value: e.target.value,
                        })
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitPurposeRename();
                        else if (e.key === "Escape") setPurposeRenaming(null);
                      }}
                      onBlur={commitPurposeRename}
                    />
                  ) : (
                    <span
                      className="chat-panel__pname"
                      onClick={() =>
                        setPurposeRenaming({
                          id: section.id,
                          value: section.name,
                        })
                      }
                    >
                      {section.name}
                    </span>
                  ))}
                {section.terminals.map((t) => {
                  const inTool = !!cleanOscTitle(t.oscTitle);
                  const state = ptyDead[t.id]
                    ? "dead"
                    : !inTool
                      ? "idle"
                      : busy[t.id]
                        ? "running"
                        : "ready";
                  return (
                    <Tip key={t.id} label={termDisplayName(t)}>
                      <button
                        role="tab"
                        aria-selected={t.id === activeId}
                        className={`chat-dot chat-dot--${state}${t.id === activeId ? " chat-dot--picked" : ""}`}
                        onClick={() => setChatActive(t.id)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setDotMenu({ termId: t.id, x: e.clientX, y: e.clientY });
                        }}
                      >
                        <span className="chat-dot__mark" />
                      </button>
                    </Tip>
                  );
                })}
              </div>
            );
          })}
        </div>
        {active && (
          <div className="chat-panel__name">
            {renaming !== null ? (
              <input
                className="chat-panel__rename"
                value={renaming}
                autoFocus
                spellCheck={false}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setRenaming(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    renameTerminal(active.id, renaming);
                    setRenaming(null);
                  } else if (e.key === "Escape") {
                    setRenaming(null);
                  }
                }}
                onBlur={() => {
                  renameTerminal(active.id, renaming);
                  setRenaming(null);
                }}
              />
            ) : (
              <Tip label={termDisplayName(active)}>
                <span
                  className="chat-panel__title"
                  // Host color as TEXT is mixed toward the foreground so dark
                  // identities (Local's crimson) stay legible (see FocusView).
                  style={{
                    color: `color-mix(in srgb, ${hostColorForConnKey(hostKeyOf(active.connId))} 62%, var(--fg-primary))`,
                  }}
                  onDoubleClick={() => setRenaming(termDisplayName(active))}
                >
                  {termDisplayName(active)}
                </span>
              </Tip>
            )}
            <Tip label="Back to TERMINAL">
              <button
                className="icon-btn"
                onClick={() => returnTerminalFromChat(active.id)}
              >
                <IconMinus size={13} />
              </button>
            </Tip>
            <Tip label="Close terminal">
              <button
                className="icon-btn chat-panel__kill"
                onClick={() => closeTerminal(active.id)}
              >
                <IconClose size={12} />
              </button>
            </Tip>
          </div>
        )}
      </div>
      {active ? (
        <div className="chat-panel__body" ref={hostRef} />
      ) : (
        <div className="chat-panel__empty">
          <IconChatBubble size={28} className="chat-panel__empty-icon" />
          <p>
            A quiet seat for Claude Code — or any shell you pair with.
          </p>
          <p className="chat-panel__empty-hint">
            Press ＋ above, or send a terminal here from the panel below.
          </p>
        </div>
      )}
      {dotMenu && (
        <ChatAgentMenu
          termId={dotMenu.termId}
          x={dotMenu.x}
          y={dotMenu.y}
          onClose={() => setDotMenu(null)}
        />
      )}
    </div>
  );
}
