/** The Transfers tool group in the bottom panel: the two-pane copier, docked.
 *  Each pane picks its own host (left defaults to Local, right starts empty);
 *  choices stick for the app session and reset on relaunch. Drag between the
 *  panes — or Ctrl+C / Ctrl+V — to copy; transfers run in the global store,
 *  so switching tabs mid-copy keeps them going. */
import { useEffect, useRef, useState } from "react";

import { hostColorForConnKey, SECTION_LOCAL, SECTION_WSL } from "../../lib/hostColors";
import { fsTransferCheck } from "../../lib/ipc";
import type { DragItem } from "../../lib/transferDrag";
import { remoteHostKey, useAppStore } from "../../store/appStore";
import { TransferConfirm, type TransferTotal } from "./TransferConfirm";
import { TransferPane } from "./TransferPane";
import { TransferProgressBar } from "./TransferProgressBar";
import type { TransferConn } from "./TransferPanel";

type Choice = "overwrite" | "keepBoth" | "cancel";

// Session-only memory: survives tab switches, resets with the app.
let remembered: { left: string | null; right: string | null } = {
  left: null,
  right: null,
};

export function TransfersView() {
  const localConnId = useAppStore((s) => s.localConnId);
  const pinnedFolders = useAppStore((s) => s.pinnedFolders);
  const wsls = useAppStore((s) => s.wsls);
  const remotes = useAppStore((s) => s.remotes);
  const pushNotice = useAppStore((s) => s.pushNotice);
  const runTransfer = useAppStore((s) => s.runTransfer);
  const setTransferOpen = useAppStore((s) => s.setTransferOpen);

  const conns: TransferConn[] = [];
  if (localConnId)
    conns.push({ connId: localConnId, roots: pinnedFolders, label: "Local", color: SECTION_LOCAL });
  for (const w of wsls)
    conns.push({
      connId: w.conn.connId,
      roots: w.pins,
      label: w.conn.name,
      color: SECTION_WSL,
    });
  for (const r of remotes)
    conns.push({
      connId: r.conn.connId,
      roots: r.pins,
      label: r.conn.name,
      color: hostColorForConnKey(remoteHostKey(r.conn)),
    });

  const [sides, setSides] = useState(remembered);
  const pick = (side: "left" | "right", connId: string | null) => {
    remembered = { ...remembered, [side]: connId };
    setSides(remembered);
  };
  const connFor = (id: string | null) => conns.find((c) => c.connId === id) ?? null;
  const left = connFor(sides.left) ?? connFor(localConnId);
  const right = connFor(sides.right);

  const [conflict, setConflict] = useState<{
    count: number;
    name: string;
    resolve: (c: Choice) => void;
  } | null>(null);
  const [sheet, setSheet] = useState<{
    items: DragItem[];
    srcConnId: string;
    srcLabel: string;
    destLabel: string;
    destDir: string;
    resolve: (r: { total: TransferTotal | null } | null) => void;
  } | null>(null);
  const busyRef = useRef(false);

  // While shown, the panes own F2/Delete (not the explorer selection).
  useEffect(() => {
    setTransferOpen(true);
    return () => setTransferOpen(false);
  }, [setTransferOpen]);

  async function onDropInto(items: DragItem[], destConnId: string, destDir: string) {
    const xfer = items.filter((it) => it.connId !== destConnId);
    if (!xfer.length) return;
    // A confirm sheet / collision prompt is already up for a prior drop — it's
    // visible, so just ignore this one silently.
    if (busyRef.current) return;
    // A transfer is mid-flight. We only run one at a time; say so, otherwise the
    // dropped drag looks like it silently vanished.
    if (useAppStore.getState().activeTransfer) {
      pushNotice("info", "A transfer is already running — let it finish first.");
      return;
    }
    const srcConnId = xfer[0].connId;
    const label = (id: string) => connFor(id)?.label ?? "?";
    busyRef.current = true;
    try {
      // 1. Confirm sheet — route + a size that fills in while scanning. Returns
      //    null on cancel, else the pre-flight total (null if committed before
      //    the scan finished, so the backend measures instead).
      const confirmed = await new Promise<{ total: TransferTotal | null } | null>(
        (resolve) =>
          setSheet({
            items: xfer,
            srcConnId,
            srcLabel: label(srcConnId),
            destLabel: label(destConnId),
            destDir,
            resolve,
          }),
      );
      setSheet(null);
      if (!confirmed) return;

      // 2. Collision prompt (unchanged) — after the intent is confirmed.
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
      // 3. Transfer — reuse the pre-flight size when we have it.
      void runTransfer({
        transferId: crypto.randomUUID(),
        srcConnId,
        srcPaths: xfer.map((it) => it.path),
        destConnId,
        destDir,
        rename,
        label: `${label(srcConnId)} → ${label(destConnId)}`,
        firstName: xfer[0].name,
        total: confirmed.total,
      });
    } catch (e) {
      pushNotice("error", `Transfer failed: ${String(e)}`);
    } finally {
      busyRef.current = false;
    }
  }

  const side = (which: "left" | "right", conn: TransferConn | null) => {
    const otherId = which === "left" ? right?.connId : left?.connId;
    return (
    <div className="transfers-side">
      <select
        className="select transfers-side__host"
        value={conn?.connId ?? ""}
        onChange={(e) => pick(which, e.target.value || null)}
      >
        {/* Placeholder is display-only, and the other side's host is out. */}
        {!conn && (
          <option value="" disabled hidden>
            pick a host…
          </option>
        )}
        {conns
          .filter((c) => c.connId !== otherId)
          .map((c) => (
            <option key={c.connId} value={c.connId}>
              {c.label}
            </option>
          ))}
      </select>
      {conn ? (
        <TransferPane
          key={conn.connId}
          connId={conn.connId}
          roots={conn.roots}
          label={conn.label}
          color={conn.color}
          onDropInto={(items, destDir) => void onDropInto(items, conn.connId, destDir)}
        />
      ) : (
        <div className="transfers-side__empty">
          Pick a host to copy {which === "left" ? "from" : "to"} (either
          direction works).
        </div>
      )}
    </div>
    );
  };

  return (
    <div className="transfers-view">
      <div className="transfers-view__body">
        {side("left", left)}
        {side("right", right)}
      </div>
      <TransferProgressBar variant="panel" />
      {sheet && (
        <TransferConfirm
          items={sheet.items}
          srcConnId={sheet.srcConnId}
          srcLabel={sheet.srcLabel}
          destLabel={sheet.destLabel}
          destDir={sheet.destDir}
          onCancel={() => sheet.resolve(null)}
          onConfirm={(total) => sheet.resolve({ total })}
        />
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
            <button className="btn btn--ghost" onClick={() => conflict.resolve("cancel")}>
              Cancel
            </button>
            <button className="btn btn--ghost" onClick={() => conflict.resolve("keepBoth")}>
              Keep both
            </button>
            <button className="btn btn--primary" onClick={() => conflict.resolve("overwrite")}>
              Overwrite
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
