/** Ctrl+Tab switcher: a centered overlay listing every editor tab across all
 *  groups — or, when a terminal is focused, every panel terminal across all
 *  hosts. Hold the modifier and keep pressing Tab (Shift+Tab walks backwards);
 *  releasing it lands on the highlighted entry. Esc cancels. Respects
 *  keybinding overrides for editor.nextTab / editor.previousTab; a binding
 *  with no modifier can't "hold to browse" and falls back to the plain cycle
 *  in useKeyboard. */
import { useEffect, useRef, useState } from "react";

import { tabHostColor, hostColorForConnKey } from "../lib/hostColors";
import { matchShortcut } from "../lib/shortcuts";
import { focusTerminal } from "../lib/terminalFocus";
import { remoteHostKey, termDisplayName, useAppStore } from "../store/appStore";

interface Cand {
  kind: "tab" | "terminal" | "chat";
  id: string;
  name: string;
  /** Right-side context: "split 2" for tabs, the host name for terminals. */
  detail: string;
  color: string | null;
}

interface SwitcherState {
  mode: "tabs" | "terminals" | "chat";
  list: Cand[];
  index: number;
}

function buildTabs(): { list: Cand[]; currentId: string | null } {
  const s = useAppStore.getState();
  const list: Cand[] = [];
  for (const g of s.editorGroups) {
    const n = s.editorGroups.indexOf(g) + 1;
    for (const t of s.tabs.filter((t) => (t.groupId ?? 0) === g)) {
      list.push({
        kind: "tab",
        id: t.id,
        name: t.name,
        detail: s.editorGroups.length > 1 ? `split ${n}` : "",
        color: tabHostColor(t.connId),
      });
    }
  }
  return { list, currentId: s.activeTabId };
}

function buildTerminals(): { list: Cand[]; currentId: string | null } {
  const s = useAppStore.getState();
  const hostOf = (connId: string): { label: string; key: string } => {
    if (connId === s.localConnId) return { label: "Local", key: "local" };
    const w = s.wsls.find((x) => x.conn.connId === connId);
    if (w) return { label: w.conn.name, key: `wsl:${w.conn.name}` };
    const r = s.remotes.find((r) => r.conn.connId === connId);
    return r
      ? { label: r.conn.name, key: remoteHostKey(r.conn) }
      : { label: "?", key: "local" };
  };
  // First host's terminals 1, 2, 3…, then the second host's, then the third's
  // — hosts in the group bar's dragged order, terminals in THEIR dragged order.
  const hosts: string[] = [];
  if (s.localConnId) hosts.push(s.localConnId);
  for (const w of s.wsls) hosts.push(w.conn.connId);
  for (const r of s.remotes) hosts.push(r.conn.connId);
  const rank = (connId: string) => {
    const i = s.termGroupOrder.indexOf(connId);
    return i < 0 ? s.termGroupOrder.length : i;
  };
  hosts.sort((a, b) => rank(a) - rank(b));
  const list = hosts.flatMap((h) =>
    s.terminals
      .filter((t) => !t.inChat && t.connId === h)
      .map((t) => {
        const host = hostOf(t.connId);
        return {
          kind: "terminal" as const,
          id: t.id,
          name: termDisplayName(t),
          detail: host.label,
          color: hostColorForConnKey(s.hostColors, host.key),
        };
      }),
  );
  return { list, currentId: s.activeTerminalId };
}

/** Focus in the CHAT column: the switcher walks its residents (the dots). */
function buildChat(): { list: Cand[]; currentId: string | null } {
  const s = useAppStore.getState();
  const hostOf = (connId: string): { label: string; key: string } => {
    if (connId === s.localConnId) return { label: "Local", key: "local" };
    const w = s.wsls.find((x) => x.conn.connId === connId);
    if (w) return { label: w.conn.name, key: `wsl:${w.conn.name}` };
    const r = s.remotes.find((r) => r.conn.connId === connId);
    return r
      ? { label: r.conn.name, key: remoteHostKey(r.conn) }
      : { label: "?", key: "local" };
  };
  const list = s.terminals
    .filter((t) => t.inChat)
    .map((t) => {
      const host = hostOf(t.connId);
      return {
        kind: "chat" as const,
        id: t.id,
        name: termDisplayName(t),
        detail: host.label,
        color: hostColorForConnKey(s.hostColors, host.key),
      };
    });
  return { list, currentId: s.chatActiveId };
}

function activate(c: Cand) {
  const store = useAppStore.getState();
  if (c.kind === "tab") {
    store.setActiveTab(c.id);
  } else if (c.kind === "chat") {
    store.setChatVisible(true);
    store.setChatActive(c.id);
    requestAnimationFrame(() => focusTerminal(c.id));
  } else {
    store.setTerminalView("terminals");
    store.setTerminalVisible(true);
    store.setActiveTerminal(c.id);
    requestAnimationFrame(() => focusTerminal(c.id));
  }
}

export function TabSwitcher() {
  const [state, setState] = useState<SwitcherState | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const selRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    selRef.current?.scrollIntoView({ block: "nearest" });
  }, [state?.index]);

  useEffect(() => {
    const commit = () => {
      const st = stateRef.current;
      if (!st) return;
      setState(null);
      const c = st.list[st.index];
      if (c) activate(c);
    };

    const move = (dir: 1 | -1) =>
      setState((st) =>
        st
          ? { ...st, index: (st.index + dir + st.list.length) % st.list.length }
          : st,
      );

    const open = (dir: 1 | -1) => {
      const el = document.activeElement as HTMLElement | null;
      const inChat = !!el?.closest(".chat-panel");
      const inTerminal = !inChat && !!el?.closest(".terminal-host");
      let built = inChat
        ? buildChat()
        : inTerminal
          ? buildTerminals()
          : buildTabs();
      let mode: SwitcherState["mode"] = inChat
        ? "chat"
        : inTerminal
          ? "terminals"
          : "tabs";
      if (mode !== "tabs" && built.list.length === 0) {
        built = buildTabs();
        mode = "tabs";
      }
      if (built.list.length === 0) return;
      const cur = built.list.findIndex((c) => c.id === built.currentId);
      const index =
        (Math.max(cur, 0) + dir + built.list.length) % built.list.length;
      setState({ mode, list: built.list, index });
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const action = matchShortcut(e);
      if (action === "nextTab" || action === "prevTab") {
        // Hold-to-browse needs a held modifier to release.
        if (!e.ctrlKey && !e.metaKey && !e.altKey) return;
        e.preventDefault();
        e.stopPropagation();
        const dir = action === "prevTab" ? -1 : 1;
        if (stateRef.current) move(dir);
        else open(dir);
        return;
      }
      if (!stateRef.current) return;
      if (e.key === "Escape") {
        setState(null);
      } else if (e.key === "ArrowDown") {
        move(1);
      } else if (e.key === "ArrowUp") {
        move(-1);
      } else if (e.key === "Enter") {
        commit();
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!stateRef.current) return;
      if (!e.ctrlKey && !e.metaKey && !e.altKey) commit();
    };

    const onBlur = () => setState(null);

    // Capture phase: runs before xterm's own key handling and before
    // useKeyboard's bubble handler, so Ctrl+Tab works inside a terminal too.
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  if (!state) return null;
  return (
    <div className="switcher">
      <div className="switcher__box">
        <div className="switcher__title">
          {state.mode === "tabs"
            ? "Editor tabs"
            : state.mode === "chat"
              ? "CHAT"
              : "Terminals"}
        </div>
        <div className="switcher__list">
          {state.list.map((c, i) => (
            <div
              key={c.id}
              ref={i === state.index ? selRef : undefined}
              className={`switcher__item${i === state.index ? " switcher__item--sel" : ""}`}
              onMouseEnter={() => setState((st) => (st ? { ...st, index: i } : st))}
              onMouseDown={(e) => {
                e.preventDefault();
                setState(null);
                activate(c);
              }}
            >
              <span
                className="switcher__dot"
                style={c.color ? { background: c.color } : undefined}
              />
              <span className="switcher__name">{c.name}</span>
              {c.detail && <span className="switcher__detail">{c.detail}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
