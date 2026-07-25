/** The in-flight transfer's progress, rendered from the global store so it shows
 *  both inside the transfer panel (`panel`) and in the status bar (`status`)
 *  after the panel is closed. Renders nothing when idle. */
import { formatSize } from "../../lib/format";
import { useAppStore } from "../../store/appStore";
import { IconClose } from "../icons";
import { Tip } from "../Tooltip";

export function TransferProgressBar({ variant }: { variant: "panel" | "status" }) {
  const t = useAppStore((s) => s.activeTransfer);
  const cancel = useAppStore((s) => s.cancelActiveTransfer);
  if (!t) return null;

  // The size may not be known yet: when you commit before the confirm sheet's
  // scan finishes, the copy starts right away and the total fills in alongside
  // it — until then the bar shows what's copied so far, "calculating".
  const known = t.totalBytes > 0 || t.totalFiles > 0;

  const pct = !known
    ? 0
    : t.totalBytes > 0
      ? Math.min(100, (t.doneBytes / t.totalBytes) * 100)
      : Math.min(100, (t.doneFiles / t.totalFiles) * 100);

  const detail = t.waiting
    ? "waiting for connection… (resumes by itself)"
    : !known
      ? t.doneBytes > 0
        ? `${formatSize(t.doneBytes)} · calculating total…`
        : "Starting…"
      : [
          t.totalFiles > 1
            ? `file ${Math.min(t.doneFiles + 1, t.totalFiles)}/${t.totalFiles}`
            : "",
          t.totalBytes > 0
            ? `${formatSize(t.doneBytes)} / ${formatSize(t.totalBytes)}`
            : "",
        ]
          .filter(Boolean)
          .join(" · ");

  if (variant === "status") {
    // Text-only readout: "host → Downloads · file 3/1200 · 45 MB/2.1 GB · 34%"
    // — no bar; the percent carries the progress, ✕ cancels.
    const statusDetail = t.waiting
      ? "waiting for connection…"
      : !known
        ? t.doneBytes > 0
          ? `${formatSize(t.doneBytes)} · calculating…`
          : "starting…"
        : [
            t.totalFiles > 1
              ? `file ${Math.min(t.doneFiles + 1, t.totalFiles)}/${t.totalFiles}`
              : "",
            t.totalBytes > 0
              ? `${formatSize(t.doneBytes)}/${formatSize(t.totalBytes)}`
              : "",
            `${Math.round(pct)}%`,
          ]
            .filter(Boolean)
            .join(" · ");
    return (
      <span className="statusbar__transfer">
        <span
          className={`statusbar__transfer-text ${t.waiting ? "statusbar__transfer-text--waiting" : ""}`}
        >
          {t.label} · {statusDetail}
        </span>
        <Tip label="Cancel transfer">
          <button className="statusbar__transfer-cancel" onClick={cancel}>
            <IconClose size={12} />
          </button>
        </Tip>
      </span>
    );
  }

  return (
    <div className="transfer-progress">
      <div className="transfer-progress__track">
        <div
          className={`transfer-progress__fill ${t.waiting ? "transfer-progress__fill--waiting" : ""}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="transfer-progress__row">
        <span className="transfer-progress__text">
          {[detail, t.current].filter(Boolean).join(" · ")}
        </span>
        <button className="btn btn--ghost" onClick={cancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
