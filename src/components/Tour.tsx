/** The guided-tour overlay (lib/tour): dims the app, cuts a spotlight around
 *  the current step's real element, and shows a card with the step text and
 *  Back / Next / Skip. Blocking by design — the overlay eats clicks; the
 *  title-bar drag/minimize stay alive above it (house z-index rule). Steps
 *  whose target is absent in the current state are skipped in the direction
 *  of travel. Keyboard: ←/→/Enter navigate, Esc leaves. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { showPanels, TOUR_STEPS, useTourStore } from "../lib/tour";

const PAD = 6; // spotlight breathing room around the target
const CARD_W = 400;
const CARD_EST_H = 170; // estimate for above/below placement

interface Cutout {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function Tour() {
  const step = useTourStore((s) => s.step);
  const stop = useTourStore((s) => s.stop);
  const next = useTourStore((s) => s.next);
  const prev = useTourStore((s) => s.prev);
  // The direction of travel — a missing-target step skips the SAME way, so
  // Back through a skipped step keeps going back.
  const dirRef = useRef<1 | -1>(1);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [ready, setReady] = useState(false);

  const def = step === null ? undefined : TOUR_STEPS[step];
  const last = step !== null && step >= TOUR_STEPS.length - 1;

  // Walked past the end → finished.
  useEffect(() => {
    if (step !== null && (step >= TOUR_STEPS.length || step < 0)) stop(true);
  }, [step, stop]);

  // Set the stage (only this step's panels open) + measure the target; skip
  // when it doesn't exist here.
  useLayoutEffect(() => {
    if (!def) return;
    setReady(false);
    showPanels(def.panels ?? {});
    let raf2 = 0;
    let cancelled = false;
    // Two frames: one for React to commit whatever prepare() revealed, one
    // for layout to settle before we measure.
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (cancelled) return;
        if (!def.target) {
          setRect(null);
          setReady(true);
          return;
        }
        const el = document.querySelector(`[data-tour="${def.target}"]`);
        const r = el?.getBoundingClientRect();
        if (!r || r.width < 2 || r.height < 2) {
          (dirRef.current === 1 ? next : prev)();
          return;
        }
        setRect(r);
        setReady(true);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Track the target through window resizes.
  useEffect(() => {
    if (!def?.target) return;
    const onResize = () => {
      const el = document.querySelector(`[data-tour="${def.target}"]`);
      const r = el?.getBoundingClientRect();
      if (r && r.width >= 2) setRect(r);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Keyboard, capture phase — the tour owns the keys while it's up.
  useEffect(() => {
    if (step === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        stop(false);
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        dirRef.current = 1;
        if (last) stop(true);
        else next();
      } else if (e.key === "ArrowLeft") {
        dirRef.current = -1;
        prev();
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [step, last, next, prev, stop]);

  if (step === null || !def || !ready) return null;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cut: Cutout | null = rect
    ? {
        left: Math.max(0, rect.left - PAD),
        top: Math.max(0, rect.top - PAD),
        right: Math.min(vw, rect.right + PAD),
        bottom: Math.min(vh, rect.bottom + PAD),
      }
    : null;

  // Card placement: below the spotlight, else above, else BESIDE it — the
  // full-height column targets (explorer, editor, sessions) have no room
  // above or below, and an off-screen card is a locked tour. Whatever wins
  // is clamped fully on-screen as the last word.
  let cardStyle: React.CSSProperties | undefined;
  if (cut) {
    const clampX = (x: number) => Math.min(Math.max(8, x), vw - CARD_W - 8);
    const clampY = (y: number) =>
      Math.min(Math.max(8, y), vh - CARD_EST_H - 8);
    let left: number;
    let top: number;
    if (cut.bottom + CARD_EST_H + 16 < vh) {
      // Below.
      left = clampX((cut.left + cut.right) / 2 - CARD_W / 2);
      top = cut.bottom + 12;
    } else if (cut.top - CARD_EST_H - 16 > 0) {
      // Above.
      left = clampX((cut.left + cut.right) / 2 - CARD_W / 2);
      top = cut.top - CARD_EST_H - 12;
    } else if (cut.right + CARD_W + 16 < vw) {
      // Right of a full-height target.
      left = cut.right + 12;
      top = clampY((cut.top + cut.bottom) / 2 - CARD_EST_H / 2);
    } else {
      // Left of it (or, clamped, over the dim — always visible).
      left = clampX(cut.left - CARD_W - 12);
      top = clampY((cut.top + cut.bottom) / 2 - CARD_EST_H / 2);
    }
    cardStyle = { left, top: clampY(top) };
  }

  const advance = () => {
    dirRef.current = 1;
    if (last) stop(true);
    else next();
  };

  return (
    <div className="tour">
      {cut ? (
        <>
          <div
            className="tour__dim"
            style={{ left: 0, top: 0, width: vw, height: cut.top }}
          />
          <div
            className="tour__dim"
            style={{
              left: 0,
              top: cut.top,
              width: cut.left,
              height: cut.bottom - cut.top,
            }}
          />
          <div
            className="tour__dim"
            style={{
              left: cut.right,
              top: cut.top,
              width: vw - cut.right,
              height: cut.bottom - cut.top,
            }}
          />
          <div
            className="tour__dim"
            style={{
              left: 0,
              top: cut.bottom,
              width: vw,
              height: vh - cut.bottom,
            }}
          />
          <div
            className="tour__ring"
            style={{
              left: cut.left,
              top: cut.top,
              width: cut.right - cut.left,
              height: cut.bottom - cut.top,
            }}
          />
        </>
      ) : (
        <div
          className="tour__dim"
          style={{ left: 0, top: 0, width: vw, height: vh }}
        />
      )}
      <div
        className={`tour__card${cut ? "" : " tour__card--center"}`}
        style={cardStyle}
      >
        <div className="tour__title">{def.title}</div>
        <div className="tour__body">{def.body}</div>
        <div className="tour__foot">
          <span className="tour__dots">
            {TOUR_STEPS.map((_, i) => (
              <span
                key={i}
                className={`tour__dot${i === step ? " tour__dot--on" : ""}`}
              />
            ))}
          </span>
          <span className="tour__actions">
            {!last && (
              <button className="btn btn--ghost" onClick={() => stop(false)}>
                Skip
              </button>
            )}
            {step > 0 && (
              <button
                className="btn btn--ghost"
                onClick={() => {
                  dirRef.current = -1;
                  prev();
                }}
              >
                Back
              </button>
            )}
            <button className="btn btn--primary" onClick={advance}>
              {last ? "Finish" : "Next"}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
