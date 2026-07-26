/** Host identity colors — FIXED theme slots, one per host: Local and WSL take
 *  their section slots; remotes take the ramp slot for their position in the
 *  remotes list (1st/2nd/3rd). No per-host overrides: editing what the five
 *  colors look like happens in the Theme UI; right-clicking a remote's host
 *  bar swaps its POSITION (and so its slot) with another remote. */
import {
  HOST_COLOR_RAMP,
  remoteHostKey,
  useAppStore,
  type RemoteConnection,
} from "../store/appStore";

export const SECTION_LOCAL = "var(--section-local)";
export const SECTION_WSL = "var(--section-wsl)";
export const SECTION_REMOTE = "var(--section-remote)";

/** Tooltip for a host's issue light, per connection state. */
export function connStateTip(state: string): string {
  switch (state) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting — retries until you disconnect";
    case "degraded":
      return "Stalled — terminals stay open, no restart";
    default:
      return "Disconnected — reconnect from the host bar";
  }
}

/** The "which pipe" summary for a host, shown on hover (docs/connections.md).
 *  Lanes are internal plumbing that no longer toast — this is where their
 *  fan-out surfaces on demand: the main connection, plus however many agents
 *  got their own dedicated session connection (the rest share the main one). */
export function laneSummary(connId: string): string {
  const prefix = `${connId}::session-`;
  const agents = useAppStore
    .getState()
    .terminals.filter((t) => t.laneConnId?.startsWith(prefix)).length;
  return agents === 0
    ? "one connection"
    : `main + ${agents} agent connection${agents === 1 ? "" : "s"}`;
}

/** A remote's slot in the ramp (its position in the remotes list). */
function remoteSlot(hostKey: string): number {
  const idx = useAppStore
    .getState()
    .remotes.findIndex((r) => remoteHostKey(r.conn) === hostKey);
  return Math.max(0, idx) % HOST_COLOR_RAMP.length;
}

/** The identity color for a remote — its ramp slot, by position. */
export function remoteColor(remote: RemoteConnection): string {
  return HOST_COLOR_RAMP[remoteSlot(remoteHostKey(remote))];
}

/** Color for a VC connKey ("local" | "wsl:<distro>" | "user@host:port"). */
export function hostColorForConnKey(connKey: string): string {
  if (connKey === "local") return SECTION_LOCAL;
  if (connKey.startsWith("wsl:")) return SECTION_WSL;
  return HOST_COLOR_RAMP[remoteSlot(connKey)];
}

/** Marker color for a tab's connection — null for local (local tabs stay
 *  unmarked by design). */
export function tabHostColor(connId: string): string | null {
  const s = useAppStore.getState();
  if (!connId || connId === s.localConnId) return null;
  const wsl = s.wsls.find((w) => w.conn.connId === connId);
  if (wsl) return SECTION_WSL;
  const remote = s.remotes.find((r) => r.conn.connId === connId);
  if (remote) return remoteColor(remote.conn);
  return null;
}
