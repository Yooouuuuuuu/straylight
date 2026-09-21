/** Diagram-language registry: languages whose "build artifact" is an SVG we
 *  can preview. The renderer is the HOST's own binary (the git/jj doctrine —
 *  nothing bundled, nothing installed by us, no drift); the backend allowlist
 *  in diagram.rs decides the actual argv, this table only carries what the
 *  UI needs. Adding a language = one entry here + one arm in diagram.rs. */
import type * as monaco from "monaco-editor";

export interface DiagramLang {
  /** Backend tool name (must exist in diagram.rs's allowlist). */
  tool: string;
  /** Human name for cards and toasts. */
  label: string;
  /** File-name test for the ¶ Preview affordances. */
  exts: RegExp;
  /** Fenced-code language in Markdown (```d2) rendered by the same tool. */
  fence: string;
  /** Monaco language id (registered below); "" = plaintext. */
  monacoLang: string;
  /** Shown on the missing-tool card. */
  installHint: string;
  docsUrl: string;
}

export const DIAGRAM_LANGS: DiagramLang[] = [
  {
    tool: "d2",
    label: "D2",
    exts: /\.d2$/i,
    fence: "d2",
    monacoLang: "d2",
    installHint:
      "curl -fsSL https://d2lang.com/install.sh | sh -s --   (Windows: winget install Terrastruct.D2)",
    docsUrl: "https://d2lang.com",
  },
];

export function diagramForFile(name: string): DiagramLang | null {
  return DIAGRAM_LANGS.find((d) => d.exts.test(name)) ?? null;
}

export function diagramForTool(tool: string | undefined): DiagramLang | null {
  return DIAGRAM_LANGS.find((d) => d.tool === tool) ?? null;
}

/** D2 syntax highlighting (Monarch). Highlighting only — semantics stay with
 *  the host's real compiler, matching the no-LSP stance. */
const D2_MONARCH: monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenizer: {
    root: [
      [/#.*/, "comment"],
      [/"(?:[^"\\]|\\.)*"/, "string"],
      [/'[^']*'/, "string"],
      [/\$\{[^}]*\}/, "variable"],
      [/<->|<-|->|--/, "operator"],
      [
        /\b(?:shape|label|style|icon|near|width|height|top|left|link|tooltip|direction|constraint|classes|class|vars|grid-rows|grid-columns|grid-gap|vertical-gap|horizontal-gap|source-arrowhead|target-arrowhead)\b/,
        "keyword",
      ],
      [
        /\b(?:opacity|stroke|fill|fill-pattern|stroke-width|stroke-dash|border-radius|shadow|3d|multiple|double-border|font|font-size|font-color|animated|bold|italic|underline|text-transform)\b/,
        "type",
      ],
      [
        /\b(?:rectangle|square|page|parallelogram|document|cylinder|queue|package|step|callout|stored_data|person|diamond|oval|circle|hexagon|cloud|text|code|sql_table|image|sequence_diagram|true|false|up|down|right|left)\b/,
        "type",
      ],
      [/-?\d+(?:\.\d+)?/, "number"],
      // Block strings (`label: |md … |`): everything to the closing pipe.
      [/\|+[a-zA-Z]*/, { token: "string", next: "@block" }],
      [/[{}[\]().;,:]/, "delimiter"],
    ],
    block: [
      [/[^|]+/, "string"],
      [/\|+/, { token: "string", next: "@pop" }],
    ],
  },
};

/** Register the diagram languages with Monaco (called from setupMonaco). */
export function registerDiagramLanguages(mo: typeof monaco): void {
  mo.languages.register({ id: "d2", extensions: [".d2"] });
  mo.languages.setMonarchTokensProvider("d2", D2_MONARCH);
  mo.languages.setLanguageConfiguration("d2", {
    comments: { lineComment: "#" },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });
}
