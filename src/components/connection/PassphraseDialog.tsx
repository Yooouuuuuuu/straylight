/** Prompt to unlock an encrypted SSH key. Opened when a connection fails with
 *  `KEY_NEEDS_PASSPHRASE:` (useSSH); the passphrase is passed straight back to
 *  a retry and held in memory only — never written to disk. */
import { useEffect, useState } from "react";

import { useDialogKeys } from "../../hooks/useDialogKeys";
import { useAppStore } from "../../store/appStore";
import { basename } from "../../lib/format";
import { IconClose } from "../icons";
import { Tip } from "../Tooltip";

export function PassphraseDialog() {
  const prompt = useAppStore((s) => s.passphrasePrompt);
  const close = useAppStore((s) => s.closePassphrasePrompt);
  const [passphrase, setPassphrase] = useState("");
  // Unlock is disabled while empty, so initial focus lands on the field;
  // Enter clicks Unlock once something's typed.
  const dlg = useDialogKeys(close, prompt);

  useEffect(() => {
    setPassphrase("");
  }, [prompt]);

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
      <div
        className="modal"
        style={{ width: "min(440px, 92vw)" }}
        role="dialog"
        aria-modal="true"
        ref={dlg.ref}
        onKeyDown={dlg.onKeyDown}
      >
        <div className="modal__header">
          <span className="modal__title">Unlock SSH key</span>
          <Tip label="Close">
            <button className="icon-btn" onClick={close}>
              <IconClose />
            </button>
          </Tip>
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
                className="input"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </div>
          </div>
        </div>
        <div className="modal__footer">
          <button className="btn btn--ghost" onClick={close}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            data-dialog-primary
            disabled={!passphrase}
            onClick={submit}
          >
            Unlock
          </button>
        </div>
      </div>
    </div>
  );
}
