/** Remote connection actions: attach/detach the window's single SSH connection
 *  and load its home directory as the remote root. The local session is always
 *  present (created at startup) and managed separately. */
import { useCallback } from "react";

import { fsListDir, sshConnect, sshDisconnect, type AuthMethod } from "../lib/ipc";
import { useAppStore } from "../store/appStore";

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
      store.setRemote(
        {
          connId,
          name: profile.name,
          host: profile.host,
          user: profile.user,
          port: profile.port,
          color: profile.color,
        },
        listing.path,
      );
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
    store.clearRemote();
  }, []);

  return { remote, connState, connect, disconnect };
}
