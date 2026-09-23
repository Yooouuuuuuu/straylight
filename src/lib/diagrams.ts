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

/** A renderer's SVG with its size pinned to concrete pixels. */
export interface SizedSvg {
  svg: string;
  w: number;
  h: number;
}

/** Pin the root `<svg>`'s width/height to concrete pixels (from its own
 *  numbers, its viewBox, or a nested inner svg's). d2 builds vary here —
 *  a percentage or missing dimension collapses to nothing inside the
 *  preview's content-sized pan/zoom stage, and makes `Image` rasterization
 *  fall back to the 300×150 SVG default (the "exported PNG is cut" bug).
 *  Exports of the .svg FILE stay the tool's raw output — this normalized
 *  form is for display and rasterizing only. */
export function normalizeSvg(raw: string): SizedSvg | null {
  const doc = new DOMParser().parseFromString(raw, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") return null;
  const px = (v: string | null) =>
    v !== null && /^\d+(\.\d+)?(px)?$/.test(v.trim()) ? parseFloat(v) : NaN;
  const fromViewBox = (el: Element): { w: number; h: number } | null => {
    const vb = (el.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
    return vb.length === 4 && vb[2] > 0 && vb[3] > 0
      ? { w: vb[2], h: vb[3] }
      : null;
  };
  let w = px(root.getAttribute("width"));
  let h = px(root.getAttribute("height"));
  if (!(w > 0 && h > 0)) {
    const vb = fromViewBox(root);
    if (vb) ({ w, h } = vb);
  }
  if (!(w > 0 && h > 0)) {
    // Some builds nest the sized svg one level down.
    const inner = root.querySelector("svg");
    if (inner) {
      w = px(inner.getAttribute("width"));
      h = px(inner.getAttribute("height"));
      if (!(w > 0 && h > 0)) {
        const vb = fromViewBox(inner);
        if (vb) ({ w, h } = vb);
      }
    }
  }
  if (!(w > 0 && h > 0)) return null;
  root.setAttribute("width", String(w));
  root.setAttribute("height", String(h));
  return { svg: new XMLSerializer().serializeToString(root), w, h };
}

/** Rasterize a size-pinned SVG to a PNG blob at `scale`× — fully
 *  client-side (d2 embeds its fonts as data URIs inside the SVG, so the
 *  canvas draw is faithful and untainted). Used for Copy image and Export
 *  PNG; sidesteps d2's own PNG export, which needs a headless Chromium on
 *  the host. The destination rectangle is passed explicitly so the draw is
 *  full-size even if the browser mis-derives the image's natural size. */
export async function svgToPngBlob(sized: SizedSvg, scale = 2): Promise<Blob> {
  const url = URL.createObjectURL(
    new Blob([sized.svg], { type: "image/svg+xml" }),
  );
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("the SVG could not be decoded"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sized.w * scale);
    canvas.height = Math.round(sized.h * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d canvas");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) =>
      canvas.toBlob(r, "image/png"),
    );
    if (!blob) throw new Error("PNG encoding failed");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
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
