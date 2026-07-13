/** Theme layer: applies the settings.json `editor` / `terminal` color sections
 *  to Monaco and to every live xterm, and ships the built-in presets. A preset
 *  is not a mode — "Theme: Nord" just overwrites the color sections in
 *  settings.json with Nord's values; every key stays individually editable and
 *  deleting keys falls back to the built-in default (Straylight). */
import type { ITheme, Terminal } from "@xterm/xterm";

import { monaco } from "./monaco";
import {
  editorColors,
  savedThemes,
  setOnSettingsApplied,
  setThemeTemplate,
  terminalFontConfig,
  terminalLocalColors,
  terminalRemoteColors,
  terminalWslColors,
  UI_COLOR_DEFAULTS,
  uiColors,
  updateSettings,
  type Settings,
  type ThemeData,
} from "./settings";
import { useAppStore } from "../store/appStore";

// ---- contract keys + Straylight (built-in default) values -------------------

/** Editor section keys (settings.json contract). */
export const EDITOR_DEFAULTS: Record<string, string> = {
  background: "#151013",
  foreground: "#f0e7e9",
  cursor: "#f30100",
  selection: "#46232c",
  lineHighlight: "#221418",
  widget: "#0f0b0d",
  comment: "#7a5f66",
  keyword: "#ff4d6d",
  string: "#5ce626",
  number: "#ff00ff",
  type: "#ffb454",
  function: "#ff7a9c",
  variable: "#f0e7e9",
  constant: "#ff00ff",
  operator: "#ff4d6d",
};

/** Terminal section keys — exactly xterm's ITheme color names. */
export const TERMINAL_DEFAULTS: Record<string, string> = {
  background: "#151013",
  foreground: "#f0e7e9",
  cursor: "#f30100",
  cursorAccent: "#151013",
  selectionBackground: "#46232c",
  black: "#241a1e",
  red: "#f30100",
  green: "#5ce626",
  yellow: "#ffb454",
  blue: "#e0446a",
  magenta: "#ff00ff",
  cyan: "#ff7a9c",
  white: "#f0e7e9",
  brightBlack: "#8a6f76",
  brightRed: "#ff5c5c",
  brightGreen: "#8aff5c",
  brightYellow: "#ffd28a",
  brightBlue: "#ff7a9c",
  brightMagenta: "#ff66ff",
  brightCyan: "#ffb3c8",
  brightWhite: "#ffffff",
};

// ---- application ------------------------------------------------------------

const CUSTOM_THEME = "straylight-custom";

/** Rough perceived luminance of a #rrggbb color (0–1). */
function luminance(color: string): number {
  const m = /^#?([0-9a-f]{6})/i.exec(color.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function buildMonacoTheme(): monaco.editor.IStandaloneThemeData {
  const g = (k: string) => editorColors[k] ?? EDITOR_DEFAULTS[k];
  const hex = (k: string) => g(k).replace("#", "");
  return {
    // Light editor backgrounds need Monaco's light base (widget chrome,
    // shadows, and unthemed token fallbacks all follow it).
    base: luminance(g("background")) > 0.5 ? "vs" : "vs-dark",
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

export type TermScope = "local" | "wsl" | "remote";

/** The effective terminal theme for one shell kind: its settings section
 *  (`terminalLocal` / `terminalWsl` / `terminalRemote`) over the defaults. */
export function currentTermTheme(scope: TermScope): ITheme {
  const section =
    scope === "local"
      ? terminalLocalColors
      : scope === "wsl"
        ? terminalWslColors
        : terminalRemoteColors;
  const out: Record<string, string> = { ...TERMINAL_DEFAULTS };
  for (const [k, v] of Object.entries(section)) {
    if (k in TERMINAL_DEFAULTS && typeof v === "string" && v.trim()) out[k] = v;
  }
  return out as unknown as ITheme;
}

export const TERMINAL_FONT_DEFAULTS = {
  family: "'Fira Code', 'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
  size: 13,
};

/** The effective terminal font (settings `terminalFont` over defaults). */
export function currentTermFont(): { family: string; size: number } {
  return {
    family: terminalFontConfig.family ?? TERMINAL_FONT_DEFAULTS.family,
    size: terminalFontConfig.size ?? TERMINAL_FONT_DEFAULTS.size,
  };
}

/** Step the terminal font size (Ctrl+± while a terminal is focused) and
 *  persist it to settings.json; null resets to the default. All live
 *  terminals re-font and refit via the settings re-apply. */
export async function adjustTerminalFontSize(delta: number | null): Promise<void> {
  const size =
    delta === null
      ? TERMINAL_FONT_DEFAULTS.size
      : Math.min(40, Math.max(6, currentTermFont().size + delta));
  await updateSettings({ terminalFont: { ...terminalFontConfig, size } });
}

// Live terminals, re-themed/refit in place when settings change.
interface LiveTerminal {
  scope: TermScope;
  refit: () => void;
}
const liveTerminals = new Map<Terminal, LiveTerminal>();

export function registerTerminal(
  term: Terminal,
  opts: { scope?: TermScope; refit?: () => void } = {},
): void {
  liveTerminals.set(term, { scope: opts.scope ?? "local", refit: opts.refit ?? (() => {}) });
}

export function unregisterTerminal(term: Terminal): void {
  liveTerminals.delete(term);
}

function applyThemeLayers(): void {
  monaco.editor.defineTheme(CUSTOM_THEME, buildMonacoTheme());
  monaco.editor.setTheme(CUSTOM_THEME);
  const themes: Record<TermScope, ITheme> = {
    local: currentTermTheme("local"),
    wsl: currentTermTheme("wsl"),
    remote: currentTermTheme("remote"),
  };
  const font = currentTermFont();
  for (const [term, meta] of liveTerminals) {
    term.options.theme = themes[meta.scope];
    const fontChanged =
      term.options.fontFamily !== font.family || term.options.fontSize !== font.size;
    if (fontChanged) {
      term.options.fontFamily = font.family;
      term.options.fontSize = font.size;
      meta.refit(); // cell metrics changed — refit cols/rows to the container
    }
  }
}

/** Hook the theme layer into settings (called once at startup). Also supplies
 *  theme.json's first-run template: the FULL default (Straylight) sections, so
 *  the file documents every customizable key. */
export function initThemes(): void {
  setOnSettingsApplied(applyThemeLayers);
  setThemeTemplate(() => ({
    colors: { ...UI_COLOR_DEFAULTS },
    editor: { ...EDITOR_DEFAULTS },
    terminalLocal: { ...TERMINAL_DEFAULTS },
    terminalWsl: { ...TERMINAL_DEFAULTS },
    terminalRemote: {
      ...TERMINAL_DEFAULTS,
      background: "#070406",
      cursorAccent: "#070406",
      black: "#1a1114",
      selectionBackground: "#381b22",
    },
    themes: builtinThemeData(),
  }));
}

// ---- presets ----------------------------------------------------------------

interface ThemePreset {
  id: string;
  title: string;
  ui: Record<string, string>;
  editor: Record<string, string>;
  /** One full section per shell kind. Local and WSL ship the same scheme;
   *  remote is a darker variant so SSH shells read as "elsewhere". */
  terminalLocal: Record<string, string>;
  terminalWsl: Record<string, string>;
  terminalRemote: Record<string, string>;
}

// Terminal schemes, shared by a preset's local + WSL sections and used as the
// base of its (darker) remote section.
const TERM_DRACULA: Record<string, string> = {
  background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2",
  cursorAccent: "#282a36", selectionBackground: "#44475a",
  black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c",
  blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2",
  brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94",
  brightYellow: "#ffffa5", brightBlue: "#d6acff", brightMagenta: "#ff92df",
  brightCyan: "#a4ffff", brightWhite: "#ffffff",
};
const TERM_SOLARIZED_LIGHT: Record<string, string> = {
  background: "#fdf6e3", foreground: "#657b83", cursor: "#657b83",
  cursorAccent: "#fdf6e3", selectionBackground: "#dcd4b9",
  black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
  blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
  brightBlack: "#002b36", brightRed: "#cb4b16", brightGreen: "#586e75",
  brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
};
const TERM_CRIMSON: Record<string, string> = {
  background: "#1c070c", foreground: "#f5e6e8", cursor: "#ff00ff",
  cursorAccent: "#1c070c", selectionBackground: "#591a28",
  black: "#331018", red: "#f30100", green: "#5ce626", yellow: "#ffb454",
  blue: "#ff4d6d", magenta: "#ff00ff", cyan: "#ff8fb0", white: "#f5e6e8",
  brightBlack: "#a06a75", brightRed: "#ff5c5c", brightGreen: "#8aff5c",
  brightYellow: "#ffd28a", brightBlue: "#ff8fb0", brightMagenta: "#ff66ff",
  brightCyan: "#ffc2d4", brightWhite: "#ffffff",
};
const TERM_NEON: Record<string, string> = {
  background: "#0a0a0a", foreground: "#e8e8e8", cursor: "#5ce626",
  cursorAccent: "#0a0a0a", selectionBackground: "#3d0f17",
  black: "#1a1a1a", red: "#f30100", green: "#5ce626", yellow: "#9dff5c",
  blue: "#ff1744", magenta: "#ff00ff", cyan: "#ff40ff", white: "#e8e8e8",
  brightBlack: "#777777", brightRed: "#ff4d4d", brightGreen: "#8aff5c",
  brightYellow: "#c8ff8a", brightBlue: "#ff4d6d", brightMagenta: "#ff66ff",
  brightCyan: "#ff8aff", brightWhite: "#ffffff",
};
const TERM_NORD: Record<string, string> = {
  background: "#2e3440", foreground: "#d8dee9", cursor: "#d8dee9",
  cursorAccent: "#2e3440", selectionBackground: "#434c5e",
  black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
  blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
  brightBlack: "#4c566a", brightRed: "#bf616a", brightGreen: "#a3be8c",
  brightYellow: "#ebcb8b", brightBlue: "#81a1c1", brightMagenta: "#b48ead",
  brightCyan: "#8fbcbb", brightWhite: "#eceff4",
};
// Remote for the Dracula preset: the classic black console (Campbell), so an
// SSH shell is unmistakable at a glance.
const TERM_CAMPBELL: Record<string, string> = {
  background: "#000000", foreground: "#ffffff", cursor: "#ffffff",
  cursorAccent: "#000000", selectionBackground: "#3a3d41",
  black: "#0c0c0c", red: "#c50f1f", green: "#13a10e", yellow: "#c19c00",
  blue: "#3b78ff", magenta: "#881798", cyan: "#3a96dd", white: "#cccccc",
  brightBlack: "#767676", brightRed: "#e74856", brightGreen: "#16c60c",
  brightYellow: "#f9f1a5", brightBlue: "#3b78ff", brightMagenta: "#b4009e",
  brightCyan: "#61d6d6", brightWhite: "#f2f2f2",
};

export const THEME_PRESETS: ThemePreset[] = [
  {
    // The signature theme and the built-in default: near-black with a plum
    // cast, #AF011C as the chrome accent, supports used semantically
    // (green=success, magenta=special, bright red=errors/cursor). Written out
    // in full like every theme — a quick-theme pick is a pure data copy.
    id: "theme.straylight",
    title: "Theme: Straylight (default)",
    ui: { ...UI_COLOR_DEFAULTS },
    editor: { ...EDITOR_DEFAULTS },
    terminalLocal: { ...TERMINAL_DEFAULTS },
    terminalWsl: { ...TERMINAL_DEFAULTS },
    terminalRemote: {
      ...TERMINAL_DEFAULTS,
      background: "#070406", cursorAccent: "#070406", black: "#1a1114",
      selectionBackground: "#381b22",
    },
  },
  {
    // Immersive: the backgrounds themselves are dark crimson — the whole app
    // sits inside the #AF011C world. Bolder than "Straylight".
    id: "theme.straylightCrimson",
    title: "Theme: Straylight Crimson",
    ui: {
      "bg-primary": "#1c070c", "bg-secondary": "#120407", "bg-tertiary": "#331018",
      "bg-selected": "#4d1622", "fg-primary": "#f5e6e8", "fg-secondary": "#a06a75",
      cyan: "#ff8fb0", green: "#5ce626", orange: "#ff6a3d", pink: "#ff00ff",
      purple: "#ff4d6d", red: "#f30100", yellow: "#ffb454",
      "tree-root": "#f5e6e8", "tree-dir": "#f5e6e8", "section-fg": "#f5e6e8",
      "section-local": "#f30100", "section-wsl": "#ff0180", "section-remote": "#ff00ff",
      titlebar: "#f30100", "titlebar-fg": "#f5e6e8",
      "icon-folder": "#ff4d6d", "icon-folder-open": "#ff8fb0", pin: "#ff00ff",
      border: "#4d1622", "border-focus": "#f30100",
      scrollbar: "#4d1622", "scrollbar-hover": "#6b1e2e",
      success: "#5ce626", warning: "#ffb454", error: "#f30100", info: "#5ce626",
      accent: "#af011c",
    },
    editor: {
      background: "#1c070c", foreground: "#f5e6e8", cursor: "#ff00ff",
      selection: "#591a28", lineHighlight: "#2b0c13", widget: "#120407",
      comment: "#8f5a66", keyword: "#ff00ff", string: "#5ce626",
      number: "#f30100", type: "#ff8fb0", function: "#ff4d6d",
      variable: "#f5e6e8", constant: "#f30100", operator: "#ff4d6d",
    },
    terminalLocal: TERM_CRIMSON,
    terminalWsl: TERM_CRIMSON,
    terminalRemote: {
      ...TERM_CRIMSON,
      background: "#0d0306", cursorAccent: "#0d0306", black: "#240a10",
      selectionBackground: "#45121e",
    },
  },
  {
    // The full ride: pitch black, all four colors at maximum volume.
    id: "theme.straylightNeon",
    title: "Theme: Straylight Neon",
    ui: {
      "bg-primary": "#0a0a0a", "bg-secondary": "#050505", "bg-tertiary": "#1a1a1a",
      "bg-selected": "#2b0f14", "fg-primary": "#eeeeee", "fg-secondary": "#777777",
      cyan: "#ff00ff", green: "#5ce626", orange: "#f30100", pink: "#ff40ff",
      purple: "#ff1744", red: "#f30100", yellow: "#9dff5c",
      "tree-root": "#eeeeee", "tree-dir": "#eeeeee", "section-fg": "#eeeeee",
      "section-local": "#f30100", "section-wsl": "#ff0180", "section-remote": "#ff00ff",
      titlebar: "#f30100", "titlebar-fg": "#eeeeee",
      "icon-folder": "#f30100", "icon-folder-open": "#ff00ff", pin: "#ff00ff",
      border: "#2b0f14", "border-focus": "#f30100",
      scrollbar: "#331016", "scrollbar-hover": "#4d1620",
      success: "#5ce626", warning: "#f30100", error: "#f30100", info: "#5ce626",
      accent: "#af011c",
    },
    editor: {
      background: "#0a0a0a", foreground: "#e8e8e8", cursor: "#5ce626",
      selection: "#3d0f17", lineHighlight: "#161014", widget: "#050505",
      comment: "#5c4448", keyword: "#ff00ff", string: "#5ce626",
      number: "#f30100", type: "#ff40ff", function: "#ff1744",
      variable: "#e8e8e8", constant: "#f30100", operator: "#ff00ff",
    },
    terminalLocal: TERM_NEON,
    terminalWsl: TERM_NEON,
    terminalRemote: {
      ...TERM_NEON,
      background: "#000000", cursorAccent: "#000000", black: "#111111",
      selectionBackground: "#330d14",
    },
  },
  {
    id: "theme.dracula",
    title: "Theme: Dracula",
    ui: {
      "bg-primary": "#282a36", "bg-secondary": "#21222c", "bg-tertiary": "#343746",
      "bg-selected": "#44475a", "fg-primary": "#f8f8f2", "fg-secondary": "#6272a4",
      cyan: "#8be9fd", green: "#50fa7b", orange: "#ffb86c", pink: "#ff79c6",
      purple: "#bd93f9", red: "#ff5555", yellow: "#f1fa8c",
      "tree-root": "#f8f8f2", "tree-dir": "#f8f8f2", "section-fg": "#21222c",
      "section-local": "#ff5555", "section-wsl": "#ff79c6", "section-remote": "#bd93f9",
      titlebar: "#21222c", "titlebar-fg": "#f8f8f2",
      "icon-folder": "#bd93f9", "icon-folder-open": "#8be9fd", pin: "#ff79c6",
      border: "#44475a", "border-focus": "#6272a4",
      scrollbar: "#44475a", "scrollbar-hover": "#6272a4",
      success: "#50fa7b", warning: "#ffb86c", error: "#ff5555", info: "#8be9fd",
      accent: "#bd93f9",
    },
    editor: {
      background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2",
      selection: "#44475a", lineHighlight: "#343746", widget: "#21222c",
      comment: "#6272a4", keyword: "#ff79c6", string: "#f1fa8c",
      number: "#bd93f9", type: "#8be9fd", function: "#50fa7b",
      variable: "#f8f8f2", constant: "#bd93f9", operator: "#ff79c6",
    },
    terminalLocal: TERM_DRACULA,
    terminalWsl: TERM_DRACULA,
    terminalRemote: TERM_CAMPBELL,
  },
  {
    id: "theme.nord",
    title: "Theme: Nord",
    ui: {
      "bg-primary": "#2e3440", "bg-secondary": "#272c36", "bg-tertiary": "#3b4252",
      "bg-selected": "#434c5e", "fg-primary": "#eceff4", "fg-secondary": "#7b88a1",
      cyan: "#88c0d0", green: "#a3be8c", orange: "#d08770", pink: "#b48ead",
      purple: "#81a1c1", red: "#bf616a", yellow: "#ebcb8b",
      "tree-root": "#eceff4", "tree-dir": "#eceff4", "section-fg": "#2e3440",
      "section-local": "#bf616a", "section-wsl": "#b48ead", "section-remote": "#81a1c1",
      titlebar: "#3b4252", "titlebar-fg": "#eceff4",
      "icon-folder": "#81a1c1", "icon-folder-open": "#88c0d0", pin: "#b48ead",
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
    terminalLocal: TERM_NORD,
    terminalWsl: TERM_NORD,
    terminalRemote: {
      ...TERM_NORD,
      background: "#242933", cursorAccent: "#242933", black: "#2e3440",
      selectionBackground: "#3b4252",
    },
  },
  {
    // The famous light theme. `section-fg` and `accent` invert (light text on
    // the blue accent bars); the remote terminal sits on the darker paper tone.
    id: "theme.solarizedLight",
    title: "Theme: Solarized Light",
    ui: {
      "bg-primary": "#fdf6e3", "bg-secondary": "#eee8d5", "bg-tertiary": "#e9e2cc",
      "bg-selected": "#dcd4b9", "fg-primary": "#586e75", "fg-secondary": "#93a1a1",
      cyan: "#2aa198", green: "#859900", orange: "#cb4b16", pink: "#d33682",
      purple: "#6c71c4", red: "#dc322f", yellow: "#b58900",
      "tree-root": "#586e75", "tree-dir": "#586e75", "section-fg": "#fdf6e3",
      "section-local": "#dc322f", "section-wsl": "#d33682", "section-remote": "#6c71c4",
      titlebar: "#eee8d5", "titlebar-fg": "#586e75",
      "icon-folder": "#268bd2", "icon-folder-open": "#2aa198", pin: "#d33682",
      border: "#d8d0b8", "border-focus": "#93a1a1",
      scrollbar: "#d8d0b8", "scrollbar-hover": "#c2b998",
      success: "#859900", warning: "#cb4b16", error: "#dc322f", info: "#268bd2",
      accent: "#268bd2",
    },
    editor: {
      background: "#fdf6e3", foreground: "#657b83", cursor: "#657b83",
      selection: "#dcd4b9", lineHighlight: "#eee8d5", widget: "#eee8d5",
      comment: "#93a1a1", keyword: "#859900", string: "#2aa198",
      number: "#d33682", type: "#b58900", function: "#268bd2",
      variable: "#657b83", constant: "#6c71c4", operator: "#859900",
    },
    terminalLocal: TERM_SOLARIZED_LIGHT,
    terminalWsl: TERM_SOLARIZED_LIGHT,
    terminalRemote: {
      ...TERM_SOLARIZED_LIGHT,
      background: "#eee8d5", cursorAccent: "#eee8d5",
      selectionBackground: "#d1c9ab",
    },
  },
];

const presetName = (p: ThemePreset) =>
  p.title.replace("Theme: ", "").replace(" (default)", "");

/** The built-in themes as pure data — seeds theme.json's `themes` library. */
export function builtinThemeData(): Record<string, ThemeData> {
  return Object.fromEntries(
    THEME_PRESETS.map((p) => [
      presetName(p),
      {
        colors: p.ui,
        editor: p.editor,
        terminalLocal: p.terminalLocal,
        terminalWsl: p.terminalWsl,
        terminalRemote: p.terminalRemote,
      },
    ]),
  );
}

/** Names in theme.json's library (built-ins seeded + user-saved). */
export function savedThemeNames(): string[] {
  return Object.keys(savedThemes);
}

/** Quick theme: copy a library entry over the live sections — pure data, no
 *  logic. `terminalFont` and everything in settings.json are untouched. */
export async function applyTheme(name: string): Promise<void> {
  const th = savedThemes[name];
  if (!th) {
    useAppStore.getState().pushNotice("error", `Theme "${name}" not found in theme.json.`);
    return;
  }
  await updateSettings({
    colors: th.colors ?? {},
    editor: th.editor ?? {},
    terminalLocal: th.terminalLocal ?? {},
    terminalWsl: th.terminalWsl ?? {},
    terminalRemote: th.terminalRemote ?? {},
    // Drop the pre-scoped `terminal` section from older files (undefined keys
    // vanish in JSON.stringify).
    terminal: undefined,
  } as Partial<Settings> & { terminal?: undefined });
}

/** Remove a library entry (built-ins included — they don't come back). */
export async function deleteTheme(name: string): Promise<void> {
  const themes = { ...savedThemes };
  delete themes[name];
  await updateSettings({ themes });
}

/** Save the live sections as a named library entry (same name overwrites). */
export async function saveCurrentTheme(name: string): Promise<void> {
  await updateSettings({
    themes: {
      ...savedThemes,
      [name]: {
        colors: { ...uiColors },
        editor: { ...editorColors },
        terminalLocal: { ...terminalLocalColors },
        terminalWsl: { ...terminalWslColors },
        terminalRemote: { ...terminalRemoteColors },
      },
    },
  });
}
