/** One editor group's Monaco surface. Models live in the global registry
 *  (lib/editorModels) keyed by tab id, so every group shares them and a tab
 *  moved between splits keeps its content, undo history, and dirty state.
 *  This component owns only the editor instance and per-group view states.
 *
 *  Dirty is computed from the model's alternative version id vs. its saved
 *  version, so undoing back to the saved state clears the dirty flag. */
import { useEffect, useRef } from "react";

import {
  acquireModel,
  recomputeDirty,
  registerGroupEditor,
} from "../../lib/editorModels";
import {
  conflictDecorations,
  setupMergeConflictActions,
} from "../../lib/mergeConflicts";
import { monaco, setupMonaco } from "../../lib/monaco";
import { useAppStore } from "../../store/appStore";

export function MonacoWrapper({ groupId }: { groupId: number }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const viewStatesRef = useRef<
    Map<string, monaco.editor.ICodeEditorViewState>
  >(new Map());
  const prevActiveRef = useRef<string | null>(null);
  /** The tab whose model this group's editor currently shows. */
  const shownTabRef = useRef<string | null>(null);

  const activeTabId = useAppStore((s) => s.groupActive[groupId] ?? null);

  // Create the editor once.
  useEffect(() => {
    setupMonaco();
    setupMergeConflictActions();
    const host = hostRef.current;
    if (!host) return;

    const editor = monaco.editor.create(host, {
      model: null,
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
      // Ctrl+wheel zooms the EDITOR FONT, only while the cursor is over an
      // editor (Monaco-native — VS Code's editor.mouseWheelZoom). App zoom
      // (Ctrl+=/−) and terminal font sizing are untouched.
      mouseWheelZoom: true,
      // VS Code's pinned block/function headers at the top while scrolling.
      // Falls back to folding/indentation where no symbol provider exists.
      stickyScroll: { enabled: true },
      // The app's own six-entry menu (TextContextMenu) takes over — a richer
      // editor menu is future work.
      contextmenu: false,
    });
    editorRef.current = editor;
    const unregister = registerGroupEditor(editor);

    // Highlight the two sides of any merge-conflict region in the shown model
    // (the accept actions themselves are CodeLenses from setupMergeConflictActions).
    const conflictDecos = editor.createDecorationsCollection();
    const updateConflictDecos = () => {
      const model = editor.getModel();
      conflictDecos.set(model ? conflictDecorations(model) : []);
    };

    // Minimap auto-off in a narrow editor — a minimap on a squeezed pane
    // costs more room than it informs. Re-enabled the moment width returns.
    let minimapOn = true;
    const minimapObs = new ResizeObserver(() => {
      const on = host.clientWidth >= 500;
      if (on !== minimapOn) {
        minimapOn = on;
        editor.updateOptions({ minimap: { enabled: on } });
      }
    });
    minimapObs.observe(host);

    const cursorSub = editor.onDidChangeCursorPosition((event) => {
      const id = shownTabRef.current;
      if (id) {
        useAppStore.getState().setTabCursor(id, {
          line: event.position.lineNumber,
          column: event.position.column,
        });
      }
    });
    const changeSub = editor.onDidChangeModelContent(() => {
      const id = shownTabRef.current;
      if (id) recomputeDirty(id);
      updateConflictDecos();
    });
    const modelSub = editor.onDidChangeModel(() => updateConflictDecos());

    return () => {
      minimapObs.disconnect();
      cursorSub.dispose();
      changeSub.dispose();
      modelSub.dispose();
      unregister();
      editor.dispose();
      editorRef.current = null;
      shownTabRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switch the editor's model when this group's active tab changes.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    if (prevActiveRef.current && editor.getModel()) {
      const state = editor.saveViewState();
      if (state) viewStatesRef.current.set(prevActiveRef.current, state);
    }

    const tab = useAppStore.getState().tabs.find((t) => t.id === activeTabId);
    // Non-file kinds (diff / log / merge / preview / terminal) render their
    // own views; the code editor shows nothing.
    if (!activeTabId || !tab || tab.isBinary || (tab.kind && tab.kind !== "file")) {
      editor.setModel(null);
      prevActiveRef.current = null;
      shownTabRef.current = null;
      return;
    }

    editor.setModel(acquireModel(tab));
    // A truncated (>50 MB) view is READ-ONLY: editing a partial file is wasted
    // work (saving it would amputate the tail, so saving is blocked anyway) —
    // no mainstream editor lets you edit a truncated view (G4 decision).
    editor.updateOptions({
      readOnly: !!tab.truncated,
      readOnlyMessage: {
        value: "Read-only — only the first 50 MB of this file is shown.",
      },
    });
    shownTabRef.current = activeTabId;
    const state = viewStatesRef.current.get(activeTabId);
    if (state) editor.restoreViewState(state);
    // NOTE: no focus here — activating a tab doesn't hand the editor the
    // cursor by itself (a preview open keeps the explorer's keyboard). Focus
    // arrives via editorFocusSeq below when the interaction asked for it.
    prevActiveRef.current = activeTabId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  // Deliberate focus hand-offs (double click, Enter, quick open, tab click,
  // Ctrl+1..3). Every group's wrapper sees the bump — only the ACTIVE group's
  // may answer, or the last-mounted split steals the focus every time.
  const focusSeq = useAppStore((s) => s.editorFocusSeq);
  const lastFocusSeq = useRef(focusSeq);
  useEffect(() => {
    if (focusSeq === lastFocusSeq.current) return;
    lastFocusSeq.current = focusSeq;
    if (useAppStore.getState().activeGroupId === groupId) {
      editorRef.current?.focus();
    }
  }, [focusSeq, groupId]);

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

  return <div className="monaco-host" ref={hostRef} />;
}
