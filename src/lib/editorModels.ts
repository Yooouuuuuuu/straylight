/** Global Monaco model registry, shared by all editor groups. A tab's model is
 *  keyed by tab id and lives here — NOT in a component — so a tab moved to
 *  another split keeps its content, undo history, and dirty state. The
 *  activeEditor bridge (save/reload plumbing) is installed once over this
 *  registry and works regardless of which group currently shows the tab. */
import { setEditorBridge } from "./activeEditor";
import { monaco } from "./monaco";
import { useAppStore, type EditorTab } from "../store/appStore";

const LIGHTWEIGHT_BYTES = 50 * 1024 * 1024;

const models = new Map<string, monaco.editor.ITextModel>();
const savedVersions = new Map<string, number>();
/** Live group editors, so setContent can find the one showing a model. */
const editors = new Set<monaco.editor.IStandaloneCodeEditor>();
let bridgeInstalled = false;

/** Called after every dirty recompute (i.e. every content change). The drafts
 *  module registers here — it imports us, so we can't import it back. */
let onEdited: ((tabId: string) => void) | null = null;
export function setOnModelEdited(cb: (tabId: string) => void): void {
  onEdited = cb;
}

export function recomputeDirty(tabId: string): void {
  const model = models.get(tabId);
  if (!model) return;
  const saved = savedVersions.get(tabId) ?? model.getAlternativeVersionId();
  useAppStore
    .getState()
    .setTabDirty(tabId, model.getAlternativeVersionId() !== saved);
  onEdited?.(tabId);
}

/** The tab's model, created from its seed content on first use. */
export function acquireModel(tab: EditorTab): monaco.editor.ITextModel {
  let model = models.get(tab.id);
  if (!model) {
    const lightweight = tab.size >= LIGHTWEIGHT_BYTES;
    model = monaco.editor.createModel(
      tab.content,
      lightweight ? "plaintext" : tab.language,
    );
    models.set(tab.id, model);
    savedVersions.set(tab.id, model.getAlternativeVersionId());
  }
  return model;
}

/** Mark a tab dirty regardless of its version history — used when a
 *  background save turns out NOT to have landed (hash guard refused / commit
 *  failed): the optimistic "saved" state was wrong, and no undo position may
 *  count as saved until a real save records one. */
export function markTabUnsaved(tabId: string): void {
  if (!models.has(tabId)) return;
  savedVersions.set(tabId, -1);
  recomputeDirty(tabId);
}

/** Lay restored-draft text over a tab's model as ONE undoable edit. The saved
 *  version stays at the disk-content seed, so the tab reads dirty and Ctrl+Z
 *  walks back to the original — where the dirty flag clears, exactly like
 *  undoing ordinary edits. Returns false when the model doesn't exist (the
 *  caller acquires it first). */
export function applyDraftContent(tabId: string, content: string): boolean {
  const model = models.get(tabId);
  if (!model) return false;
  model.pushEditOperations(
    [],
    [{ range: model.getFullModelRange(), text: content }],
    () => null,
  );
  recomputeDirty(tabId);
  return true;
}

/** Convert a tab's line endings in place (undoable edit; marks it dirty —
 *  save to persist). Returns false if the model was never created. */
export function setTabEol(tabId: string, eol: "LF" | "CRLF"): boolean {
  const model = models.get(tabId);
  if (!model) return false;
  model.setEOL(
    eol === "LF"
      ? monaco.editor.EndOfLineSequence.LF
      : monaco.editor.EndOfLineSequence.CRLF,
  );
  recomputeDirty(tabId);
  return true;
}

/** Dispose models whose tabs are gone. */
export function pruneModels(liveIds: Set<string>): void {
  for (const [id, model] of models) {
    if (!liveIds.has(id)) {
      model.dispose();
      models.delete(id);
      savedVersions.delete(id);
    }
  }
}

function editorShowing(
  model: monaco.editor.ITextModel,
): monaco.editor.IStandaloneCodeEditor | null {
  for (const e of editors) if (e.getModel() === model) return e;
  return null;
}

/** The registered group editor whose DOM contains `node` — how the custom
 *  right-click menu resolves which editor was clicked (Monaco's own menu is
 *  disabled in the file editors). */
export function editorAtNode(
  node: Node,
): monaco.editor.IStandaloneCodeEditor | null {
  for (const e of editors) {
    if (e.getContainerDomNode()?.contains(node)) return e;
  }
  return null;
}

/** Focus the editor showing `tabId` and open Monaco's find widget (Ctrl+F —
 *  works from anywhere, e.g. with focus still in the explorer after a
 *  single-click preview). False if the tab has no live editor. */
export function openFindIn(tabId: string): boolean {
  const model = models.get(tabId);
  const editor = model ? editorShowing(model) : null;
  if (!editor) return false;
  editor.focus();
  void editor.getAction("actions.find")?.run();
  return true;
}

/** Track a group's editor instance. Returns the unregister function. Installs
 *  the save/reload bridge on first registration (module-lived thereafter). */
export function registerGroupEditor(
  editor: monaco.editor.IStandaloneCodeEditor,
): () => void {
  editors.add(editor);
  if (!bridgeInstalled) {
    bridgeInstalled = true;
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
        const shown = editorShowing(model);
        // Follow the tail: if the view was pinned to the bottom (log watching),
        // keep it there after the reload; otherwise restore the old position.
        const atBottom =
          !!shown &&
          shown.getScrollTop() + shown.getLayoutInfo().height >=
            shown.getScrollHeight() - 2 * 20;
        const viewState = shown ? shown.saveViewState() : null;
        // Replace via an edit operation (NOT setValue) so the undo history
        // survives an external reload — Ctrl+Z steps back across it.
        model.pushEditOperations(
          [],
          [{ range: model.getFullModelRange(), text: content }],
          () => null,
        );
        savedVersions.set(id, model.getAlternativeVersionId());
        recomputeDirty(id);
        if (shown && viewState) shown.restoreViewState(viewState);
        if (shown && atBottom) shown.revealLine(model.getLineCount());
      },
    });
  }
  return () => {
    editors.delete(editor);
  };
}
