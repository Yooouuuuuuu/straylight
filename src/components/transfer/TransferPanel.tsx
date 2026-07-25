/** Two-pane transfer overlay: drag a file/folder from one connection's tree onto
 *  a folder in the other to copy it across (see docs/drag-drop.md). Copy-only,
 *  streamed (no size cap). The transfer itself + its progress live in the global
 *  store, so closing this panel mid-transfer keeps it running with the progress
 *  bar shown in the status bar. */
import { useEffect, useRef, useState } from "react";

import { fsTransferCheck } from "../../lib/ipc";
import type { DragItem } from "../../lib/transferDrag";
import { useAppStore } from "../../store/appStore";
import { IconClose } from "../icons";
import { Tip } from "../Tooltip";
import { TransferPane } from "./TransferPane";
import { TransferProgressBar } from "./TransferProgressBar";

export interface TransferConn {
  connId: string;
  /** The connection's pinned working dirs (absolute paths). */
  roots: string[];
  label: string;
  color?: string;
  /** Exact identity shown beside the picker (`user@host`); absent for Local. */
  sub?: string;
}

type Choice = "overwrite" | "keepBoth" | "cancel";

export function TransferPanel({
  a,
  b,
  onClose,
}: {
  a: TransferConn;
  b: TransferConn;
  onClose: () => void;
}) {
  const pushNotice = useAppStore((s) => s.pushNotice);
  const runTransfer = useAppStore((s) => s.runTransfer);
  const setTransferOpen = useAppStore((s) => s.setTransferOpen);
  const [conflict, setConflict] = useState<{
    count: number;
    name: string;
    resolve: (c: Choice) => void;
  } | null>(null);
  const busyRef = useRef(false); // guards the collision-prompt window

  // While open, the transfer panes own F2/Delete — keep the global explorer
  // shortcuts from acting on the (possibly different-host) explorer selection.
  useEffect(() => {
    setTransferOpen(true);
    return () => setTransferOpen(false);
  }, [setTransferOpen]);

  async function onDropInto(
    items: DragItem[],
    destConnId: string,
    destDir: string,
  ) {
    // One transfer at a time (the global store tracks the running one).
    if (busyRef.current || useAppStore.getState().activeTransfer) return;
    const xfer = items.filter((it) => it.connId !== destConnId);
    if (!xfer.length) return;
    const srcConnId = xfer[0].connId; // a pane's items share one connection
    busyRef.current = true;
    try {
      // One prompt for the whole batch if any item would collide.
      let anyCollide = false;
      for (const it of xfer) {
        if (await fsTransferCheck(it.path, destConnId, destDir)) {
          anyCollide = true;
          break;
        }
      }
      let rename = false;
      if (anyCollide) {
        const choice = await new Promise<Choice>((resolve) =>
          setConflict({ count: xfer.length, name: xfer[0].name, resolve }),
        );
        setConflict(null);
        if (choice === "cancel") return;
        rename = choice === "keepBoth";
      }
      const srcLabel = srcConnId === a.connId ? a.label : b.label;
      const destLabel = destConnId === a.connId ? a.label : b.label;
      // Fire-and-forget: the store owns the transfer so it survives a close.
      void runTransfer({
        transferId: crypto.randomUUID(),
        srcConnId,
        srcPaths: xfer.map((it) => it.path),
        destConnId,
        destDir,
        rename,
        label: `${srcLabel} → ${destLabel}`,
        firstName: xfer[0].name,
      });
    } catch (e) {
      pushNotice("error", `Transfer failed: ${String(e)}`);
    } finally {
      busyRef.current = false;
    }
  }

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="transfer-modal" role="dialog" aria-modal="true">
        <div className="transfer-modal__head">
          <span className="transfer-modal__title">
            {a.label} ⇄ {b.label}
          </span>
          <span className="transfer-modal__hint">
            Drag between the panes — or select and Ctrl+C / Ctrl+V — to copy
          </span>
          <Tip label="Close">
            <button className="icon-btn" onClick={onClose}>
              <IconClose />
            </button>
          </Tip>
        </div>

        <div className="transfer-modal__body">
          <TransferPane
            connId={a.connId}
            roots={a.roots}
            label={a.label}
            color={a.color}
            onDropInto={(items, destDir) => void onDropInto(items, a.connId, destDir)}
          />
          <TransferPane
            connId={b.connId}
            roots={b.roots}
            label={b.label}
            color={b.color}
            onDropInto={(items, destDir) => void onDropInto(items, b.connId, destDir)}
          />
        </div>

        <TransferProgressBar variant="panel" />

        {conflict && (
          <div className="transfer-conflict">
            <div className="transfer-conflict__text">
              {conflict.count === 1 ? (
                <>
                  <strong className="mono">{conflict.name}</strong> already exists
                  at the destination.
                </>
              ) : (
                <>
                  Some of these <strong>{conflict.count}</strong> items already
                  exist at the destination.
                </>
              )}
            </div>
            <div className="transfer-conflict__actions">
              <button
                className="btn btn--ghost"
                onClick={() => conflict.resolve("cancel")}
              >
                Cancel
              </button>
              <button
                className="btn btn--ghost"
                onClick={() => conflict.resolve("keepBoth")}
              >
                Keep both
              </button>
              <button
                className="btn btn--primary"
                onClick={() => conflict.resolve("overwrite")}
              >
                Overwrite
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
