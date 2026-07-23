/** Pre-flight confirm for a cross-host copy (the Transfers tool). Pops the
 *  instant you drop/paste: it shows the route and the items, and fills in the
 *  size while the source is scanned. Copy is enabled from the first frame — so
 *  a deep tree never blocks the decision; commit early and the backend just
 *  measures for the progress bar instead. */
import { useEffect, useRef, useState } from "react";

import { formatSize } from "../../lib/format";
import { fsTransferMeasure } from "../../lib/ipc";
import type { DragItem } from "../../lib/transferDrag";

export type TransferTotal = { bytes: number; files: number };

export function TransferConfirm({
  items,
  srcConnId,
  srcLabel,
  destLabel,
  destDir,
  onCancel,
  onConfirm,
}: {
  items: DragItem[];
  srcConnId: string;
  srcLabel: string;
  destLabel: string;
  destDir: string;
  onCancel: () => void;
  onConfirm: (total: TransferTotal | null) => void;
}) {
  const [total, setTotal] = useState<TransferTotal | null>(null);
  const [scanning, setScanning] = useState(true);
  // Read at click/Enter time so the latest scan result is used even if it
  // landed after the last render (the keydown closure would otherwise be stale).
  const totalRef = useRef<TransferTotal | null>(null);

  useEffect(() => {
    let alive = true;
    setScanning(true);
    fsTransferMeasure(
      srcConnId,
      items.map((i) => i.path),
    )
      .then((info) => {
        if (!alive) return;
        const t = { bytes: info.bytes, files: info.files };
        totalRef.current = t;
        setTotal(t);
      })
      .catch(() => {
        /* leave total null — committing just measures on the backend */
      })
      .finally(() => {
        if (alive) setScanning(false);
      });
    return () => {
      alive = false;
    };
  }, [srcConnId, items]);

  // The sheet owns the keyboard while open: Enter commits, Esc cancels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onConfirm(totalRef.current);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel, onConfirm]);

  const shown = items.slice(0, 6);
  const extra = items.length - shown.length;

  return (
    <div className="transfer-confirm" role="dialog" aria-modal="true">
      <div className="transfer-confirm__card">
        <div className="transfer-confirm__route">
          <span className="transfer-confirm__host">{srcLabel}</span>
          <span className="transfer-confirm__arrow">→</span>
          <span className="transfer-confirm__host">
            {destLabel}
            <span className="transfer-confirm__dir mono">{destDir}</span>
          </span>
        </div>
        <ul className="transfer-confirm__items">
          {shown.map((it) => (
            <li
              key={`${it.connId}:${it.path}`}
              className="transfer-confirm__item mono"
            >
              {it.name}
              {it.isDir ? "/" : ""}
            </li>
          ))}
          {extra > 0 && (
            <li className="transfer-confirm__more">+{extra} more</li>
          )}
        </ul>
        <div className="transfer-confirm__size">
          {scanning
            ? "Calculating size…"
            : total
              ? `${total.files.toLocaleString()} file${total.files === 1 ? "" : "s"} · ${formatSize(total.bytes)}`
              : "Size unavailable"}
        </div>
        <div className="transfer-confirm__actions">
          <button className="btn btn--ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            onClick={() => onConfirm(totalRef.current)}
          >
            Copy
          </button>
        </div>
      </div>
    </div>
  );
}
