/** Tip — a themed tooltip drawn ABOVE its anchor element.
 *
 *  Native `title` tooltips render at the OS pointer position, so a large
 *  accessibility cursor sits on top of them (and they ignore the app theme).
 *  This one anchors to the element instead: centered above it (below when
 *  there's no room), clamped to the viewport, pointer-events none.
 *
 *  Wrap exactly ONE element; its own mouse handlers are preserved. Note that
 *  disabled buttons fire no mouse events — a disabled anchor shows no tip.
 */
import {
  cloneElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";

const SHOW_DELAY_MS = 450;

interface AnchorProps {
  onMouseEnter?: (e: ReactMouseEvent<HTMLElement>) => void;
  onMouseLeave?: (e: ReactMouseEvent<HTMLElement>) => void;
  onMouseDown?: (e: ReactMouseEvent<HTMLElement>) => void;
}

export function Tip({
  label,
  children,
}: {
  label: string;
  children: ReactElement<AnchorProps>;
}) {
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(
    null,
  );
  const timer = useRef<number | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);

  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const hide = () => {
    clear();
    setPos(null);
  };
  const show = (e: ReactMouseEvent<HTMLElement>) => {
    const el = e.currentTarget;
    clear();
    timer.current = window.setTimeout(() => {
      const r = el.getBoundingClientRect();
      const below = r.top < 34; // no room above — flip under the anchor
      setPos({ x: r.left + r.width / 2, y: below ? r.bottom : r.top, below });
    }, SHOW_DELAY_MS);
  };
  useEffect(() => clear, []);

  // Keep the rendered tip on-screen: nudge it back inside the viewport once
  // its real width is known (the SC panel hugs the right edge).
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el || !pos) return;
    const half = el.offsetWidth / 2 + 6;
    const clamped = Math.min(Math.max(pos.x, half), window.innerWidth - half);
    if (clamped !== pos.x) el.style.left = `${clamped}px`;
  }, [pos]);

  const child = cloneElement(children, {
    onMouseEnter: (e: ReactMouseEvent<HTMLElement>) => {
      children.props.onMouseEnter?.(e);
      show(e);
    },
    onMouseLeave: (e: ReactMouseEvent<HTMLElement>) => {
      children.props.onMouseLeave?.(e);
      hide();
    },
    onMouseDown: (e: ReactMouseEvent<HTMLElement>) => {
      children.props.onMouseDown?.(e);
      hide();
    },
  });

  return (
    <>
      {child}
      {pos &&
        createPortal(
          <div
            ref={tipRef}
            className={`tip ${pos.below ? "tip--below" : ""}`}
            style={{ left: pos.x, top: pos.y }}
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  );
}
