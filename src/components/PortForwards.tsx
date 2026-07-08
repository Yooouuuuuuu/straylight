/** Local SSH port forwarding, docked in the terminal panel's Forwarding
 *  group. Bind a local 127.0.0.1 port and tunnel it to a host:port reachable
 *  from the server. The Ports table prefills this via forwardPrefill. */
import { useEffect, useMemo, useState } from "react";

import {
  portForwardList,
  portForwardStart,
  portForwardStop,
  type ForwardInfo,
} from "../lib/ipc";
import { useAppStore } from "../store/appStore";

interface Conn {
  connId: string;
  label: string;
}

export function ForwardingView() {
  const remotes = useAppStore((s) => s.remotes);
  const wsl = useAppStore((s) => s.wsl);
  const pushNotice = useAppStore((s) => s.pushNotice);
  const prefill = useAppStore((s) => s.forwardPrefill);
  const setForwardPrefill = useAppStore((s) => s.setForwardPrefill);

  const conns = useMemo<Conn[]>(() => {
    const c: Conn[] = remotes.map((r) => ({
      connId: r.conn.connId,
      label: r.conn.name,
    }));
    if (wsl) c.push({ connId: wsl.connId, label: wsl.name });
    return c;
  }, [remotes, wsl]);

  const [forwards, setForwards] = useState<ForwardInfo[]>([]);
  const setForwardCount = useAppStore((s) => s.setForwardCount);
  useEffect(() => setForwardCount(forwards.length), [forwards, setForwardCount]);
  const [connId, setConnId] = useState(conns[0]?.connId ?? "");
  const [localPort, setLocalPort] = useState("");
  const [remoteHost, setRemoteHost] = useState("localhost");
  const [remotePort, setRemotePort] = useState("");
  const [busy, setBusy] = useState(false);

  // A "Forward" click in the Ports table lands here prefilled.
  useEffect(() => {
    if (!prefill) return;
    setConnId(prefill.connId);
    setRemotePort(String(prefill.port));
    setLocalPort(String(prefill.port));
    setRemoteHost("localhost");
    setForwardPrefill(null);
  }, [prefill, setForwardPrefill]);

  useEffect(() => {
    if (!conns.some((c) => c.connId === connId) && conns[0])
      setConnId(conns[0].connId);
  }, [conns, connId]);

  useEffect(() => {
    const refresh = () =>
      portForwardList()
        .then(setForwards)
        .catch(() => {});
    refresh();
    // Keep the list fresh while the group is open (tunnel errors show up).
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, []);

  const labelFor = (id: string) =>
    conns.find((c) => c.connId === id)?.label ?? "—";

  const add = async () => {
    const lp = Number(localPort);
    const rp = Number(remotePort);
    if (!connId || !Number.isInteger(lp) || lp <= 0 || !Number.isInteger(rp) || rp <= 0) {
      pushNotice("error", "Enter a valid local and remote port.");
      return;
    }
    if (forwards.some((f) => f.localPort === lp)) {
      pushNotice("error", `127.0.0.1:${lp} is already being forwarded.`);
      return;
    }
    setBusy(true);
    try {
      const info = await portForwardStart(
        connId,
        lp,
        remoteHost.trim() || "localhost",
        rp,
      );
      setForwards((f) => [...f, info]);
      setLocalPort("");
      setRemotePort("");
      pushNotice("info", `Forwarding 127.0.0.1:${lp} → ${info.remoteHost}:${rp}`);
    } catch (e) {
      pushNotice("error", `Forward failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const stop = async (id: string) => {
    try {
      await portForwardStop(id);
    } catch {
      /* ignore */
    }
    setForwards((f) => f.filter((x) => x.id !== id));
  };

  return (
    <div className="ports-view">
      {conns.length === 0 ? (
        <div className="conn-empty">
          Connect to a server or WSL distro to forward a port.
        </div>
      ) : (
        <>
          <div className="ports-form">
            {conns.length > 1 && (
              <select
                className="select ports-form__conn"
                value={connId}
                onChange={(e) => setConnId(e.target.value)}
              >
                {conns.map((c) => (
                  <option key={c.connId} value={c.connId}>
                    {c.label}
                  </option>
                ))}
              </select>
            )}
            <input
              className="input"
              placeholder="Local port"
              value={localPort}
              inputMode="numeric"
              onChange={(e) => setLocalPort(e.target.value.replace(/\D/g, ""))}
            />
            <span className="ports-form__arrow">→</span>
            <input
              className="input input--mono"
              placeholder="host"
              value={remoteHost}
              onChange={(e) => setRemoteHost(e.target.value)}
            />
            <input
              className="input"
              placeholder="Remote port"
              value={remotePort}
              inputMode="numeric"
              onChange={(e) => setRemotePort(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") void add();
              }}
            />
            <button
              className="btn btn--primary"
              disabled={busy}
              onClick={() => void add()}
            >
              Add
            </button>
          </div>

          <div className="ports-list">
            {forwards.length === 0 ? (
              <div className="ports-list__empty">No active forwards.</div>
            ) : (
              forwards.map((f) => (
                <div
                  className={`ports-item ${f.lastError ? "ports-item--error" : ""}`}
                  key={f.id}
                >
                  <div className="ports-item__main">
                    <span className="ports-item__route mono">
                      127.0.0.1:{f.localPort} → {f.remoteHost}:{f.remotePort}
                    </span>
                    {f.lastError && (
                      <span className="ports-item__err" title={f.lastError}>
                        {f.lastError}
                      </span>
                    )}
                  </div>
                  <span className="ports-item__conn">{labelFor(f.connId)}</span>
                  <button
                    className="btn btn--ghost"
                    onClick={() => void stop(f.id)}
                  >
                    Stop
                  </button>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
