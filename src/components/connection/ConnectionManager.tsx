/** Remote-connect panel (shown in the sidebar's Remote section when no server is
 *  attached): a Connect button plus the hosts parsed from ~/.ssh/config. The
 *  "Edit" action opens the config in-app via the local session. */
import { useEffect, useState } from "react";

import { colorForName } from "../../lib/connectionColor";
import { sshListConfigHosts, type SshHostEntry } from "../../lib/ipc";
import { useSSH } from "../../hooks/useSSH";
import { useAppStore } from "../../store/appStore";
import { IconPlug } from "../icons";

function hostDetail(host: SshHostEntry): string {
  const target = host.hostName ?? host.name;
  const user = host.user ? `${host.user}@` : "";
  const port = host.port && host.port !== 22 ? `:${host.port}` : "";
  const via = host.proxyJump ? ` · via ${host.proxyJump}` : "";
  return `${user}${target}${port}${via}`;
}

export function ConnectionManager() {
  const [hosts, setHosts] = useState<SshHostEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const openDialog = useAppStore((s) => s.openDialog);
  const { connect } = useSSH();

  useEffect(() => {
    let active = true;
    const load = () => {
      sshListConfigHosts()
        .then((entries) => {
          if (active) setHosts(entries);
        })
        .catch(() => {
          if (active) setHosts([]);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    };
    load();
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  function onHostClick(host: SshHostEntry) {
    if (!host.user) {
      openDialog(host);
      return;
    }
    void connect(
      {
        name: host.name,
        host: host.hostName ?? host.name,
        port: host.port ?? 22,
        user: host.user,
        auth: { type: "auto", identityFile: host.identityFile },
        proxyJump: host.proxyJump,
        color: colorForName(host.name),
      },
      {
        // No usable key for this host → open the password dialog prefilled with
        // it instead of failing, focus on the password field.
        onKeyAuthFail: () =>
          openDialog(
            host,
            "Key authentication didn't work for this host — enter a password to connect.",
          ),
      },
    ).catch(() => {
      /* key-auth failure opens the password dialog; others surface via toast */
    });
  }

  return (
    <div className="conn-list">
      <button
        className="btn btn--primary btn--block"
        onClick={() => openDialog()}
      >
        <IconPlug /> Connect to a server
      </button>

      {loading ? (
        <div className="conn-empty">
          <span className="spinner" /> Reading ~/.ssh/config…
        </div>
      ) : hosts.length === 0 ? (
        <div className="conn-empty">
          No hosts in ~/.ssh/config.
          <br />
          Use “Connect to a server” or “Edit”.
        </div>
      ) : (
        hosts.map((host) => (
          <div
            key={host.name}
            className="conn-item"
            style={{ borderLeftColor: colorForName(host.name) }}
            onClick={() => onHostClick(host)}
            title={`Connect to ${host.name}`}
          >
            <div className="conn-item__name">{host.name}</div>
            <div className="conn-item__detail">{hostDetail(host)}</div>
          </div>
        ))
      )}
    </div>
  );
}
