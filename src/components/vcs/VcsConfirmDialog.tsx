/** Generic confirmation for VC actions that mutate the working tree or publish
 *  (Update/Rebase, Push, stash Pop, amending a pushed commit, jj squash). */
import { useEffect } from "react";

import { useVcsStore } from "../../store/vcsStore";

export function VcsConfirmDialog() {
  const confirm = useVcsStore((s) => s.vcsConfirm);
  const clearConfirm = useVcsStore((s) => s.clearConfirm);

  useEffect(() => {
    if (!confirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm, clearConfirm]);

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
          <button className="btn btn--ghost" onClick={() => clearConfirm()}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            onClick={() => {
              const run = confirm.run;
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
