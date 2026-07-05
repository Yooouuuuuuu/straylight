/** The editor surface. Holds one Monaco editor and one model per open tab, so
 *  each tab keeps its own content, undo history, cursor, and scroll. Stays
 *  mounted across tab/binary changes so models aren't lost.
 *
 *  Dirty is computed from the model's alternative version id vs. its saved
 *  version, so undoing back to the saved state clears the dirty flag. */
import { useEffect, useRef } from "react";

import { setEditorBridge } from "../../lib/activeEditor";
import {
  conflictDecorations,
  setupMergeConflictActions,
} from "../../lib/mergeConflicts";
import { DRACULA_THEME, monaco, setupMonaco } from "../../lib/monaco";
import { useAppStore } from "../../store/appStore";

const LIGHTWEIGHT_BYTES = 50 * 1024 * 1024;

export function MonacoWrapper() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelsRef = useRef<Map<string, monaco.editor.ITextModel>>(new Map());
  const viewStatesRef = useRef<
    Map<string, monaco.editor.ICodeEditorViewState>
  >(new Map());
  /** Per-tab "saved" alternative version id, for dirty detection. */
  const savedVersionRef = useRef<Map<string, number>>(new Map());
  const prevActiveRef = useRef<string | null>(null);

  const activeTabId = useAppStore((s) => s.activeTabId);
  const tabs = useAppStore((s) => s.tabs);

  // Create the editor once.
  useEffect(() => {
    setupMonaco();
    setupMergeConflictActions();
    const host = hostRef.current;
    if (!host) return;

    const editor = monaco.editor.create(host, {
      model: null,
      theme: DRACULA_THEME,
      automaticLayout: true,
      fontFamily: "'Fira Code', 'Cascadia Code', monospace",
      fontLigatures: true,
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: true },
      largeFileOptimizations: true,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      renderWhitespace: "selection",
      cursorBlinking: "smooth",
      guides: { indentation: true },
    });
    editorRef.current = editor;

    const models = modelsRef.current;
    const savedVersions = savedVersionRef.current;

    const recomputeDirty = (tabId: string) => {
      const model = models.get(tabId);
      if (!model) return;
      const saved = savedVersions.get(tabId) ?? model.getAlternativeVersionId();
      useAppStore
        .getState()
        .setTabDirty(tabId, model.getAlternativeVersionId() !== saved);
    };

    setEditorBridge({
      getContent: (id) => models.get(id)?.getValue() ?? null,
      getVersionId: (id) => models.get(id)?.getAlternativeVersionId() ?? null,
      markSavedVersion: (id, versionId) => {
        savedVersions.set(id, versionId);
        recomputeDirty(id);
      },
      setContent: (id, content) => {
        const model = models.get(id);
        if (!model) return; // never activated — the store's tab.content seeds it
        const active = editor.getModel() === model;
        // Follow the tail: if the view was pinned to the bottom (log watching),
        // keep it there after the reload; otherwise restore the old position.
        const atBottom =
          active &&
          editor.getScrollTop() + editor.getLayoutInfo().height >=
            editor.getScrollHeight() - 2 * 20;
        const viewState = active ? editor.saveViewState() : null;
        model.setValue(content);
        savedVersions.set(id, model.getAlternativeVersionId());
        recomputeDirty(id);
        if (active && viewState) editor.restoreViewState(viewState);
        if (atBottom) editor.revealLine(model.getLineCount());
      },
    });

    // Highlight the two sides of any merge-conflict region in the active model
    // (the accept actions themselves are CodeLenses from setupMergeConflictActions).
    const conflictDecos = editor.createDecorationsCollection();
    const updateConflictDecos = () => {
      const model = editor.getModel();
      conflictDecos.set(model ? conflictDecorations(model) : []);
    };

    const cursorSub = editor.onDidChangeCursorPosition((event) => {
      const id = useAppStore.getState().activeTabId;
      if (id) {
        useAppStore.getState().setTabCursor(id, {
          line: event.position.lineNumber,
          column: event.position.column,
        });
      }
    });
    const changeSub = editor.onDidChangeModelContent(() => {
      const id = useAppStore.getState().activeTabId;
      if (id) recomputeDirty(id);
      updateConflictDecos();
    });
    const modelSub = editor.onDidChangeModel(() => updateConflictDecos());

    return () => {
      cursorSub.dispose();
      changeSub.dispose();
      modelSub.dispose();
      setEditorBridge(null);
      models.forEach((model) => model.dispose());
      models.clear();
      savedVersions.clear();
      editor.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switch the editor's model when the active tab changes.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    if (prevActiveRef.current && editor.getModel()) {
      const state = editor.saveViewState();
      if (state) viewStatesRef.current.set(prevActiveRef.current, state);
    }

    const tab = useAppStore.getState().tabs.find((t) => t.id === activeTabId);
    // Diff/log tabs render their own views; the code editor shows nothing.
    // Non-file kinds (diff / log / merge / preview) render their own views.
    if (!activeTabId || !tab || tab.isBinary || (tab.kind && tab.kind !== "file")) {
      editor.setModel(null);
      prevActiveRef.current = null;
      return;
    }

    let model = modelsRef.current.get(activeTabId);
    if (!model) {
      const lightweight = tab.size >= LIGHTWEIGHT_BYTES;
      model = monaco.editor.createModel(
        tab.content,
        lightweight ? "plaintext" : tab.language,
      );
      modelsRef.current.set(activeTabId, model);
      savedVersionRef.current.set(activeTabId, model.getAlternativeVersionId());
    }
    editor.setModel(model);
    const state = viewStatesRef.current.get(activeTabId);
    if (state) editor.restoreViewState(state);
    editor.focus();
    prevActiveRef.current = activeTabId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  // Reveal a target line once its file's model is active (from search results).
  const revealTarget = useAppStore((s) => s.revealTarget);
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !revealTarget) return;
    const tab = useAppStore.getState().tabs.find((t) => t.id === activeTabId);
    if (
      !tab ||
      tab.connId !== revealTarget.connId ||
      tab.path !== revealTarget.path ||
      !editor.getModel()
    ) {
      return;
    }
    const line = Math.max(1, revealTarget.line);
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
    useAppStore.getState().setRevealTarget(null);
  }, [revealTarget, activeTabId]);

  // Dispose models for tabs that were closed.
  useEffect(() => {
    const ids = new Set(tabs.map((t) => t.id));
    for (const [id, model] of modelsRef.current) {
      if (!ids.has(id)) {
        model.dispose();
        modelsRef.current.delete(id);
        viewStatesRef.current.delete(id);
        savedVersionRef.current.delete(id);
      }
    }
  }, [tabs]);

  return <div className="monaco-host" ref={hostRef} />;
}
