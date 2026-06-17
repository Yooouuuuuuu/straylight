/** Confirm before deleting a file or folder. */
import { useEffect } from "react";

import { deleteEntry } from "../../lib/fileOps";
import { useAppStore } from "../../store/appStore";

export function DeleteConfirmDialog() {
  const confirmDelete = useAppStore((s) => s.confirmDelete);
  const closeConfirmDelete = useAppStore((s) => s.closeConfirmDelete);

  // Esc dismisses the dialog without deleting (same as Cancel).
  useEffect(() => {
    if (!confirmDelete) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeConfirmDelete();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmDelete, closeConfirmDelete]);

  if (!confirmDelete) return null;
  const node = confirmDelete;

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeConfirmDelete();
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
            Delete {node.isDir ? "folder" : "file"}
          </span>
        </div>
        <div className="modal__body">
          <div className="conn-empty" style={{ textAlign: "left", padding: 0 }}>
            Delete <strong className="mono">{node.name}</strong>
            {node.isDir ? " and everything inside it" : ""}? This can’t be undone.
          </div>
        </div>
        <div className="modal__footer">
          <button className="btn btn--ghost" onClick={() => closeConfirmDelete()}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            style={{
              background: "var(--red)",
              borderColor: "var(--red)",
              color: "#fff",
            }}
            onClick={() => void deleteEntry(node.connId, node.path)}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
