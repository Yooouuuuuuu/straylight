/** Prompt for the name of a new file or folder (created in a target directory). */
import { useEffect, useRef, useState } from "react";

import { createEntry } from "../../lib/fileOps";
import { basename } from "../../lib/format";
import { useAppStore } from "../../store/appStore";

export function NewEntryDialog() {
  const newEntry = useAppStore((s) => s.newEntry);
  const closeNewEntry = useAppStore((s) => s.closeNewEntry);
  const [name, setName] = useState("");
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (newEntry) {
      setName("");
      const timer = window.setTimeout(() => ref.current?.focus(), 0);
      return () => window.clearTimeout(timer);
    }
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
              ref={ref}
              className="input input--mono"
              value={name}
              placeholder={entry.isDir ? "folder name" : "file name"}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                else if (e.key === "Escape") closeNewEntry();
              }}
            />
          </div>
        </div>
        <div className="modal__footer">
          <button className="btn btn--ghost" onClick={() => closeNewEntry()}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
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
