/** A small in-app folder picker: browse one connection's directories and pick a
 *  folder to open/pin. Works for local, WSL, and remote (it's just `fsListDir`),
 *  so it replaces the OS folder dialog and gives every connection the same UX. A
 *  path bar lets you jump anywhere (e.g. another drive on Windows). */
import { useEffect, useState } from "react";

import { dirname } from "../lib/format";
import { fsListDir, listDrives, type FileEntry } from "../lib/ipc";
import { FileIcon } from "./filetree/FileIcons";
import { IconClose } from "./icons";
import { Tip } from "./Tooltip";

export function FolderBrowser({
  connId,
  title,
  showDrives = false,
  onPick,
  onClose,
}: {
  connId: string;
  title: string;
  /** Show a row of disk chips (local machine's drives) for switching disks. */
  showDrives?: boolean;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState(""); // requested dir; "" resolves to home
  const [current, setCurrent] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [drives, setDrives] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    setEntries(null);
    setError(null);
    fsListDir(connId, path)
      .then((l) => {
        if (!active) return;
        setCurrent(l.path);
        setEntries(l.entries);
        setInput(l.path);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [connId, path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!showDrives) return;
    let active = true;
    listDrives()
      .then((d) => {
        if (active) setDrives(d);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [showDrives]);

  const dirs = (entries ?? []).filter((e) => e.isDir);
  const goUp = () => {
    if (current) setPath(dirname(current));
  };
  const goInput = () => {
    if (input.trim()) setPath(input.trim());
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="folder-browser" role="dialog" aria-modal="true">
        <div className="folder-browser__head">
          <span className="folder-browser__title">{title}</span>
          <Tip label="Close">
            <button className="icon-btn" onClick={onClose}>
              <IconClose />
            </button>
          </Tip>
        </div>

        {drives.length > 1 && (
          <div className="folder-browser__drives">
            {drives.map((d) => {
              const root = d.replace(/[\\/]+$/, "");
              const active = (current ?? "")
                .toLowerCase()
                .startsWith(root.toLowerCase());
              return (
                <Tip key={d} label={d}>
                  <button
                    className={`folder-browser__drive ${active ? "folder-browser__drive--active" : ""}`}
                    onClick={() => setPath(d)}
                  >
                    {root}
                  </button>
                </Tip>
              );
            })}
          </div>
        )}

        <div className="folder-browser__pathbar">
          <Tip label="Up one level">
            <button className="btn btn--ghost" onClick={goUp} disabled={!current}>
              ↑
            </button>
          </Tip>
          <input
            className="input input--mono"
            value={input}
            placeholder="Type or paste a path…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") goInput();
            }}
          />
          <button className="btn btn--ghost" onClick={goInput}>
            Go
          </button>
        </div>

        <div className="folder-browser__list">
          {error ? (
            <div className="folder-browser__msg">{error}</div>
          ) : entries === null ? (
            <div className="folder-browser__msg">
              <span className="spinner spinner--sm" /> Loading…
            </div>
          ) : dirs.length === 0 ? (
            <div className="folder-browser__msg">No subfolders here.</div>
          ) : (
            dirs.map((d) => (
              <Tip key={d.path} label={d.path}>
                <div
                  className="folder-browser__item"
                  onClick={() => setPath(d.path)}
                >
                  <span className="folder-browser__icon">
                    <FileIcon name={d.name} isDir isOpen={false} />
                  </span>
                  <span className="folder-browser__name">{d.name}</span>
                </div>
              </Tip>
            ))
          )}
        </div>

        <div className="folder-browser__foot">
          <Tip label={current ?? ""}>
            <span className="folder-browser__current">{current ?? "…"}</span>
          </Tip>
          <div className="folder-browser__actions">
            <button className="btn btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn--primary"
              disabled={!current}
              onClick={() => current && onPick(current)}
            >
              Open this folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
