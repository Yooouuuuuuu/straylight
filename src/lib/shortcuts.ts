/**
 * Keybinding definitions. The full VS Code-style table (fuzzy finder, tab
 * cycling, etc.) lands alongside the features that need it in later phases; for
 * Phase 1 we wire the shortcuts that act on what already exists.
 */

export type ShortcutAction =
  | "toggleTerminal"
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
    action: "toggleTerminal",
    key: "`",
    ctrl: true,
    description: "Toggle the terminal panel",
    label: "Ctrl+`",
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
  const key = event.key.toLowerCase();

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
