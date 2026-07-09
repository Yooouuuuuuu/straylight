/** Connect to a WSL distro (provision + attach + open its terminal) — shared
 *  by the sidebar's WSL section and the startup auto/ask reconnect. Throws
 *  `WSL_NEEDS_INSTALL:`-prefixed errors up to the caller (the sidebar turns
 *  those into its install prompt). */
import { fsListDir, sshDisconnect, wslConnect } from "./ipc";
import { useAppStore, type RemoteConnection } from "../store/appStore";

export async function connectWslDistro(
  distro: string,
  allowInstall = false,
): Promise<void> {
  const store = useAppStore.getState();
  // One distro slot: switching drops the current connection first.
  const prev = store.wsl;
  if (prev) {
    try {
      await sshDisconnect(prev.connId);
    } catch {
      /* ignore */
    }
    useAppStore.getState().clearWsl();
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
  useAppStore.getState().setWsl(conn, listing.path);
  useAppStore.getState().openTerminal(connId, distro);
}
