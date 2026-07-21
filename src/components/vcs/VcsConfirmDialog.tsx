/** Generic confirmation for VC actions that mutate the working tree or publish
 *  (Update, Push, stash Pop, amending a pushed commit).
 *  Dialogs opened with an id offer "don't ask again" (settings.json
 *  `confirms` — delete the key there to bring a dialog back). */
import { useEffect, useState } from "react";

import { disableConfirm } from "../../lib/settings";
import { useDialogKeys } from "../../hooks/useDialogKeys";
import { useVcsStore } from "../../store/vcsStore";
import { Tip } from "../Tooltip";

export function VcsConfirmDialog() {
  const confirm = useVcsStore((s) => s.vcsConfirm);
  const clearConfirm = useVcsStore((s) => s.clearConfirm);
  const [silence, setSilence] = useState(false);
  const dlg = useDialogKeys(clearConfirm, confirm);

  useEffect(() => {
    setSilence(false); // fresh checkbox per dialog
  }, [confirm]);

  if (!confirm) return null;

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) clearConfirm();
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
          <span className="modal__title">{confirm.title}</span>
        </div>
        <div className="modal__body">
          <div className="conn-empty" style={{ textAlign: "left", padding: 0 }}>
            {confirm.body}
          </div>
        </div>
        <div className="modal__footer">
          {confirm.id && (
            <Tip label="Saved to settings.json — delete the key there to undo">
              <label className="confirm-silence">
                <input
                  type="checkbox"
                  checked={silence}
                  onChange={(e) => setSilence(e.target.checked)}
                />
                Don't ask again
              </label>
            </Tip>
          )}
          <button className="btn btn--ghost" onClick={() => clearConfirm()}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            data-dialog-primary
            onClick={() => {
              const { run, id } = confirm;
              if (silence && id) void disableConfirm(id);
              clearConfirm();
              run();
            }}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
