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
  sshTrustHost,
  type AuthMethod,
} from "../lib/ipc";
import {
  MAX_REMOTES,
  remoteHostKey,
  useAppStore,
  type RemoteConnection,
} from "../store/appStore";
import { consumePendingRemoteTabs } from "../lib/session";

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
        // Reopen this host's pinned/drafted files (persistence is simply
        // "connected at close" now — the snapshot reads live connections).
        await consumePendingRemoteTabs(remote);
        // Give the new connection a ready-to-use remote shell.
        store.openTerminal(remote.connId, remote.name);
        store.pushNotice("info", `Connected to ${remote.name}.`);
      } catch (error) {
        const message = String(error);
        store.setConnState("disconnected", message);
        // The key is encrypted and we have no (or a wrong) passphrase — prompt
        // for it and retry with the passphrase held in memory only.
        const needsPass = message.match(/KEY_NEEDS_PASSPHRASE:(.*)$/);
        const hadPass = profile.auth.type === "auto" && !!profile.auth.passphrase;
        // Host-key verification (known_hosts). UNKNOWN: first contact — show the
        // fingerprint and let the user trust it, then retry. CHANGED: the key no
        // longer matches known_hosts — refuse loudly (no one-click override).
        const unknownHost = message.match(/HOST_KEY_UNKNOWN:(.*)$/);
        if (unknownHost) {
          store.openHostKeyPrompt({
            kind: "unknown",
            host: profile.host,
            port: profile.port,
            fingerprint: unknownHost[1].trim(),
            onTrust: () => {
              store.closeHostKeyPrompt();
              void (async () => {
                try {
                  await sshTrustHost(profile.host, profile.port);
                } catch (e) {
                  store.pushNotice("error", `Could not trust host: ${String(e)}`);
                  return;
                }
                void connect(profile, opts);
              })();
            },
          });
        } else if (/HOST_KEY_CHANGED/.test(message)) {
          store.openHostKeyPrompt({
            kind: "changed",
            host: profile.host,
            port: profile.port,
          });
        } else if (needsPass) {
          const identityFile =
            profile.auth.type === "auto" ? (profile.auth.identityFile ?? null) : null;
          store.openPassphrasePrompt({
            keyPath: needsPass[1].trim(),
            onSubmit: (passphrase) => {
              store.closePassphrasePrompt();
              void connect(
                { ...profile, auth: { type: "auto", identityFile, passphrase } },
                opts,
              );
            },
          });
        } else if (
          opts?.onKeyAuthFail &&
          /no usable key|key authentication failed/i.test(message)
        ) {
          // A config host with no usable key: fall back to password entry
          // rather than a dead-end error, when the caller offers that path.
          opts.onKeyAuthFail();
        } else if (hadPass && /passphrase/i.test(message)) {
          // Wrong passphrase on a retry — one clear toast (the prompt closed).
          store.pushNotice("error", "Incorrect passphrase — try connecting again.");
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
      // No bookkeeping needed: the session snapshot persists whatever is
      // connected, so a disconnected host simply isn't in the next one.
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
