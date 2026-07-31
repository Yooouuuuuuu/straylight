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

import { openExternal } from "./ipc";
import { bindMonaco } from "./monacoRef";
import { buildMonacoTheme } from "./themes";

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

// Publish the value namespace so eager modules (the theme layer, the model
// registry, the text context menu) can reach Monaco without importing it
// directly — the mechanism that keeps Monaco out of editor-less windows
// (lib/monacoRef.ts). Runs on module eval, i.e. the instant this chunk loads.
bindMonaco(monaco);

export const FALLBACK_THEME = "straylight";

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

  // Ctrl/Cmd-click on a link: Monaco shows the "follow link" hint, but the
  // WebView2 has no working window.open to an external browser, so the click
  // did nothing. Hand http(s) links to the OS default browser; anything else
  // (mailto:, file:, custom schemes) is left unhandled on purpose.
  monaco.editor.registerLinkOpener({
    open(resource) {
      const url = resource.toString(true);
      if (/^https?:\/\//i.test(url)) {
        void openExternal(url);
        return true;
      }
      return false;
    },
  });

  // Straylight ships no language server — Monaco's TS worker has no tsconfig
  // or node_modules, so its SEMANTIC pass flags every relative import as
  // "cannot find module" (a false positive on any real project). Keep syntax
  // checking (genuine typos are file-local and real) but drop the misleading
  // type/module diagnostics, matching the deliberate no-LSP stance.
  const tsDiag = { noSemanticValidation: true, noSyntaxValidation: false };
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(tsDiag);
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(tsDiag);

  // Built from EDITOR_DEFAULTS via the same function the live theme uses (at
  // bootstrap the settings sections are empty, so it yields the Straylight
  // defaults) — one source of truth, no drift with the real theme.
  monaco.editor.defineTheme(FALLBACK_THEME, buildMonacoTheme());
  // The global default; the theme layer may override it with the custom theme
  // built from settings.json. Editors must NOT pass `theme:` at create time —
  // that would reset the global theme every time one mounts.
  monaco.editor.setTheme(FALLBACK_THEME);
  initialized = true;
  return monaco;
}

export { monaco };
