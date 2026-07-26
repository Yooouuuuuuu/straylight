/** The in-flight transfer's progress, rendered from the global store so it shows
 *  both inside the transfer panel (`panel`) and in the status bar (`status`)
 *  after the panel is closed. Renders nothing when idle. */
import { useRef } from "react";

import { formatSize } from "../../lib/format";
import { useAppStore } from "../../store/appStore";
import { IconClose } from "../icons";
import { Tip } from "../Tooltip";

/** Live rate from successive progress frames (frontend-only — no backend
 *  events). A short EMA over ~1 s windows: steady enough to read, fresh
 *  enough to see Background caps and stalls. */
function useTransferRate(id: string | null, doneBytes: number): number | null {
  const sample = useRef<{ id: string; t: number; bytes: number; rate: number | null } | null>(null);
  if (id == null) {
    sample.current = null;
    return null;
  }
  const now = performance.now();
  const prev = sample.current;
  if (!prev || prev.id !== id || doneBytes < prev.bytes) {
    sample.current = { id, t: now, bytes: doneBytes, rate: null };
    return null;
  }
  const dt = now - prev.t;
  if (dt < 1000) return prev.rate; // keep the window ~1 s wide
  const instant = ((doneBytes - prev.bytes) * 1000) / dt;
  const rate = prev.rate == null ? instant : prev.rate * 0.5 + instant * 0.5;
  sample.current = { id, t: now, bytes: doneBytes, rate };
  return rate;
}

/** Remaining time from the same EMA rate the MB/s readout shows (so the two
 *  never disagree), rounded coarse enough not to jitter. */
function formatEta(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return "";
  const s = Math.round(seconds);
  if (s < 60) return `~${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return m < 10 ? `~${m}m ${s % 60}s` : `~${m}m`;
  return `~${Math.floor(m / 60)}h ${m % 60}m`;
}

export function TransferProgressBar({
  variant,
  shrink = 0,
}: {
  variant: "panel" | "status";
  /** Status bar only: how many left-side pieces to drop as the bar narrows —
   *  1 label, 2 file-count, 3 bytes, 4 percent. Rate · ETA · ✕ is the floor
   *  and never drops. */
  shrink?: number;
}) {
  const t = useAppStore((s) => s.activeTransfer);
  const cancel = useAppStore((s) => s.cancelActiveTransfer);
  const rate = useTransferRate(t?.id ?? null, t?.doneBytes ?? 0);
  if (!t) return null;
  const rateText =
    rate != null && rate > 0 && !t.waiting ? `${formatSize(rate)}/s` : "";
  const etaText =
    rate != null && rate > 0 && !t.waiting && t.totalBytes > 0 && t.doneBytes < t.totalBytes
      ? formatEta((t.totalBytes - t.doneBytes) / rate)
      : "";

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
    // Text-only readout, shed left-to-right as the bar narrows (`shrink`):
    // label · file 3/1200 · 45 MB/2.1 GB · 34% · 2.0 MB/s · ~3m 20s ✕
    //   ↑1        ↑2            ↑3          ↑4      └──── floor (kept) ────┘
    // The ✕ cancels. Rate · ETA is the guaranteed minimum.
    const parts: string[] = [];
    if (shrink < 1) parts.push(t.label);
    if (t.waiting) {
      parts.push("waiting for connection…");
    } else if (!known) {
      if (t.doneBytes > 0) {
        if (shrink < 3) parts.push(formatSize(t.doneBytes));
        if (rateText) parts.push(rateText);
        if (shrink < 2) parts.push("calculating…");
      } else {
        parts.push("starting…");
      }
    } else {
      if (shrink < 2 && t.totalFiles > 1)
        parts.push(`file ${Math.min(t.doneFiles + 1, t.totalFiles)}/${t.totalFiles}`);
      if (shrink < 3 && t.totalBytes > 0)
        parts.push(`${formatSize(t.doneBytes)}/${formatSize(t.totalBytes)}`);
      if (shrink < 4) parts.push(`${Math.round(pct)}%`);
      if (rateText) parts.push(rateText);
      if (etaText) parts.push(etaText);
    }
    return (
      <span className="statusbar__transfer">
        <span
          className={`statusbar__transfer-text ${t.waiting ? "statusbar__transfer-text--waiting" : ""}`}
        >
          {parts.join(" · ")}
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
          {[detail, rateText, etaText, t.current].filter(Boolean).join(" · ")}
        </span>
        <button className="btn btn--ghost" onClick={cancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
