/** The focus view (F11): a full-window CHAT workspace filling the body (the
 *  title bar stays; the status bar hides). LEFT — a resizable panel: agents
 *  grouped into solid host-color blocks (a slim colored strip is the identity
 *  + host drag handle; drag an agent within its host to reorder; double-click
 *  to rename; ✕ to close). Each agent shows a state icon on the left, its
 *  last line under the name, and — when done — how long ago it finished on
 *  the right (a fresh, unread result vs. one already seen). At the bottom a
 *  HOSTS block: every connected host (name + state word, `user@host` on
 *  hover, draggable to reorder) with `check usage` and a ＋. The usage check
 *  runs a read-only probe and VERIFIES `/usage` rendered — on failure it
 *  stays on the app-logo backdrop and toasts a retry. RIGHT — the active
 *  agent's live terminal, reparented in. The editor is never involved. */
import { Fragment, useEffect, useRef, useState } from "react";

import appIcon from "../assets/icon.png";
import { confirmEnabled } from "../lib/settings";
import { hostColorForConnKey } from "../lib/hostColors";
import {
  fitTerminal,
  focusTerminal,
  readTerminalText,
  sendTerminalInput,
} from "../lib/terminalFocus";
import { mountTerminalIn, parkTerminal } from "../lib/terminalSlots";
import {
  chatSections,
  cleanOscTitle,
  connKeyForConnId,
  connectedChatHosts,
  termDisplayName,
  useAppStore,
  type ChatSection,
  type TerminalSession,
} from "../store/appStore";
import { useVcsStore } from "../store/vcsStore";
import { ChatAgentMenu } from "./chat/ChatAgentMenu";
import { RelativeTime } from "./RelativeTime";
import {
  IconChatBubble,
  IconClose,
  IconPlus,
  IconLayers,
  IconTerminal,
} from "./icons";
import { Tip } from "./Tooltip";

const HOST_MIME = "application/x-straylight-chathost";
const CHAT_MIME = "application/x-straylight-chatterm";
const PURPOSE_MIME = "application/x-straylight-chatpurpose";

// Resizable left panel: 1.2× the old 260px by default, draggable 260–390.
const LIST_MIN = 260;
const LIST_MAX = 390;
const LIST_DEFAULT = 312;
const LIST_KEY = "straylight.focuslist";

/** Skip a buffer line? — Claude Code chrome, none of which is "what it said":
 *  rules, box-drawing, the input prompt, menu choices, the status bar, the
 *  banner, hints, AND the ✻ spinner/stats line ("✻ Brewed for 2s"). */
function isChrome(l: string): boolean {
  if (l.length < 2) return true;
  const box = (l.match(/[│─╭╮╰╯├┤┬┴┼█▌▐░▒▓╔╗╚╝║═▛▜▝▘▞▟]/g) ?? []).length;
  if (box / l.length > 0.25) return true; // rules / borders / banner
  if (/^[>❯➜$#✻✳*]/.test(l)) return true; // prompt / spinner / stats
  if (/^\d+\.\s/.test(l)) return true; // menu choices ("1. Yes…")
  if (
    /manual mode|for shortcuts|for agents|esc to|enter to|ctrl\+|shift\+|press |claude code v|opus |sonnet |with .*effort|using |brewed|tokens|↑|↓/i.test(
      l,
    )
  )
    return true; // status bar / banner / hints / stats
  return false;
}

/** Best-effort "last line the agent gave". Claude prefixes ITS OWN responses
 *  with "●"/"⏺" (the ✻ line is its thinking-stats, not a message) — prefer
 *  the last such response; otherwise the last non-chrome line. A TUI isn't
 *  structured text, so this is a heuristic glance. */
function lastAgentLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim());
  let fallback = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    const bullet = /^[●⏺]\s*(.+)/.exec(raw);
    if (bullet && bullet[1].trim().length > 1) return clip(bullet[1].trim());
    if (!fallback && !isChrome(raw)) fallback = clip(raw);
  }
  return fallback;
}

function clip(l: string): string {
  return l.length > 90 ? l.slice(0, 90) + "…" : l;
}

/** For a plain shell (not a tool): its current directory — read from the last
 *  prompt line (pwsh "PS C:\… >", bash "…:~/dir$"), falling back to the window
 *  title. Cleaner and truer than scraping "the last line" for a bare shell. */
function shellDir(buf: string, title?: string): string {
  const lines = buf.split("\n").map((l) => l.trimEnd());
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    const ps = /^PS\s+(.+?)>\s*$/.exec(l); // PowerShell
    if (ps) return clip(ps[1]);
    const sh = /[:@]\s*([~/][^\s$#]*)\s*[$#]\s*$/.exec(l); // bash/zsh prompt
    if (sh) return clip(sh[1]);
  }
  if (title) {
    const t = title.replace(/^Administrator:\s*/i, "").trim();
    const at = /^[^@\s]+@[^:\s]+:\s*(.+)$/.exec(t); // user@host: path
    return clip(at ? at[1].trim() : t);
  }
  return "";
}

export function FocusView() {
  const terminals = useAppStore((s) => s.terminals);
  const thinking = useAppStore((s) => s.thinking);
  const thinkingSince = useAppStore((s) => s.thinkingSince);
  const belled = useAppStore((s) => s.belled);
  const finishedAt = useAppStore((s) => s.finishedAt);
  const ptyDead = useAppStore((s) => s.ptyDead);
  const chatActiveId = useAppStore((s) => s.chatActiveId);
  const setChatActive = useAppStore((s) => s.setChatActive);
  const clearBell = useAppStore((s) => s.clearBell);
  const openTerminalInChat = useAppStore((s) => s.openTerminalInChat);
  const openAgentInChat = useAppStore((s) => s.openAgentInChat);
  const closeTerminal = useAppStore((s) => s.closeTerminal);
  const renameTerminal = useAppStore((s) => s.renameTerminal);
  const pushNotice = useAppStore((s) => s.pushNotice);
  const moveTerminal = useAppStore((s) => s.moveTerminal);
  const chatHostOrder = useAppStore((s) => s.chatHostOrder);
  const setChatHostOrder = useAppStore((s) => s.setChatHostOrder);
  const chatPurposes = useAppStore((s) => s.chatPurposes);
  const addPurpose = useAppStore((s) => s.addPurpose);
  const renamePurpose = useAppStore((s) => s.renamePurpose);
  const deletePurpose = useAppStore((s) => s.deletePurpose);
  const addToPurpose = useAppStore((s) => s.addToPurpose);
  const removeFromPurpose = useAppStore((s) => s.removeFromPurpose);
  const movePurpose = useAppStore((s) => s.movePurpose);
  const reorderInPurpose = useAppStore((s) => s.reorderInPurpose);
  const localConnId = useAppStore((s) => s.localConnId);
  const wsls = useAppStore((s) => s.wsls);
  const remotes = useAppStore((s) => s.remotes);
  const askConfirm = useVcsStore((s) => s.askConfirm);
  const paneRef = useRef<HTMLDivElement>(null);

  const [loadingProbe, setLoadingProbe] = useState<string | null>(null);
  // Host name whose usage check just failed — the right pane stays on the
  // logo backdrop with a retry hint until the user picks something else.
  const [usageFailed, setUsageFailed] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(
    null,
  );
  const [statusLines, setStatusLines] = useState<Record<string, string>>({});
  // Drag hints, all cleared on drag end. draggingId = the agent being dragged
  // (to ban cross-host drops); dropKey = the block highlighted for an agent
  // move; dropRow = the row an agent would land before; dropGroupKey = the
  // block header highlighted for a group (host/purpose) reorder.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const [dropRow, setDropRow] = useState<string | null>(null);
  const [dropGroupKey, setDropGroupKey] = useState<string | null>(null);
  const [dropGroupAfter, setDropGroupAfter] = useState(false);
  // Which half of a header the cursor is over → insert before / after.
  const halfAfter = (e: React.DragEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY > r.top + r.height / 2;
  };
  const [menu, setMenu] = useState<{ termId: string; x: number; y: number } | null>(
    null,
  );
  const [purposeRenaming, setPurposeRenaming] = useState<{
    id: string;
    value: string;
  } | null>(null);
  const [listWidth, setListWidth] = useState(() => {
    const v = Number(localStorage.getItem(LIST_KEY));
    return v >= LIST_MIN && v <= LIST_MAX ? v : LIST_DEFAULT;
  });

  // Every connected host, canonical order + drag overrides — the ONE order
  // used by both the blocks and the HOSTS section (so closing terminals never
  // reshuffles hosts; only dragging does).
  const hosts = connectedChatHosts({ localConnId, wsls, remotes, chatHostOrder });
  // Purpose blocks first, then the host blocks for uncategorized agents.
  const sections = chatSections(terminals, chatPurposes, hosts);
  const listResidents = sections.flatMap((s) => s.terminals);
  const allResidents = terminals.filter((t) => t.inChat);
  const active =
    allResidents.find((t) => t.id === chatActiveId) ?? listResidents[0] ?? null;
  const activeId = active?.id ?? null;
  const loading = loadingProbe != null && activeId === loadingProbe;
  const activeProbeConn = active?.usageProbe ? active.connId : null;

  const hostName = (connId: string): string => {
    if (connId === localConnId) return "Local";
    return (
      wsls.find((w) => w.conn.connId === connId)?.conn.name ??
      remotes.find((r) => r.conn.connId === connId)?.conn.name ??
      "Host"
    );
  };
  const newLabel = (connId: string): string =>
    connId === localConnId ? "pwsh" : hostName(connId);
  const hostColor = (connId: string): string | undefined => {
    const key = connKeyForConnId(connId);
    return key ? hostColorForConnKey(key) : undefined;
  };
  const hostInfo = (
    connId: string,
  ): { name: string; sub: string | null; state: string | null } => {
    if (connId === localConnId) return { name: "Local", sub: null, state: null };
    const w = wsls.find((x) => x.conn.connId === connId);
    if (w)
      return {
        name: w.conn.name,
        sub: w.conn.user ? `${w.conn.user}@${w.conn.name}` : null,
        state: w.state,
      };
    const r = remotes.find((x) => x.conn.connId === connId);
    if (r)
      return {
        name: r.conn.name,
        sub: `${r.conn.user}@${r.conn.host}`,
        state: r.state,
      };
    return { name: "Host", sub: null, state: null };
  };

  const dropHost = (
    dragConnId: string,
    targetConnId: string,
    after?: boolean,
  ) => {
    if (dragConnId === targetConnId) return;
    const order = [...hosts];
    const from = order.indexOf(dragConnId);
    if (from < 0 || !order.includes(targetConnId)) return;
    order.splice(from, 1);
    let to = order.indexOf(targetConnId);
    if (after) to += 1;
    order.splice(to, 0, dragConnId);
    setChatHostOrder(order);
  };

  const activate = (id: string) => {
    setUsageFailed(null);
    setChatActive(id);
    clearBell(id); // looking at it marks the completion READ
  };

  const USAGE_READY_MS = 9000;
  const REFRESH_READY_MS = 1500;

  const verifyUsage = (id: string, connId: string) => {
    const low = readTerminalText(id).toLowerCase();
    // Failures: no claude, or the channel was refused (MaxSessions).
    const failed =
      /not recognized|command not found|no such file|failed to open terminal|session limit|maxsessions/.test(
        low,
      );
    const hits = ["session", "week", "reset", "limit", "usage", "%"].filter(
      (w) => low.includes(w),
    ).length;
    setLoadingProbe((cur) => (cur === id ? null : cur));
    if (failed || hits < 2) {
      closeTerminal(id);
      setUsageFailed(hostName(connId));
      pushNotice(
        "warn",
        `Couldn't load usage on ${hostName(connId)} — confirm Claude Code is set up for environment and logged in already before retry.`,
      );
    }
  };

  const runProbe = (connId: string, existing: TerminalSession | undefined) => {
    setUsageFailed(null);
    if (existing) {
      setChatActive(existing.id);
      setLoadingProbe(existing.id);
      sendTerminalInput(existing.id, "\x1b"); // Esc — dismiss the open panel
      window.setTimeout(() => sendTerminalInput(existing.id, "/usage\r"), 400);
      window.setTimeout(() => verifyUsage(existing.id, connId), REFRESH_READY_MS);
      return;
    }
    const id = openTerminalInChat(connId, "usage", {
      locked: true,
      usageProbe: true,
      scriptedInput: [
        { text: "claude\r", delayMs: 600 },
        { text: "\r", delayMs: 4000 }, // trust-folder ask, if any
        { text: "\r", delayMs: 6000 }, // …and a spare for slow starts
        { text: "/usage\r", delayMs: 7500 },
      ],
    });
    if (id) {
      setLoadingProbe(id);
      window.setTimeout(() => verifyUsage(id, connId), USAGE_READY_MS);
    }
  };

  const onHostClick = (connId: string) => {
    const existing = terminals.find(
      (t) => t.inChat && t.usageProbe && t.connId === connId,
    );
    if (existing || !confirmEnabled("usage-check")) {
      runProbe(connId, existing);
      return;
    }
    askConfirm(
      "Check Claude usage?",
      `Opens a read-only session on ${hostName(connId)} that runs claude and shows /usage.`,
      () => runProbe(connId, undefined),
      "usage-check",
    );
  };

  const closeAgent = (t: TerminalSession) => {
    const run = () => closeTerminal(t.id);
    if (!confirmEnabled("close-agent")) return run();
    askConfirm(
      "Close session?",
      `Close ${termDisplayName(t)} on ${hostName(t.connId)}? Its shell is terminated.`,
      run,
      "close-agent",
    );
  };

  const commitRename = () => {
    if (renaming) renameTerminal(renaming.id, renaming.value);
    setRenaming(null);
  };
  const commitPurposeRename = () => {
    if (purposeRenaming) renamePurpose(purposeRenaming.id, purposeRenaming.value);
    setPurposeRenaming(null);
  };

  // Drop an agent INTO a purpose (before `beforeId` to reorder), or back onto
  // a host block (only its own host — an agent can't change machines).
  const dropOnPurpose = (draggedId: string, purposeId: string, beforeId?: string) => {
    addToPurpose(purposeId, draggedId);
    if (beforeId && beforeId !== draggedId)
      reorderInPurpose(purposeId, draggedId, beforeId);
  };
  const dropOnHost = (draggedId: string, connId: string, beforeId?: string) => {
    const dragged = terminals.find((t) => t.id === draggedId);
    if (!dragged || dragged.connId !== connId) return;
    removeFromPurpose(draggedId);
    if (beforeId && beforeId !== draggedId) moveTerminal(draggedId, beforeId);
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = listWidth;
    let w = start;
    const onMove = (ev: MouseEvent) => {
      w = Math.min(LIST_MAX, Math.max(LIST_MIN, start + (ev.clientX - startX)));
      setListWidth(w);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      localStorage.setItem(LIST_KEY, String(Math.round(w)));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Reparent the active resident's live xterm into the right pane.
  useEffect(() => {
    if (!activeId || !paneRef.current) return;
    mountTerminalIn(activeId, paneRef.current);
    // Deterministic refit to THIS pane right after the reparent — the xterm
    // and its PTY take the new width now, not when (and if) the debounced
    // ResizeObserver gets around to it.
    fitTerminal(activeId);
    focusTerminal(activeId);
    return () => parkTerminal(activeId);
  }, [activeId]);

  // Clear the drop hints when any drag ends.
  useEffect(() => {
    const clear = () => {
      setDraggingId(null);
      setDropKey(null);
      setDropRow(null);
      setDropGroupKey(null);
      setDropGroupAfter(false);
    };
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);
  // The agent being dragged, if any — used to ban cross-host drops mid-drag.
  const dragged = draggingId
    ? terminals.find((t) => t.id === draggingId)
    : null;

  // Second-line scan (F11-only, throttled): a Claude agent shows its last
  // message, a plain shell shows its current directory.
  useEffect(() => {
    const scan = () => {
      const list = useAppStore
        .getState()
        .terminals.filter((t) => t.inChat && !t.usageProbe);
      setStatusLines((prev) => {
        const next: Record<string, string> = {};
        let changed = list.length !== Object.keys(prev).length;
        for (const t of list) {
          const buf = readTerminalText(t.id);
          const line = cleanOscTitle(t.oscTitle)
            ? lastAgentLine(buf)
            : shellDir(buf, t.oscTitle);
          next[t.id] = line;
          if (prev[t.id] !== line) changed = true;
        }
        return changed ? next : prev;
      });
    };
    scan();
    const timer = window.setInterval(scan, 2000);
    return () => window.clearInterval(timer);
  }, []);

  // One agent row, shared by purpose + host sections (section drives drops).
  const agentRow = (t: TerminalSession, section: ChatSection) => {
    const inTool = !!cleanOscTitle(t.oscTitle);
    const dead = !!ptyDead[t.id];
    const isThinking = inTool && !dead && !!thinking[t.id];
    const unread = inTool && !dead && !!belled[t.id];
    const readDone = inTool && !dead && !belled[t.id] && !!finishedAt[t.id];
    const isRenaming = renaming?.id === t.id;
    const status = statusLines[t.id];
    const accent = hostColor(t.connId);
    return (
      <div
        key={t.id}
        role="button"
        tabIndex={0}
        className={`focus-view__item${t.id === activeId ? " focus-view__item--active" : ""}${dropRow === t.id ? " focus-view__item--dropover" : ""}`}
        draggable={!isRenaming}
        onDragStart={(e) => {
          e.dataTransfer.setData(CHAT_MIME, t.id);
          setDraggingId(t.id);
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(CHAT_MIME)) return;
          e.preventDefault();
          e.stopPropagation();
          // A host block only takes agents of its OWN host — ban the rest.
          const banned =
            section.kind === "host" &&
            dragged != null &&
            dragged.connId !== section.connId;
          e.dataTransfer.dropEffect = banned ? "none" : "move";
          if (banned) {
            if (dropRow === t.id) setDropRow(null);
          } else if (dropRow !== t.id) {
            setDropRow(t.id);
          }
        }}
        onDrop={(e) => {
          const id = e.dataTransfer.getData(CHAT_MIME);
          setDropRow(null);
          setDropKey(null);
          if (!id || id === t.id) return;
          e.preventDefault();
          e.stopPropagation();
          if (section.kind === "purpose") dropOnPurpose(id, section.id, t.id);
          else dropOnHost(id, section.connId, t.id);
        }}
        onClick={() => activate(t.id)}
        onDoubleClick={() => setRenaming({ id: t.id, value: termDisplayName(t) })}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ termId: t.id, x: e.clientX, y: e.clientY });
        }}
      >
        {/* Host-color accent — which machine this runs on (matters in a
            purpose block, which mixes hosts). */}
        <span
          className="focus-view__accent"
          style={accent ? { background: accent } : undefined}
        />
        {/* State icon: non-Claude shell = terminal glyph; a Claude agent is
            the chat glyph — bounces (cyan) thinking, GREEN finished-unread,
            calm gray once read / idle. */}
        <span className="focus-view__icon">
          {!inTool ? (
            <IconTerminal size={13} className="focus-view__shell" />
          ) : isThinking ? (
            <IconChatBubble size={14} className="focus-view__thinking" />
          ) : unread ? (
            <IconChatBubble size={14} className="focus-view__unread" />
          ) : (
            <IconChatBubble size={14} className="focus-view__idle" />
          )}
        </span>

        <span className="focus-view__body">
          {isRenaming ? (
            <input
              className="focus-view__rename"
              autoFocus
              spellCheck={false}
              value={renaming.value}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setRenaming({ id: t.id, value: e.target.value })}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commitRename();
                else if (e.key === "Escape") setRenaming(null);
              }}
              onBlur={commitRename}
            />
          ) : (
            <span className="focus-view__name">{termDisplayName(t)}</span>
          )}
          {status && !isRenaming && (
            <span className="focus-view__status">{status}</span>
          )}
        </span>

        {isThinking && thinkingSince[t.id] ? (
          <RelativeTime
            at={thinkingSince[t.id]}
            title={null}
            thinking
            className="focus-view__time focus-view__time--think"
          />
        ) : (
          (unread || readDone) &&
          finishedAt[t.id] && (
            <RelativeTime
              at={finishedAt[t.id]}
              title={null}
              compact
              className="focus-view__time"
            />
          )
        )}
        <Tip label="Close session">
          <button
            className="focus-view__kill"
            onClick={(e) => {
              e.stopPropagation();
              closeAgent(t);
            }}
          >
            <IconClose size={14} />
          </button>
        </Tip>
      </div>
    );
  };

  return (
    <div className="focus-view">
      <div
        className="focus-view__list"
        style={{ flex: `0 0 ${listWidth}px`, width: listWidth }}
      >
        <div className="focus-view__head">
          <span>SESSIONS</span>
          <Tip label="New group">
            <button
              className="icon-btn"
              onClick={() => {
                const id = addPurpose();
                setPurposeRenaming({ id, value: "" });
              }}
            >
              <IconLayers size={15} />
            </button>
          </Tip>
        </div>

        <div className="focus-view__groups">
          {sections.length === 0 ? (
            <div className="focus-view__list-empty">No sessions running.</div>
          ) : (
            sections.map((section, i) => {
              // With purposes present, label the two runs: "IN PROGRESS"
              // above the first purpose, "UNCATEGORIZED" above the first host.
              const prev = sections[i - 1];
              const subhead =
                chatPurposes.length === 0
                  ? null
                  : section.kind === "purpose" && prev?.kind !== "purpose"
                    ? "IN PROGRESS"
                    : section.kind === "host" && prev?.kind !== "host"
                      ? "UNCATEGORIZED"
                      : null;
              return (
                <Fragment
                  key={
                    section.kind === "purpose"
                      ? `p:${section.id}`
                      : `h:${section.connId}`
                  }
                >
                  {subhead && (
                    <div className="focus-view__subhead">{subhead}</div>
                  )}
                  {section.kind === "purpose" ? (
                <div
                  className={`focus-view__group focus-view__group--purpose${dropKey === `p:${section.id}` ? " focus-view__group--drop" : ""}${dropGroupKey === `p:${section.id}` ? (dropGroupAfter ? " focus-view__group--after" : " focus-view__group--before") : ""}`}
                  style={{ "--group-color": section.color } as React.CSSProperties}
                  onDragOver={(e) => {
                    // The WHOLE block is the drop target — routed by type:
                    // an AGENT drops into the purpose, a PURPOSE reorders it.
                    const types = e.dataTransfer.types;
                    if (types.includes(CHAT_MIME)) {
                      e.preventDefault();
                      if (dropKey !== `p:${section.id}`)
                        setDropKey(`p:${section.id}`);
                    } else if (types.includes(PURPOSE_MIME)) {
                      e.preventDefault();
                      const after = halfAfter(e);
                      if (
                        dropGroupKey !== `p:${section.id}` ||
                        dropGroupAfter !== after
                      ) {
                        setDropGroupKey(`p:${section.id}`);
                        setDropGroupAfter(after);
                      }
                    }
                  }}
                  onDrop={(e) => {
                    const agentId = e.dataTransfer.getData(CHAT_MIME);
                    const groupId = e.dataTransfer.getData(PURPOSE_MIME);
                    e.preventDefault();
                    if (agentId) dropOnPurpose(agentId, section.id);
                    else if (groupId)
                      movePurpose(groupId, section.id, halfAfter(e));
                    setDropKey(null);
                    setDropGroupKey(null);
                  }}
                >
                  <div
                    className="focus-view__purposehead"
                    draggable={purposeRenaming?.id !== section.id}
                    onDragStart={(e) =>
                      e.dataTransfer.setData(PURPOSE_MIME, section.id)
                    }
                    onDoubleClick={() =>
                      setPurposeRenaming({ id: section.id, value: section.name })
                    }
                  >
                    {purposeRenaming?.id === section.id ? (
                      <input
                        className="focus-view__prename"
                        autoFocus
                        spellCheck={false}
                        placeholder={section.name}
                        value={purposeRenaming.value}
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
                      <span className="focus-view__purposename">
                        {section.name}
                      </span>
                    )}
                    <Tip label="Dissolve group">
                      <button
                        className="focus-view__kill"
                        onClick={() => deletePurpose(section.id)}
                      >
                        <IconClose size={13} />
                      </button>
                    </Tip>
                  </div>
                  {section.terminals.length === 0 ? (
                    <div className="focus-view__purpose-empty">
                      drag or add a session here
                    </div>
                  ) : (
                    section.terminals.map((t) => agentRow(t, section))
                  )}
                </div>
              ) : (
                <div
                  className={`focus-view__group${dropKey === `h:${section.connId}` ? " focus-view__group--drop" : ""}${dropGroupKey === `h:${section.connId}` ? (dropGroupAfter ? " focus-view__group--after" : " focus-view__group--before") : ""}`}
                  style={
                    {
                      "--group-color":
                        hostColor(section.connId) ?? "var(--fg-secondary)",
                    } as React.CSSProperties
                  }
                  onDragOver={(e) => {
                    // The WHOLE block is the drop target — routed by type: an
                    // AGENT (only of THIS host — the rest are banned) drops in,
                    // a HOST reorders the block.
                    const types = e.dataTransfer.types;
                    if (types.includes(CHAT_MIME)) {
                      const banned =
                        dragged != null && dragged.connId !== section.connId;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = banned ? "none" : "move";
                      if (banned) {
                        if (dropKey === `h:${section.connId}`) setDropKey(null);
                      } else if (dropKey !== `h:${section.connId}`) {
                        setDropKey(`h:${section.connId}`);
                      }
                    } else if (types.includes(HOST_MIME)) {
                      e.preventDefault();
                      const after = halfAfter(e);
                      if (
                        dropGroupKey !== `h:${section.connId}` ||
                        dropGroupAfter !== after
                      ) {
                        setDropGroupKey(`h:${section.connId}`);
                        setDropGroupAfter(after);
                      }
                    }
                  }}
                  onDrop={(e) => {
                    const agentId = e.dataTransfer.getData(CHAT_MIME);
                    const groupId = e.dataTransfer.getData(HOST_MIME);
                    e.preventDefault();
                    if (agentId) dropOnHost(agentId, section.connId);
                    else if (groupId)
                      dropHost(groupId, section.connId, halfAfter(e));
                    setDropKey(null);
                    setDropGroupKey(null);
                  }}
                >
                  {/* Host header — the host name, a labeled bar the same size
                      as a purpose header, and the reorder drag handle. */}
                  <div
                    className="focus-view__hosthead"
                    draggable
                    onDragStart={(e) =>
                      e.dataTransfer.setData(HOST_MIME, section.connId)
                    }
                  >
                    {hostName(section.connId)}
                  </div>
                  {section.terminals.map((t) => agentRow(t, section))}
                </div>
              )}
                </Fragment>
              );
            })
          )}
        </div>

        <div className="focus-view__hosts">
          <div className="focus-view__head focus-view__hostshead">
            <span>HOST</span>
          </div>
          {hosts.map((connId) => {
            const color = hostColor(connId);
            const info = hostInfo(connId);
            const showingUsage = activeProbeConn === connId;
            return (
              <div
                className={`focus-view__hostrow${showingUsage ? " focus-view__hostrow--active" : ""}`}
                key={connId}
                draggable
                onDragStart={(e) => e.dataTransfer.setData(HOST_MIME, connId)}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes(HOST_MIME))
                    e.preventDefault();
                }}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData(HOST_MIME);
                  if (id) {
                    e.preventDefault();
                    dropHost(id, connId);
                  }
                }}
              >
                <span className="focus-view__hostinfo">
                  <Tip label={info.sub ?? info.name}>
                    <span
                      className="focus-view__hostlabel"
                      // Host color AS TEXT gets mixed toward the foreground —
                      // dark identities (Local's crimson) stay legible while
                      // keeping their hue (backgrounds mix toward bg, same rule).
                      style={
                        color
                          ? { color: `color-mix(in srgb, ${color} 62%, var(--fg-primary))` }
                          : undefined
                      }
                    >
                      {info.name}
                    </span>
                  </Tip>
                  {info.state && (
                    <span
                      className={`focus-view__hoststate focus-view__hoststate--${info.state}`}
                    >
                      — {info.state}
                    </span>
                  )}
                </span>
                <Tip label="Show Claude's /usage on this host">
                  <button
                    className="focus-view__usage"
                    onClick={() => onHostClick(connId)}
                  >
                    check usage
                  </button>
                </Tip>
                <Tip label={`New session on ${info.name}`}>
                  <button
                    className="icon-btn"
                    onClick={() => void openAgentInChat(connId, newLabel(connId))}
                  >
                    <IconPlus size={12} />
                  </button>
                </Tip>
              </div>
            );
          })}
        </div>

        {/* Drag the right edge to resize the panel. */}
        <div className="focus-view__resize" onMouseDown={startResize} />
      </div>

      {usageFailed ? (
        <div className="focus-view__pane focus-view__splash">
          <img src={appIcon} className="focus-view__splash-logo" alt="" />
          <p className="focus-view__splash-hint">
            Couldn't load usage on {usageFailed}. Install Claude Code there and
            set up the environment so the “claude” command works in its
            terminal, then click “check usage” to retry.
          </p>
        </div>
      ) : active ? (
        <div className="focus-view__panewrap">
          <div className="focus-view__pane" ref={paneRef} />
          {loading && (
            <div className="focus-view__splash">
              <img src={appIcon} className="focus-view__splash-logo" alt="" />
              <p className="focus-view__loading">loading usage</p>
            </div>
          )}
        </div>
      ) : (
        <div className="focus-view__pane focus-view__splash">
          <img src={appIcon} className="focus-view__splash-logo" alt="" />
          <p className="focus-view__splash-hint">
            Pick a session,
            <br />
            or ＋ beside a host to start one.
          </p>
        </div>
      )}
      {menu && (
        <ChatAgentMenu
          termId={menu.termId}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
