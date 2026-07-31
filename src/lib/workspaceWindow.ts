/** Open (or focus) a secondary window — a second window running the same app
 *  shell with a role-specific layout, for use on another monitor
 *  (docs/dev/multi-window.md). Each is a singleton by label: a second click
 *  focuses the existing one. Secondary windows share the backend (connections,
 *  PTYs) with the main window and adopt its live state on boot.
 *
 *  - `workspace` — explorer + editor (Option A).
 *  - `sessions`  — the CHAT/sessions focus view (Option B).
 */
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export const WORKSPACE_LABEL = "workspace";
export const SESSIONS_LABEL = "sessions";

interface ChildOptions {
  title: string;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
}

/** The live theme's window background for a new webview's pre-paint fill —
 *  without it the OS shows a WHITE sheet until first paint (main's equivalent
 *  is `backgroundColor` in tauri.conf.json). Falls back to the built-in dark
 *  when the theme value isn't a plain hex color. */
function themeBackground(): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue("--bg-primary")
    .trim();
  return /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v) ? v : "#151013";
}

async function openChildWindow(
  label: string,
  options: ChildOptions,
): Promise<void> {
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.unminimize().catch(() => {});
    await existing.setFocus().catch(() => {});
    return;
  }

  const win = new WebviewWindow(label, {
    url: "index.html",
    decorations: false, // custom title bar, matching the main window
    center: true,
    backgroundColor: themeBackground(), // no white flash before first paint
    // Like main (tauri.conf.json): Tauri's native drag-drop interception
    // swallows ALL drag events — off, or in-page HTML5 drag-and-drop
    // (session/host/group reordering, tab drags) is dead in this window.
    dragDropEnabled: false,
    ...options,
  });

  win.once("tauri://error", (e) => {
    // Surfacing here is enough — the click just does nothing if creation fails.
    console.error(`${label} window failed to open:`, e);
  });
}

export function openWorkspaceWindow(): Promise<void> {
  return openChildWindow(WORKSPACE_LABEL, {
    title: "Straylight — Workspace",
    width: 1200,
    height: 820,
    minWidth: 600,
    minHeight: 600,
  });
}

export function openSessionsWindow(): Promise<void> {
  return openChildWindow(SESSIONS_LABEL, {
    title: "Straylight — Sessions",
    width: 940,
    height: 860,
    minWidth: 420,
    minHeight: 520,
  });
}
