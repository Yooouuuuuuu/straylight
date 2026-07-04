/** Git-style merge-conflict helpers for the editor: detect
 *  `<<<<<<< / ======= / >>>>>>>` regions in a model, offer CodeLens actions
 *  (Accept Current / Incoming / Both), and highlight the two sides.
 *
 *  jj's default markers use its own `%%%%%%%` diff format, which has no plain
 *  ours/theirs blocks — those files open for hand-editing but get no accept
 *  actions (the regions still highlight). */
import { monaco } from "./monaco";

export interface ConflictRegion {
  /** Line of `<<<<<<<`. */
  start: number;
  /** Line of `|||||||` (diff3 base), if present. */
  base?: number;
  /** Line of `=======` — absent in jj-style conflicts (no accept actions). */
  sep?: number;
  /** Line of `>>>>>>>`. */
  end: number;
}

export function findConflicts(model: monaco.editor.ITextModel): ConflictRegion[] {
  const out: ConflictRegion[] = [];
  const lineCount = model.getLineCount();
  let cur: { start: number; base?: number; sep?: number } | null = null;
  for (let i = 1; i <= lineCount; i += 1) {
    const line = model.getLineContent(i);
    if (line.startsWith("<<<<<<<")) {
      cur = { start: i };
    } else if (cur && cur.sep === undefined && line.startsWith("|||||||")) {
      cur.base = i;
    } else if (cur && cur.sep === undefined && line.startsWith("=======")) {
      cur.sep = i;
    } else if (cur && line.startsWith(">>>>>>>")) {
      out.push({ start: cur.start, base: cur.base, sep: cur.sep, end: i });
      cur = null;
    }
  }
  return out;
}

type Choice = "current" | "incoming" | "both";

function linesText(
  model: monaco.editor.ITextModel,
  from: number,
  to: number,
): string {
  if (from > to) return "";
  const parts: string[] = [];
  for (let i = from; i <= to; i += 1) parts.push(model.getLineContent(i));
  return parts.join(model.getEOL());
}

/** Replace a conflict region with the chosen side(s). */
export function acceptConflict(
  model: monaco.editor.ITextModel,
  region: ConflictRegion,
  choice: Choice,
): void {
  if (region.sep === undefined) return;
  const eol = model.getEOL();
  const ours = linesText(model, region.start + 1, (region.base ?? region.sep) - 1);
  const theirs = linesText(model, region.sep + 1, region.end - 1);
  const replacement =
    choice === "current"
      ? ours
      : choice === "incoming"
        ? theirs
        : [ours, theirs].filter((s) => s.length > 0).join(eol);

  const lastLine = model.getLineCount();
  let range: InstanceType<typeof monaco.Range>;
  let text: string;
  if (region.end < lastLine) {
    // Replace through the marker line's EOL.
    range = new monaco.Range(region.start, 1, region.end + 1, 1);
    text = replacement.length > 0 ? replacement + eol : "";
  } else {
    range = new monaco.Range(
      region.start,
      1,
      region.end,
      model.getLineMaxColumn(region.end),
    );
    text = replacement;
  }
  model.pushEditOperations([], [{ range, text }], () => null);
}

const COMMAND_ID = "straylight.acceptConflict";
let registered = false;

/** Register the accept-conflict command + CodeLens provider (idempotent). */
export function setupMergeConflictActions(): void {
  if (registered) return;
  registered = true;

  monaco.editor.registerCommand(
    COMMAND_ID,
    (_accessor: unknown, uri: string, startLine: number, choice: Choice) => {
      const model = monaco.editor.getModel(monaco.Uri.parse(uri));
      if (!model) return;
      const region = findConflicts(model).find((r) => r.start === startLine);
      if (region) acceptConflict(model, region, choice);
    },
  );

  monaco.languages.registerCodeLensProvider("*", {
    provideCodeLenses(model) {
      const lenses: monaco.languages.CodeLens[] = [];
      for (const region of findConflicts(model)) {
        if (region.sep === undefined) continue; // jj-style: no accept actions
        const range = new monaco.Range(region.start, 1, region.start, 1);
        const uri = model.uri.toString();
        lenses.push(
          {
            range,
            command: {
              id: COMMAND_ID,
              title: "Accept Current",
              arguments: [uri, region.start, "current"],
            },
          },
          {
            range,
            command: {
              id: COMMAND_ID,
              title: "Accept Incoming",
              arguments: [uri, region.start, "incoming"],
            },
          },
          {
            range,
            command: {
              id: COMMAND_ID,
              title: "Accept Both",
              arguments: [uri, region.start, "both"],
            },
          },
        );
      }
      return { lenses, dispose: () => {} };
    },
    resolveCodeLens: (_model, lens) => lens,
  });
}

/** Decorations for the two sides of every conflict in a model. */
export function conflictDecorations(
  model: monaco.editor.ITextModel,
): monaco.editor.IModelDeltaDecoration[] {
  const out: monaco.editor.IModelDeltaDecoration[] = [];
  for (const region of findConflicts(model)) {
    const oursEnd = (region.base ?? region.sep ?? region.end) - 1;
    if (oursEnd >= region.start) {
      out.push({
        range: new monaco.Range(region.start, 1, oursEnd, 1),
        options: { isWholeLine: true, className: "merge-current" },
      });
    }
    const theirsStart = region.sep !== undefined ? region.sep + 1 : region.start + 1;
    if (region.end >= theirsStart - 1) {
      out.push({
        range: new monaco.Range(
          region.sep !== undefined ? region.sep : region.end,
          1,
          region.end,
          1,
        ),
        options: { isWholeLine: true, className: "merge-incoming" },
      });
    }
  }
  return out;
}
