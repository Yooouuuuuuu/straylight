/** Hosts a single Monaco editor instance. Phase 1 is read-only (code viewing);
 *  editing and saving arrive in Phase 2. The editor is created once and its
 *  model is swapped as the open file changes. */
import { useEffect, useRef } from "react";

import { DRACULA_THEME, monaco, setupMonaco } from "../../lib/monaco";
import { useAppStore, type OpenFile } from "../../store/appStore";

const LIGHTWEIGHT_BYTES = 50 * 1024 * 1024;

export function MonacoWrapper({ file }: { file: OpenFile }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const setCursor = useAppStore((s) => s.setCursor);

  // Create the editor once on mount.
  useEffect(() => {
    setupMonaco();
    const host = hostRef.current;
    if (!host) return;

    const lightweight = file.size >= LIGHTWEIGHT_BYTES;
    const editor = monaco.editor.create(host, {
      value: file.content,
      language: lightweight ? "plaintext" : file.language,
      theme: DRACULA_THEME,
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      fontFamily: "'Fira Code', 'Cascadia Code', monospace",
      fontLigatures: true,
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: !lightweight },
      folding: !lightweight,
      largeFileOptimizations: true,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      renderWhitespace: "selection",
      cursorBlinking: "smooth",
      guides: { indentation: true },
    });
    editorRef.current = editor;

    const sub = editor.onDidChangeCursorPosition((event) => {
      setCursor({
        line: event.position.lineNumber,
        column: event.position.column,
      });
    });

    return () => {
      sub.dispose();
      editor.dispose();
      editorRef.current = null;
    };
    // Create once; subsequent file changes are handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap content/language when the open file changes.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const lightweight = file.size >= LIGHTWEIGHT_BYTES;
    const model = editor.getModel();
    if (model) {
      if (model.getValue() !== file.content) {
        editor.setValue(file.content);
      }
      monaco.editor.setModelLanguage(
        model,
        lightweight ? "plaintext" : file.language,
      );
    } else {
      editor.setValue(file.content);
    }
    editor.setScrollTop(0);
    setCursor({ line: 1, column: 1 });
  }, [file.path, file.content, file.language, file.size, setCursor]);

  return <div className="monaco-host" ref={hostRef} />;
}
