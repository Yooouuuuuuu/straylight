/** 3-way merge editor for a conflicted file: read-only **Current (ours)** and
 *  **Incoming (theirs)** panes on top (each side fully resolved one way), and an
 *  editable **Result** below seeded with the conflict markers. Each conflict in
 *  the Result gets the Accept Current / Incoming / Both CodeLenses (the global
 *  provider); the header tracks how many remain, offers accept-all shortcuts,
 *  and **Complete merge** saves + stages (git) once everything is resolved. */
import { useEffect, useRef, useState } from "react";

import {
  acceptConflict,
  conflictDecorations,
  findConflicts,
  resolveConflictsInText,
} from "../../lib/mergeConflicts";
import { monaco, setupMonaco } from "../../lib/monaco";
import { fsWriteFile, vcsStage } from "../../lib/ipc";
import { useAppStore, type EditorTab } from "../../store/appStore";
import { useVcsStore } from "../../store/vcsStore";

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

export function MergeEditor({ tab }: { tab: EditorTab }) {
  const oursRef = useRef<HTMLDivElement | null>(null);
  const theirsRef = useRef<HTMLDivElement | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const editorsRef = useRef<monaco.editor.IStandaloneCodeEditor[]>([]);
  const resultModelRef = useRef<monaco.editor.ITextModel | null>(null);

  const [remaining, setRemaining] = useState(0);
  const [saving, setSaving] = useState(false);
  const modifiedRef = useRef(tab.modified);

  useEffect(() => {
    setupMonaco();
    const hosts = [oursRef.current, theirsRef.current, resultRef.current];
    if (hosts.some((h) => !h)) return;

    const shared = {
      automaticLayout: true,
      fontFamily: "'Fira Code', 'Cascadia Code', monospace",
      fontLigatures: true,
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      // Ctrl+wheel font zoom, same as the file editor (shared zoom level).
      mouseWheelZoom: true,
    } as const;

    const oursModel = monaco.editor.createModel(
      resolveConflictsInText(tab.content, "current"),
      tab.language,
    );
    const theirsModel = monaco.editor.createModel(
      resolveConflictsInText(tab.content, "incoming"),
      tab.language,
    );
    const resultModel = monaco.editor.createModel(tab.content, tab.language);
    resultModelRef.current = resultModel;

    const ours = monaco.editor.create(oursRef.current!, {
      ...shared,
      model: oursModel,
      readOnly: true,
    });
    const theirs = monaco.editor.create(theirsRef.current!, {
      ...shared,
      model: theirsModel,
      readOnly: true,
    });
    const result = monaco.editor.create(resultRef.current!, {
      ...shared,
      model: resultModel,
    });
    editorsRef.current = [ours, theirs, result];

    const decos = result.createDecorationsCollection();
    const update = () => {
      setRemaining(findConflicts(resultModel).filter((r) => r.sep !== undefined).length);
      decos.set(conflictDecorations(resultModel));
    };
    update();
    const sub = resultModel.onDidChangeContent(update);

    return () => {
      sub.dispose();
      for (const e of editorsRef.current) e.dispose();
      editorsRef.current = [];
      oursModel.dispose();
      theirsModel.dispose();
      resultModel.dispose();
      resultModelRef.current = null;
    };
    // The tab is recreated per file (id includes the path); content is a seed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  const acceptAll = (choice: "current" | "incoming") => {
    const model = resultModelRef.current;
    if (!model) return;
    for (let guard = 0; guard < 5000; guard += 1) {
      const region = findConflicts(model).find((r) => r.sep !== undefined);
      if (!region) break;
      acceptConflict(model, region, choice);
    }
  };

  const save = async (): Promise<boolean> => {
    const model = resultModelRef.current;
    if (!model) return false;
    setSaving(true);
    try {
      const res = await fsWriteFile(tab.connId, tab.path, model.getValue(), null);
      modifiedRef.current = res.modified;
      return true;
    } catch (e) {
      useAppStore.getState().pushNotice("error", `Save failed: ${String(e)}`);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const complete = async () => {
    if (!(await save())) return;
    // Stage the file (git) and refresh the owning repo; jj detects resolution
    // on its next snapshot, so saving is enough there.
    const repo = useVcsStore
      .getState()
      .repos.find(
        (r) =>
          r.connId === tab.connId &&
          norm(tab.path).startsWith(`${norm(r.root)}/`),
      );
    if (repo) {
      const rel = norm(tab.path).slice(norm(repo.root).length + 1);
      if (repo.backend !== "jj") {
        try {
          await vcsStage(tab.connId, repo.root, [rel]);
        } catch (e) {
          useAppStore.getState().pushNotice("error", `Stage failed: ${String(e)}`);
        }
      }
      void useVcsStore.getState().refreshRepo(repo.connKey, repo.root);
    }
    useAppStore.getState().pushNotice("info", `Merge of ${tab.name} completed.`);
    useAppStore.getState().forceCloseTab(tab.id);
  };

  return (
    <div className="merge-editor">
      <div className="merge-editor__bar">
        <span
          className={`merge-editor__count ${remaining === 0 ? "merge-editor__count--done" : ""}`}
        >
          {remaining === 0
            ? "All conflicts resolved"
            : `${remaining} conflict${remaining === 1 ? "" : "s"} remaining`}
        </span>
        <button
          className="btn btn--ghost"
          disabled={remaining === 0}
          onClick={() => acceptAll("current")}
        >
          All current
        </button>
        <button
          className="btn btn--ghost"
          disabled={remaining === 0}
          onClick={() => acceptAll("incoming")}
        >
          All incoming
        </button>
        <button className="btn btn--ghost" disabled={saving} onClick={() => void save()}>
          Save
        </button>
        <button
          className="btn btn--primary"
          disabled={remaining > 0 || saving}
          title={remaining > 0 ? "Resolve the remaining conflicts first" : "Save and stage"}
          onClick={() => void complete()}
        >
          Complete merge
        </button>
      </div>
      <div className="merge-editor__tops">
        <div className="merge-editor__pane">
          <div className="merge-editor__label">Current (yours)</div>
          <div className="merge-editor__host" ref={oursRef} />
        </div>
        <div className="merge-editor__pane merge-editor__pane--incoming">
          <div className="merge-editor__label">Incoming (theirs)</div>
          <div className="merge-editor__host" ref={theirsRef} />
        </div>
      </div>
      <div className="merge-editor__pane merge-editor__pane--result">
        <div className="merge-editor__label">
          Result — accept with the actions above each conflict, or edit freely
        </div>
        <div className="merge-editor__host" ref={resultRef} />
      </div>
    </div>
  );
}
