/** Rendered Markdown preview tab. Shows the *live* content of the source file:
 *  the open editor model when the file is open (so unsaved edits show), else
 *  the snapshot taken when the preview was opened. Rendered with marked,
 *  sanitized with DOMPurify; link clicks are swallowed (the WebView must not
 *  navigate away). Relative `<img>` paths are resolved against the source
 *  file's directory and embedded as `data:` URLs (they can't resolve to the
 *  packaged webview root otherwise); ```mermaid blocks render to SVG with
 *  mermaid, which is lazy-loaded only when a diagram is actually present. */
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";

import { getTabContent } from "../../lib/activeEditor";
import { DIAGRAM_LANGS } from "../../lib/diagrams";
import { dirname } from "../../lib/format";
import { fsReadBase64, renderDiagram } from "../../lib/ipc";
import { useAppStore, type EditorTab } from "../../store/appStore";

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
  ico: "image/x-icon",
};

function imageMime(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return IMAGE_MIME[ext] ?? "application/octet-stream";
}

/** Scroll position per preview tab, module-lived: only the active tab's view
 *  mounts (EditorArea), so switching away unmounts the preview — without this
 *  every return landed back at the top. */
const scrollTops = new Map<string, number>();

/** Resolve a markdown image `src` against the source file's directory. Returns
 *  null for things we shouldn't touch (absolute URLs, data URLs). */
function resolveImagePath(baseDir: string, src: string): string | null {
  if (!src || /^(https?:|data:)/i.test(src)) return null;
  const cleaned = src.replace(/^\.\//, "");
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(cleaned)) return cleaned; // already absolute
  return baseDir ? `${baseDir}/${cleaned}` : cleaned;
}

export function MarkdownPreview({ tab }: { tab: EditorTab }) {
  // Track the source tab so external reloads re-render the preview.
  const source = useAppStore((s) =>
    s.tabs.find(
      (t) => (!t.kind || t.kind === "file") && t.connId === tab.connId && t.path === tab.path,
    ),
  );
  const bodyRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** Restore target still being enforced (null once the user takes over). */
  const pendingScrollRef = useRef<number | null>(null);

  // Restore the saved position on mount. Async content (data-URL images,
  // mermaid SVGs) lands AFTER this and grows the page — a position past the
  // not-yet-grown height gets clamped by the browser — so the target is kept
  // in pendingScrollRef and re-applied on each late load (reapplyScroll)
  // until the user actually interacts, which makes their position the truth.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const saved = scrollTops.get(tab.id) ?? 0;
    pendingScrollRef.current = saved > 0 ? saved : null;
    el.scrollTop = saved;
    const takeOver = () => {
      pendingScrollRef.current = null;
    };
    el.addEventListener("wheel", takeOver, { passive: true });
    el.addEventListener("pointerdown", takeOver);
    return () => {
      el.removeEventListener("wheel", takeOver);
      el.removeEventListener("pointerdown", takeOver);
    };
  }, [tab.id]);

  const reapplyScroll = () => {
    const el = rootRef.current;
    if (el && pendingScrollRef.current !== null) {
      el.scrollTop = pendingScrollRef.current;
    }
  };

  const html = useMemo(() => {
    const markdown =
      (source ? (getTabContent(source.id) ?? source.content) : null) ?? tab.content;
    const raw = marked.parse(markdown, { async: false });
    return DOMPurify.sanitize(raw);
  }, [source, source?.content, tab.content]);

  const srcPath = source?.path ?? tab.path;

  // Resolve relative <img> paths → data URLs read from the source's host.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const baseDir = dirname(srcPath);
    let cancelled = false;
    el.querySelectorAll("img").forEach((img) => {
      const abs = resolveImagePath(baseDir, img.getAttribute("src") ?? "");
      if (!abs) return;
      void fsReadBase64(tab.connId, abs)
        .then((b64) => {
          if (cancelled) return;
          // The decoded image grows the page — hold the restored scroll spot.
          img.addEventListener("load", reapplyScroll, { once: true });
          img.src = `data:${imageMime(abs)};base64,${b64}`;
        })
        .catch(() => {}); // a missing image just stays broken
    });
    return () => {
      cancelled = true;
    };
  }, [html, srcPath, tab.connId]);

  // Render ```mermaid blocks to SVG. Mermaid is heavy, so it's lazy-loaded and
  // only when a diagram is actually on the page.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const blocks = Array.from(
      el.querySelectorAll<HTMLElement>("code.language-mermaid"),
    );
    if (!blocks.length) return;
    let cancelled = false;
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          securityLevel: "strict",
        });
        for (let i = 0; i < blocks.length; i++) {
          if (cancelled) return;
          const code = blocks[i];
          try {
            const { svg } = await mermaid.render(
              `md-mermaid-${i}`,
              code.textContent ?? "",
            );
            if (cancelled) return;
            const wrap = document.createElement("div");
            wrap.className = "md-preview__mermaid";
            wrap.innerHTML = svg;
            (code.closest("pre") ?? code).replaceWith(wrap);
            reapplyScroll(); // the SVG resized the page — hold the spot
          } catch {
            // leave the raw code block in place on a render error
          }
        }
      } catch {
        // mermaid failed to load — leave the blocks as code
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [html]);

  // Render ```d2 (and future diagram-language) fences through the HOST's own
  // renderer — the same one-shot stdin→SVG engine as the diagram preview tab
  // (diagram.rs). A failed or missing render just leaves the code block as
  // code, exactly like a mermaid error.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    let cancelled = false;
    const dir = dirname(srcPath);
    for (const lang of DIAGRAM_LANGS) {
      const blocks = Array.from(
        el.querySelectorAll<HTMLElement>(`code.language-${lang.fence}`),
      );
      for (const code of blocks) {
        void renderDiagram(tab.connId, lang.tool, dir, code.textContent ?? "")
          .then((r) => {
            if (cancelled || r.svg === null) return;
            const wrap = document.createElement("div");
            wrap.className = "md-preview__mermaid";
            wrap.innerHTML = DOMPurify.sanitize(r.svg, {
              USE_PROFILES: { svg: true, svgFilters: true },
            });
            (code.closest("pre") ?? code).replaceWith(wrap);
            reapplyScroll(); // the SVG resized the page — hold the spot
          })
          .catch(() => {});
      }
    }
    return () => {
      cancelled = true;
    };
  }, [html, srcPath, tab.connId]);

  return (
    <div
      className="md-preview"
      ref={rootRef}
      onScroll={(e) => scrollTops.set(tab.id, e.currentTarget.scrollTop)}
      onClick={(e) => {
        // Never let a link navigate the app's WebView away.
        const a = (e.target as HTMLElement).closest("a");
        if (a) e.preventDefault();
      }}
    >
      <div
        ref={bodyRef}
        className="md-preview__body"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
