/** Host-key verification prompt (known_hosts). Opened by useSSH when a connect
 *  is refused: `unknown` on first contact (show the SHA256 fingerprint, offer to
 *  trust and record it), `changed` when the server's key no longer matches
 *  `~/.ssh/known_hosts` (refuse loudly — no one-click override; the user must
 *  remove the stale line by hand if the change is legitimate). */
import { useEffect } from "react";

import { useAppStore } from "../../store/appStore";
import { IconClose } from "../icons";

export function HostKeyDialog() {
  const prompt = useAppStore((s) => s.hostKeyPrompt);
  const close = useAppStore((s) => s.closeHostKeyPrompt);

  useEffect(() => {
    if (!prompt) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prompt, close]);

  if (!prompt) return null;

  const changed = prompt.kind === "changed";
  const target = `${prompt.host}:${prompt.port}`;

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal" style={{ width: "min(460px, 92vw)" }} role="dialog" aria-modal="true">
        <div className="modal__header">
          <span className="modal__title">
            {changed ? "Host key changed" : "Unknown host key"}
          </span>
          <button className="icon-btn" onClick={close} title="Close">
            <IconClose />
          </button>
        </div>
        <div className="modal__body">
          <div className="modal__section">
            {changed ? (
              <div className="conn-empty" style={{ textAlign: "left", padding: 0 }}>
                <strong>The host key for <span className="mono">{target}</span> has
                changed.</strong>{" "}
                This can mean the server was reinstalled or its key rotated — but it
                can also mean the connection is being intercepted. Straylight won't
                connect. If you know the change is legitimate, remove the old line
                for this host from <span className="mono">~/.ssh/known_hosts</span> and
                connect again.
              </div>
            ) : (
              <>
                <div className="conn-empty" style={{ textAlign: "left", padding: 0 }}>
                  <span className="mono">{target}</span> isn't in your{" "}
                  <span className="mono">known_hosts</span> yet. Verify this
                  fingerprint matches the server before trusting it.
                </div>
                <div className="field">
                  <label className="field__label">SHA256 fingerprint</label>
                  <div className="input mono" style={{ userSelect: "text", wordBreak: "break-all" }}>
                    {prompt.fingerprint}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
        <div className="modal__footer">
          <button className="btn btn--ghost" onClick={close}>
            {changed ? "Close" : "Cancel"}
          </button>
          {!changed && (
            <button className="btn btn--primary" onClick={prompt.onTrust}>
              Trust &amp; connect
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
