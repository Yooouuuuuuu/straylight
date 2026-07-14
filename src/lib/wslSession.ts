/** Connect to a WSL distro (provision + attach + open its terminal) — shared
 *  by the sidebar's WSL section and the startup auto/ask reconnect. Throws
 *  `WSL_NEEDS_INSTALL:`-prefixed errors up to the caller (the sidebar turns
 *  those into its install prompt). */
import { fsListDir, sshDisconnect, wslConnect } from "./ipc";
import { MAX_WSLS, useAppStore, type RemoteConnection } from "../store/appStore";

export async function connectWslDistro(
  distro: string,
  allowInstall = false,
): Promise<void> {
  const store = useAppStore.getState();
  // Reconnecting an already-attached distro: drop its old link first (its
  // pins/toggles survive — addWsl keeps them for a known name).
  const prev = store.wsls.find((w) => w.conn.name === distro);
  if (prev) {
    try {
      await sshDisconnect(prev.conn.connId);
    } catch {
      /* ignore */
    }
    useAppStore.getState().removeWsl(prev.conn.connId);
  } else if (store.wsls.length >= MAX_WSLS) {
    throw new Error(`Up to ${MAX_WSLS} WSL distros can be connected at once.`);
  }
  const { connId, user } = await wslConnect(distro, allowInstall);
  const listing = await fsListDir(connId, "");
  const conn: RemoteConnection = {
    connId,
    name: distro,
    host: "127.0.0.1",
    user,
    port: 0,
    color: "var(--section-wsl)",
    authType: "auto",
    identityFile: null,
    proxyJump: null,
  };
  useAppStore.getState().addWsl(conn, listing.path);
  useAppStore.getState().openTerminal(connId, distro);
}
