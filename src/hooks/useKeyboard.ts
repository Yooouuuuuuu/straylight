/** Global keyboard shortcut dispatch. Terminal-bound keys are left to xterm
 *  when the terminal is focused; our shortcuts are all Ctrl/Cmd-based so they
 *  don't interfere with typing. */
import { useEffect } from "react";

import { matchShortcut } from "../lib/shortcuts";
import { useAppStore } from "../store/appStore";

export function useKeyboard() {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const action = matchShortcut(event);
      if (!action) return;

      const target = event.target as HTMLElement | null;
      const inTerminal = !!target?.closest(".terminal-host");
      const store = useAppStore.getState();

      switch (action) {
        case "toggleTerminal":
          if (store.remote) {
            store.toggleTerminal();
            event.preventDefault();
          }
          break;
        case "toggleSidebar":
          store.toggleSidebar();
          event.preventDefault();
          break;
        case "focusFileExplorer":
          store.setSidebarVisible(true);
          event.preventDefault();
          break;
        case "closeFile":
          // Ctrl+W must not close a tab while the terminal is focused.
          if (!inTerminal && store.openFile) {
            store.setOpenFile(null);
            event.preventDefault();
          }
          break;
        case "refreshTree":
          store.refreshTree();
          event.preventDefault();
          break;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
