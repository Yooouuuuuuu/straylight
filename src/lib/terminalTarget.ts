/** Where a new terminal opens. Default priority is remote → WSL → local; the
 *  user can pin a preference (which falls back to the priority when that
 *  workspace isn't connected). */
import { useAppStore } from "../store/appStore";

export function pickTerminalTarget(): { connId: string; label: string } | null {
  const s = useAppStore.getState();
  const options = {
    remote: s.remote ? { connId: s.remote.connId, label: s.remote.name } : null,
    wsl: s.wsl ? { connId: s.wsl.connId, label: s.wsl.name } : null,
    local: s.localConnId ? { connId: s.localConnId, label: "Local" } : null,
  };
  const pref = s.newTerminalTarget;
  if (pref !== "auto" && options[pref]) return options[pref];
  return options.remote ?? options.wsl ?? options.local;
}
