/** Remote connection actions: attach/detach the window's SSH connections (up
 *  to MAX_REMOTES simultaneously), loading each host's home directory as its
 *  root. The local session is always present (created at startup) and managed
 *  separately. */
import { useCallback } from "react";

import {
  fsListDir,
  sshConnect,
  sshDisconnect,
  sshReconnect,
  type AuthMethod,
} from "../lib/ipc";
import {
  MAX_REMOTES,
  remoteHostKey,
  useAppStore,
  type RemoteConnection,
} from "../store/appStore";
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

  const connect = useCallback(
    async (profile: ConnectProfile, opts?: { onKeyAuthFail?: () => void }) => {
      const store = useAppStore.getState();

      // Reconnecting to an attached host refreshes it; a NEW host needs a slot.
      const key = `${profile.user}@${profile.host}:${profile.port}`;
      const known = store.remotes.some((r) => remoteHostKey(r.conn) === key);
      if (!known && store.remotes.length >= MAX_REMOTES) {
        store.pushNotice(
          "warn",
          `Up to ${MAX_REMOTES} remotes per window — disconnect one first.`,
        );
        throw new Error("remote slots full");
      }
      if (known) {
        // Drop the stale transport before dialing the same host again.
        const old = store.remotes.find((r) => remoteHostKey(r.conn) === key);
        if (old) {
          try {
            await sshDisconnect(old.conn.connId);
          } catch {
            /* ignore */
          }
        }
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
            profile.auth.type === "auto"
              ? (profile.auth.identityFile ?? null)
              : null,
          proxyJump: profile.proxyJump ?? null,
        };
        store.setRemote(remote, listing.path);
        // Remember this server for restore-on-next-launch, and reopen any tabs
        // that were waiting for it (session restore).
        setDesiredRemote(remote);
        await consumePendingRemoteTabs(remote);
        // Give the new connection a ready-to-use remote shell.
        store.openTerminal(remote.connId, remote.name);
      } catch (error) {
        const message = String(error);
        store.setConnState("disconnected", message);
        // A config host with no usable key: fall back to password entry rather
        // than a dead-end error, when the caller offers that path.
        if (
          opts?.onKeyAuthFail &&
          /no usable key|key authentication failed/i.test(message)
        ) {
          opts.onKeyAuthFail();
        } else {
          store.pushNotice("error", `Connection failed: ${message}`);
        }
        throw error;
      }
    },
    [],
  );

  const disconnect = useCallback(async (connId?: string) => {
    const store = useAppStore.getState();
    const entry =
      store.remotes.find((r) => r.conn.connId === connId) ?? store.remotes[0];
    if (entry) {
      try {
        await sshDisconnect(entry.conn.connId);
      } catch {
        /* ignore */
      }
      // Explicit disconnect: forget this server so it isn't auto-reconnected
      // next launch.
      clearDesiredRemote(remoteHostKey(entry.conn));
      store.clearRemote(entry.conn.connId);
    }
  }, []);

  // Re-establish a connection the supervisor gave up on. The backend keeps the
  // same connId, so open tabs and the terminal reattach; refresh the tree and
  // restart the terminal once the link is back.
  const reconnect = useCallback(async (connId?: string) => {
    const store = useAppStore.getState();
    const entry =
      store.remotes.find((r) => r.conn.connId === connId) ?? store.remotes[0];
    if (!entry) return;
    try {
      // The backend emits reconnecting → connected; the ssh-status handler in
      // App.tsx is the single place that refreshes the tree and restarts the
      // terminal on recovery, so we don't duplicate that here.
      await sshReconnect(entry.conn.connId);
    } catch (error) {
      store.pushNotice("error", `Reconnect failed: ${String(error)}`);
    }
  }, []);

  return { remote, connState, connect, disconnect, reconnect };
}
