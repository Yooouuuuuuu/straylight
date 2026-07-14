/** Global keyboard shortcut dispatch. Terminal-bound keys are left to xterm
 *  when the terminal is focused; our shortcuts are all Ctrl/Cmd-based so they
 *  don't interfere with typing. */
import { useEffect } from "react";

import { refreshApp } from "../lib/appRefresh";
import { allCommands } from "../lib/commands";
import { saveActiveFile } from "../lib/saveFile";
import { matchShortcut } from "../lib/shortcuts";
import { adjustTerminalFontSize } from "../lib/themes";
import { focusTerminal } from "../lib/terminalFocus";
import { focusExplorer } from "../lib/treeNav";
import { useAppStore } from "../store/appStore";

export function useKeyboard() {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const action = matchShortcut(event);

      // Any modifier combo of F5 (Ctrl+F5, Shift+F5, …) must never reach the
      // WebView (it would reload the whole app). Plain F5 matches "appRefresh"
      // below; the variants are swallowed here.
      if (!action && event.key === "F5") {
        event.preventDefault();
        return;
      }
      if (!action) return;

      const target = event.target as HTMLElement | null;
      const inTerminal = !!target?.closest(".terminal-host");
      const inEditable = !!target?.closest(
        "input, textarea, [contenteditable=true], .monaco-host, .terminal-host",
      );
      const store = useAppStore.getState();

      switch (action) {
        case "saveFile":
          // Ctrl+S is XOFF in a terminal — let xterm have it there.
          if (!inTerminal) {
            void saveActiveFile();
            event.preventDefault();
          }
          break;
        case "quickOpen":
          // Ctrl+P is readline "previous" in a terminal — leave it there.
          if (!inTerminal) {
            store.setFinderOpen(true);
            event.preventDefault();
          }
          break;
        case "searchInFiles":
          if (!inTerminal) {
            store.setSearchOpen(true);
            event.preventDefault();
          }
          break;
        case "appRefresh":
          // Ctrl+R stays readline reverse-search in a terminal (xterm consumes
          // it, so the WebView never sees it either).
          if (!inTerminal) {
            void refreshApp();
            event.preventDefault();
          }
          break;
        case "commandPalette":
          if (!inTerminal) {
            store.setPaletteOpen(true);
            event.preventDefault();
          }
          break;
        case "zoomIn":
        case "zoomOut":
        case "zoomReset": {
          // In a terminal, Ctrl+±/0 sizes the terminal font (persisted to
          // settings.json "terminalFont"); elsewhere it's whole-app zoom.
          if (inTerminal) {
            void adjustTerminalFontSize(
              action === "zoomIn" ? 1 : action === "zoomOut" ? -1 : null,
            );
          } else {
            const id =
              action === "zoomIn"
                ? "view.zoomIn"
                : action === "zoomOut"
                  ? "view.zoomOut"
                  : "view.zoomReset";
            void allCommands().find((c) => c.id === id)?.run();
          }
          event.preventDefault();
          break;
        }
        case "copyPathSelected":
          if (!inEditable && store.selected) {
            void allCommands().find((c) => c.id === "explorer.copyPath")?.run();
            event.preventDefault();
          }
          break;
        case "propertiesSelected":
          if (!inEditable && (store.selected || store.selection.length)) {
            void allCommands().find((c) => c.id === "explorer.properties")?.run();
            event.preventDefault();
          }
          break;
        case "markdownPreview": {
          const active = store.tabs.find((t) => t.id === store.activeTabId);
          if (
            !inTerminal &&
            active &&
            (!active.kind || active.kind === "file") &&
            /\.(md|markdown)$/i.test(active.name)
          ) {
            store.openPreviewTab({
              connId: active.connId,
              path: active.path,
              name: `${active.name} (preview)`,
              content: active.content,
            });
            event.preventDefault();
          }
          break;
        }
        case "nextTab":
          if (store.tabs.length > 1) {
            store.cycleTab(1);
            event.preventDefault();
          }
          break;
        case "prevTab":
          if (store.tabs.length > 1) {
            store.cycleTab(-1);
            event.preventDefault();
          }
          break;
        case "renameSelected":
          // The transfer panel owns F2/Delete while open (it has its own
          // selection on a possibly different host).
          if (!inEditable && !store.transferOpen && store.selected) {
            store.startRename(store.selected.connId, store.selected.path);
            event.preventDefault();
          }
          break;
        case "deleteSelected": {
          const targets = store.selection.length
            ? store.selection
            : store.selected
              ? [store.selected]
              : [];
          if (!inEditable && !store.transferOpen && targets.length) {
            store.openConfirmDelete(targets);
            event.preventDefault();
          }
          break;
        }
        case "toggleTerminal":
          if (store.remote || store.localConnId) {
            // VS Code-style: reveal+focus when hidden, focus when visible but
            // not focused, and only hide when the terminal already has focus.
            if (!store.terminalVisible) {
              store.setTerminalVisible(true);
              focusTerminal(store.activeTerminalId);
            } else if (!inTerminal && store.activeTerminalId) {
              focusTerminal(store.activeTerminalId);
            } else {
              store.setTerminalVisible(false);
            }
            event.preventDefault();
          }
          break;
        case "newTerminal": {
          // Only while a terminal is focused — the new one opens on THAT
          // terminal's host. Elsewhere (editor, tools) the shortcut is inert:
          // click into a host's terminal first.
          const connId = inTerminal
            ? (target?.closest(".terminal-host") as HTMLElement | null)
                ?.dataset.connId
            : undefined;
          if (connId) {
            const label =
              connId === store.localConnId
                ? "pwsh"
                : (store.wsls.find((w) => w.conn.connId === connId)?.conn
                    .name ??
                  store.remotes.find((r) => r.conn.connId === connId)?.conn
                    .name ??
                  "shell");
            store.openTerminal(connId, label);
            store.setTerminalVisible(true);
            event.preventDefault();
          }
          break;
        }
        case "nextTerminal":
          if (store.terminals.length > 1) {
            store.cycleTerminal(1);
            event.preventDefault();
          }
          break;
        case "prevTerminal":
          if (store.terminals.length > 1) {
            store.cycleTerminal(-1);
            event.preventDefault();
          }
          break;
        case "toggleSidebar":
          store.toggleSidebar();
          event.preventDefault();
          break;
        case "focusFileExplorer":
          store.setSidebarVisible(true);
          focusExplorer();
          event.preventDefault();
          break;
        case "closeFile":
          // Ctrl+W must not close a tab while the terminal is focused.
          if (!inTerminal && store.activeTabId) {
            store.closeTab(store.activeTabId);
            event.preventDefault();
          }
          break;
        case "refreshTree":
          // Ctrl+Shift+R is a global "refresh everything" — all sections.
          store.refreshLocal();
          store.refreshRemote();
          store.refreshWsl();
          event.preventDefault();
          break;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
