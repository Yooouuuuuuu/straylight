/**
 * Extension → accent color for file-tree icons. Phase 1 keeps this intentionally
 * lightweight (a tinted document glyph per file type); Phase 2 swaps in a full
 * Catppuccin icon set. Tints reference the theme's palette slots, so every
 * theme (including light ones) re-colors the icons.
 */

const CYAN = "var(--cyan)";
const GREEN = "var(--green)";
const ORANGE = "var(--orange)";
const PINK = "var(--pink)";
const PURPLE = "var(--purple)";
const RED = "var(--red)";
const YELLOW = "var(--yellow)";
const FG = "var(--fg-primary)";
const MUTED = "var(--fg-secondary)";

const EXTENSION_COLORS: Record<string, string> = {
  ts: CYAN,
  tsx: CYAN,
  mts: CYAN,
  cts: CYAN,
  js: YELLOW,
  jsx: YELLOW,
  mjs: YELLOW,
  cjs: YELLOW,
  json: YELLOW,
  jsonc: YELLOW,
  html: ORANGE,
  htm: ORANGE,
  xml: ORANGE,
  vue: GREEN,
  css: PINK,
  scss: PINK,
  less: PINK,
  py: GREEN,
  pyi: GREEN,
  rs: ORANGE,
  go: CYAN,
  java: RED,
  kt: PURPLE,
  c: CYAN,
  h: CYAN,
  cpp: CYAN,
  cc: CYAN,
  hpp: CYAN,
  cs: GREEN,
  php: PURPLE,
  rb: RED,
  swift: ORANGE,
  scala: RED,
  sh: GREEN,
  bash: GREEN,
  zsh: GREEN,
  fish: GREEN,
  ps1: CYAN,
  sql: PINK,
  yaml: PINK,
  yml: PINK,
  toml: ORANGE,
  ini: MUTED,
  cfg: MUTED,
  conf: MUTED,
  env: YELLOW,
  md: FG,
  markdown: FG,
  mdx: FG,
  lua: PURPLE,
  dart: CYAN,
  graphql: PINK,
  gql: PINK,
  proto: CYAN,
  png: PURPLE,
  jpg: PURPLE,
  jpeg: PURPLE,
  gif: PURPLE,
  webp: PURPLE,
  svg: ORANGE,
  ico: PURPLE,
  lock: MUTED,
  log: MUTED,
  txt: FG,
};

const FILENAME_COLORS: Record<string, string> = {
  dockerfile: CYAN,
  makefile: ORANGE,
  ".gitignore": MUTED,
  ".gitattributes": MUTED,
  ".dockerignore": MUTED,
  ".env": YELLOW,
  "cargo.toml": ORANGE,
  "cargo.lock": MUTED,
  "package.json": YELLOW,
  "package-lock.json": MUTED,
  "tsconfig.json": CYAN,
  "license": YELLOW,
  "license-mit": YELLOW,
  "license-apache": YELLOW,
  "readme.md": CYAN,
};

// Folder glyphs are themable (settings.json `colors` keys); per-filetype tints
// below stay fixed — they're language-semantic, like syntax colors.
export const FOLDER_COLOR = "var(--icon-folder)";
export const FOLDER_OPEN_COLOR = "var(--icon-folder-open)";
export const DEFAULT_FILE_COLOR = MUTED;

/** Accent color for a file's icon based on its name/extension. */
export function fileIconColor(name: string): string {
  const lower = name.toLowerCase();

  const byName = FILENAME_COLORS[lower];
  if (byName) return byName;

  const dot = lower.lastIndexOf(".");
  if (dot >= 0 && dot < lower.length - 1) {
    const ext = lower.slice(dot + 1);
    const byExt = EXTENSION_COLORS[ext];
    if (byExt) return byExt;
  }

  return DEFAULT_FILE_COLOR;
}
