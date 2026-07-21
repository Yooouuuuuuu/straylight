/** A self-updating "N ago" label. It recomputes only as often as the displayed
 *  unit can change — every second under a minute, every minute under an hour,
 *  every hour under a day, then daily — so it stays exact with a single cheap
 *  timer that slows down on its own as the timestamp ages. */
import { useEffect, useState } from "react";

import { Tip } from "./Tooltip";

/** Shared "N ago" formatter. Under 10 s it's a static bucket — a per-second
 *  count-up right after every action reads as nervous ticking. */
export function formatAgo(seconds: number): string {
  if (seconds < 10) return "<10s ago";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** How long until the displayed value could next change, given the current age. */
function nextTickMs(seconds: number): number {
  if (seconds < 10) return (10 - seconds) * 1_000; // one hop to the bucket edge
  if (seconds < 60) return 1_000;
  if (seconds < 3_600) return 60_000;
  if (seconds < 86_400) return 3_600_000;
  return 86_400_000;
}

export function RelativeTime({
  at,
  title = "Last refreshed",
}: {
  at: number | null;
  /** Native tooltip; pass null when a parent Tip already covers it. */
  title?: string | null;
}) {
  const [, bump] = useState(0);

  useEffect(() => {
    if (at == null) return;
    let timer: number;
    const schedule = () => {
      const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
      timer = window.setTimeout(() => {
        bump((n) => n + 1);
        schedule();
      }, nextTickMs(seconds));
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [at]);

  if (at == null) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  const span = (
    <span className="sidebar__section-ago">{formatAgo(seconds)}</span>
  );
  return title ? <Tip label={title}>{span}</Tip> : span;
}
