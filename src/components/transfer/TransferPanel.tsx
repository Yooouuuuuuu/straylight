/** Two-pane transfer overlay: drag a file/folder from one connection's tree onto
 *  a folder in the other to copy it across (see docs/drag-drop.md). Copy-only. */
import { useState } from "react";

import { fsTransfer, fsTransferCheck } from "../../lib/ipc";
import type { DragItem } from "../../lib/transferDrag";
import { useAppStore } from "../../store/appStore";
import { IconClose } from "../icons";
import { TransferPane } from "./TransferPane";

export interface TransferConn {
  connId: string;
  rootPath: string;
  label: string;
  color?: string;
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
  const refreshConn = useAppStore((s) => s.refreshConn);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<{
    count: number;
    name: string;
    resolve: (c: Choice) => void;
  } | null>(null);

  async function onDropInto(
    items: DragItem[],
    destConnId: string,
    destDir: string,
  ) {
    if (busy) return;
    const xfer = items.filter((it) => it.connId !== destConnId);
    if (!xfer.length) return;
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
      setBusy(true);
      for (const it of xfer) {
        await fsTransfer(it.connId, it.path, destConnId, destDir, rename);
      }
      // refreshConn bumps the section token, which refreshes both the matching
      // explorer tree and this panel's pane (it reads the same token).
      refreshConn(destConnId);
      pushNotice(
        "info",
        xfer.length === 1 ? `Copied ${xfer[0].name}` : `Copied ${xfer.length} items`,
      );
    } catch (e) {
      pushNotice("error", `Transfer failed: ${String(e)}`);
    } finally {
      setBusy(false);
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
          <button className="icon-btn" onClick={onClose} title="Close">
            <IconClose />
          </button>
        </div>

        <div className="transfer-modal__body">
          <TransferPane
            connId={a.connId}
            rootPath={a.rootPath}
            label={a.label}
            color={a.color}
            onDropInto={(items, destDir) => void onDropInto(items, a.connId, destDir)}
          />
          <TransferPane
            connId={b.connId}
            rootPath={b.rootPath}
            label={b.label}
            color={b.color}
            onDropInto={(items, destDir) => void onDropInto(items, b.connId, destDir)}
          />
        </div>

        {busy && (
          <div className="transfer-modal__busy">
            <span className="spinner spinner--sm" /> Transferring…
          </div>
        )}

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
