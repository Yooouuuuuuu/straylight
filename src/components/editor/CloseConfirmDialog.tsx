/** Shown when closing a tab with unsaved changes: Save, Don't save, or Cancel. */
import { deleteDraftFor } from "../../lib/drafts";
import { saveTab } from "../../lib/saveFile";
import { useDialogKeys } from "../../hooks/useDialogKeys";
import { useAppStore } from "../../store/appStore";

export function CloseConfirmDialog() {
  const closeConfirm = useAppStore((s) => s.closeConfirm);
  const tabs = useAppStore((s) => s.tabs);
  const clearCloseConfirm = useAppStore((s) => s.clearCloseConfirm);
  const forceCloseTab = useAppStore((s) => s.forceCloseTab);
  const dlg = useDialogKeys(clearCloseConfirm, closeConfirm);

  const tab = closeConfirm ? tabs.find((t) => t.id === closeConfirm.tabId) : null;
  if (!closeConfirm || !tab) return null;
  const target = tab;

  async function saveAndClose() {
    const outcome = await saveTab(target.id);
    if (outcome === "saved" || outcome === "noop") {
      forceCloseTab(target.id);
    } else {
      // Conflict/error: keep the tab open (a conflict dialog takes over).
      clearCloseConfirm();
    }
  }

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) clearCloseConfirm();
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
          <span className="modal__title">Unsaved changes</span>
        </div>
        <div className="modal__body">
          <div className="conn-empty" style={{ textAlign: "left", padding: 0 }}>
            <strong className="mono">{target.name}</strong> has unsaved changes.
            Save them before closing?
          </div>
        </div>
        <div className="modal__footer">
          <button className="btn btn--ghost" onClick={() => clearCloseConfirm()}>
            Cancel
          </button>
          <button
            className="btn"
            onClick={() => {
              // Explicitly dropping the edits resolves their hot-exit draft
              // too — the net is for accidents, not chosen discards.
              deleteDraftFor(target.connId, target.path);
              forceCloseTab(target.id);
            }}
          >
            Don’t save
          </button>
          <button
            className="btn btn--primary"
            data-dialog-primary
            onClick={() => void saveAndClose()}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
