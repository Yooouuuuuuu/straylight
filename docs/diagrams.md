# Diagrams — D2 preview, rendered by the host's own tools

Straylight previews **D2** (`.d2` files and ` ```d2 ` fences in the Markdown
preview) the same way it runs git and jj: **the host's own binary does the
work**. Nothing is bundled, nothing is resident, and a `.d2` file on a remote
server renders on that server — the diagram source never leaves the host that
owns it.

## The decision: host binary, not WASM, not a server

D2 ships an official WASM build, and bundling it would make previews work
with zero install. It was rejected on weight alone: the npm package unpacks
to **~57 MB** (Go compiles its entire runtime into every WASM binary, and D2
is secretly a compiler + two layout engines + embedded fonts + a Markdown
renderer) against Straylight's ~8.5 MB installer. The native `d2` binary is
~40 MB for the same reason — that weight exists either way; the only question
is whose disk it lives on. It lives on the host of the user who opted in,
installed once like git.

This is also the architecture D2's own VS Code extension chose (it requires
the CLI and bridges to it). The cautionary tale in the other direction is the
PlantUML extension: its *bundled* renderer goes stale, and its recommended
*server* mode ships your diagram source to a render server — both failure
modes this design refuses structurally. Render-server modes, the PlantUML
playground-URL scheme, and D2's playground links were all rejected for the
same reason: Straylight's only network trace stays the GitHub update check.

## How a render flows (`diagram.rs`)

- **Probe, jj-style.** `d2` is located per connection: default PATH, the
  official installer's `~/.local/bin`, `/usr/local/bin`, `~/go/bin`,
  Homebrew's prefix, then a login shell's PATH — the contract is *"if it runs
  in your terminal, the preview finds it."* Found paths are cached; a miss
  deliberately is **not**, so installing the tool mid-session is picked up by
  the very next render. Locally, PATH does the probing at spawn time. A host
  without the tool gets an install card, never an error.
- **One-shot stdin→SVG.** Each render pipes the **live editor buffer** into
  `d2 - -` (no temp files, no repo pollution, unsaved edits render) with
  cwd = the file's directory, so relative imports (`...@lib.d2`) resolve
  exactly as the CLI would. Renders ride the data lane and debounce on a
  typing pause; compile errors show over the last good render, and their
  `line:col` references jump the editor to the spot.
- **Multi-board fallback.** A file using `layers`/`scenarios`/`steps`
  refuses single-SVG stdout, so on that exact refusal the render retries as
  **one animated SVG** cycling the boards — d2 only writes that to a real
  `.svg` path, so it goes through a throwaway file in the host's *temp*
  directory (written, read, removed in the same one-shot command; the
  no-repo-pollution promise is about user trees, not `/tmp`). The preview's
  **Root only** toggle renders just the root board instead (`--target ''`).
  A full board picker is parked until d2 can list a file's boards — parsing
  D2 source ourselves to find them would be a reimplementation that drifts.
- **The frontend registry** (`lib/diagrams.ts`) carries what the UI needs
  per language (extensions, fence name, Monaco grammar, install hint); the
  backend allowlist decides every argv — the frontend can only *name* a
  tool, never shape a command.

## The preview surface

A pan/zoom canvas (wheel zooms toward the cursor, drag pans, double-click
fits; view persists per tab) with a toolbar: zoom level, Fit, the Root-only
toggle for multi-board files, **Copy image**, and **Export SVG / PNG**
written beside the source (`foo.d2` → `foo.svg`). Copy image and PNG export
rasterize **client-side** (the SVG drawn to a canvas — faithful because d2
embeds its fonts as data URIs), which deliberately sidesteps `d2`'s own PNG
export needing a headless Chromium on the host. **Format** (palette: *File:
Format D2 File*) runs the host's `d2 fmt` and applies the result as one
undoable edit — never a save. Alt+D opens the preview (Ctrl+Shift+V works
too, as for Markdown); `.d2` gets Monarch syntax highlighting — highlighting
only, semantics stay with the real compiler (the no-LSP stance).

Theme, layout engine, and sketch mode are deliberately **not** app settings:
D2 reads them from the file itself (`vars: { d2-config: … }`), which keeps
them per-diagram and versioned with it. Mirror the tool.

## Adding a language

A new diagram language is a table row, not a feature: one entry in
`lib/diagrams.ts` (extensions, fence, install hint) and one arm in
`diagram.rs`'s allowlist (probe + argv). PlantUML fits the same
stdin→SVG shape (`plantuml -pipe -tsvg`) and is the likely second entry;
its caveat is JVM startup (~1–2 s per render), and its host needs Java +
Graphviz. Graphviz itself (`dot -Tsvg`) is the natural third.
