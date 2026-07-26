/** Rendered Markdown preview tab. Shows the *live* content of the source file:
 *  the open editor model when the file is open (so unsaved edits show), else
 *  the snapshot taken when the preview was opened. Rendered with marked,
 *  sanitized with DOMPurify; link clicks are swallowed (the WebView must not
 *  navigate away). Relative `<img>` paths are resolved against the source
 *  file's directory and embedded as `data:` URLs (they can't resolve to the
 *  packaged webview root otherwise); ```mermaid blocks render to SVG with
 *  mermaid, which is lazy-loaded only when a diagram is actually present. */
import { useEffect, useMemo, useRef } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";

import { getTabContent } from "../../lib/activeEditor";
import { dirname } from "../../lib/format";
import { fsReadBase64 } from "../../lib/ipc";
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
          if (!cancelled) img.src = `data:${imageMime(abs)};base64,${b64}`;
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

  return (
    <div
      className="md-preview"
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
