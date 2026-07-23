/** Focus view (F11): a full-window CHAT workspace — the agent list on the
 *  left, the active agent's live terminal on the right — overlaying the
 *  normal layout (the editor is never involved). It's a plain boolean toggle;
 *  the overlay (components/FocusView) reparents the active resident's xterm
 *  into its right pane, and ChatPanel yields ownership while it's open. */
import { useAppStore } from "../store/appStore";

export function toggleFocusView(): void {
  const app = useAppStore.getState();
  const next = !app.focusView;
  if (!next) {
    // Leaving the workspace: usage probes die with it (their claude exits
    // with the PTY — the channel close HUPs it).
    for (const t of app.terminals.filter((t) => t.usageProbe)) {
      app.closeTerminal(t.id);
    }
  }
  app.setFocusView(next);
}
