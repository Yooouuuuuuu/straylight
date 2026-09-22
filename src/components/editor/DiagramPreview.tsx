/** Rendered diagram preview tab (D2, …). Shows the *live* content of the
 *  source file — the open editor model when the file is open (unsaved edits
 *  render), else the snapshot taken when the preview opened — compiled by
 *  the HOST's own renderer binary over one-shot stdin→SVG invocations
 *  (diagram.rs; the git/jj doctrine — nothing bundled, no daemons).
 *
 *  The canvas is pan/zoom, image-viewer style: wheel zooms toward the
 *  cursor, drag pans, double-click fits. Renders debounce on a typing
 *  pause; the last good SVG stays up under an error strip whose line:col
 *  references jump the editor; a host without the tool gets an install
 *  card, not an error. Copy image / Export PNG rasterize client-side
 *  (svgToPngBlob) — no host-side Chromium, works for remote files. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";

import { getTabContent } from "../../lib/activeEditor";
import { diagramForTool, svgToPngBlob } from "../../lib/diagrams";
import { revealPosition } from "../../lib/editorModels";
import { basename, dirname } from "../../lib/format";
import { fsWriteBase64, fsWriteFile, renderDiagram } from "../../lib/ipc";
import { useMenuClamp } from "../../hooks/useMenuClamp";
import { useAppStore, type EditorTab } from "../../store/appStore";

interface ViewState {
  scale: number;
  x: number;
  y: number;
  rootOnly: boolean;
}

/** Pan/zoom + board-mode per preview tab, module-lived (only the active
 *  tab's view mounts — same reasoning as the Markdown preview's scroll). */
const viewStates = new Map<string, ViewState>();

const MIN_SCALE = 0.05;
const MAX_SCALE = 8;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(",", 2)[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Split an error message into text and clickable `-:line:col` locations. */
function errorParts(
  text: string,
): { text: string; line?: number; column?: number }[] {
  const out: { text: string; line?: number; column?: number }[] = [];
  const re = /-:(\d+):(\d+)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[0], line: Number(m[1]), column: Number(m[2]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export function DiagramPreview({ tab }: { tab: EditorTab }) {
  // Track the source tab so external reloads re-render the preview (and so
  // error locations can jump into its editor).
  const source = useAppStore((s) =>
    s.tabs.find(
      (t) =>
        (!t.kind || t.kind === "file") &&
        t.connId === tab.connId &&
        t.path === tab.path,
    ),
  );
  const pushNotice = useAppStore((s) => s.pushNotice);
  const lang = diagramForTool(tab.diagramTool);
  const text = source
    ? (getTabContent(source.id) ?? source.content)
    : tab.content;

  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(true);
  const [animated, setAnimated] = useState(false);
  const saved = viewStates.get(tab.id);
  const [rootOnly, setRootOnly] = useState(saved?.rootOnly ?? false);
  const [view, setView] = useState({
    scale: saved?.scale ?? 1,
    x: saved?.x ?? 0,
    y: saved?.y ?? 0,
  });
  const fitted = useRef(saved !== undefined); // a restored view is "fitted"
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const clamp = useMenuClamp(menu?.x ?? 0, menu?.y ?? 0, !!menu);

  const canvasRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  // Serialize renders: one in flight, at most one queued (the newest source
  // always wins — intermediate keystrokes are never rendered).
  const inFlight = useRef(false);
  const queued = useRef<string | null>(null);
  const disposed = useRef(false);

  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
    };
  }, []);

  useEffect(() => {
    viewStates.set(tab.id, { ...view, rootOnly });
  }, [tab.id, view, rootOnly]);

  useEffect(() => {
    if (!lang) return;
    const run = (t: string) => {
      inFlight.current = true;
      setBusy(true);
      void renderDiagram(tab.connId, lang.tool, dirname(tab.path), t, rootOnly)
        .then((r) => {
          if (disposed.current) return;
          setMissing(r.missing);
          if (r.svg !== null) {
            setSvg(r.svg);
            setAnimated(r.animated);
            setError(null);
          } else if (r.error !== null) {
            setError(r.error); // last good SVG stays up underneath
          }
        })
        .catch((e) => {
          if (!disposed.current) setError(String(e));
        })
        .finally(() => {
          inFlight.current = false;
          if (disposed.current) return;
          const next = queued.current;
          queued.current = null;
          if (next !== null) run(next);
          else setBusy(false);
        });
    };
    // Debounce on a typing pause — each render is a real process on the
    // file's host, not worth paying per keystroke.
    const timer = setTimeout(() => {
      if (inFlight.current) queued.current = text;
      else run(text);
    }, 500);
    return () => clearTimeout(timer);
  }, [text, tab.connId, tab.path, lang, rootOnly]);

  /** The rendered SVG's intrinsic size, off the live element. */
  const svgSize = useCallback((): { w: number; h: number } | null => {
    const el = stageRef.current?.querySelector("svg");
    if (!el) return null;
    const w = parseFloat(el.getAttribute("width") ?? "");
    const h = parseFloat(el.getAttribute("height") ?? "");
    if (w > 0 && h > 0) return { w, h };
    const vb = (el.getAttribute("viewBox") ?? "").split(/\s+/).map(Number);
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { w: vb[2], h: vb[3] };
    return null;
  }, []);

  const fit = useCallback(() => {
    const canvas = canvasRef.current;
    const size = svgSize();
    if (!canvas || !size) return;
    const pad = 24;
    const scale = Math.min(
      (canvas.clientWidth - pad) / size.w,
      (canvas.clientHeight - pad) / size.h,
      1, // never enlarge past 1:1 on fit — zoom is for that
    );
    const s = Math.max(MIN_SCALE, scale);
    setView({
      scale: s,
      x: (canvas.clientWidth - size.w * s) / 2,
      y: (canvas.clientHeight - size.h * s) / 2,
    });
  }, [svgSize]);

  // First successful render (with no restored view): fit to the window.
  useLayoutEffect(() => {
    if (svg !== null && !fitted.current) {
      fitted.current = true;
      fit();
    }
  }, [svg, fit]);

  // Wheel zoom toward the cursor. Attached manually: React's onWheel is
  // passive, and preventDefault must win or the page rubber-bands.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setView((v) => {
        const factor = Math.exp(-e.deltaY * 0.0015);
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
        const k = scale / v.scale;
        return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  // Drag to pan (left button on the canvas — toolbar/menu clicks excluded
  // by their own stopPropagation-free hit test below).
  const drag = useRef<{ px: number; py: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { px: e.clientX, py: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    drag.current = { px: e.clientX, py: e.clientY };
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  };

  /** A still SVG for raster outputs: the current render, or — when it's the
   *  animated multi-board form — a fresh root-board render (a PNG can't
   *  animate; the root board is the file's main view). */
  const getStillSvg = useCallback(async (): Promise<string> => {
    if (svg !== null && !animated) return svg;
    if (!lang) throw new Error("unknown diagram type");
    const r = await renderDiagram(
      tab.connId,
      lang.tool,
      dirname(tab.path),
      text,
      true,
    );
    if (r.svg === null) throw new Error(r.error ?? "render failed");
    return r.svg;
  }, [svg, animated, lang, tab.connId, tab.path, text]);

  const copyImage = useCallback(async () => {
    try {
      const blob = await svgToPngBlob(await getStillSvg());
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      pushNotice("info", "Diagram copied as image");
    } catch (e) {
      pushNotice("error", `Copy failed: ${String(e)}`);
    }
  }, [getStillSvg, pushNotice]);

  const exportSvg = useCallback(async () => {
    if (svg === null) return;
    const out = tab.path.replace(/\.[^./\\]+$/, "") + ".svg";
    try {
      await fsWriteFile(tab.connId, out, svg, null);
      pushNotice("info", `Exported ${basename(out)}`);
    } catch (e) {
      pushNotice("error", `Export failed: ${String(e)}`);
    }
  }, [svg, tab.connId, tab.path, pushNotice]);

  const exportPng = useCallback(async () => {
    const out = tab.path.replace(/\.[^./\\]+$/, "") + ".png";
    try {
      const blob = await svgToPngBlob(await getStillSvg());
      await fsWriteBase64(tab.connId, out, await blobToBase64(blob));
      pushNotice("info", `Exported ${basename(out)}`);
    } catch (e) {
      pushNotice("error", `Export failed: ${String(e)}`);
    }
  }, [getStillSvg, tab.connId, tab.path, pushNotice]);

  if (!lang) {
    return <div className="diagram-preview__card">Unknown diagram type.</div>;
  }

  const menuItems: { label: string; run: () => void }[] = [
    { label: "Copy image", run: () => void copyImage() },
    { label: "Export SVG", run: () => void exportSvg() },
    { label: "Export PNG", run: () => void exportPng() },
    { label: "Fit to window", run: fit },
    {
      label: "Zoom 100%",
      run: () => setView((v) => ({ ...v, scale: 1 })),
    },
  ];

  return (
    <div className="diagram-preview">
      {missing && svg === null ? (
        <div className="diagram-preview__card">
          <div className="diagram-preview__cardtitle">
            {lang.label} isn't installed on this host
          </div>
          <p>
            The preview runs the host's own <code>{lang.tool}</code> — nothing
            is bundled. Install it where the file lives, then edit or reopen
            to render:
          </p>
          <pre>{lang.installHint}</pre>
          <p>
            Any standard install location works (anything your login shell's
            PATH can reach is found). Docs: {lang.docsUrl}
          </p>
        </div>
      ) : (
        <>
          <div className="diagram-preview__toolbar">
            <button
              className="diagram-preview__tool"
              title="Reset zoom to 100%"
              onClick={() => setView((v) => ({ ...v, scale: 1 }))}
            >
              {Math.round(view.scale * 100)}%
            </button>
            <button
              className="diagram-preview__tool"
              title="Fit to window (double-click the canvas)"
              onClick={fit}
            >
              Fit
            </button>
            {(animated || rootOnly) && (
              <button
                className={`diagram-preview__tool${rootOnly ? " diagram-preview__tool--on" : ""}`}
                title="Multi-board file: show only the root board instead of the animated set"
                onClick={() => {
                  fitted.current = false; // re-fit for the new content
                  setRootOnly((r) => !r);
                }}
              >
                Root only
              </button>
            )}
            <span className="diagram-preview__spacer" />
            {busy && <span className="diagram-preview__busy">…</span>}
            <button
              className="diagram-preview__tool"
              title="Copy the diagram to the clipboard as an image"
              onClick={() => void copyImage()}
            >
              Copy image
            </button>
            <button
              className="diagram-preview__tool"
              title={`Save beside the source as ${basename(tab.path).replace(/\.[^.]+$/, "")}.svg`}
              onClick={() => void exportSvg()}
            >
              SVG
            </button>
            <button
              className="diagram-preview__tool"
              title={`Save beside the source as ${basename(tab.path).replace(/\.[^.]+$/, "")}.png`}
              onClick={() => void exportPng()}
            >
              PNG
            </button>
          </div>
          {error && (
            <div className="diagram-preview__error">
              {errorParts(error).map((p, i) =>
                p.line !== undefined ? (
                  <button
                    key={i}
                    className="diagram-preview__errloc"
                    title="Jump to this location in the editor"
                    onClick={() => {
                      if (
                        !source ||
                        !revealPosition(source.id, p.line ?? 1, p.column ?? 1)
                      ) {
                        pushNotice("info", "Open the source file to jump to the error.");
                      }
                    }}
                  >
                    {p.text}
                  </button>
                ) : (
                  <span key={i}>{p.text}</span>
                ),
              )}
            </div>
          )}
          <div
            className="diagram-preview__canvas"
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={fit}
            onContextMenu={(e) => {
              e.preventDefault();
              if (svg !== null) setMenu({ x: e.clientX, y: e.clientY });
            }}
            onClick={(e) => {
              // Never let a diagram link navigate the app's WebView away.
              const a = (e.target as HTMLElement).closest("a");
              if (a) e.preventDefault();
            }}
          >
            {svg !== null ? (
              <div
                className="diagram-preview__stage"
                ref={stageRef}
                style={{
                  transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                }}
                dangerouslySetInnerHTML={{
                  __html: DOMPurify.sanitize(svg, {
                    USE_PROFILES: { svg: true, svgFilters: true },
                  }),
                }}
              />
            ) : (
              !error && (
                <div className="diagram-preview__card">
                  {busy ? "Rendering…" : "Nothing to render."}
                </div>
              )
            )}
          </div>
          {menu && (
            <>
              <div
                className="menu-backdrop"
                style={{ zIndex: 1199 }}
                onMouseDown={() => setMenu(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu(null);
                }}
              />
              <div
                className="ctx-menu"
                ref={clamp.ref}
                style={{ left: clamp.left, top: clamp.top }}
                role="menu"
              >
                {menuItems.map((it) => (
                  <button
                    key={it.label}
                    className="terminal-menu__item"
                    onClick={() => {
                      setMenu(null);
                      it.run();
                    }}
                  >
                    {it.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
