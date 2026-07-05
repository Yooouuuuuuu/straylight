/** settings.json — the one hand-editable preferences file (app config dir).
 *
 *  Shape (every part optional; missing keys fall back to defaults):
 *    {
 *      "zoom": 1.1,
 *      "keybindings": { "search.inFiles": "ctrl+alt+f" },
 *      "colors":   { "bg-primary": "#2e3440", ... },   // UI palette
 *      "editor":   { ... },                            // Monaco colors
 *      "terminal": { ... }                             // xterm ANSI palette
 *    }
 *
 *  The color sections ARE the theme — theme presets simply overwrite them with
 *  a known set. Keys mirror the CSS custom properties (minus the `--`). The
 *  file is watched: saving it re-applies everything live. Problems never fail
 *  silently — they surface as a toast and a warning row in the command palette. */
import { applyKeybindingOverrides } from "./shortcuts";
import { applyZoom } from "./zoom";
import { fileWatch, fsReadFile, fsWriteFile, onFileFsChange, settingsPath } from "./ipc";
import { useAppStore } from "../store/appStore";

export interface Settings {
  zoom?: number;
  keybindings?: Record<string, string>;
  colors?: Record<string, string>;
  editor?: Record<string, string>;
  terminal?: Record<string, string>;
}

/** The default (Dracula) UI palette — mirrors src/theme/dracula.css. These key
 *  names are the settings.json contract. */
export const UI_COLOR_DEFAULTS: Record<string, string> = {
  "bg-primary": "#282a36",
  "bg-secondary": "#21222c",
  "bg-tertiary": "#343746",
  "bg-selected": "#44475a",
  "fg-primary": "#f8f8f2",
  "fg-secondary": "#6272a4",
  cyan: "#8be9fd",
  green: "#50fa7b",
  orange: "#ffb86c",
  pink: "#ff79c6",
  purple: "#bd93f9",
  red: "#ff5555",
  yellow: "#f1fa8c",
  border: "#44475a",
  "border-focus": "#6272a4",
  scrollbar: "#44475a",
  "scrollbar-hover": "#6272a4",
  success: "#50fa7b",
  warning: "#ffb86c",
  error: "#ff5555",
  info: "#8be9fd",
  accent: "#bd93f9",
};

let file: string | null = null;
let connId: string | null = null;
/** Editor/terminal sections, held for the theme layer to consume. */
export let editorColors: Record<string, string> = {};
export let terminalColors: Record<string, string> = {};
/** Called after every (re)apply so the theme layer can push editor/terminal
 *  colors into Monaco and live terminals. */
let onApplied: (() => void) | null = null;

export function setOnSettingsApplied(cb: () => void): void {
  onApplied = cb;
}

export function settingsFilePath(): string | null {
  return file;
}

function applyUiColors(colors: Record<string, string>, issues: string[]): void {
  const rootStyle = document.documentElement.style;
  for (const key of Object.keys(UI_COLOR_DEFAULTS)) {
    const value = colors[key];
    if (value !== undefined) {
      if (typeof value === "string" && value.trim()) {
        rootStyle.setProperty(`--${key}`, value);
      } else {
        issues.push(`colors: "${key}" must be a CSS color string`);
        rootStyle.removeProperty(`--${key}`);
      }
    } else {
      // Deleting a key reverts to the stylesheet default.
      rootStyle.removeProperty(`--${key}`);
    }
  }
  for (const key of Object.keys(colors)) {
    if (!(key in UI_COLOR_DEFAULTS)) issues.push(`colors: unknown key "${key}"`);
  }
}

async function loadAndApply(): Promise<void> {
  if (!file || !connId) return;
  const issues: string[] = [];
  let settings: Settings = {};

  let raw: string | null = null;
  try {
    raw = (await fsReadFile(connId, file)).content;
  } catch {
    raw = null; // no file yet — pure defaults, not an error
  }
  if (raw && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") settings = parsed as Settings;
      else issues.push("settings.json: top level must be an object");
    } catch (e) {
      issues.push(`settings.json: ${String(e).replace("SyntaxError: ", "")}`);
    }
  }

  // Zoom
  if (settings.zoom !== undefined) {
    if (typeof settings.zoom === "number" && settings.zoom >= 0.5 && settings.zoom <= 3) {
      void applyZoom(settings.zoom);
    } else {
      issues.push('settings.json: "zoom" must be a number between 0.5 and 3');
      void applyZoom(1);
    }
  } else {
    void applyZoom(1);
  }

  // Keybindings (invalid entries are reported and skipped, valid ones apply)
  issues.push(...applyKeybindingOverrides(settings.keybindings ?? {}));

  // Colors
  applyUiColors(settings.colors ?? {}, issues);
  editorColors = settings.editor ?? {};
  terminalColors = settings.terminal ?? {};
  onApplied?.();

  const prev = useAppStore.getState().settingsIssues;
  useAppStore.getState().setSettingsIssues(issues);
  if (issues.length > 0 && prev.join("\n") !== issues.join("\n")) {
    useAppStore
      .getState()
      .pushNotice("error", `settings.json: ${issues.length} problem${issues.length === 1 ? "" : "s"} — see the command palette`);
  }
}

/** Merge a patch into settings.json (sections replace wholesale) and re-apply. */
export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  if (!file || !connId) return;
  let current: Settings = {};
  try {
    const raw = (await fsReadFile(connId, file)).content;
    if (raw.trim()) current = JSON.parse(raw) as Settings;
  } catch {
    /* missing or broken — start over from the patch */
  }
  const next = { ...current, ...patch };
  await fsWriteFile(connId, file, `${JSON.stringify(next, null, 2)}\n`, null);
  await loadAndApply();
}

/** Resolve the file, apply it, and keep it live (re-apply on save). */
export async function initSettings(localConnId: string): Promise<void> {
  connId = localConnId;
  file = await settingsPath();
  await loadAndApply();
  fileWatch(localConnId, file).catch(() => {});
  void onFileFsChange((c) => {
    if (file && c.path === file) void loadAndApply();
  });
}
