/** A late-bound handle to Monaco's value namespace. Eager modules that only
 *  SOMETIMES need Monaco — the theme layer, the model registry, the text
 *  context menu — reach it through here instead of importing `monaco-editor`
 *  directly. That keeps ~5 MB of Monaco out of any window that never shows an
 *  editor: the Sessions pop-out imports these modules (via the shared title
 *  bar / keyboard hook) but never loads Monaco (docs/dev/multi-window.md).
 *
 *  The editor stack binds it on load (lib/monaco.ts, on module eval), and
 *  editor windows preload Monaco at boot (main.tsx) so it's bound before any
 *  restore path runs. `monacoRef()` is null ONLY where Monaco was deliberately
 *  never loaded — callers there simply skip the editor-only work. */

let bound: typeof import("monaco-editor") | null = null;

/** Called by the editor stack the moment Monaco loads. */
export function bindMonaco(ns: typeof import("monaco-editor")): void {
  bound = ns;
}

/** Monaco's value namespace, or null in a window that never loaded it. */
export function monacoRef(): typeof import("monaco-editor") | null {
  return bound;
}
