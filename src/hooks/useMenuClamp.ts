/** Keep a popup / context menu inside the window. Anchor it at (x, y), then —
 *  after it renders — measure the REAL box and nudge it back from the right and
 *  bottom edges (8px margin). Measuring beats guessing dimensions: a menu that
 *  grows a row (remote-only items, a rename, more groups) can't clip. `open`
 *  gates and re-runs the measure whenever the menu (re)opens or moves. Attach
 *  `ref` to the menu's root element and position it with the returned left/top.
 *
 *  Usage:
 *    const { ref, left, top } = useMenuClamp(menu?.x ?? 0, menu?.y ?? 0, !!menu);
 *    <div ref={ref} style={{ left, top }} />
 */
import { useLayoutEffect, useRef, useState } from "react";

const MARGIN = 8;

export function useMenuClamp(x: number, y: number, open = true) {
  const ref = useRef<HTMLDivElement>(null);
  const [nudge, setNudge] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    if (!open) {
      setNudge({ x: 0, y: 0 });
      return;
    }
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setNudge({
      x: Math.min(0, window.innerWidth - MARGIN - (x + r.width)),
      y: Math.min(0, window.innerHeight - MARGIN - (y + r.height)),
    });
  }, [x, y, open]);
  return {
    ref,
    // nudge is <= 0 (it only pulls back from the right/bottom); the max guards
    // the left/top edges when a menu is wider/taller than the window itself.
    left: Math.max(MARGIN, x + nudge.x),
    top: Math.max(MARGIN, y + nudge.y),
  };
}
