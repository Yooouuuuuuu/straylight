/** Deterministic workspace accent color for a connection, so the same server
 *  always tints the title bar the same way. Colors are **theme slots**
 *  (`var(--purple)` …), not fixed hex — switching themes recolors every
 *  consumer (title bar, repo-card frames, graph lanes) automatically. A user
 *  override (picked on a repo card) wins over the hash and stays as picked. */
export const PALETTE = [
  "var(--purple)",
  "var(--cyan)",
  "var(--green)",
  "var(--orange)",
  "var(--pink)",
  "var(--yellow)",
  "var(--red)",
];

/** Human label for a palette entry ("var(--purple)" → "purple"). */
export function paletteName(value: string): string {
  const m = /^var\(--(.+)\)$/.exec(value);
  return m ? m[1] : value;
}

/** Every connection shares the theme's main color (user decision). Per-REPO
 *  colors are a separate thing — set from a repo card, stored in the VCS store. */
export function colorForName(_name: string): string {
  return "var(--accent)";
}
