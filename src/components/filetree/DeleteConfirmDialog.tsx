/** Confirm before deleting a file or folder (one or many). */
import { deleteEntries } from "../../lib/fileOps";
import { useDialogKeys } from "../../hooks/useDialogKeys";
import { useAppStore } from "../../store/appStore";

export function DeleteConfirmDialog() {
  const confirmDelete = useAppStore((s) => s.confirmDelete);
  const closeConfirmDelete = useAppStore((s) => s.closeConfirmDelete);
  const dlg = useDialogKeys(
    closeConfirmDelete,
    confirmDelete && confirmDelete.length > 0 ? confirmDelete : null,
  );

  if (!confirmDelete || confirmDelete.length === 0) return null;
  const items = confirmDelete;
  const single = items.length === 1 ? items[0] : null;

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
        ref={dlg.ref}
        onKeyDown={dlg.onKeyDown}
      >
        <div className="modal__header">
          <span className="modal__title">
            {single
              ? `Delete ${single.isDir ? "folder" : "file"}`
              : `Delete ${items.length} items`}
          </span>
        </div>
        <div className="modal__body">
          <div className="conn-empty" style={{ textAlign: "left", padding: 0 }}>
            {single ? (
              <>
                Delete <strong className="mono">{single.name}</strong>
                {single.isDir ? " and everything inside it" : ""}? This can’t be
                undone.
              </>
            ) : (
              <>
                Delete these <strong>{items.length}</strong> items (and everything
                inside any folders)? This can’t be undone.
              </>
            )}
          </div>
        </div>
        <div className="modal__footer">
          <button className="btn btn--ghost" onClick={() => closeConfirmDelete()}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            data-dialog-primary
            style={{
              background: "var(--red)",
              borderColor: "var(--red)",
              color: "#fff",
            }}
            onClick={() => void deleteEntries(items)}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
