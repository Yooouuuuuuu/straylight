/** Local SSH port forwarding. Bind a local 127.0.0.1 port and tunnel it to a
 *  host:port reachable from the server (e.g. a service on the remote). */
import { useEffect, useMemo, useState } from "react";

import {
  portForwardList,
  portForwardStart,
  portForwardStop,
  type ForwardInfo,
} from "../lib/ipc";
import { useAppStore } from "../store/appStore";
import { IconClose } from "./icons";

interface Conn {
  connId: string;
  label: string;
}

export function PortForwards() {
  const open = useAppStore((s) => s.portsOpen);
  const setOpen = useAppStore((s) => s.setPortsOpen);
  if (!open) return null;
  return <PortsModal onClose={() => setOpen(false)} />;
}

function PortsModal({ onClose }: { onClose: () => void }) {
  const remote = useAppStore((s) => s.remote);
  const wsl = useAppStore((s) => s.wsl);
  const pushNotice = useAppStore((s) => s.pushNotice);

  const conns = useMemo<Conn[]>(() => {
    const c: Conn[] = [];
    if (remote) c.push({ connId: remote.connId, label: remote.name });
    if (wsl) c.push({ connId: wsl.connId, label: wsl.name });
    return c;
  }, [remote, wsl]);

  const [forwards, setForwards] = useState<ForwardInfo[]>([]);
  const [connId, setConnId] = useState(conns[0]?.connId ?? "");
  const [localPort, setLocalPort] = useState("");
  const [remoteHost, setRemoteHost] = useState("localhost");
  const [remotePort, setRemotePort] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    portForwardList()
      .then(setForwards)
      .catch(() => {});
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const labelFor = (id: string) =>
    conns.find((c) => c.connId === id)?.label ?? "—";

  const add = async () => {
    const lp = Number(localPort);
    const rp = Number(remotePort);
    if (!connId || !Number.isInteger(lp) || lp <= 0 || !Number.isInteger(rp) || rp <= 0) {
      pushNotice("error", "Enter a valid local and remote port.");
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
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" style={{ width: "min(520px, 94vw)" }} role="dialog" aria-modal="true">
        <div className="modal__header">
          <span className="modal__title">Port forwarding</span>
          <button className="icon-btn" onClick={onClose} title="Close">
            <IconClose />
          </button>
        </div>
        <div className="modal__body">
          {conns.length === 0 ? (
            <div className="conn-empty" style={{ padding: 0 }}>
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
                    <div className="ports-item" key={f.id}>
                      <span className="ports-item__route mono">
                        127.0.0.1:{f.localPort} → {f.remoteHost}:{f.remotePort}
                      </span>
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
      </div>
    </div>
  );
}
