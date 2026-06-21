/** Global keyboard shortcut dispatch. Terminal-bound keys are left to xterm
 *  when the terminal is focused; our shortcuts are all Ctrl/Cmd-based so they
 *  don't interfere with typing. */
import { useEffect } from "react";

import { saveActiveFile } from "../lib/saveFile";
import { matchShortcut } from "../lib/shortcuts";
import { focusTerminal } from "../lib/terminalFocus";
import { pickTerminalTarget } from "../lib/terminalTarget";
import { focusExplorer } from "../lib/treeNav";
import { useAppStore } from "../store/appStore";

export function useKeyboard() {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const action = matchShortcut(event);
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
          const target = pickTerminalTarget();
          if (target) {
            store.openTerminal(target.connId, target.label);
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
