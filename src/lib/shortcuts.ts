/**
 * Keybinding definitions. The full VS Code-style table (fuzzy finder, tab
 * cycling, etc.) lands alongside the features that need it in later phases; for
 * Phase 1 we wire the shortcuts that act on what already exists.
 */

export type ShortcutAction =
  | "saveFile"
  | "quickOpen"
  | "searchInFiles"
  | "appRefresh"
  | "nextTab"
  | "prevTab"
  | "renameSelected"
  | "deleteSelected"
  | "toggleTerminal"
  | "newTerminal"
  | "nextTerminal"
  | "prevTerminal"
  | "toggleSidebar"
  | "focusFileExplorer"
  | "closeFile"
  | "refreshTree";

export interface Shortcut {
  action: ShortcutAction;
  /** `KeyboardEvent.key`, compared case-insensitively. */
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  description: string;
  label: string;
}

export const SHORTCUTS: Shortcut[] = [
  {
    action: "saveFile",
    key: "s",
    ctrl: true,
    description: "Save the current file",
    label: "Ctrl+S",
  },
  {
    action: "quickOpen",
    key: "p",
    ctrl: true,
    description: "Quick-open a file by name",
    label: "Ctrl+P",
  },
  {
    action: "searchInFiles",
    key: "f",
    ctrl: true,
    shift: true,
    description: "Search across files",
    label: "Ctrl+Shift+F",
  },
  // Replaces the WebView page reload: refresh explorer + repos + open files.
  {
    action: "appRefresh",
    key: "F5",
    description: "Refresh everything (explorer, repos, open files)",
    label: "F5",
  },
  {
    action: "appRefresh",
    key: "r",
    ctrl: true,
    description: "Refresh everything (explorer, repos, open files)",
    label: "Ctrl+R",
  },
  {
    action: "nextTab",
    key: "Tab",
    ctrl: true,
    description: "Next tab",
    label: "Ctrl+Tab",
  },
  {
    action: "prevTab",
    key: "Tab",
    ctrl: true,
    shift: true,
    description: "Previous tab",
    label: "Ctrl+Shift+Tab",
  },
  {
    action: "renameSelected",
    key: "F2",
    description: "Rename the selected item",
    label: "F2",
  },
  {
    action: "deleteSelected",
    key: "Delete",
    description: "Delete the selected item",
    label: "Del",
  },
  {
    action: "toggleTerminal",
    key: "`",
    ctrl: true,
    description: "Toggle the terminal panel",
    label: "Ctrl+`",
  },
  {
    action: "newTerminal",
    key: "`",
    ctrl: true,
    shift: true,
    description: "Open a new terminal",
    label: "Ctrl+Shift+`",
  },
  {
    action: "nextTerminal",
    key: "PageDown",
    ctrl: true,
    description: "Next terminal",
    label: "Ctrl+PageDown",
  },
  {
    action: "prevTerminal",
    key: "PageUp",
    ctrl: true,
    description: "Previous terminal",
    label: "Ctrl+PageUp",
  },
  {
    action: "toggleSidebar",
    key: "b",
    ctrl: true,
    description: "Toggle the sidebar",
    label: "Ctrl+B",
  },
  {
    action: "focusFileExplorer",
    key: "e",
    ctrl: true,
    shift: true,
    description: "Focus the file explorer",
    label: "Ctrl+Shift+E",
  },
  {
    action: "closeFile",
    key: "w",
    ctrl: true,
    description: "Close the current file",
    label: "Ctrl+W",
  },
  {
    action: "refreshTree",
    key: "r",
    ctrl: true,
    shift: true,
    description: "Refresh the file tree",
    label: "Ctrl+Shift+R",
  },
];

/** Resolve a keyboard event to a shortcut action, if any. Treats Cmd as Ctrl. */
export function matchShortcut(event: KeyboardEvent): ShortcutAction | null {
  const ctrl = event.ctrlKey || event.metaKey;
  // Match the backtick on its physical key or the "~" it yields under Shift, so
  // Ctrl+` and Ctrl+Shift+` both resolve (event.key alone would miss the latter).
  const key =
    event.code === "Backquote" || event.key === "~"
      ? "`"
      : event.key.toLowerCase();

  for (const shortcut of SHORTCUTS) {
    if (
      !!shortcut.ctrl === ctrl &&
      !!shortcut.shift === event.shiftKey &&
      !!shortcut.alt === event.altKey &&
      shortcut.key.toLowerCase() === key
    ) {
      return shortcut.action;
    }
  }
  return null;
}

/** Actions that belong to the terminal. These are the *only* shortcuts that act
 *  while a terminal is focused — everything else is left to the shell, so
 *  Ctrl+B, Ctrl+R, Ctrl+W, Ctrl+E, etc. keep their readline/tmux meaning. xterm
 *  is told to ignore these so they reach the window handler. */
const TERMINAL_ACTIONS: ShortcutAction[] = [
  "toggleTerminal",
  "newTerminal",
  "nextTerminal",
  "prevTerminal",
];

export function isTerminalAction(action: ShortcutAction): boolean {
  return TERMINAL_ACTIONS.includes(action);
}

export function isPassthroughShortcut(event: KeyboardEvent): boolean {
  const action = matchShortcut(event);
  return action !== null && TERMINAL_ACTIONS.includes(action);
}
