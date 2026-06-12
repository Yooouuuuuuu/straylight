/** Connection actions: establish/tear down the window's SSH connection and load
 *  the remote home directory as the file-tree root. */
import { useCallback } from "react";

import {
  sftpListDir,
  sshConnect,
  sshDisconnect,
  type AuthMethod,
} from "../lib/ipc";
import { useAppStore, type ConnectionMeta } from "../store/appStore";

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
  const connection = useAppStore((s) => s.connection);
  const connState = useAppStore((s) => s.connState);

  const connect = useCallback(async (profile: ConnectProfile) => {
    const store = useAppStore.getState();

    // One connection per window: drop any existing one first.
    if (store.connection) {
      try {
        await sshDisconnect(store.connection.connId);
      } catch {
        /* ignore */
      }
      store.clearConnection();
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

      const meta: ConnectionMeta = {
        connId,
        name: profile.name,
        host: profile.host,
        user: profile.user,
        port: profile.port,
        color: profile.color,
      };
      store.setConnection(meta);

      // Resolve the home directory and use it as the tree root.
      const listing = await sftpListDir(connId, "");
      store.setRootPath(listing.path);
    } catch (error) {
      store.setConnState("disconnected", String(error));
      store.pushNotice("error", `Connection failed: ${String(error)}`);
      throw error;
    }
  }, []);

  const disconnect = useCallback(async () => {
    const store = useAppStore.getState();
    if (store.connection) {
      try {
        await sshDisconnect(store.connection.connId);
      } catch {
        /* ignore */
      }
    }
    store.clearConnection();
  }, []);

  return { connection, connState, connect, disconnect };
}
