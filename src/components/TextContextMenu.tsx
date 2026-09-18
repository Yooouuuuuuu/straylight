/** The app-owned right-click menu for every place you can type — text fields
 *  (commit box, renames, dialog inputs) and the file editor — VS Code's six:
 *  Undo / Redo / Cut / Copy / Paste / Select All. WebView2's native menu
 *  (refresh/print/inspect…) never shows: surfaces with their own menus
 *  (terminal, explorer, tabs, diff/merge editors) preventDefault before this
 *  window listener runs; everything else is suppressed here, menu or not.
 *
 *  Password fields get the reduced set (Paste · Select All) like native menus;
 *  read-only surfaces keep only Copy · Select All enabled. Selectable static
 *  text (the Markdown preview) gets Copy · Select All too — it has no field
 *  or editor, so without its own case it got the suppression and no menu. */
import { useEffect, useState } from "react";

import { readText } from "@tauri-apps/plugin-clipboard-manager";

import type * as monaco from "monaco-editor";

import { editorAtNode } from "../lib/editorModels";
import { monacoRef } from "../lib/monacoRef";
import { useMenuClamp } from "../hooks/useMenuClamp";
import { useAppStore } from "../store/appStore";

type Field = HTMLInputElement | HTMLTextAreaElement;

type MenuState =
  | { kind: "field"; x: number; y: number; field: Field }
  | { kind: "editor"; x: number; y: number; editor: monaco.editor.IStandaloneCodeEditor }
  // Selectable-but-read-only surfaces (the Markdown preview): Copy · Select All.
  | { kind: "static"; x: number; y: number; container: HTMLElement };

export function TextContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  useAppStore((s) => s.settingsRev); // theme/settings re-render like other menus
  const { ref, left, top } = useMenuClamp(menu?.x ?? 0, menu?.y ?? 0, !!menu);

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
        return;
      }
      // The Markdown preview is selectable text with no menu of its own —
      // without this it got the suppression (line above) and nothing else.
      const staticText = target.closest(".md-preview") as HTMLElement | null;
      if (staticText) {
        setMenu({ kind: "static", x: e.clientX, y: e.clientY, container: staticText });
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
  // An editor menu only appears once an editor exists, so Monaco is loaded and
  // the ref is bound; the `true` arm is unreachable defensive cover.
  const mo = monacoRef();
  const writable =
    menu.kind === "field"
      ? !menu.field.readOnly && !menu.field.disabled
      : menu.kind === "editor"
        ? mo
          ? !menu.editor.getOption(mo.editor.EditorOption.readOnly)
          : true
        : false;
  const hasSelection =
    menu.kind === "field"
      ? menu.field.selectionStart !== menu.field.selectionEnd
      : menu.kind === "editor"
        ? !(menu.editor.getSelection()?.isEmpty() ?? true)
        : !(window.getSelection()?.isCollapsed ?? true);

  const run = (act: "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll") => {
    setMenu(null);
    if (menu.kind === "static") {
      if (act === "copy") {
        const text = window.getSelection()?.toString() ?? "";
        if (text) void navigator.clipboard.writeText(text).catch(() => {});
      } else if (act === "selectAll") {
        const body =
          menu.container.querySelector(".md-preview__body") ?? menu.container;
        const range = document.createRange();
        range.selectNodeContents(body);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      return;
    }
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
          void readText()
            .then((text) => {
              if (!text) return;
              f.focus();
              document.execCommand("insertText", false, text);
            })
            .catch(() => {});
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
        void readText()
          .then((text) => {
            if (!text) return;
            ed.focus();
            const s = ed.getSelection();
            if (s) {
              ed.executeEdits("contextmenu", [
                { range: s, text, forceMoveMarkers: true },
              ]);
            }
          })
          .catch(() => {});
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
  }[] = menu.kind === "static"
    ? [
        { act: "copy", label: "Copy", hint: "Ctrl+C", enabled: hasSelection },
        { act: "selectAll", label: "Select All", hint: "Ctrl+A", enabled: true },
      ]
    : isPassword
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
      <div className="ctx-menu" ref={ref} style={{ left, top }} role="menu">
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
