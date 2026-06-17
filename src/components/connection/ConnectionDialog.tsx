/** Modal for a manual, password-based connection: host / port / user / password
 *  (+ optional jump host). Key-based connections are added to ~/.ssh/config and
 *  launched from the sidebar list instead. */
import { useEffect, useMemo, useRef, useState } from "react";

import { colorForName } from "../../lib/connectionColor";
import { useSSH } from "../../hooks/useSSH";
import { useAppStore } from "../../store/appStore";
import { IconClose } from "../icons";

export function ConnectionDialog() {
  const prefill = useAppStore((s) => s.dialogPrefill);
  const note = useAppStore((s) => s.dialogNote);
  const setDialogOpen = useAppStore((s) => s.setDialogOpen);
  const { connect } = useSSH();

  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [proxyJump, setProxyJump] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hostRef = useRef<HTMLInputElement>(null);
  const userRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // Focus the first field that still needs input when the dialog opens: Host for
  // a fresh connection, User for a config host missing its username, Password
  // when host+user are already known (a restored password host).
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (!prefill) hostRef.current?.focus();
      else if (!prefill.user) userRef.current?.focus();
      else passwordRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Prefill from a config host (opened when the host is missing a username).
  useEffect(() => {
    if (!prefill) return;
    setName(prefill.name);
    setHost(prefill.hostName ?? prefill.name);
    setPort(String(prefill.port ?? 22));
    setUser(prefill.user ?? "");
    setProxyJump(prefill.proxyJump ?? "");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  function close() {
    setDialogOpen(false);
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canConnect = useMemo(
    () => host.trim() !== "" && user.trim() !== "" && password !== "",
    [host, user, password],
  );

  // Auto-generated label when Name is left blank: "user@host" (or just the host).
  const autoName = useMemo(() => {
    const h = host.trim();
    const u = user.trim();
    if (!h) return "";
    return u ? `${u}@${h}` : h;
  }, [host, user]);

  async function submit() {
    if (!canConnect || busy) return;
    setBusy(true);
    setError(null);
    const displayName = name.trim() || autoName || host.trim();
    try {
      await connect({
        name: displayName,
        host: host.trim(),
        port: Number(port) || 22,
        user: user.trim(),
        auth: { type: "password", password },
        proxyJump: proxyJump.trim() || null,
        color: colorForName(displayName),
      });
      // connect() closes the dialog on success.
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal__header">
          <span className="modal__title">Connect with a password</span>
          <button className="icon-btn" onClick={close} title="Close">
            <IconClose />
          </button>
        </div>

        <div className="modal__body">
          {note && <div className="modal__note">{note}</div>}
          <div className="modal__section">
            <div className="field">
              <label className="field__label">Name (optional)</label>
              <input
                className="input"
                value={name}
                placeholder={autoName || "auto"}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="field__row">
              <div className="field">
                <label className="field__label">Host</label>
                <input
                  ref={hostRef}
                  className="input input--mono"
                  value={host}
                  placeholder="10.0.0.5 or example.com"
                  onChange={(e) => setHost(e.target.value)}
                />
              </div>
              <div className="field" style={{ maxWidth: 110, flex: "0 0 auto" }}>
                <label className="field__label">Port</label>
                <input
                  className="input input--mono"
                  value={port}
                  inputMode="numeric"
                  onChange={(e) =>
                    setPort(e.target.value.replace(/[^0-9]/g, ""))
                  }
                />
              </div>
            </div>
            <div className="field">
              <label className="field__label">User</label>
              <input
                ref={userRef}
                className="input input--mono"
                value={user}
                placeholder="root"
                onChange={(e) => setUser(e.target.value)}
              />
            </div>
            <div className="field">
              <label className="field__label">Password</label>
              <input
                ref={passwordRef}
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
              />
            </div>
            <div className="field">
              <label className="field__label">Jump host (optional)</label>
              <input
                className="input input--mono"
                value={proxyJump}
                placeholder="user@bastion:22"
                onChange={(e) => setProxyJump(e.target.value)}
              />
            </div>
          </div>

          {error && <div className="modal__error">{error}</div>}
        </div>

        <div className="modal__footer">
          <button className="btn btn--ghost" onClick={close}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={!canConnect || busy}
            onClick={() => void submit()}
          >
            {busy ? (
              <>
                <span className="spinner spinner--sm" /> Connecting…
              </>
            ) : (
              "Connect"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
