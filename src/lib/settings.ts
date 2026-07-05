/** settings.json — the one hand-editable preferences file (app config dir).
 *
 *  Shape (every part optional; missing keys fall back to defaults):
 *    {
 *      "zoom": 1.1,
 *      "keybindings": { "search.inFiles": "ctrl+alt+f" },
 *      "colors":   { "bg-primary": "#2e3440", ... },   // UI palette
 *      "editor":   { ... },                            // Monaco colors
 *      "terminalLocal":  { ... },                      // xterm ANSI palette, local shells (pwsh)
 *      "terminalWsl":    { ... },                      // WSL shells
 *      "terminalRemote": { ... },                      // SSH shells
 *      "terminalFont": { "family": "Fira Code", "size": 13 }
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
  /** One explicit color section per shell kind — no inheritance between them;
   *  missing sections/keys fall back to the built-in (Straylight) defaults. */
  terminalLocal?: Record<string, string>;
  terminalWsl?: Record<string, string>;
  terminalRemote?: Record<string, string>;
  terminalFont?: { family?: string; size?: number };
}

/** The default (Straylight) UI palette — mirrors src/theme/straylight.css.
 *  These key names are the settings.json contract. */
export const UI_COLOR_DEFAULTS: Record<string, string> = {
  "bg-primary": "#151013",
  "bg-secondary": "#0f0b0d",
  "bg-tertiary": "#241a1e",
  "bg-selected": "#3a2228",
  "fg-primary": "#f0e7e9",
  "fg-secondary": "#8a6f76",
  cyan: "#ff7a9c",
  green: "#5ce626",
  orange: "#ff6a3d",
  pink: "#ff00ff",
  purple: "#e0446a",
  red: "#f30100",
  yellow: "#ffb454",
  "tree-root": "#f0e7e9",
  "tree-dir": "#f0e7e9",
  "icon-folder": "#e0446a",
  "icon-folder-open": "#ff7a9c",
  "section-fg": "#f5e6e8",
  border: "#3a2228",
  "border-focus": "#af011c",
  scrollbar: "#3a2228",
  "scrollbar-hover": "#5a3038",
  success: "#5ce626",
  warning: "#ffb454",
  error: "#f30100",
  info: "#ff7a9c",
  accent: "#af011c",
};

let file: string | null = null;
let connId: string | null = null;
/** Editor/terminal sections, held for the theme layer to consume. */
export let editorColors: Record<string, string> = {};
export let terminalLocalColors: Record<string, string> = {};
export let terminalWslColors: Record<string, string> = {};
export let terminalRemoteColors: Record<string, string> = {};
export let terminalFontConfig: { family?: string; size?: number } = {};
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
  // Legacy `terminal` (pre-scoped) seeds any scope section that's absent, so
  // an old file keeps looking right until the next preset click rewrites it.
  const legacyTerminal = (settings as { terminal?: Record<string, string> }).terminal ?? {};
  terminalLocalColors = settings.terminalLocal ?? legacyTerminal;
  terminalWslColors = settings.terminalWsl ?? legacyTerminal;
  terminalRemoteColors = settings.terminalRemote ?? legacyTerminal;

  // Terminal font (family string, size 6–40; invalid entries report + default)
  terminalFontConfig = {};
  const font = settings.terminalFont;
  if (font !== undefined) {
    if (font && typeof font === "object") {
      if (font.family !== undefined) {
        if (typeof font.family === "string" && font.family.trim()) {
          terminalFontConfig.family = font.family;
        } else {
          issues.push('terminalFont: "family" must be a font name string');
        }
      }
      if (font.size !== undefined) {
        if (typeof font.size === "number" && font.size >= 6 && font.size <= 40) {
          terminalFontConfig.size = font.size;
        } else {
          issues.push('terminalFont: "size" must be a number between 6 and 40');
        }
      }
    } else {
      issues.push('terminalFont: must be an object like { "family": "Fira Code", "size": 13 }');
    }
  }
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
  // Self-heal: a dev hot-reload can reset this module's state — re-init from
  // the live local session instead of silently dropping the write.
  if (!file || !connId) {
    const localConnId = useAppStore.getState().localConnId;
    if (localConnId) await initSettings(localConnId);
  }
  if (!file || !connId) {
    useAppStore
      .getState()
      .pushNotice("error", "Settings not ready yet — try again in a moment.");
    return;
  }
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
