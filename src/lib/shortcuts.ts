/**
 * Keybinding definitions. Every shortcut carries the **command id** it belongs
 * to (the stable, user-facing name used by the palette and by keybinding
 * overrides in settings.json). Defaults follow VS Code / OS conventions; users
 * remap by id via `"keybindings": { "search.inFiles": "ctrl+alt+f" }`.
 */

export type ShortcutAction =
  | "saveFile"
  | "quickOpen"
  | "searchInFiles"
  | "appRefresh"
  | "markdownPreview"
  | "commandPalette"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "copyPathSelected"
  | "propertiesSelected"
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
  | "refreshTree"
  | "findInFile"
  | "toggleSourceControl"
  | "toggleChat"
  | "splitRight"
  | "togglePanel"
  | "focusGroup1"
  | "focusGroup2"
  | "focusGroup3";

export interface Shortcut {
  /** Stable command id (the contract) — palette + overrides reference this. */
  id: string;
  action: ShortcutAction;
  /** `KeyboardEvent.key`, compared case-insensitively. */
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  description: string;
  label: string;
  /** Never pass THIS binding through from a focused terminal, even when its
   *  action is terminal-capable — e.g. Ctrl+J toggles the panel outside a
   *  shell but stays the shell's newline inside one. */
  noTerminal?: boolean;
}

/** The default keybinding table. Never mutated — overrides produce a copy. */
export const SHORTCUTS: Shortcut[] = [
  { id: "file.save", action: "saveFile", key: "s", ctrl: true, description: "Save the current file", label: "Ctrl+S" },
  { id: "file.quickOpen", action: "quickOpen", key: "p", ctrl: true, description: "Quick-open a file by name", label: "Ctrl+P" },
  { id: "search.inFiles", action: "searchInFiles", key: "f", ctrl: true, shift: true, description: "Search across files", label: "Ctrl+Shift+F" },
  // Opens Monaco's find on the ACTIVE file from anywhere (the explorer keeps
  // focus after a single-click preview, so Monaco alone would never see it).
  // Not in the terminal passthrough list — a shell keeps its own Ctrl+F.
  { id: "editor.find", action: "findInFile", key: "f", ctrl: true, description: "Find in the current file", label: "Ctrl+F" },
  { id: "file.markdownPreview", action: "markdownPreview", key: "v", ctrl: true, shift: true, description: "Open the Markdown preview for the current file", label: "Ctrl+Shift+V" },
  { id: "app.commandPalette", action: "commandPalette", key: "p", ctrl: true, shift: true, description: "Show all commands", label: "Ctrl+Shift+P" },
  // Replaces the WebView page reload: refresh explorer + repos + open files.
  { id: "app.refreshAll", action: "appRefresh", key: "F5", description: "Refresh everything (explorer, repos, open files)", label: "F5" },
  { id: "app.refreshAll", action: "appRefresh", key: "r", ctrl: true, description: "Refresh everything (explorer, repos, open files)", label: "Ctrl+R" },
  { id: "view.zoomIn", action: "zoomIn", key: "=", ctrl: true, description: "Zoom in", label: "Ctrl+=" },
  { id: "view.zoomIn", action: "zoomIn", key: "+", ctrl: true, description: "Zoom in", label: "Ctrl++" },
  { id: "view.zoomOut", action: "zoomOut", key: "-", ctrl: true, description: "Zoom out", label: "Ctrl+-" },
  { id: "view.zoomReset", action: "zoomReset", key: "0", ctrl: true, description: "Reset zoom", label: "Ctrl+0" },
  { id: "explorer.copyPath", action: "copyPathSelected", key: "c", shift: true, alt: true, description: "Copy the selected item's path", label: "Shift+Alt+C" },
  { id: "explorer.properties", action: "propertiesSelected", key: "Enter", alt: true, description: "Properties of the selected item", label: "Alt+Enter" },
  { id: "editor.nextTab", action: "nextTab", key: "Tab", ctrl: true, description: "Next tab", label: "Ctrl+Tab" },
  { id: "editor.previousTab", action: "prevTab", key: "Tab", ctrl: true, shift: true, description: "Previous tab", label: "Ctrl+Shift+Tab" },
  { id: "explorer.rename", action: "renameSelected", key: "F2", description: "Rename the selected item", label: "F2" },
  { id: "explorer.delete", action: "deleteSelected", key: "Delete", description: "Delete the selected item", label: "Del" },
  { id: "terminal.toggle", action: "toggleTerminal", key: "`", ctrl: true, description: "Toggle the terminal panel", label: "Ctrl+`" },
  { id: "terminal.new", action: "newTerminal", key: "`", ctrl: true, shift: true, description: "New terminal — on the focused terminal's host, else the selected group", label: "Ctrl+Shift+`" },
  // Context keys (VS Code-style): next/previous tab of whatever is focused —
  // the terminal panel's tabs (host groups, then tool views) or, anywhere
  // else, the editor's tabs. CHAT cycles its residents.
  { id: "terminal.next", action: "nextTerminal", key: "PageDown", ctrl: true, description: "Next tab — terminal panel when focused, else editor", label: "Ctrl+PageDown" },
  { id: "terminal.previous", action: "prevTerminal", key: "PageUp", ctrl: true, description: "Previous tab — terminal panel when focused, else editor", label: "Ctrl+PageUp" },
  { id: "view.toggleSidebar", action: "toggleSidebar", key: "b", ctrl: true, description: "Toggle the sidebar", label: "Ctrl+B" },
  { id: "view.toggleSourceControl", action: "toggleSourceControl", key: "g", ctrl: true, shift: true, description: "Toggle Source Control", label: "Ctrl+Shift+G" },
  { id: "view.toggleChat", action: "toggleChat", key: "i", ctrl: true, alt: true, description: "Toggle the CHAT column", label: "Ctrl+Alt+I" },
  // Second CHAT binding (VS Code pairs Ctrl+Alt+I with Ctrl+Shift+I). In dev
  // builds the WebView may grab this one for DevTools; packaged builds don't.
  { id: "view.toggleChat", action: "toggleChat", key: "i", ctrl: true, shift: true, description: "Toggle the CHAT column", label: "Ctrl+Shift+I" },
  { id: "editor.splitRight", action: "splitRight", key: "\\", ctrl: true, description: "Split right — move the file over, or open an empty pane", label: "Ctrl+\\" },
  // VS Code's Ctrl+J: pure show/hide of the panel — it wins over the shell
  // (VS Code also steals Ctrl+J from the terminal for this).
  { id: "view.togglePanel", action: "togglePanel", key: "j", ctrl: true, description: "Show/hide the terminal panel", label: "Ctrl+J" },
  // VS Code's way back to the editor without hiding the terminal.
  { id: "editor.focusGroup1", action: "focusGroup1", key: "1", ctrl: true, description: "Focus editor group 1", label: "Ctrl+1" },
  { id: "editor.focusGroup2", action: "focusGroup2", key: "2", ctrl: true, description: "Focus editor group 2", label: "Ctrl+2" },
  { id: "editor.focusGroup3", action: "focusGroup3", key: "3", ctrl: true, description: "Focus editor group 3", label: "Ctrl+3" },
  { id: "explorer.focus", action: "focusFileExplorer", key: "e", ctrl: true, shift: true, description: "Focus the file explorer", label: "Ctrl+Shift+E" },
  { id: "editor.closeTab", action: "closeFile", key: "w", ctrl: true, description: "Close the current file (or empty split)", label: "Ctrl+W" },
  { id: "editor.closeTab", action: "closeFile", key: "F4", ctrl: true, description: "Close the current file (or empty split)", label: "Ctrl+F4" },
  { id: "explorer.refreshTrees", action: "refreshTree", key: "r", ctrl: true, shift: true, description: "Refresh the file tree", label: "Ctrl+Shift+R" },
];

/** The active table: defaults, or defaults + settings.json overrides. */
let effective: Shortcut[] = SHORTCUTS;

/** Parse a settings.json key string like "ctrl+shift+f", "f5", "alt+enter". */
function parseKeySpec(spec: string): Pick<Shortcut, "key" | "ctrl" | "shift" | "alt"> | null {
  const parts = spec
    .split("+")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const out = { key: "", ctrl: false, shift: false, alt: false };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "ctrl" || lower === "cmd" || lower === "meta") out.ctrl = true;
    else if (lower === "shift") out.shift = true;
    else if (lower === "alt") out.alt = true;
    else if (out.key === "") out.key = part;
    else return null; // two non-modifier keys — chords aren't supported
  }
  return out.key ? out : null;
}

function formatLabel(s: Pick<Shortcut, "key" | "ctrl" | "shift" | "alt">): string {
  const mods = [s.ctrl ? "Ctrl" : "", s.shift ? "Shift" : "", s.alt ? "Alt" : ""].filter(Boolean);
  const key = s.key.length === 1 ? s.key.toUpperCase() : s.key;
  return [...mods, key].join("+");
}

/** Apply overrides (command id → key spec) from settings.json. Returns
 *  human-readable issues for anything skipped; valid entries still apply. */
export function applyKeybindingOverrides(overrides: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const knownIds = new Set(SHORTCUTS.map((s) => s.id));
  const parsed = new Map<string, Pick<Shortcut, "key" | "ctrl" | "shift" | "alt">>();

  for (const [id, spec] of Object.entries(overrides)) {
    if (!knownIds.has(id)) {
      issues.push(`keybindings: unknown command "${id}"`);
      continue;
    }
    if (typeof spec !== "string") {
      issues.push(`keybindings: "${id}" must be a string like "ctrl+shift+f"`);
      continue;
    }
    const p = parseKeySpec(spec);
    if (!p) {
      issues.push(`keybindings: can't parse "${spec}" for "${id}" (chords unsupported)`);
      continue;
    }
    parsed.set(id, p);
  }

  effective = SHORTCUTS.map((s) => {
    const p = parsed.get(s.id);
    return p ? { ...s, ...p, label: formatLabel(p) } : s;
  });
  return issues;
}

/** The effective (possibly overridden) key label for a command id, if bound. */
export function keyLabelFor(commandId: string): string | null {
  return effective.find((s) => s.id === commandId)?.label ?? null;
}

/** Resolve a keyboard event to its shortcut entry, if any. Treats Cmd as Ctrl. */
function findShortcut(event: KeyboardEvent): Shortcut | null {
  const ctrl = event.ctrlKey || event.metaKey;
  // Match the backtick on its physical key or the "~" it yields under Shift, so
  // Ctrl+` and Ctrl+Shift+` both resolve (event.key alone would miss the latter).
  const key =
    event.code === "Backquote" || event.key === "~"
      ? "`"
      : event.key.toLowerCase();

  for (const shortcut of effective) {
    if (
      !!shortcut.ctrl === ctrl &&
      !!shortcut.shift === event.shiftKey &&
      !!shortcut.alt === event.altKey &&
      shortcut.key.toLowerCase() === key
    ) {
      return shortcut;
    }
  }
  return null;
}

/** Resolve a keyboard event to a shortcut action, if any. */
export function matchShortcut(event: KeyboardEvent): ShortcutAction | null {
  return findShortcut(event)?.action ?? null;
}

/** Actions that belong to the terminal. These are the *only* shortcuts that act
 *  while a terminal is focused — everything else is left to the shell, so
 *  Ctrl+B, Ctrl+R, Ctrl+W, Ctrl+E, etc. keep their readline/tmux meaning. xterm
 *  is told to ignore these so they reach the window handler. Ctrl+±/0 are here
 *  because in a terminal they resize the terminal font (not the app zoom). */
const TERMINAL_ACTIONS: ShortcutAction[] = [
  "toggleTerminal",
  "newTerminal",
  "nextTerminal",
  "prevTerminal",
  "zoomIn",
  "zoomOut",
  "zoomReset",
  // Jumping out of the terminal is exactly when these are needed.
  "toggleChat",
  "toggleSourceControl",
  "togglePanel",
  "focusGroup1",
  "focusGroup2",
  "focusGroup3",
];

export function isPassthroughShortcut(event: KeyboardEvent): boolean {
  const s = findShortcut(event);
  return s !== null && TERMINAL_ACTIONS.includes(s.action) && !s.noTerminal;
}
