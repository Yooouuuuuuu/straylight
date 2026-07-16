/** The in-flight transfer's progress, rendered from the global store so it shows
 *  both inside the transfer panel (`panel`) and in the status bar (`status`)
 *  after the panel is closed. Renders nothing when idle. */
import { formatSize } from "../../lib/format";
import { useAppStore } from "../../store/appStore";
import { IconClose } from "../icons";

export function TransferProgressBar({ variant }: { variant: "panel" | "status" }) {
  const t = useAppStore((s) => s.activeTransfer);
  const cancel = useAppStore((s) => s.cancelActiveTransfer);
  if (!t) return null;

  const pct =
    t.totalBytes > 0
      ? Math.min(100, (t.doneBytes / t.totalBytes) * 100)
      : t.totalFiles > 0
        ? Math.min(100, (t.doneFiles / t.totalFiles) * 100)
        : 0;

  const detail =
    t.totalFiles === 0
      ? "Preparing…" // before the first event (size pre-pass)
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
    return (
      <span className="statusbar__transfer" title={`${t.label} · ${detail}`}>
        <span className="statusbar__transfer-track">
          <span className="statusbar__transfer-fill" style={{ width: `${pct}%` }} />
        </span>
        <span className="statusbar__transfer-text">{detail}</span>
        <button
          className="statusbar__transfer-cancel"
          onClick={cancel}
          title="Cancel transfer"
        >
          <IconClose size={12} />
        </button>
      </span>
    );
  }

  return (
    <div className="transfer-progress">
      <div className="transfer-progress__track">
        <div className="transfer-progress__fill" style={{ width: `${pct}%` }} />
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
