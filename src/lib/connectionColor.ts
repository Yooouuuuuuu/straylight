/** Deterministic workspace accent color for a connection, so the same server
 *  always tints the title bar the same way. A user override (picked on a repo
 *  card) wins over the hash; overrides persist per name. */
export const PALETTE = [
  "#bd93f9", // purple
  "#8be9fd", // cyan
  "#50fa7b", // green
  "#ffb86c", // orange
  "#ff79c6", // pink
  "#f1fa8c", // yellow
  "#ff5555", // red
];

const KEY = "straylight.connColors";

function loadOverrides(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

let overrides = loadOverrides();

export function colorForName(name: string): string {
  const chosen = overrides[name];
  if (chosen) return chosen;
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}

/** Set (or clear, with null) the user's color for a connection name. */
export function setColorOverride(name: string, color: string | null): void {
  if (color) overrides[name] = color;
  else delete overrides[name];
  try {
    localStorage.setItem(KEY, JSON.stringify(overrides));
  } catch {
    /* ignore */
  }
}
