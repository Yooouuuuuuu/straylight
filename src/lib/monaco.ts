/**
 * Monaco bootstrap: web-worker wiring for Vite and the fallback (Straylight)
 * theme shown until the settings-driven theme layer takes over.
 *
 * Vite bundles Monaco's language workers via the `?worker` import suffix; we
 * point `MonacoEnvironment.getWorker` at them by label. Call {@link setupMonaco}
 * once before creating any editor.
 */
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

export const FALLBACK_THEME = "straylight";

const fallbackTheme: monaco.editor.IStandaloneThemeData = {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "", foreground: "F0E7E9" },
    { token: "comment", foreground: "7A5F66", fontStyle: "italic" },
    { token: "keyword", foreground: "FF4D6D" },
    { token: "string", foreground: "5CE626" },
    { token: "number", foreground: "FF00FF" },
    { token: "type", foreground: "FFB454", fontStyle: "italic" },
    { token: "function", foreground: "FF7A9C" },
    { token: "variable", foreground: "F0E7E9" },
    { token: "constant", foreground: "FF00FF" },
    { token: "operator", foreground: "FF4D6D" },
    { token: "delimiter", foreground: "F0E7E9" },
    { token: "tag", foreground: "FF4D6D" },
    { token: "attribute.name", foreground: "FF7A9C" },
    { token: "attribute.value", foreground: "5CE626" },
    { token: "regexp", foreground: "FF00FF" },
  ],
  colors: {
    "editor.background": "#151013",
    "editor.foreground": "#F0E7E9",
    "editor.lineHighlightBackground": "#221418",
    "editor.selectionBackground": "#46232C",
    "editorCursor.foreground": "#F30100",
    "editorWhitespace.foreground": "#46232C",
    "editorLineNumber.foreground": "#7A5F66",
    "editorLineNumber.activeForeground": "#F0E7E9",
    "editor.findMatchBackground": "#9E6A03",
    "editor.findMatchHighlightBackground": "#5C4308",
    "editorWidget.background": "#0F0B0D",
    "editorWidget.border": "#46232C",
    "editorSuggestWidget.background": "#0F0B0D",
    "editorSuggestWidget.border": "#46232C",
    "editorSuggestWidget.selectedBackground": "#46232C",
    "editorGutter.background": "#151013",
    "editorIndentGuide.background1": "#221418",
    "editorIndentGuide.activeBackground1": "#46232C",
    "scrollbarSlider.background": "#46232C80",
    "scrollbarSlider.hoverBackground": "#46232CBB",
    "scrollbarSlider.activeBackground": "#7A5F66",
    "minimap.background": "#0F0B0D",
  },
};

let initialized = false;

/** Idempotently configure Monaco's workers and register the fallback theme. */
export function setupMonaco(): typeof monaco {
  if (initialized) return monaco;

  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case "json":
          return new JsonWorker();
        case "css":
        case "scss":
        case "less":
          return new CssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new HtmlWorker();
        case "typescript":
        case "javascript":
          return new TsWorker();
        default:
          return new EditorWorker();
      }
    },
  };

  monaco.editor.defineTheme(FALLBACK_THEME, fallbackTheme);
  // The global default; the theme layer may override it with the custom theme
  // built from settings.json. Editors must NOT pass `theme:` at create time —
  // that would reset the global theme every time one mounts.
  monaco.editor.setTheme(FALLBACK_THEME);
  initialized = true;
  return monaco;
}

export { monaco };
