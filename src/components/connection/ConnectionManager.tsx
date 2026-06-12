/** Sidebar connection list: shows hosts parsed from ~/.ssh/config and a button
 *  for manual connections. Clicking a host connects (via ssh-agent, or its
 *  IdentityFile when present); hosts without a User open the dialog prefilled. */
import { useEffect, useState } from "react";

import { colorForName } from "../../lib/connectionColor";
import { openSshConfig, sshListConfigHosts, type SshHostEntry } from "../../lib/ipc";
import { useSSH } from "../../hooks/useSSH";
import { useAppStore } from "../../store/appStore";
import { IconExternal, IconPlug } from "../icons";

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
    // Re-read the config when the window regains focus (e.g. after editing it).
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  function onHostClick(host: SshHostEntry) {
    if (!host.user) {
      // We can't connect non-interactively without a username.
      openDialog(host);
      return;
    }
    void connect({
      name: host.name,
      host: host.hostName ?? host.name,
      port: host.port ?? 22,
      user: host.user,
      // One-click: agent → IdentityFile → default keys (resolved in the backend).
      auth: { type: "auto", identityFile: host.identityFile },
      proxyJump: host.proxyJump,
      color: colorForName(host.name),
    }).catch(() => {
      /* failure surfaced via toast */
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

      <div
        className="conn-group-label"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span>SSH config hosts</span>
        <button
          className="btn btn--ghost"
          style={{ padding: "2px 8px" }}
          title="Open ~/.ssh/config in your editor"
          onClick={() => void openSshConfig()}
        >
          <IconExternal size={13} /> Edit
        </button>
      </div>

      {loading ? (
        <div className="conn-empty">
          <span className="spinner" /> Reading ~/.ssh/config…
        </div>
      ) : hosts.length === 0 ? (
        <div className="conn-empty">
          No hosts found in ~/.ssh/config.
          <br />
          Use “New connection” to connect manually.
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
