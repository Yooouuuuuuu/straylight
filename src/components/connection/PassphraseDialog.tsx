/** Prompt to unlock an encrypted SSH key. Opened when a connection fails with
 *  `KEY_NEEDS_PASSPHRASE:` (useSSH); the passphrase is passed straight back to
 *  a retry and held in memory only — never written to disk. */
import { useEffect, useRef, useState } from "react";

import { useAppStore } from "../../store/appStore";
import { basename } from "../../lib/format";
import { IconClose } from "../icons";

export function PassphraseDialog() {
  const prompt = useAppStore((s) => s.passphrasePrompt);
  const close = useAppStore((s) => s.closePassphrasePrompt);
  const [passphrase, setPassphrase] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPassphrase("");
    if (prompt) {
      const t = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(t);
    }
  }, [prompt]);

  useEffect(() => {
    if (!prompt) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prompt, close]);

  if (!prompt) return null;

  const submit = () => {
    if (!passphrase) return;
    prompt.onSubmit(passphrase); // closes the prompt + retries the connection
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal" style={{ width: "min(440px, 92vw)" }} role="dialog" aria-modal="true">
        <div className="modal__header">
          <span className="modal__title">Unlock SSH key</span>
          <button className="icon-btn" onClick={close} title="Close">
            <IconClose />
          </button>
        </div>
        <div className="modal__body">
          <div className="modal__section">
            <div className="conn-empty" style={{ textAlign: "left", padding: 0 }}>
              <strong className="mono">{basename(prompt.keyPath)}</strong> is
              passphrase-protected. Enter its passphrase to connect — it's held
              in memory for this session only, never saved.
            </div>
            <div className="field">
              <label className="field__label">Passphrase</label>
              <input
                ref={inputRef}
                className="input"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
              />
            </div>
          </div>
        </div>
        <div className="modal__footer">
          <button className="btn btn--ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={!passphrase} onClick={submit}>
            Unlock
          </button>
        </div>
      </div>
    </div>
  );
}
