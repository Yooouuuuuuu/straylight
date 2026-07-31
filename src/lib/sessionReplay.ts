/** Terminal-state hand-off for the sessions pop-out (docs/dev/multi-window.md).
 *
 *  A session's PTY is shared, but each window renders it with its OWN xterm. A
 *  full-screen TUI (htop/vim) sets its modes (alt-screen, hidden cursor) once at
 *  startup, so a freshly-attached xterm that joins mid-stream shows a broken
 *  screen. Before a window RELEASES its views (main on pop-out, the sessions
 *  window on close) it serializes each session's full state into a backend stash;
 *  the window that re-attaches replays it (see `useTerminal` attach path). */
import { setSessionReplay, setSessionsPopped, setSessionsSnapshot } from "./ipc";
import { readTerminalSerialized } from "./terminalFocus";
import { openSessionsWindow } from "./workspaceWindow";
import { buildSessionRegistry, useAppStore } from "../store/appStore";

/** Serialize every CHAT session's full terminal state and stash it in the
 *  backend. Call BEFORE releasing the views. */
export async function stashSessionReplays(): Promise<void> {
  const sessions = useAppStore.getState().terminals.filter((t) => t.inChat);
  await Promise.all(
    sessions.map((t) => {
      const data = readTerminalSerialized(t.id);
      return data ? setSessionReplay(t.id, data) : Promise.resolve();
    }),
  );
}

/** Pop the sessions out — a HAND-OFF, not a mirror (docs/dev/multi-window.md):
 *  stash every session's terminal state, write the session registry (the
 *  backend snapshot the pop-out pulls on boot), flip ownership BEFORE clearing
 *  (the popped flag gates main's registry writes — cleared first, main would
 *  republish an empty registry), release main's copies, then open the window. */
export async function popOutSessions(): Promise<void> {
  await stashSessionReplays();
  const st = useAppStore.getState();
  await setSessionsSnapshot(JSON.stringify(buildSessionRegistry(st)));
  await setSessionsPopped(true);
  st.setSessionsPoppedOut(true);
  st.clearChatSessions();
  await openSessionsWindow();
}
