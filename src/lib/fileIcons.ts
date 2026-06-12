/**
 * Extension → accent color for file-tree icons. Phase 1 keeps this intentionally
 * lightweight (a tinted document glyph per file type); Phase 2 swaps in a full
 * Catppuccin icon set. Colors come from the Dracula palette.
 */

const CYAN = "#8BE9FD";
const GREEN = "#50FA7B";
const ORANGE = "#FFB86C";
const PINK = "#FF79C6";
const PURPLE = "#BD93F9";
const RED = "#FF5555";
const YELLOW = "#F1FA8C";
const FG = "#F8F8F2";
const MUTED = "#6272A4";

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

export const FOLDER_COLOR = PURPLE;
export const FOLDER_OPEN_COLOR = CYAN;
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
