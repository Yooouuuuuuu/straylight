/** Rendered diagram preview tab (D2, …). Shows the *live* content of the
 *  source file — the open editor model when the file is open (unsaved edits
 *  render), else the snapshot taken when the preview opened — compiled by
 *  the HOST's own renderer binary over one-shot stdin→SVG invocations
 *  (diagram.rs; the git/jj doctrine — nothing bundled, no daemons). Renders
 *  debounce on a typing pause; the last good SVG stays up under an error
 *  strip, and a host without the tool gets an install card, not an error. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";

import { getTabContent } from "../../lib/activeEditor";
import { diagramForTool } from "../../lib/diagrams";
import { dirname } from "../../lib/format";
import { renderDiagram } from "../../lib/ipc";
import { useAppStore, type EditorTab } from "../../store/appStore";

/** Scroll position per preview tab, module-lived (same reasoning as the
 *  Markdown preview: only the active tab's view mounts). */
const scrollTops = new Map<string, number>();

export function DiagramPreview({ tab }: { tab: EditorTab }) {
  // Track the source tab so external reloads re-render the preview.
  const source = useAppStore((s) =>
    s.tabs.find(
      (t) =>
        (!t.kind || t.kind === "file") &&
        t.connId === tab.connId &&
        t.path === tab.path,
    ),
  );
  const lang = diagramForTool(tab.diagramTool);
  const text = source
    ? (getTabContent(source.id) ?? source.content)
    : tab.content;

  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
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
    if (!lang) return;
    const run = (text: string) => {
      inFlight.current = true;
      setBusy(true);
      void renderDiagram(tab.connId, lang.tool, dirname(tab.path), text)
        .then((r) => {
          if (disposed.current) return;
          setMissing(r.missing);
          if (r.svg !== null) {
            setSvg(r.svg);
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
  }, [text, tab.connId, tab.path, lang]);

  // Restore the saved scroll position once the first render has real height.
  const restored = useRef(false);
  useLayoutEffect(() => {
    restored.current = false;
  }, [tab.id]);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || restored.current || svg === null) return;
    restored.current = true;
    el.scrollTop = scrollTops.get(tab.id) ?? 0;
  }, [svg, tab.id]);

  if (!lang) {
    return <div className="diagram-preview__card">Unknown diagram type.</div>;
  }

  return (
    <div
      className="diagram-preview"
      ref={rootRef}
      onScroll={(e) => scrollTops.set(tab.id, e.currentTarget.scrollTop)}
    >
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
          {error && <div className="diagram-preview__error">{error}</div>}
          {svg !== null && (
            <div
              className="diagram-preview__body"
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(svg, {
                  USE_PROFILES: { svg: true, svgFilters: true },
                }),
              }}
            />
          )}
          {svg === null && !error && (
            <div className="diagram-preview__card">
              {busy ? "Rendering…" : "Nothing to render."}
            </div>
          )}
        </>
      )}
    </div>
  );
}
