/**
 * Map a remote file name to a Monaco language id. Monaco has no path → language
 * resolver of its own, so we maintain a small explicit table covering the
 * common cases. Unknown files fall back to `plaintext`.
 */

const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  css: "css",
  scss: "scss",
  less: "less",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cxx: "cpp",
  cc: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  cs: "csharp",
  php: "php",
  rb: "ruby",
  swift: "swift",
  scala: "scala",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "powershell",
  bat: "bat",
  cmd: "bat",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  lua: "lua",
  pl: "perl",
  r: "r",
  dart: "dart",
  proto: "proto",
  graphql: "graphql",
  gql: "graphql",
  vue: "html",
  dockerfile: "dockerfile",
  tf: "hcl",
  hcl: "hcl",
};

const FILENAME_LANGUAGES: Record<string, string> = {
  dockerfile: "dockerfile",
  "dockerfile.dev": "dockerfile",
  makefile: "makefile",
  "gnumakefile": "makefile",
  ".gitignore": "ignore",
  ".gitattributes": "ignore",
  ".dockerignore": "ignore",
  ".bashrc": "shell",
  ".bash_profile": "shell",
  ".zshrc": "shell",
  ".profile": "shell",
  ".env": "ini",
  "cargo.lock": "ini",
  "go.mod": "ini",
  "go.sum": "ini",
};

export function languageForFile(name: string): string {
  const lower = name.toLowerCase();

  const byName = FILENAME_LANGUAGES[lower];
  if (byName) return byName;

  const dot = lower.lastIndexOf(".");
  if (dot >= 0 && dot < lower.length - 1) {
    const ext = lower.slice(dot + 1);
    const byExt = EXTENSION_LANGUAGES[ext];
    if (byExt) return byExt;
  }

  return "plaintext";
}

