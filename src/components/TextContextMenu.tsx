/** The app-owned right-click menu for every place you can type — text fields
 *  (commit box, renames, dialog inputs) and the file editor — VS Code's six:
 *  Undo / Redo / Cut / Copy / Paste / Select All. WebView2's native menu
 *  (refresh/print/inspect…) never shows: surfaces with their own menus
 *  (terminal, explorer, tabs, diff/merge editors) preventDefault before this
 *  window listener runs; everything else is suppressed here, menu or not.
 *
 *  Password fields get the reduced set (Paste · Select All) like native menus;
 *  read-only surfaces keep only Copy · Select All enabled. */
import { useEffect, useState } from "react";

import { editorAtNode } from "../lib/editorModels";
import { monaco } from "../lib/monaco";
import { useAppStore } from "../store/appStore";

type Field = HTMLInputElement | HTMLTextAreaElement;

type MenuState =
  | { kind: "field"; x: number; y: number; field: Field }
  | { kind: "editor"; x: number; y: number; editor: monaco.editor.IStandaloneCodeEditor };

const MENU_W = 190;
const ITEM_H = 28;

export function TextContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  useAppStore((s) => s.settingsRev); // theme/settings re-render like other menus

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      // A surface that runs its own menu (terminal copy/paste, explorer rows,
      // editor tabs, Monaco's menu in diff/merge views) already claimed this.
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      e.preventDefault(); // the native browser menu never shows

      const field = target.closest("input, textarea") as Field | null;
      // Monaco's hidden keyboard proxy (.inputarea) is not a real field — a
      // click there means the editor. The find widget's inputs ARE real.
      if (field && !field.classList.contains("inputarea")) {
        setMenu({ kind: "field", x: e.clientX, y: e.clientY, field });
        return;
      }
      const editor = editorAtNode(target);
      if (editor && editor.getModel()) {
        setMenu({ kind: "editor", x: e.clientX, y: e.clientY, editor });
      }
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setMenu(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [menu]);

  if (!menu) return null;

  const isPassword =
    menu.kind === "field" &&
    menu.field instanceof HTMLInputElement &&
    menu.field.type === "password";
  const writable =
    menu.kind === "field"
      ? !menu.field.readOnly && !menu.field.disabled
      : !menu.editor.getOption(monaco.editor.EditorOption.readOnly);
  const hasSelection =
    menu.kind === "field"
      ? menu.field.selectionStart !== menu.field.selectionEnd
      : !(menu.editor.getSelection()?.isEmpty() ?? true);

  const run = (act: "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll") => {
    setMenu(null);
    if (menu.kind === "field") {
      const f = menu.field;
      f.focus();
      switch (act) {
        case "undo":
          document.execCommand("undo");
          break;
        case "redo":
          document.execCommand("redo");
          break;
        case "cut":
          document.execCommand("cut");
          break;
        case "copy":
          document.execCommand("copy");
          break;
        case "paste":
          // insertText goes through the browser's edit path: the input event
          // fires (React onChange) and the field's undo stack stays intact.
          void navigator.clipboard.readText().then((text) => {
            if (!text) return;
            f.focus();
            document.execCommand("insertText", false, text);
          });
          break;
        case "selectAll":
          f.select();
          break;
      }
      return;
    }
    const ed = menu.editor;
    const model = ed.getModel();
    if (!model) return;
    ed.focus();
    const sel = ed.getSelection();
    switch (act) {
      case "undo":
        ed.trigger("contextmenu", "undo", null);
        break;
      case "redo":
        ed.trigger("contextmenu", "redo", null);
        break;
      case "copy":
        if (sel && !sel.isEmpty()) {
          void navigator.clipboard.writeText(model.getValueInRange(sel));
        }
        break;
      case "cut":
        if (sel && !sel.isEmpty()) {
          void navigator.clipboard.writeText(model.getValueInRange(sel));
          ed.executeEdits("contextmenu", [{ range: sel, text: "" }]);
        }
        break;
      case "paste":
        void navigator.clipboard.readText().then((text) => {
          if (!text) return;
          ed.focus();
          const s = ed.getSelection();
          if (s) {
            ed.executeEdits("contextmenu", [
              { range: s, text, forceMoveMarkers: true },
            ]);
          }
        });
        break;
      case "selectAll":
        ed.setSelection(model.getFullModelRange());
        break;
    }
  };

  const items: {
    act: Parameters<typeof run>[0];
    label: string;
    hint: string;
    enabled: boolean;
    sepBefore?: boolean;
  }[] = isPassword
    ? [
        { act: "paste", label: "Paste", hint: "Ctrl+V", enabled: writable },
        { act: "selectAll", label: "Select All", hint: "Ctrl+A", enabled: true },
      ]
    : [
        { act: "undo", label: "Undo", hint: "Ctrl+Z", enabled: writable },
        { act: "redo", label: "Redo", hint: "Ctrl+Y", enabled: writable },
        { act: "cut", label: "Cut", hint: "Ctrl+X", enabled: writable && hasSelection, sepBefore: true },
        { act: "copy", label: "Copy", hint: "Ctrl+C", enabled: hasSelection },
        { act: "paste", label: "Paste", hint: "Ctrl+V", enabled: writable },
        { act: "selectAll", label: "Select All", hint: "Ctrl+A", enabled: true, sepBefore: true },
      ];

  const height = items.length * ITEM_H + items.filter((i) => i.sepBefore).length * 9 + 10;
  const x = Math.min(menu.x, window.innerWidth - MENU_W - 8);
  const y = Math.min(menu.y, window.innerHeight - height - 8);

  return (
    <>
      <div
        className="menu-backdrop"
        style={{ zIndex: 1199 }}
        onMouseDown={() => setMenu(null)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu(null);
        }}
      />
      <div className="ctx-menu" style={{ left: x, top: y }} role="menu">
        {items.map((it) => (
          <span key={it.act} style={{ display: "contents" }}>
            {it.sepBefore && <div className="ctx-menu__sep" />}
            <button
              className="terminal-menu__item"
              disabled={!it.enabled}
              // preventDefault so the field keeps its focus AND selection —
              // the action must run against the surface that was clicked.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(it.act)}
            >
              {it.label}
              <span className="action-menu__hint">{it.hint}</span>
            </button>
          </span>
        ))}
      </div>
    </>
  );
}
