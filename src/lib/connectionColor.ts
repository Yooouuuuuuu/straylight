/** Deterministic workspace accent color for a connection, so the same server
 *  always tints the title bar the same way. */
const PALETTE = [
  "#bd93f9", // purple
  "#8be9fd", // cyan
  "#50fa7b", // green
  "#ffb86c", // orange
  "#ff79c6", // pink
  "#f1fa8c", // yellow
  "#ff5555", // red
];

export function colorForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}
