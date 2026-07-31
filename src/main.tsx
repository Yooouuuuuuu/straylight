import ReactDOM from "react-dom/client";

import "./theme/straylight.css";
import "./theme/tokens.css";
import "./theme/fonts.css";
import "./styles/global.css";
import "@xterm/xterm/css/xterm.css";

import App from "./App";
import { isSessions, isWorkspace } from "./lib/windowRole";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element #root was not found");
}
// Note: StrictMode is intentionally omitted. Monaco and xterm.js manage their
// own imperative lifecycles and don't tolerate StrictMode's deliberate double
// mount/unmount in development.
const root = ReactDOM.createRoot(container);

// Warm the heavy chunks THIS window will actually show, before first paint, so
// the code-split (docs/dev/multi-window.md) never costs a flash of empty panes.
// Each window skips the chunk(s) it never shows — the whole point of the split:
// the Sessions pop-out loads no Monaco (~5 MB), the Workspace window no xterm.
async function boot(): Promise<void> {
  const warm: Promise<unknown>[] = [];
  if (!isSessions) warm.push(warmEditor());
  if (!isWorkspace) warm.push(import("./components/layout/TerminalPanel"));
  await Promise.all(warm);
  root.render(<App />);
}

// Monaco (workers + fallback theme) then the editor chunk. Preloading Monaco
// here also guarantees the theme layer and model registry find it bound before
// any restore path runs — no slower than the static import it replaces.
async function warmEditor(): Promise<void> {
  const { setupMonaco } = await import("./lib/monaco");
  setupMonaco();
  await import("./components/layout/EditorArea");
}

void boot();
