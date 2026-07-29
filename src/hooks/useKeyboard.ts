/** Global keyboard shortcut dispatch. Terminal-bound keys are left to xterm
 *  when the terminal is focused; our shortcuts are all Ctrl/Cmd-based so they
 *  don't interfere with typing. */
import { useEffect } from "react";

import { refreshApp } from "../lib/appRefresh";
import { allCommands } from "../lib/commands";
import { openFindIn } from "../lib/editorModels";
import { toggleFocusView } from "../lib/focusMode";
import { closeDevtools } from "../lib/ipc";
import { chatSections, connectedChatHosts } from "../store/appStore";
import { saveActiveFile } from "../lib/saveFile";
import { matchShortcut } from "../lib/shortcuts";
import { cycleTerminalPanelTab } from "../lib/terminalTabs";
import { adjustTerminalFontSize } from "../lib/themes";
import { focusTerminal } from "../lib/terminalFocus";
import { focusExplorer } from "../lib/treeNav";
import { useAppStore } from "../store/appStore";
import { useVcsStore } from "../store/vcsStore";

export function useKeyboard() {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const store = useAppStore.getState();

      // Focus view (F11), Windows Terminal-style digits: Ctrl+Shift+1..9 = a
      // new agent on the Nth host of the HOSTS block (WT: new tab, profile
      // N); Ctrl+Alt+1..9 = jump to the Nth agent in visual order (WT:
      // switch to tab N). Handled before shortcut matching — digit combos
      // aren't in the shortcut table.
      if (
        store.focusView &&
        event.ctrlKey &&
        event.shiftKey !== event.altKey && // exactly one of them
        /^Digit[1-9]$/.test(event.code)
      ) {
        const n = Number(event.code.slice(5)) - 1;
        if (event.shiftKey) {
          const connId = connectedChatHosts(store)[n];
          if (connId) {
            const label =
              connId === store.localConnId
                ? "pwsh"
                : (store.wsls.find((w) => w.conn.connId === connId)?.conn
                    .name ??
                  store.remotes.find((r) => r.conn.connId === connId)?.conn
                    .name ??
                  "shell");
            void store.openAgentInChat(connId, label);
          }
        } else {
          const t = chatSections(
            store.terminals,
            store.chatPurposes,
            connectedChatHosts(store),
          ).flatMap((g) => g.terminals)[n];
          if (t) store.setChatActive(t.id);
        }
        event.preventDefault();
        return;
      }

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
      // The focus view's pane hosts a reparented xterm — it IS a terminal.
      const inTerminal = !!target?.closest(".terminal-host, .focus-view__pane");
      const inEditable = !!target?.closest(
        "input, textarea, [contenteditable=true], .monaco-host, .terminal-host, .focus-view__pane",
      );
      // A focused Transfers pane owns F2 / Delete for its own selection (its
      // pane handler acts); the explorer keeps them everywhere else. Scoping by
      // focus — not by "the tab is open" — is what lets both coexist.
      const inTransfer = !!target?.closest(".transfer-pane");

      // FOCUS VIEW (F11) has its own tiny keymap — nothing may touch the
      // normal layout hiding underneath. Ctrl+Tab / Ctrl+PageDown/Up cycle
      // the agents, Ctrl+Shift+` starts one on the shown agent's host, the
      // terminal font zoom keeps working, F11 exits (capture listener); every
      // other app shortcut is swallowed. Shell keys reach the terminal as
      // ever — only OUR shortcuts are filtered here.
      if (store.focusView) {
        // VISUAL order — hosts as sectioned, then each host's agents.
        const residents = chatSections(
          store.terminals,
          store.chatPurposes,
          connectedChatHosts(store),
        ).flatMap((g) => g.terminals);
        switch (action) {
          case "nextTab":
          case "prevTab":
          case "nextTerminal":
          case "prevTerminal": {
            const dir =
              action === "nextTab" || action === "nextTerminal" ? 1 : -1;
            if (residents.length > 1) {
              const cur = residents.findIndex(
                (t) => t.id === store.chatActiveId,
              );
              const next =
                residents[
                  (Math.max(cur, 0) + dir + residents.length) %
                    residents.length
                ];
              store.setChatActive(next.id);
            }
            event.preventDefault();
            return;
          }
          case "newTerminal": {
            // On the shown agent's host; the first agent falls back to local.
            const shown =
              residents.find((t) => t.id === store.chatActiveId) ??
              residents[0];
            const connId = shown?.connId ?? store.localConnId;
            if (connId) {
              const label =
                connId === store.localConnId
                  ? "pwsh"
                  : (store.wsls.find((w) => w.conn.connId === connId)?.conn
                      .name ??
                    store.remotes.find((r) => r.conn.connId === connId)?.conn
                      .name ??
                    "shell");
              void store.openAgentInChat(connId, label);
            }
            event.preventDefault();
            return;
          }
          case "zoomIn":
          case "zoomOut":
          case "zoomReset":
            break; // terminal font sizing — fine in the focus view
          default:
            event.preventDefault();
            return;
        }
      }

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
          if (!inEditable && !inTransfer && store.selected) {
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
          if (!inEditable && !inTransfer && targets.length) {
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
          // On the focused terminal's host; otherwise the panel's selected
          // group (so it works from the empty-group screen and its hint),
          // falling back to local. Reveals the panel either way.
          const focusedConn = inTerminal
            ? (target?.closest(".terminal-host") as HTMLElement | null)
                ?.dataset.connId
            : undefined;
          const g = store.termGroup;
          const groupConn =
            g &&
            (g === store.localConnId ||
              store.wsls.some((w) => w.conn.connId === g) ||
              store.remotes.some((r) => r.conn.connId === g))
              ? g
              : store.localConnId;
          const connId = focusedConn ?? groupConn ?? undefined;
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
        case "prevTerminal": {
          // "Next tab of whatever I'm in": CHAT cycles its residents; the
          // terminal panel cycles its tabs (host groups, then tool views);
          // anywhere else it's the editor's next/previous tab (VS Code's
          // Ctrl+PageDown).
          const dir = (action === "nextTerminal" ? 1 : -1) as 1 | -1;
          if (target?.closest(".chat-panel")) {
            const residents = store.terminals.filter((t) => t.inChat);
            if (residents.length > 1) {
              const cur = residents.findIndex(
                (t) => t.id === store.chatActiveId,
              );
              const next =
                residents[
                  (Math.max(cur, 0) + dir + residents.length) %
                    residents.length
                ];
              store.setChatActive(next.id);
              event.preventDefault();
            }
          } else if (target?.closest(".terminal-panel")) {
            cycleTerminalPanelTab(dir);
            event.preventDefault();
          } else if (store.tabs.length > 1) {
            store.cycleTab(dir);
            event.preventDefault();
          }
          break;
        }
        case "toggleSourceControl":
          useVcsStore.getState().toggleScm();
          event.preventDefault();
          break;
        case "toggleChat":
          store.toggleChat();
          // Debug WebView2 opens DevTools on Ctrl+Shift+I at the browser
          // level (preventDefault can't stop it) — slam them shut.
          void closeDevtools().catch(() => {});
          event.preventDefault();
          break;
        case "togglePanel":
          // Pure show/hide (VS Code's Ctrl+J) — wins even from the terminal.
          store.setTerminalVisible(!store.terminalVisible);
          event.preventDefault();
          break;
        case "splitRight":
          if (!inTerminal) {
            void allCommands().find((c) => c.id === "editor.splitRight")?.run();
            event.preventDefault();
          }
          break;
        case "focusGroup1":
        case "focusGroup2":
        case "focusGroup3": {
          // VS Code's Ctrl+1..3: focus (or create the next) editor group —
          // the way back to the editor without hiding the terminal.
          const id =
            action === "focusGroup1"
              ? "editor.focusGroup1"
              : action === "focusGroup2"
                ? "editor.focusGroup2"
                : "editor.focusGroup3";
          void allCommands().find((c) => c.id === id)?.run();
          event.preventDefault();
          break;
        }
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
          // Ctrl+W / Ctrl+F4 must not close a tab while the terminal is
          // focused. Closing the LAST file also closes its split
          // (groupsPatch); on a focused EMPTY split it closes the split.
          if (!inTerminal) {
            if (store.activeTabId) {
              store.closeTab(store.activeTabId);
              event.preventDefault();
            } else if (store.editorGroups.length > 1) {
              store.closeGroup(store.activeGroupId);
              store.requestEditorFocus();
              event.preventDefault();
            }
          }
          break;
        case "findInFile": {
          if (inTerminal) break; // the shell keeps its own Ctrl+F
          // Not while typing in an input / the commit box (Monaco's hidden
          // textarea is fine — Monaco handles its own Ctrl+F before us).
          const typing =
            !!target?.closest("input, [contenteditable=true]") ||
            (target instanceof HTMLTextAreaElement &&
              !target.closest(".monaco-host"));
          if (typing) break;
          const tab = store.tabs.find((t) => t.id === store.activeTabId);
          if (tab && (!tab.kind || tab.kind === "file") && !tab.isBinary) {
            if (openFindIn(tab.id)) event.preventDefault();
          }
          break;
        }
        case "refreshTree":
          // Ctrl+Shift+R is a global "refresh everything" — all sections.
          store.refreshLocal();
          store.refreshRemote();
          store.refreshWsl();
          event.preventDefault();
          break;
      }
    }

    // F11 must fire from ANY focus — Monaco and the tree consume keys they
    // don't know before those bubble to the window handler, so the focus view
    // listens at the CAPTURE phase and wins everywhere.
    function onKeyDownCapture(event: KeyboardEvent) {
      if (matchShortcut(event) === "focusView") {
        toggleFocusView();
        event.preventDefault();
        event.stopPropagation();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keydown", onKeyDownCapture, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keydown", onKeyDownCapture, true);
    };
  }, []);
}
