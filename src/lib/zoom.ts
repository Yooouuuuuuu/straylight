/** Whole-window zoom via the WebView's native zoom factor — real browser
 *  page-zoom (the mechanism VS Code uses): layout reflows, text re-rasterizes
 *  sharp, and Monaco/xterm officially support it. Requires the
 *  `core:webview:allow-set-webview-zoom` capability. There is deliberately NO
 *  CSS-zoom fallback — CSS zoom breaks Monaco mouse targets and blurs the
 *  terminal canvas, so failure surfaces as a toast instead of degrading.
 *  The persisted value lives in settings.json ("zoom") — callers persist. */
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { WINDOW_MIN } from "./layoutBudget";
import { useAppStore } from "../store/appStore";

let current = 1;

export function currentZoom(): number {
  return current;
}

/** Clamp + apply a zoom factor. Returns the factor now in effect. */
export async function applyZoom(factor: number): Promise<number> {
  const next = Math.min(3, Math.max(0.5, Math.round(factor * 10) / 10));
  // Clear any CSS zoom left over from the old (broken) approach.
  document.documentElement.style.removeProperty("zoom");
  document.body.style.removeProperty("zoom");
  try {
    await getCurrentWebviewWindow().setZoom(next);
    current = next;
    // Keep the window floor meaningful in CSS px at any zoom: page zoom
    // shrinks the effective viewport, so the OS minimum scales with it.
    getCurrentWebviewWindow()
      .setMinSize(new LogicalSize(WINDOW_MIN * next, WINDOW_MIN * next))
      .catch(() => {});
    // Nudge anything that sizes itself from the window (xterm fit, panels).
    window.dispatchEvent(new Event("resize"));
  } catch (e) {
    // Don't nag at startup when the default (1) can't be applied.
    if (next !== 1) {
      useAppStore.getState().pushNotice("error", `Zoom unavailable: ${String(e)}`);
    }
  }
  return current;
}

export async function zoomBy(delta: number): Promise<number> {
  return applyZoom(current + delta);
}
