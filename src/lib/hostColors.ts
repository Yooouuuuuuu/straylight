/** Host identity colors. Local and WSL take their section colors (theme keys);
 *  remote hosts take a persisted per-host color (right-click the host bar),
 *  defaulting to the ramp. Everything host-scoped — the host bar, VC card
 *  frames, file-tab markers, the title-bar tint — reads these. */
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
    default:
      return "Disconnected — reconnect from the host bar";
  }
}

/** A remote's default slot in the ramp (its position in the remotes list). */
function remoteSlot(hostKey: string): number {
  const idx = useAppStore
    .getState()
    .remotes.findIndex((r) => remoteHostKey(r.conn) === hostKey);
  return Math.max(0, idx) % HOST_COLOR_RAMP.length;
}

/** The identity color for a connected remote (custom, else ramp by slot). */
export function remoteColor(
  hostColors: Record<string, string>,
  remote: RemoteConnection,
): string {
  const key = remoteHostKey(remote);
  return hostColors[key] ?? HOST_COLOR_RAMP[remoteSlot(key)];
}

/** Color for a VC connKey ("local" | "wsl:<distro>" | "user@host:port").
 *  WSL distros can be recolored per distro (right-click their host bar). */
export function hostColorForConnKey(
  hostColors: Record<string, string>,
  connKey: string,
): string {
  if (connKey === "local") return SECTION_LOCAL;
  if (connKey.startsWith("wsl:")) return hostColors[connKey] ?? SECTION_WSL;
  return hostColors[connKey] ?? HOST_COLOR_RAMP[remoteSlot(connKey)];
}

/** Marker color for a tab's connection — null for local (local tabs stay
 *  unmarked by design). */
export function tabHostColor(connId: string): string | null {
  const s = useAppStore.getState();
  if (!connId || connId === s.localConnId) return null;
  const wsl = s.wsls.find((w) => w.conn.connId === connId);
  if (wsl) return s.hostColors[`wsl:${wsl.conn.name}`] ?? SECTION_WSL;
  const remote = s.remotes.find((r) => r.conn.connId === connId);
  if (remote) return remoteColor(s.hostColors, remote.conn);
  return null;
}
