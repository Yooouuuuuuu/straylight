// Downloads the Fira Code woff2 weights into public/fonts.
// The fonts are already committed, but this lets you refetch them after a clean
// checkout. Run with: node scripts/fetch-fonts.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fontDir = join(here, "..", "public", "fonts");

const WEIGHTS = {
  Light: 300,
  Regular: 400,
  Medium: 500,
  SemiBold: 600,
  Bold: 700,
};

const BASE = "https://cdn.jsdelivr.net/npm/@fontsource/fira-code/files";

await mkdir(fontDir, { recursive: true });

for (const [name, weight] of Object.entries(WEIGHTS)) {
  const url = `${BASE}/fira-code-latin-${weight}-normal.woff2`;
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`Failed to fetch ${name} (${weight}): ${response.status}`);
    continue;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(join(fontDir, `FiraCode-${name}.woff2`), buffer);
  console.log(`Saved FiraCode-${name}.woff2 (${buffer.length} bytes)`);
}
