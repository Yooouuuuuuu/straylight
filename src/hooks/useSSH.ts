/** Remote connection actions: attach/detach the window's single SSH connection
 *  and load its home directory as the remote root. The local session is always
 *  present (created at startup) and managed separately. */
import { useCallback } from "react";

import {
  fsListDir,
  sshConnect,
  sshDisconnect,
  sshReconnect,
  type AuthMethod,
} from "../lib/ipc";
import { useAppStore, type RemoteConnection } from "../store/appStore";
import {
  clearDesiredRemote,
  consumePendingRemoteTabs,
  setDesiredRemote,
} from "../lib/session";

export interface ConnectProfile {
  name: string;
  host: string;
  port: number;
  user: string;
  auth: AuthMethod;
  proxyJump?: string | null;
  color: string;
}

export function useSSH() {
  const remote = useAppStore((s) => s.remote);
  const connState = useAppStore((s) => s.connState);

  const connect = useCallback(async (profile: ConnectProfile) => {
    const store = useAppStore.getState();

    // One remote per window: drop any existing one first.
    if (store.remote) {
      try {
        await sshDisconnect(store.remote.connId);
      } catch {
        /* ignore */
      }
      store.clearRemote();
    }

    store.setDialogOpen(false);
    store.setConnState("connecting");

    try {
      const connId = await sshConnect({
        host: profile.host,
        port: profile.port,
        user: profile.user,
        auth: profile.auth,
        proxyJump: profile.proxyJump ?? null,
      });

      const listing = await fsListDir(connId, "");
      const remote: RemoteConnection = {
        connId,
        name: profile.name,
        host: profile.host,
        user: profile.user,
        port: profile.port,
        color: profile.color,
        authType: profile.auth.type,
        identityFile:
          profile.auth.type === "auto" ? (profile.auth.identityFile ?? null) : null,
        proxyJump: profile.proxyJump ?? null,
      };
      store.setRemote(remote, listing.path);
      // Remember this server for restore-on-next-launch, and reopen any tabs
      // that were waiting for it (session restore).
      setDesiredRemote(remote);
      await consumePendingRemoteTabs(remote);
    } catch (error) {
      store.setConnState("disconnected", String(error));
      store.pushNotice("error", `Connection failed: ${String(error)}`);
      throw error;
    }
  }, []);

  const disconnect = useCallback(async () => {
    const store = useAppStore.getState();
    if (store.remote) {
      try {
        await sshDisconnect(store.remote.connId);
      } catch {
        /* ignore */
      }
    }
    // Explicit disconnect: forget the server so it isn't auto-reconnected next
    // launch.
    clearDesiredRemote();
    store.clearRemote();
  }, []);

  // Re-establish a connection the supervisor gave up on. The backend keeps the
  // same connId, so open tabs and the terminal reattach; refresh the tree and
  // restart the terminal once the link is back.
  const reconnect = useCallback(async () => {
    const store = useAppStore.getState();
    if (!store.remote) return;
    try {
      // The backend emits reconnecting → connected; the ssh-status handler in
      // App.tsx is the single place that refreshes the tree and restarts the
      // terminal on recovery, so we don't duplicate that here.
      await sshReconnect(store.remote.connId);
    } catch (error) {
      store.pushNotice("error", `Reconnect failed: ${String(error)}`);
    }
  }, []);

  return { remote, connState, connect, disconnect, reconnect };
}
