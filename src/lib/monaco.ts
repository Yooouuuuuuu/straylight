/**
 * Monaco bootstrap: web-worker wiring for Vite and the Dracula theme.
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

export const DRACULA_THEME = "dracula";

const draculaTheme: monaco.editor.IStandaloneThemeData = {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "", foreground: "F8F8F2" },
    { token: "comment", foreground: "6272A4", fontStyle: "italic" },
    { token: "keyword", foreground: "FF79C6" },
    { token: "string", foreground: "F1FA8C" },
    { token: "number", foreground: "BD93F9" },
    { token: "type", foreground: "8BE9FD", fontStyle: "italic" },
    { token: "function", foreground: "50FA7B" },
    { token: "variable", foreground: "F8F8F2" },
    { token: "constant", foreground: "BD93F9" },
    { token: "operator", foreground: "FF79C6" },
    { token: "delimiter", foreground: "F8F8F2" },
    { token: "tag", foreground: "FF79C6" },
    { token: "attribute.name", foreground: "50FA7B" },
    { token: "attribute.value", foreground: "F1FA8C" },
    { token: "regexp", foreground: "FF5555" },
  ],
  colors: {
    "editor.background": "#282A36",
    "editor.foreground": "#F8F8F2",
    "editor.lineHighlightBackground": "#343746",
    "editor.selectionBackground": "#44475A",
    "editorCursor.foreground": "#F8F8F2",
    "editorWhitespace.foreground": "#44475A",
    "editorLineNumber.foreground": "#6272A4",
    "editorLineNumber.activeForeground": "#F8F8F2",
    "editor.findMatchBackground": "#FFB86C44",
    "editor.findMatchHighlightBackground": "#FFB86C22",
    "editorWidget.background": "#21222C",
    "editorWidget.border": "#44475A",
    "editorSuggestWidget.background": "#21222C",
    "editorSuggestWidget.border": "#44475A",
    "editorSuggestWidget.selectedBackground": "#44475A",
    "editorGutter.background": "#282A36",
    "editorIndentGuide.background1": "#343746",
    "editorIndentGuide.activeBackground1": "#44475A",
    "scrollbarSlider.background": "#44475A80",
    "scrollbarSlider.hoverBackground": "#44475ABB",
    "scrollbarSlider.activeBackground": "#6272A4",
    "minimap.background": "#21222C",
  },
};

let initialized = false;

/** Idempotently configure Monaco's workers and register the Dracula theme. */
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

  monaco.editor.defineTheme(DRACULA_THEME, draculaTheme);
  initialized = true;
  return monaco;
}

export { monaco };
