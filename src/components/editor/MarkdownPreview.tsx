/** Rendered Markdown preview tab. Shows the *live* content of the source file:
 *  the open editor model when the file is open (so unsaved edits show), else
 *  the snapshot taken when the preview was opened. Rendered with marked and
 *  sanitized with DOMPurify; link clicks are swallowed (the WebView must not
 *  navigate away). Relative images aren't resolved in v1. */
import { useMemo } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";

import { getTabContent } from "../../lib/activeEditor";
import { useAppStore, type EditorTab } from "../../store/appStore";

export function MarkdownPreview({ tab }: { tab: EditorTab }) {
  // Track the source tab so external reloads re-render the preview.
  const source = useAppStore((s) =>
    s.tabs.find(
      (t) => (!t.kind || t.kind === "file") && t.connId === tab.connId && t.path === tab.path,
    ),
  );

  const html = useMemo(() => {
    const markdown =
      (source ? (getTabContent(source.id) ?? source.content) : null) ?? tab.content;
    const raw = marked.parse(markdown, { async: false });
    return DOMPurify.sanitize(raw);
  }, [source, source?.content, tab.content]);

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
        className="md-preview__body"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
