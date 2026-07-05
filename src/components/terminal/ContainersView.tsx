/** The Containers tab in the terminal panel: running containers (podman or
 *  docker) across every connected host, with their ports. Click one to jump
 *  into a shell inside it (a normal terminal that types the `exec` for you).
 *  Lazy: refreshes when the tab is shown and every 5 s while it stays open. */
import { useEffect, useState } from "react";

import { containerList, type ContainerInfo } from "../../lib/ipc";
import { useAppStore } from "../../store/appStore";

interface HostContainers {
  connId: string;
  label: string;
  state: "loading" | "done";
  containers: ContainerInfo[];
}

const POLL_MS = 5000;

export function ContainersView() {
  const localConnId = useAppStore((s) => s.localConnId);
  const remote = useAppStore((s) => s.remote);
  const wsl = useAppStore((s) => s.wsl);
  const openTerminal = useAppStore((s) => s.openTerminal);

  const [hosts, setHosts] = useState<HostContainers[]>([]);

  useEffect(() => {
    const conns = [
      localConnId ? { connId: localConnId, label: "Local" } : null,
      wsl ? { connId: wsl.connId, label: wsl.name } : null,
      remote ? { connId: remote.connId, label: remote.name } : null,
    ].filter((c): c is { connId: string; label: string } => c !== null);

    let alive = true;
    setHosts(
      conns.map((c) => ({ ...c, state: "loading" as const, containers: [] })),
    );

    const refresh = () => {
      for (const c of conns) {
        containerList(c.connId)
          .then((containers) => {
            if (!alive) return;
            setHosts((h) =>
              h.map((x) =>
                x.connId === c.connId ? { ...x, state: "done", containers } : x,
              ),
            );
          })
          .catch(() => {
            if (!alive) return;
            setHosts((h) =>
              h.map((x) =>
                x.connId === c.connId ? { ...x, state: "done", containers: [] } : x,
              ),
            );
          });
      }
    };
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [localConnId, remote, wsl]);

  const enter = (host: HostContainers, c: ContainerInfo) => {
    openTerminal(
      host.connId,
      c.name || c.id,
      null,
      `${c.engine} exec -it ${c.id} /bin/sh`,
    );
  };

  const loading = hosts.some((h) => h.state === "loading");
  const total = hosts.reduce((n, h) => n + h.containers.length, 0);

  return (
    <div className="containers-view">
      <div className="containers-view__head">
        <span>Running containers</span>
        {loading && <span className="spinner spinner--sm" />}
      </div>
      {total === 0 && !loading ? (
        <div className="containers-view__empty">
          No running containers (or no podman/docker on the connected hosts).
        </div>
      ) : (
        hosts
          .filter((h) => h.containers.length > 0)
          .map((h) => (
            <div className="containers-view__host" key={h.connId}>
              <div className="containers-view__host-label">{h.label}</div>
              {h.containers.map((c) => (
                <div
                  className="container-row"
                  key={`${h.connId}:${c.id}`}
                  title={`${c.image} — click to open a shell inside`}
                  onClick={() => enter(h, c)}
                >
                  <span className="container-row__engine">{c.engine}</span>
                  <span className="container-row__name">{c.name || c.id}</span>
                  <span className="container-row__image">{c.image}</span>
                  <span className="container-row__ports">{c.ports || "—"}</span>
                  <span className="container-row__status">{c.status}</span>
                </div>
              ))}
            </div>
          ))
      )}
    </div>
  );
}
