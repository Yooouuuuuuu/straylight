/** A read-only Monaco diff editor for a "diff" tab: the file's base version
 *  (git `HEAD:` / jj `@-`) on the left, the working copy on the right. Mounted
 *  only while a diff tab is active; its two models are recreated from the tab's
 *  stored content when the active diff tab changes. */
import { useEffect, useRef } from "react";

import { DRACULA_THEME, monaco, setupMonaco } from "../../lib/monaco";
import type { EditorTab } from "../../store/appStore";

export function MonacoDiffWrapper({ tab }: { tab: EditorTab }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);

  useEffect(() => {
    setupMonaco();
    const host = hostRef.current;
    if (!host) return;
    const editor = monaco.editor.createDiffEditor(host, {
      theme: DRACULA_THEME,
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      fontFamily: "'Fira Code', 'Cascadia Code', monospace",
      fontLigatures: true,
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    });
    editorRef.current = editor;
    return () => {
      const model = editor.getModel();
      model?.original.dispose();
      model?.modified.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  // (Re)build the two models whenever the active diff tab or its content changes.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || tab.isBinary) return;
    const prev = editor.getModel();
    const original = monaco.editor.createModel(tab.diffBase ?? "", tab.language);
    const modified = monaco.editor.createModel(tab.content, tab.language);
    editor.setModel({ original, modified });
    prev?.original.dispose();
    prev?.modified.dispose();
  }, [tab.id, tab.diffBase, tab.content, tab.language, tab.isBinary]);

  if (tab.isBinary) {
    return (
      <div className="diff-binary">Binary file — diff not shown.</div>
    );
  }
  return <div className="monaco-host monaco-host--diff" ref={hostRef} />;
}
