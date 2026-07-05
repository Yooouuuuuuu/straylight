/** Theme layer: applies the settings.json `editor` / `terminal` color sections
 *  to Monaco and to every live xterm, and ships the built-in presets. A preset
 *  is not a mode — "Theme: Nord" just overwrites the three color sections in
 *  settings.json with Nord's values; every key stays individually editable and
 *  deleting keys falls back to Dracula. */
import type { ITheme, Terminal } from "@xterm/xterm";

import { monaco } from "./monaco";
import { editorColors, setOnSettingsApplied, terminalColors, updateSettings } from "./settings";

// ---- contract keys + Dracula defaults --------------------------------------

/** Editor section keys (settings.json contract). */
export const EDITOR_DEFAULTS: Record<string, string> = {
  background: "#282A36",
  foreground: "#F8F8F2",
  cursor: "#F8F8F2",
  selection: "#44475A",
  lineHighlight: "#343746",
  widget: "#21222C",
  comment: "#6272A4",
  keyword: "#FF79C6",
  string: "#F1FA8C",
  number: "#BD93F9",
  type: "#8BE9FD",
  function: "#50FA7B",
  variable: "#F8F8F2",
  constant: "#BD93F9",
  operator: "#FF79C6",
};

/** Terminal section keys — exactly xterm's ITheme color names. */
export const TERMINAL_DEFAULTS: Record<string, string> = {
  background: "#282A36",
  foreground: "#F8F8F2",
  cursor: "#F8F8F2",
  cursorAccent: "#282A36",
  selectionBackground: "#44475A",
  black: "#21222C",
  red: "#FF5555",
  green: "#50FA7B",
  yellow: "#F1FA8C",
  blue: "#BD93F9",
  magenta: "#FF79C6",
  cyan: "#8BE9FD",
  white: "#F8F8F2",
  brightBlack: "#6272A4",
  brightRed: "#FF6E6E",
  brightGreen: "#69FF94",
  brightYellow: "#FFFFA5",
  brightBlue: "#D6ACFF",
  brightMagenta: "#FF92DF",
  brightCyan: "#A4FFFF",
  brightWhite: "#FFFFFF",
};

// ---- application ------------------------------------------------------------

const CUSTOM_THEME = "straylight-custom";

function buildMonacoTheme(): monaco.editor.IStandaloneThemeData {
  const g = (k: string) => editorColors[k] ?? EDITOR_DEFAULTS[k];
  const hex = (k: string) => g(k).replace("#", "");
  return {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: hex("foreground") },
      { token: "comment", foreground: hex("comment"), fontStyle: "italic" },
      { token: "keyword", foreground: hex("keyword") },
      { token: "string", foreground: hex("string") },
      { token: "number", foreground: hex("number") },
      { token: "type", foreground: hex("type"), fontStyle: "italic" },
      { token: "function", foreground: hex("function") },
      { token: "variable", foreground: hex("variable") },
      { token: "constant", foreground: hex("constant") },
      { token: "operator", foreground: hex("operator") },
      { token: "delimiter", foreground: hex("foreground") },
      { token: "tag", foreground: hex("keyword") },
      { token: "attribute.name", foreground: hex("function") },
      { token: "attribute.value", foreground: hex("string") },
      { token: "regexp", foreground: hex("number") },
    ],
    colors: {
      "editor.background": g("background"),
      "editor.foreground": g("foreground"),
      "editor.lineHighlightBackground": g("lineHighlight"),
      "editor.selectionBackground": g("selection"),
      "editorCursor.foreground": g("cursor"),
      "editorWhitespace.foreground": g("selection"),
      "editorLineNumber.foreground": g("comment"),
      "editorLineNumber.activeForeground": g("foreground"),
      "editor.findMatchBackground": `${g("selection")}CC`,
      "editor.findMatchHighlightBackground": `${g("selection")}66`,
      "editorWidget.background": g("widget"),
      "editorWidget.border": g("selection"),
      "editorSuggestWidget.background": g("widget"),
      "editorSuggestWidget.border": g("selection"),
      "editorSuggestWidget.selectedBackground": g("selection"),
      "editorGutter.background": g("background"),
      "editorIndentGuide.background1": g("lineHighlight"),
      "editorIndentGuide.activeBackground1": g("selection"),
      "scrollbarSlider.background": `${g("selection")}80`,
      "scrollbarSlider.hoverBackground": `${g("selection")}BB`,
      "scrollbarSlider.activeBackground": g("comment"),
      "minimap.background": g("widget"),
    },
  };
}

/** The effective terminal theme (defaults + settings overrides). */
export function currentTermTheme(): ITheme {
  const out: Record<string, string> = { ...TERMINAL_DEFAULTS };
  for (const [k, v] of Object.entries(terminalColors)) {
    if (k in TERMINAL_DEFAULTS && typeof v === "string" && v.trim()) out[k] = v;
  }
  return out as unknown as ITheme;
}

// Live terminals, re-themed in place when settings change.
const liveTerminals = new Set<Terminal>();

export function registerTerminal(term: Terminal): void {
  liveTerminals.add(term);
}

export function unregisterTerminal(term: Terminal): void {
  liveTerminals.delete(term);
}

function applyThemeLayers(): void {
  monaco.editor.defineTheme(CUSTOM_THEME, buildMonacoTheme());
  monaco.editor.setTheme(CUSTOM_THEME);
  const theme = currentTermTheme();
  for (const term of liveTerminals) term.options.theme = theme;
}

/** Hook the theme layer into settings (called once at startup). */
export function initThemes(): void {
  setOnSettingsApplied(applyThemeLayers);
}

// ---- presets ----------------------------------------------------------------

interface ThemePreset {
  id: string;
  title: string;
  ui: Record<string, string>;
  editor: Record<string, string>;
  terminal: Record<string, string>;
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: "theme.dracula",
    title: "Theme: Dracula (default)",
    // Empty sections = every key falls back to the built-in defaults.
    ui: {},
    editor: {},
    terminal: {},
  },
  {
    id: "theme.nord",
    title: "Theme: Nord",
    ui: {
      "bg-primary": "#2e3440", "bg-secondary": "#272c36", "bg-tertiary": "#3b4252",
      "bg-selected": "#434c5e", "fg-primary": "#eceff4", "fg-secondary": "#7b88a1",
      cyan: "#88c0d0", green: "#a3be8c", orange: "#d08770", pink: "#b48ead",
      purple: "#81a1c1", red: "#bf616a", yellow: "#ebcb8b",
      border: "#434c5e", "border-focus": "#7b88a1",
      scrollbar: "#434c5e", "scrollbar-hover": "#4c566a",
      success: "#a3be8c", warning: "#d08770", error: "#bf616a", info: "#88c0d0",
      accent: "#88c0d0",
    },
    editor: {
      background: "#2e3440", foreground: "#d8dee9", cursor: "#d8dee9",
      selection: "#434c5e", lineHighlight: "#3b4252", widget: "#272c36",
      comment: "#616e88", keyword: "#81a1c1", string: "#a3be8c",
      number: "#b48ead", type: "#8fbcbb", function: "#88c0d0",
      variable: "#d8dee9", constant: "#b48ead", operator: "#81a1c1",
    },
    terminal: {
      background: "#2e3440", foreground: "#d8dee9", cursor: "#d8dee9",
      cursorAccent: "#2e3440", selectionBackground: "#434c5e",
      black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
      blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
      brightBlack: "#4c566a", brightRed: "#bf616a", brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b", brightBlue: "#81a1c1", brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb", brightWhite: "#eceff4",
    },
  },
  {
    id: "theme.catppuccinMocha",
    title: "Theme: Catppuccin Mocha",
    ui: {
      "bg-primary": "#1e1e2e", "bg-secondary": "#181825", "bg-tertiary": "#313244",
      "bg-selected": "#45475a", "fg-primary": "#cdd6f4", "fg-secondary": "#7f849c",
      cyan: "#89dceb", green: "#a6e3a1", orange: "#fab387", pink: "#f5c2e7",
      purple: "#cba6f7", red: "#f38ba8", yellow: "#f9e2af",
      border: "#45475a", "border-focus": "#7f849c",
      scrollbar: "#45475a", "scrollbar-hover": "#585b70",
      success: "#a6e3a1", warning: "#fab387", error: "#f38ba8", info: "#89dceb",
      accent: "#cba6f7",
    },
    editor: {
      background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc",
      selection: "#45475a", lineHighlight: "#313244", widget: "#181825",
      comment: "#6c7086", keyword: "#cba6f7", string: "#a6e3a1",
      number: "#fab387", type: "#f9e2af", function: "#89b4fa",
      variable: "#cdd6f4", constant: "#fab387", operator: "#94e2d5",
    },
    terminal: {
      background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc",
      cursorAccent: "#1e1e2e", selectionBackground: "#45475a",
      black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
      blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5", white: "#bac2de",
      brightBlack: "#585b70", brightRed: "#f38ba8", brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af", brightBlue: "#89b4fa", brightMagenta: "#f5c2e7",
      brightCyan: "#94e2d5", brightWhite: "#a6adc8",
    },
  },
];

/** Overwrite settings.json's color sections with a preset's values. */
export async function applyThemePreset(preset: ThemePreset): Promise<void> {
  await updateSettings({
    colors: preset.ui,
    editor: preset.editor,
    terminal: preset.terminal,
  });
}
