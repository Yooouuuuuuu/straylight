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
  s.openTerminal(connId, label, null, cdInto(connId, path));
}

/** Open a CHAT-column agent session on the folder's host, cd'd into it — like
 *  openTerminalAt, but as a session (its own connection lane on SSH/WSL). */
export function openSessionAt(connId: string, path: string): void {
  const s = useAppStore.getState();
  const local = connId === s.localConnId;
  const label = local
    ? "Local"
    : (s.remotes.find((r) => r.conn.connId === connId)?.conn.name ??
      s.wsls.find((w) => w.conn.connId === connId)?.conn.name ??
      "Shell");
  void s.openAgentInChat(connId, label, { initialInput: cdInto(connId, path) });
}

/** A `cd '<path>'` line that works in both PowerShell (local) and POSIX shells
 *  (WSL/remote) — single-quoted literal, only the embedded-quote escape differs. */
function cdInto(connId: string, path: string): string {
  const local = connId === useAppStore.getState().localConnId;
  return local
    ? `cd '${path.replace(/'/g, "''")}'`
    : `cd '${path.replace(/'/g, "'\\''")}'`;
}
