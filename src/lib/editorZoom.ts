/** Editor-font wheel zoom (Ctrl+wheel over an editor), replacing Monaco's
 *  built-in `mouseWheelZoom`: its ±1px steps are timid, and it works through
 *  the global EditorZoom multiplier — which also scales the minimap. This
 *  applies a session-wide factor straight to `fontSize` via updateOptions on
 *  every live editor (file / diff / merge share one level), so the minimap's
 *  own scale is never touched. `lineHeight` scales WITH the font (the
 *  wrappers pin 20px for a 13px font — scaling one without the other
 *  overlaps lines).
 *
 *  Feel: VS Code window-zoom — ×1.2 per wheel notch, clamped. The level
 *  PERSISTS across restarts (localStorage, like the column widths) — and
 *  since windows share storage, the workspace pop-out's editors open at the
 *  same zoom. App zoom (Ctrl+=/−) and terminal font sizing are untouched. */

const BASE_FONT = 13;
const BASE_LINE = 20;
const STEP = 1.2;
const MIN_FACTOR = 0.5; // ~7px
// Capped so the minimap's font-coupled width term can't undercut its fixed
// 40-column cap at realistic pane widths (the bar must hold still — see
// MonacoWrapper's minimap options). ~2.5 ≈ a 32px font, plenty of zoom.
const MAX_FACTOR = 2.5;

const FACTOR_KEY = "straylight.editorZoom";

function loadFactor(): number {
  try {
    const v = Number(localStorage.getItem(FACTOR_KEY));
    return Number.isFinite(v) && v >= MIN_FACTOR && v <= MAX_FACTOR ? v : 1;
  } catch {
    return 1;
  }
}

let factor = loadFactor();

/** Anything with Monaco's updateOptions shape — standalone, diff (applies to
 *  both panes), and the merge editors all qualify. Structural on purpose: no
 *  monaco import, so this stays out of the eager graph (the code-split). */
interface Zoomable {
  updateOptions(o: { fontSize?: number; lineHeight?: number }): void;
}

const live = new Set<Zoomable>();

function apply(ed: Zoomable): void {
  ed.updateOptions({
    fontSize: Math.round(BASE_FONT * factor),
    lineHeight: Math.round(BASE_LINE * factor),
  });
}

/** Track an editor for the shared zoom level. Applies the current level
 *  immediately, so a split/diff opened mid-session matches its siblings.
 *  Returns the unregister function. */
export function registerZoomable(ed: Zoomable): () => void {
  live.add(ed);
  if (factor !== 1) apply(ed);
  return () => {
    live.delete(ed);
  };
}

/** One zoom step (1 = in, -1 = out) across every live editor. */
export function zoomEditorFont(dir: 1 | -1): void {
  const next = factor * (dir > 0 ? STEP : 1 / STEP);
  factor = Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, next));
  for (const ed of live) apply(ed);
  // Notches are discrete user actions — a per-step write is fine (unlike the
  // per-mousemove writes the column drags had to shed).
  try {
    localStorage.setItem(FACTOR_KEY, String(factor));
  } catch {
    /* prefs only */
  }
}

/** Ctrl+wheel on an editor host → zoom. CAPTURE phase, because Monaco's own
 *  scroll machinery consumes wheel events on its descendants (it calls
 *  stopPropagation — that's how it scrolls), so a bubble listener on the host
 *  never hears them; capturing runs first on the way down. Non-passive so
 *  preventDefault sticks, and we stopPropagation so the Ctrl+wheel is OURS
 *  alone — no scroll underneath it. Returns the detach. */
export function attachWheelZoom(host: HTMLElement): () => void {
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey || e.deltaY === 0) return;
    e.preventDefault();
    e.stopPropagation();
    zoomEditorFont(e.deltaY < 0 ? 1 : -1);
  };
  host.addEventListener("wheel", onWheel, { passive: false, capture: true });
  return () =>
    host.removeEventListener("wheel", onWheel, { capture: true });
}
