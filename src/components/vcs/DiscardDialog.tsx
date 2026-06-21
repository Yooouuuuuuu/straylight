/** Confirm before discarding working-tree changes (destructive — reverts files
 *  to HEAD / the jj parent, and deletes new/untracked files). */
import { useEffect } from "react";

import { useVcsStore } from "../../store/vcsStore";

export function DiscardDialog() {
  const pending = useVcsStore((s) => s.pendingDiscard);
  const confirmDiscard = useVcsStore((s) => s.confirmDiscard);
  const cancelDiscard = useVcsStore((s) => s.cancelDiscard);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelDiscard();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, cancelDiscard]);

  if (!pending) return null;
  const n = pending.changes.length;
  const single = n === 1 ? pending.changes[0] : null;

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancelDiscard();
      }}
    >
      <div
        className="modal"
        style={{ width: "min(440px, 92vw)" }}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal__header">
          <span className="modal__title">
            {single ? "Discard changes" : `Discard ${n} files`}
          </span>
        </div>
        <div className="modal__body">
          <div className="conn-empty" style={{ textAlign: "left", padding: 0 }}>
            {single ? (
              <>
                Discard changes to <strong className="mono">{single.path}</strong>?
              </>
            ) : (
              <>Discard changes to these {n} files?</>
            )}{" "}
            This reverts them to the last commit and <strong>can’t be undone</strong>
            ; new/untracked files are deleted.
          </div>
        </div>
        <div className="modal__footer">
          <button className="btn btn--ghost" onClick={() => cancelDiscard()}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            style={{ background: "var(--red)", borderColor: "var(--red)", color: "#fff" }}
            onClick={() => void confirmDiscard()}
          >
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}
