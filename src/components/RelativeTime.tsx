/** A self-updating "N ago" label. It recomputes only as often as the displayed
 *  unit can change — every second under a minute, every minute under an hour,
 *  every hour under a day, then daily — so it stays exact with a single cheap
 *  timer that slows down on its own as the timestamp ages. */
import { useEffect, useState } from "react";

function format(seconds: number): string {
  if (seconds < 1) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** How long until the displayed value could next change, given the current age. */
function nextTickMs(seconds: number): number {
  if (seconds < 60) return 1_000;
  if (seconds < 3_600) return 60_000;
  if (seconds < 86_400) return 3_600_000;
  return 86_400_000;
}

export function RelativeTime({ at }: { at: number | null }) {
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
  return (
    <span className="sidebar__section-ago" title="Last refreshed">
      {format(seconds)}
    </span>
  );
}
