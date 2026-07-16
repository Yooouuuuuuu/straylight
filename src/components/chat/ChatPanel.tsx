/** The CHAT column — a bare terminal docked beside Source Control, meant for
 *  Claude Code or any other CLI you pair with. Residents are ordinary
 *  terminals (`inChat`); one shows at a time, the 12px dots switch between
 *  them, and hiding the column never evicts anyone. The live xterm DOM is
 *  reparented in (terminalSlots) — the shell never restarts. */
import { useEffect, useRef, useState } from "react";

import { hostColorForConnKey } from "../../lib/hostColors";
import { focusTerminal } from "../../lib/terminalFocus";
import { mountTerminalIn, parkTerminal } from "../../lib/terminalSlots";
import {
  cleanOscTitle,
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
  IconToBar,
} from "../icons";
import { Tip } from "../Tooltip";

export function ChatPanel() {
  const terminals = useAppStore((s) => s.terminals);
  const chatActiveId = useAppStore((s) => s.chatActiveId);
  const setChatActive = useAppStore((s) => s.setChatActive);
  const setChatVisible = useAppStore((s) => s.setChatVisible);
  const returnTerminalFromChat = useAppStore((s) => s.returnTerminalFromChat);
  const closeTerminal = useAppStore((s) => s.closeTerminal);
  const openTerminalInChat = useAppStore((s) => s.openTerminalInChat);
  const renameTerminal = useAppStore((s) => s.renameTerminal);
  const dockOrder = useAppStore((s) => s.dockOrder);
  const stepDock = useAppStore((s) => s.stepDock);
  const chatPos = dockOrder.indexOf("chat");
  const hostColors = useAppStore((s) => s.hostColors);
  const busy = useAppStore((s) => s.busy);
  const ptyDead = useAppStore((s) => s.ptyDead);
  const localConnId = useAppStore((s) => s.localConnId);
  const wsls = useAppStore((s) => s.wsls);
  const remotes = useAppStore((s) => s.remotes);

  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  const residents = terminals.filter((t) => t.inChat);
  const active =
    residents.find((t) => t.id === chatActiveId) ?? residents[0] ?? null;
  const activeId = active?.id ?? null;

  // Reparent the active resident's live xterm into the column.
  useEffect(() => {
    if (!activeId || !hostRef.current) return;
    mountTerminalIn(activeId, hostRef.current);
    focusTerminal(activeId);
    return () => parkTerminal(activeId);
  }, [activeId]);

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
    <div className="chat-panel">
      <div className="chat-panel__head">
        <div className="chat-panel__dots" role="tablist">
          {residents.map((t) => {
            // Host color is only the outline; the fill is the lifecycle, and
            // it only runs while a TOOL is in charge of the terminal — i.e.
            // it announced itself via the terminal title (Claude Code, vim…).
            // A bare shell prompt has only path-noise titles (filtered by
            // cleanOscTitle) and stays blank. Picked (on screen) fills white,
            // covering whatever the state is.
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
                  style={
                    {
                      "--dot-color": hostColorForConnKey(
                        hostColors,
                        hostKeyOf(t.connId),
                      ),
                    } as React.CSSProperties
                  }
                  onClick={() => setChatActive(t.id)}
                >
                  <span className="chat-dot__mark" />
                </button>
              </Tip>
            );
          })}
          <span className="chat-panel__spacer" />
          <span className="chat-panel__newwrap">
            <button
              className="icon-btn"
              title="New terminal here…"
              onClick={() => setMenuOpen((v) => !v)}
            >
              <IconPlus size={13} />
            </button>
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
                          openTerminalInChat(h.connId, h.label);
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
          <button
            className="icon-btn"
            title="Move left (past the editor)"
            disabled={chatPos <= 0}
            onClick={() => stepDock("chat", -1)}
          >
            <IconToBar size={13} dir="left" />
          </button>
          <button
            className="icon-btn"
            title="Move right (past the editor)"
            disabled={chatPos === dockOrder.length - 1}
            onClick={() => stepDock("chat", 1)}
          >
            <IconToBar size={13} dir="right" />
          </button>
          <button
            className="icon-btn panel-head__hide"
            title="Hide CHAT (the status bar brings it back)"
            onClick={() => setChatVisible(false)}
          >
            <IconPanelHide size={14} />
          </button>
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
              <span
                className="chat-panel__title"
                title={termDisplayName(active)}
                onDoubleClick={() => setRenaming(termDisplayName(active))}
              >
                {termDisplayName(active)}
              </span>
            )}
            <button
              className="icon-btn"
              title="Return to the terminal panel"
              onClick={() => returnTerminalFromChat(active.id)}
            >
              <IconMinus size={13} />
            </button>
            <button
              className="icon-btn chat-panel__kill"
              title="Close terminal"
              onClick={() => closeTerminal(active.id)}
            >
              <IconClose size={12} />
            </button>
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
    </div>
  );
}
