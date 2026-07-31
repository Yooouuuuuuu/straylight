/** Theme layer: applies the settings.json `editor` / `terminal` color sections
 *  to Monaco and to every live xterm, and ships the built-in presets. A preset
 *  is not a mode — "Theme: Nord" just overwrites the color sections in
 *  settings.json with Nord's values; every key stays individually editable and
 *  deleting keys falls back to the built-in default (Straylight). */
import type { ITheme, Terminal } from "@xterm/xterm";

import type * as monaco from "monaco-editor";

import { hostColorForConnKey } from "./hostColors";
import { monacoRef } from "./monacoRef";
import {
  editorColors,
  savedThemes,
  setOnSettingsApplied,
  setThemeTemplate,
  terminalColors,
  terminalFontConfig,
  terminalHostColorConfig,
  UI_COLOR_DEFAULTS,
  uiColors,
  updateSettings,
  type Settings,
  type ThemeData,
} from "./settings";
import { connKeyForConnId, useAppStore } from "../store/appStore";

// ---- contract keys + Straylight (built-in default) values -------------------

/** Editor section keys (settings.json contract). */
export const EDITOR_DEFAULTS: Record<string, string> = {
  background: "#151013",
  foreground: "#f0e7e9",
  cursor: "#c62435",
  selection: "#46232c",
  lineHighlight: "#221418",
  findMatch: "#ffa00047",
  findMatchHighlight: "#ffa0001a",
  widget: "#0f0b0d",
  comment: "#876a72",
  keyword: "#f05f72",
  string: "#6fca4a",
  number: "#c17dd0",
  type: "#ffb454",
  function: "#ff7a9c",
  variable: "#f0e7e9",
  constant: "#c17dd0",
  operator: "#c99aa2",
};

/** Terminal section keys — exactly xterm's ITheme color names. ONE scheme for
 *  every shell: Catppuccin Mocha's soft ANSI set on the warm Straylight
 *  background (hosts are told apart by identity cursor/selection, not by
 *  per-scope schemes). */
export const TERMINAL_DEFAULTS: Record<string, string> = {
  background: "#151013",
  foreground: "#f0e7e9",
  cursor: "#f5e0dc",
  cursorAccent: "#151013",
  selectionBackground: "#46232c",
  black: "#45475a",
  red: "#f38ba8",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  blue: "#89b4fa",
  magenta: "#cba6f7",
  cyan: "#89dceb",
  white: "#bac2de",
  brightBlack: "#585b70",
  brightRed: "#f38ba8",
  brightGreen: "#a6e3a1",
  brightYellow: "#f9e2af",
  brightBlue: "#89b4fa",
  brightMagenta: "#cba6f7",
  brightCyan: "#89dceb",
  brightWhite: "#a6adc8",
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

export function buildMonacoTheme(): monaco.editor.IStandaloneThemeData {
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
      "editor.findMatchBackground": g("findMatch"),
      "editor.findMatchHighlightBackground": g("findMatchHighlight"),
      // A bright, opaque border around every match (findMatch minus its alpha)
      // — eye-catching without covering the matched text.
      "editor.findMatchBorder": g("findMatch").slice(0, 7),
      "editor.findMatchHighlightBorder": g("findMatch").slice(0, 7),
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

/** A CSS color to a concrete value: `var(--x)` → its computed value (xterm
 *  paints to canvas, so CSS variables can't pass through). */
function computedColor(c: string): string {
  const m = /^var\((--[\w-]+)\)$/.exec(c.trim());
  if (!m) return c;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(m[1])
    .trim();
  return v || c;
}

/** The effective terminal theme for one terminal: the single `terminal`
 *  section over the defaults; with `terminalHostColor` on (default), the
 *  cursor + selection take the HOST's identity color instead. */
export function currentTermTheme(connId: string | null): ITheme {
  const out: Record<string, string> = { ...TERMINAL_DEFAULTS };
  for (const [k, v] of Object.entries(terminalColors)) {
    if (k in TERMINAL_DEFAULTS && typeof v === "string" && v.trim()) out[k] = v;
  }
  if (terminalHostColorConfig && connId) {
    const key = connKeyForConnId(connId);
    if (key) {
      const hc = computedColor(hostColorForConnKey(key));
      if (/^#[0-9a-fA-F]{6}$/.test(hc)) {
        out.cursor = hc;
        out.selectionBackground = `${hc}59`; // ~35% — readable text on top
        // The character under a block cursor draws in cursorAccent — pick
        // whichever of fg/bg reads better on THIS host color (dark crimson
        // wants a light char; a bright blue wants a dark one).
        const cr = (a: string, b: string) => {
          const [hi, lo] =
            luminance(a) > luminance(b)
              ? [luminance(a), luminance(b)]
              : [luminance(b), luminance(a)];
          return (hi + 0.05) / (lo + 0.05);
        };
        out.cursorAccent =
          cr(out.foreground, hc) >= cr(out.background, hc)
            ? out.foreground
            : out.background;
      }
    }
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
  connId: string | null;
  refit: () => void;
}
const liveTerminals = new Map<Terminal, LiveTerminal>();

export function registerTerminal(
  term: Terminal,
  opts: { connId?: string | null; refit?: () => void } = {},
): void {
  liveTerminals.set(term, {
    connId: opts.connId ?? null,
    refit: opts.refit ?? (() => {}),
  });
}

export function unregisterTerminal(term: Terminal): void {
  liveTerminals.delete(term);
}

/** Re-theme every live terminal (per terminal — host color is per connId).
 *  Also runs when the remotes list reorders: position = identity color. */
function applyTerminalThemes(): void {
  for (const [term, meta] of liveTerminals) {
    term.options.theme = currentTermTheme(meta.connId);
  }
}

function applyThemeLayers(): void {
  // The editor theme applies only where Monaco is loaded — not the Sessions
  // pop-out. Editor windows preload Monaco at boot (main.tsx) before this ever
  // runs, so the ref is bound; the Sessions window skips this block for good.
  const mo = monacoRef();
  if (mo) {
    mo.editor.defineTheme(CUSTOM_THEME, buildMonacoTheme());
    mo.editor.setTheme(CUSTOM_THEME);
  }
  const font = currentTermFont();
  // Expose the terminal font size as a CSS var so chrome that wants to match
  // the terminal (the focus view's section headers) tracks it live.
  document.documentElement.style.setProperty(
    "--term-font-size",
    `${font.size}px`,
  );
  applyTerminalThemes();
  for (const [term, meta] of liveTerminals) {
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
  // Host colors are positional (remote slot = position) — a reorder must
  // recolor live terminals' cursor/selection without a settings write.
  useAppStore.subscribe((s, prev) => {
    if (s.remotes !== prev.remotes) applyTerminalThemes();
  });
  setThemeTemplate(() => ({
    colors: { ...UI_COLOR_DEFAULTS },
    editor: { ...EDITOR_DEFAULTS },
    terminal: { ...TERMINAL_DEFAULTS },
    themes: builtinThemeData(),
  }));
}

// ---- presets ----------------------------------------------------------------

interface ThemePreset {
  id: string;
  title: string;
  ui: Record<string, string>;
  editor: Record<string, string>;
  /** ONE terminal scheme for every shell — hosts are told apart by the
   *  identity cursor/selection (`terminalHostColor`), not per-scope schemes. */
  terminal: Record<string, string>;
}

// Terminal schemes, one per preset.
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
// Catppuccin Latte's ANSI set (light sibling of the Mocha set the default
// uses) — on Straylight Light's warm paper here, on true Latte base below.
const TERM_STRAYLIGHT_LIGHT: Record<string, string> = {
  background: "#faf4f5", foreground: "#3a262d", cursor: "#c62435",
  cursorAccent: "#faf4f5", selectionBackground: "#e8d3d9",
  // Latte's set with yellow/magenta deepened — our rules want ≥3:1 on paper.
  black: "#5c5f77", red: "#d20f39", green: "#40a02b", yellow: "#b17110",
  blue: "#1e66f5", magenta: "#c94ba8", cyan: "#179299", white: "#acb0be",
  brightBlack: "#6c6f85", brightRed: "#d20f39", brightGreen: "#40a02b",
  brightYellow: "#b17110", brightBlue: "#1e66f5", brightMagenta: "#c94ba8",
  brightCyan: "#179299", brightWhite: "#bcc0cc",
};
const TERM_LATTE: Record<string, string> = {
  background: "#eff1f5", foreground: "#4c4f69", cursor: "#d20f39",
  cursorAccent: "#eff1f5", selectionBackground: "#ccd0da",
  black: "#5c5f77", red: "#d20f39", green: "#40a02b", yellow: "#df8e1d",
  blue: "#1e66f5", magenta: "#ea76cb", cyan: "#179299", white: "#acb0be",
  brightBlack: "#6c6f85", brightRed: "#d20f39", brightGreen: "#40a02b",
  brightYellow: "#df8e1d", brightBlue: "#1e66f5", brightMagenta: "#ea76cb",
  brightCyan: "#179299", brightWhite: "#bcc0cc",
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
    terminal: { ...TERMINAL_DEFAULTS },
  },
  {
    // The identity on warm paper: rosy-white base, near-black plum text, the
    // crimson brand carrying chrome. Semantics re-anchored for light (deep
    // forest success, ochre warning, deep teal info) — never inverted.
    id: "theme.straylightLight",
    title: "Theme: Straylight Light",
    ui: {
      "bg-primary": "#faf4f5", "bg-secondary": "#f2eaec", "bg-tertiary": "#eadde0",
      "bg-selected": "#decdd3", "fg-primary": "#2b1a1f", "fg-secondary": "#7a5a64",
      cyan: "#0f7a70", green: "#2c8f10", orange: "#c04a18", pink: "#c400c4",
      purple: "#7644b8", red: "#d40012", yellow: "#9a6a00",
      "tree-root": "#2b1a1f", "tree-dir": "#2b1a1f", "section-fg": "#fdf8f9",
      "section-local": "#af011c", "section-wsl": "#a91274", "section-remote": "#7c2fb4",
      "section-remote-2": "#4b3fd1", "section-remote-3": "#1e6ad0",
      titlebar: "#f2eaec", "titlebar-fg": "#2b1a1f",
      "icon-folder": "#b25064", "icon-folder-open": "#0f7a70", pin: "#c400c4",
      border: "#decdd3", "border-focus": "#af011c",
      scrollbar: "#decdd3", "scrollbar-hover": "#c9b2ba",
      success: "#2c8f10", warning: "#9a6a00", error: "#d40012", info: "#0f7a70",
      accent: "#af011c",
    },
    editor: {
      background: "#faf4f5", foreground: "#2b1a1f", cursor: "#af011c",
      selection: "#ecd4da", lineHighlight: "#f3e8ea", widget: "#f2eaec",
      findMatch: "#df8e1d55", findMatchHighlight: "#df8e1d24",
      comment: "#977e86", keyword: "#c22540", string: "#3c7d1e",
      number: "#8b3fa8", type: "#9a6a00", function: "#b3395f",
      variable: "#2b1a1f", constant: "#8b3fa8", operator: "#8d6a72",
    },
    terminal: TERM_STRAYLIGHT_LIGHT,
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
      "section-local": "#bd93f9", "section-wsl": "#ff79c6", "section-remote": "#8be9fd",
      "section-remote-2": "#50fa7b", "section-remote-3": "#f1fa8c",
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
      findMatch: "#ffb86c4d", findMatchHighlight: "#ffb86c21",
      comment: "#6272a4", keyword: "#ff79c6", string: "#f1fa8c",
      number: "#bd93f9", type: "#8be9fd", function: "#50fa7b",
      variable: "#f8f8f2", constant: "#bd93f9", operator: "#ff79c6",
    },
    terminal: TERM_DRACULA,
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
      "section-local": "#88c0d0", "section-wsl": "#5e81ac", "section-remote": "#a3be8c",
      "section-remote-2": "#ebcb8b", "section-remote-3": "#d08770",
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
      findMatch: "#ebcb8b4d", findMatchHighlight: "#ebcb8b21",
      comment: "#616e88", keyword: "#81a1c1", string: "#a3be8c",
      number: "#b48ead", type: "#8fbcbb", function: "#88c0d0",
      variable: "#d8dee9", constant: "#b48ead", operator: "#81a1c1",
    },
    terminal: TERM_NORD,
  },
  {
    // The famous light theme. `section-fg` and `accent` invert (light text on
    // the blue accent bars); the remote terminal sits on the darker paper tone.
    id: "theme.solarizedLight",
    title: "Theme: Solarized Light",
    ui: {
      "bg-primary": "#fdf6e3", "bg-secondary": "#eee8d5", "bg-tertiary": "#e9e2cc",
      "bg-selected": "#dcd4b9", "fg-primary": "#586e75", "fg-secondary": "#657b83",
      cyan: "#2aa198", green: "#859900", orange: "#cb4b16", pink: "#d33682",
      purple: "#6c71c4", red: "#dc322f", yellow: "#b58900",
      "tree-root": "#586e75", "tree-dir": "#586e75", "section-fg": "#fdf6e3",
      "section-local": "#268bd2", "section-wsl": "#2aa198", "section-remote": "#d33682",
      "section-remote-2": "#cb4b16", "section-remote-3": "#b58900",
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
      findMatch: "#b5890055", findMatchHighlight: "#b5890026",
      comment: "#93a1a1", keyword: "#859900", string: "#2aa198",
      number: "#d33682", type: "#b58900", function: "#268bd2",
      variable: "#657b83", constant: "#6c71c4", operator: "#859900",
    },
    terminal: TERM_SOLARIZED_LIGHT,
  },
  {
    // The community's modern light favorite — official Latte palette, mauve
    // as the accent; pairs with the Mocha ANSI set the default terminal uses.
    id: "theme.catppuccinLatte",
    title: "Theme: Catppuccin Latte",
    ui: {
      "bg-primary": "#eff1f5", "bg-secondary": "#e6e9ef", "bg-tertiary": "#dce0e8",
      "bg-selected": "#ccd0da", "fg-primary": "#4c4f69", "fg-secondary": "#6c6f85",
      cyan: "#179299", green: "#40a02b", orange: "#fe640b", pink: "#ea76cb",
      purple: "#8839ef", red: "#d20f39", yellow: "#df8e1d",
      "tree-root": "#4c4f69", "tree-dir": "#4c4f69", "section-fg": "#eff1f5",
      "section-local": "#8839ef", "section-wsl": "#1e66f5", "section-remote": "#179299",
      "section-remote-2": "#40a02b", "section-remote-3": "#d15408",
      titlebar: "#e6e9ef", "titlebar-fg": "#4c4f69",
      "icon-folder": "#8839ef", "icon-folder-open": "#179299", pin: "#ea76cb",
      border: "#ccd0da", "border-focus": "#8839ef",
      scrollbar: "#ccd0da", "scrollbar-hover": "#bcc0cc",
      success: "#40a02b", warning: "#df8e1d", error: "#d20f39", info: "#179299",
      accent: "#8839ef",
    },
    editor: {
      background: "#eff1f5", foreground: "#4c4f69", cursor: "#d20f39",
      selection: "#ccd0da", lineHighlight: "#e6e9ef", widget: "#e6e9ef",
      findMatch: "#df8e1d55", findMatchHighlight: "#df8e1d24",
      comment: "#7c7f93", keyword: "#8839ef", string: "#40a02b",
      number: "#fe640b", type: "#df8e1d", function: "#1e66f5",
      variable: "#4c4f69", constant: "#fe640b", operator: "#04a5e5",
    },
    terminal: TERM_LATTE,
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
        terminal: p.terminal,
      },
    ]),
  );
}

/** The theme a fresh install wakes up in (its values ARE the shipped
 *  settings defaults) — tagged "(default)" in the theme lists. */
export const DEFAULT_THEME_NAME = "Straylight";

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
    // Older library entries carry the retired per-scope split — first
    // non-empty section stands in for the single scheme.
    terminal:
      th.terminal ??
      (th as { terminalLocal?: Record<string, string> }).terminalLocal ??
      {},
    // The retired split keys die in settings.json here (undefined keys vanish
    // in JSON.stringify).
    terminalLocal: undefined,
    terminalWsl: undefined,
    terminalRemote: undefined,
  } as Partial<Settings> & {
    terminalLocal?: undefined;
    terminalWsl?: undefined;
    terminalRemote?: undefined;
  });
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
        terminal: { ...terminalColors },
      },
    },
  });
}
