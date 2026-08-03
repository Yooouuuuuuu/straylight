/** Window-size budget: when the window can't hold every visible panel at its
 *  minimum, panels are SUPPRESSED in a fixed order (Sessions → SC → explorer)
 *  until the editor keeps its floor — and restored in reverse as space
 *  returns. Suppression is a derived overlay: the user's visibility flags are
 *  never touched, so growing the window brings back exactly what the resize
 *  hid and nothing the user hid. A hysteresis band keeps the thresholds from
 *  flapping while dragging. The Y axis has one rung: the terminal collapses
 *  when the body can't hold editor + terminal floors.
 *
 *  Below every rung, the app window itself is floored (tauri.conf.json
 *  minWidth/minHeight) — states smaller than the smallest legal layout can't
 *  exist. */
import { useEffect, useState } from "react";

/** Column minimums (px) — match HW_BOUNDS mins in App.tsx. */
export const COL_MIN = { sidebar: 160, scm: 200, chat: 220 } as const;
/** The editor column's X floor — sized so the TERMINAL group bar fits its
 *  worst case (1 Local + 3 WSL + 3 remote chips + four tool icons + the hide
 *  button = 12 icons, all icon-only) with working room. Below this, columns
 *  start being suppressed. */
export const EDITOR_MIN_X = 420;
/** The window floor (square, per design): explorer min + editor/terminal
 *  floor + chrome, with the whole square scaled 1.2× — the extra X all goes
 *  to the editor/terminal column. The OS min-size is kept at this many CSS
 *  px at any zoom (applyZoom rescales the logical minimum). */
export const WINDOW_MIN = 600;
/** Drag handles + column borders allowance. */
export const X_CHROME = 16;
/** Hysteresis: restoring needs this much MORE room than suppressing took. */
export const BAND = 32;

export const Y_TITLEBAR = 36;
export const Y_STATUSBAR = 24;
export const EDITOR_MIN_Y = 160;
export const TERMINAL_MIN_Y = 110;

export type SuppressKey = "chat" | "scm" | "sidebar";
/** First to go → last: Sessions (its signals live on elsewhere), then SC.
 *  The EXPLORER is never suppressed — the window floor is sized to hold it
 *  next to the editor/terminal at their minimums — and the editor never. */
export const SUPPRESS_ORDER: SuppressKey[] = ["chat", "scm"];
/** Shrink-toward-min order (the explorer shrinks; it just never hides). */
export const SHRINK_ORDER: SuppressKey[] = ["chat", "scm", "sidebar"];

export interface Suppressed {
  chat: boolean;
  scm: boolean;
  sidebar: boolean;
  terminal: boolean;
}

export const NONE_SUPPRESSED: Suppressed = {
  chat: false,
  scm: false,
  sidebar: false,
  terminal: false,
};

/** Which of the SHOWN columns must be suppressed at width `w` (pure, no
 *  hysteresis — the caller compares against the current state for that). */
export function xSuppressionFor(
  w: number,
  shown: Record<SuppressKey, boolean>,
): Set<SuppressKey> {
  const out = new Set<SuppressKey>();
  const needed = () =>
    EDITOR_MIN_X +
    X_CHROME +
    // The explorer is unsuppressible but its footprint still counts.
    (shown.sidebar ? COL_MIN.sidebar : 0) +
    SUPPRESS_ORDER.filter((k) => shown[k] && !out.has(k)).reduce(
      (s, k) => s + COL_MIN[k],
      0,
    );
  for (const k of SUPPRESS_ORDER) {
    if (w >= needed()) break;
    if (!shown[k]) continue;
    // The LAST visible column is never suppressed: suppression exists to
    // free space for the editor, but with nothing else left the user's one
    // remaining panel wins and the editor flexes below its floor instead
    // (e.g. explorer hidden by hand → SC survives at the window floor).
    const othersLeft =
      shown.sidebar ||
      SUPPRESS_ORDER.some((o) => o !== k && shown[o] && !out.has(o));
    if (!othersLeft) break;
    out.add(k);
  }
  return out;
}

/** Rendered column widths: before anything is suppressed, columns SHRINK
 *  toward their minimums in the same order (Sessions gives first), so the
 *  editor holds its floor as long as possible. Suppressed/hidden columns
 *  should simply not be passed as shown. */
export function clampedWidths(
  w: number,
  shown: Record<SuppressKey, boolean>,
  desired: { sidebar: number; scm: number; chat: number },
): { sidebar: number; scm: number; chat: number } {
  const widths = { ...desired };
  const active = SHRINK_ORDER.filter((k) => shown[k]);
  let excess =
    active.reduce((s, k) => s + widths[k], 0) + EDITOR_MIN_X + X_CHROME - w;
  for (const k of active) {
    if (excess <= 0) break;
    const give = Math.min(excess, widths[k] - COL_MIN[k]);
    widths[k] -= give;
    excess -= give;
  }
  return widths;
}

/** Live window size (one listener per mounted user). */
export function useWindowSize(): { w: number; h: number } {
  const [size, setSize] = useState({
    w: window.innerWidth,
    h: window.innerHeight,
  });
  useEffect(() => {
    // rAF-coalesced: the raw event fires several times per frame during a
    // drag-resize and each setState re-rendered the WHOLE app. One write per
    // frame, size read at fire time so the final value always lands
    // (docs/dev/code-scan-2026-08.md A6).
    let raf = 0;
    const onResize = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setSize({ w: window.innerWidth, h: window.innerHeight });
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  return size;
}
