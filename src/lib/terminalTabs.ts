/** Terminal-panel tab cycling (Ctrl+PageDown/Up while the panel is focused):
 *  EVERY shell first — hosts in the bar's displayed (drag) order, each host's
 *  terminals in their list order — then the visible tool views (Ports,
 *  Containers, Forwarding, Transfers), wrapping. So 3 local + 2 WSL + 1
 *  remote shells = six stops, then the tools. */
import { panelsConfig } from "./settings";
import { focusTerminal } from "./terminalFocus";
import { useAppStore } from "../store/appStore";

type ToolView = "ports" | "containers" | "forwarding" | "transfers";
type Entry = { kind: "term"; id: string; connId: string } | { kind: "view"; view: ToolView };

export function cycleTerminalPanelTab(dir: 1 | -1): void {
  const s = useAppStore.getState();

  // Hosts in the panel bar's displayed order (same ranking the bar uses).
  const all: string[] = [];
  if (s.localConnId) all.push(s.localConnId);
  for (const w of s.wsls) all.push(w.conn.connId);
  for (const r of s.remotes) all.push(r.conn.connId);
  const rank = (id: string) => {
    const i = s.termGroupOrder.indexOf(id);
    return i < 0 ? s.termGroupOrder.length : i;
  };
  const groups = [...all].sort((a, b) => rank(a) - rank(b));

  const terms: Entry[] = groups.flatMap((g) =>
    s.terminals
      .filter((t) => !t.inChat && t.connId === g)
      .map((t): Entry => ({ kind: "term", id: t.id, connId: g })),
  );
  const tools: Entry[] = (
    ["ports", "containers", "forwarding", "transfers"] as const
  )
    .filter((v) => panelsConfig[v])
    .map((v): Entry => ({ kind: "view", view: v }));

  const entries = [...terms, ...tools];
  if (entries.length === 0) return;

  // Where are we now? A tool view, or the active shell.
  const cur =
    s.terminalView === "terminals"
      ? entries.findIndex(
          (e) => e.kind === "term" && e.id === s.activeTerminalId,
        )
      : entries.findIndex(
          (e) => e.kind === "view" && e.view === s.terminalView,
        );

  const next = entries[(Math.max(cur, 0) + dir + entries.length) % entries.length];
  if (next.kind === "term") {
    // Land on the shell: its group selected, the shell active and focused so
    // the cycle keys keep working from the new stop.
    s.setTermGroup(next.connId);
    s.setTerminalView("terminals");
    s.setActiveTerminal(next.id);
    focusTerminal(next.id);
  } else {
    s.setTerminalView(next.view);
    // The xterm that had focus is gone from view — keep the keyboard inside
    // the panel so the next Ctrl+PageDown continues the cycle.
    focusPanel();
  }
}

function focusPanel(): void {
  requestAnimationFrame(() => {
    document
      .querySelector<HTMLElement>(".terminal-panel")
      ?.focus({ preventScroll: true });
  });
}
