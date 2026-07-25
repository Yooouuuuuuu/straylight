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

/** Open a shell on the folder's host and cd into it. Shells start at home, so
 *  the cd is typed into the fresh prompt — visible and cancelable, like the
 *  Containers tab's exec. */
export function openTerminalAt(connId: string, path: string): void {
  const s = useAppStore.getState();
  const local = connId === s.localConnId;
  const label = local
    ? "Local"
    : (s.remotes.find((r) => r.conn.connId === connId)?.conn.name ??
      s.wsls.find((w) => w.conn.connId === connId)?.conn.name ??
      "Shell");
  // Single-quoted literals work in both PowerShell (local) and POSIX shells
  // (WSL/remote); only the embedded-quote escape differs.
  const cd = local
    ? `cd '${path.replace(/'/g, "''")}'`
    : `cd '${path.replace(/'/g, "'\\''")}'`;
  s.openTerminal(connId, label, null, cd);
}
