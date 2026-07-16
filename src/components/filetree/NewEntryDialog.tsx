/** Prompt for the name of a new file or folder (created in a target directory). */
import { useEffect, useState } from "react";

import { createEntry } from "../../lib/fileOps";
import { basename } from "../../lib/format";
import { useDialogKeys } from "../../hooks/useDialogKeys";
import { useAppStore } from "../../store/appStore";

export function NewEntryDialog() {
  const newEntry = useAppStore((s) => s.newEntry);
  const closeNewEntry = useAppStore((s) => s.closeNewEntry);
  const [name, setName] = useState("");
  // The Create button is disabled while the name is empty, so the hook's
  // initial focus lands on the input; Enter clicks Create once it's enabled.
  const dlg = useDialogKeys(closeNewEntry, newEntry);

  useEffect(() => {
    if (newEntry) setName("");
  }, [newEntry]);

  if (!newEntry) return null;
  const entry = newEntry;

  const submit = () => {
    if (name.trim()) void createEntry(entry.connId, entry.parent, name, entry.isDir);
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeNewEntry();
      }}
    >
      <div
        className="modal"
        style={{ width: "min(420px, 92vw)" }}
        role="dialog"
        aria-modal="true"
        ref={dlg.ref}
        onKeyDown={dlg.onKeyDown}
      >
        <div className="modal__header">
          <span className="modal__title">
            {entry.isDir ? "New folder" : "New file"}
          </span>
        </div>
        <div className="modal__body">
          <div className="field">
            <label className="field__label">
              In <span className="mono">{basename(entry.parent) || entry.parent}</span>
            </label>
            <input
              className="input input--mono"
              value={name}
              placeholder={entry.isDir ? "folder name" : "file name"}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        </div>
        <div className="modal__footer">
          <button className="btn btn--ghost" onClick={() => closeNewEntry()}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            data-dialog-primary
            disabled={!name.trim()}
            onClick={submit}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
