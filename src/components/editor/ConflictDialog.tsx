/** Shown when a save is refused because the file changed on disk. Offers
 *  Overwrite, Reload (discard local edits), or Cancel. */
import { openFileByPath } from "../../lib/openFile";
import { overwritePendingFile } from "../../lib/saveFile";
import { useAppStore } from "../../store/appStore";

export function ConflictDialog() {
  const conflict = useAppStore((s) => s.conflict);
  const tabs = useAppStore((s) => s.tabs);
  const clearConflict = useAppStore((s) => s.clearConflict);
  const forceCloseTab = useAppStore((s) => s.forceCloseTab);

  const tab = conflict ? tabs.find((t) => t.id === conflict.tabId) : null;
  if (!conflict || !tab) return null;
  const target = tab;

  async function reload() {
    clearConflict();
    forceCloseTab(target.id);
    await openFileByPath(target.connId, target.path, target.name);
  }

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) clearConflict();
      }}
    >
      <div
        className="modal"
        style={{ width: "min(460px, 92vw)" }}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal__header">
          <span className="modal__title">File changed on disk</span>
        </div>
        <div className="modal__body">
          <div className="conn-empty" style={{ textAlign: "left", padding: 0 }}>
            <strong className="mono">{target.name}</strong> was modified outside
            Straylight since you opened it. Overwrite it with your version, reload
            the version on disk (discarding your changes), or cancel and keep
            editing.
          </div>
        </div>
        <div className="modal__footer">
          <button className="btn btn--ghost" onClick={() => clearConflict()}>
            Cancel
          </button>
          <button className="btn" onClick={() => void reload()}>
            Reload from disk
          </button>
          <button
            className="btn btn--primary"
            onClick={() => void overwritePendingFile()}
          >
            Overwrite
          </button>
        </div>
      </div>
    </div>
  );
}
