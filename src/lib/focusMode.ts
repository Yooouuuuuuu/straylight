/** Focus view (F11): a full-window CHAT workspace — the agent list on the
 *  left, the active agent's live terminal on the right — overlaying the
 *  normal layout (the editor is never involved). It's a plain boolean toggle;
 *  the overlay (components/FocusView) reparents the active resident's xterm
 *  into its right pane, and ChatPanel yields ownership while it's open. */
import { isSecondary } from "./windowRole";
import { useAppStore } from "../store/appStore";

export function toggleFocusView(): void {
  // F11 belongs to the MAIN window only: the sessions pop-out IS the focus
  // view (bound to its role, not this toggle — toggling would run the exit
  // path below and kill its usage probes), and the workspace window has no
  // sessions at all.
  if (isSecondary) return;
  const app = useAppStore.getState();
  const next = !app.focusView;
  // While the sessions are popped out there is nothing here to focus — the
  // agents live in the other window. The ⛶ button is already locked; the
  // F11 key must match it.
  if (next && app.sessionsPoppedOut) return;
  if (!next) {
    // Leaving the workspace: usage probes die with it (their claude exits
    // with the PTY — the channel close HUPs it).
    for (const t of app.terminals.filter((t) => t.usageProbe)) {
      app.closeTerminal(t.id);
    }
  }
  app.setFocusView(next);
}
