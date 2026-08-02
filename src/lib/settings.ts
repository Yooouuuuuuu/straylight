/** settings.json — THE hand-editable preferences file (app config dir),
 *  watched and live-applied, seeded as a complete template. Behavior keys on
 *  top, the LIVE theme sections at the bottom:
 *    {
 *      "zoom": 1,
 *      "keybindings": { "search.inFiles": "ctrl+alt+f" },
 *      "terminalFont": { "family": "Fira Code", "size": 13 },
 *      "confirms": { "exit": true, ... },  // false = that dialog is silenced
 *      "colors":         { "bg-primary": "...", ... },  // UI palette (live)
 *      "editor":         { ... },                       // Monaco colors
 *      "terminalLocal":  { ... },                       // xterm, local shells
 *      "terminalWsl":    { ... },
 *      "terminalRemote": { ... }
 *    }
 *
 *  A second file, theme.json, is NOT user-facing: it stores the theme LIBRARY
 *  (`themes`: name → full sections), seeded once with every built-in and
 *  managed via ⚙ → Manage themes (save current / delete). A quick-theme pick
 *  copies a library entry over settings.json's live sections — pure data.
 *
 *  Missing keys fall back to built-in (Straylight) defaults. Problems never
 *  fail silently — they surface as a toast and a warning row in the palette. */
import { applyKeybindingOverrides } from "./shortcuts";
import { applyZoom } from "./zoom";
import { fileWatch, fsReadFile, fsWriteFile, onFileFsChange, settingsPath } from "./ipc";
import { useAppStore } from "../store/appStore";

export interface Settings {
  zoom?: number;
  keybindings?: Record<string, string>;
  terminalFont?: { family?: string; size?: number };
  /** Per-dialog "ask again?" flags: `false` silences that confirmation. All
   *  don't-ask-again checkboxes write here (visible + hand-restorable). */
  confirms?: Record<string, boolean>;
  /** Startup reconnects: host keys ("wsl:<name>" / "user@host:port") that
   *  connect silently on launch — every other host asks first. The ask
   *  dialog's "don't ask again" checkbox adds its host here; the Storage →
   *  Auto-connect tab removes them. Only hosts still connected at close are
   *  candidates at all. */
  autoConnect?: string[];
  /** Hot-exit drafts: local copies of unsaved edits (app config dir,
   *  `drafts/`), surviving crash/close. `enabled: false` turns writing and
   *  restoring off (existing drafts stay on disk for the cleanup panel). */
  drafts?: { enabled?: boolean };
  /** Bottom-panel tool groups: hide the ones you never use, and tune how often
   *  the open tab re-polls (seconds; nothing polls while closed). */
  panels?: {
    ports?: boolean;
    containers?: boolean;
    forwarding?: boolean;
    transfers?: boolean;
    portsInterval?: number;
    containersInterval?: number;
    /** Hide well-known/system ports (<1024, SSH/RDP/DNS/SMB…). */
    hideSystemPorts?: boolean;
    /** Hosts the Ports tab doesn't monitor ("local" | "wsl:<distro>" |
     *  "user@host:port") — also drops them from the chip digits. */
    portsIgnoreHosts?: string[];
    /** Hosts the Containers tab doesn't monitor (same keys as
     *  `portsIgnoreHosts`) — also drops them from the chip digits. */
    containersIgnoreHosts?: string[];
  };
  /** UI reduction switches (also checkboxes in Preferences → Interface).
   *  `localOnly: true` removes the explorer's L/W/R section toggles and every
   *  non-local section; honored only while no WSL/remote host is connected
   *  (flagged and inert otherwise). `disableChat: true` removes the CHAT
   *  column entirely — the status-bar button, the column, and the
   *  move-to-CHAT button on terminal entries; honored only while no terminal
   *  lives in the CHAT panel. */
  ui?: { localOnly?: boolean; disableChat?: boolean };
  /** Where the explorer/quick-open "Download" action drops files. Empty = your
   *  OS Downloads folder; either way it downloads on click, no prompt. */
  download?: { dir?: string };
  /** Session lanes: each session opened from the SESSIONS panel / F11 gets its
   *  own SSH connection; `max` caps how many per host (past it new sessions
   *  share the host's main connection; 0 = always share). */
  sessionConnections?: { max?: number };
  /** Transfer speed: the confirm sheet's default mode, and the Background
   *  mode's bandwidth cap in MB/s (0 = no cap, just a shallow pipeline).
   *  Downloads (no sheet) always use the default mode. */
  transfers?: { default?: "full" | "background"; backgroundLimitMBps?: number };
  // ---- theme.json sections ----
  colors?: Record<string, string>;
  editor?: Record<string, string>;
  /** ONE terminal scheme for every shell — hosts are told apart by identity
   *  color (see `terminalHostColor`), not by per-scope schemes. */
  terminal?: Record<string, string>;
  /** Paint each terminal's cursor + selection in its HOST's identity color
   *  (the 5 section slots) instead of the scheme's own. Default true. */
  terminalHostColor?: boolean;
  /** The theme library: name → full color sections. Quick-theme copies an
   *  entry over the live sections; saving adds one; delete lines to remove. */
  themes?: Record<string, ThemeData>;
  /** Built-in names ever seeded into the library (theme.json only) — lets
   *  NEW built-ins reach existing installs while deletions stay deleted. */
  seeded?: string[];
}

export type ThemeData = Pick<Settings, "colors" | "editor" | "terminal">;

const THEME_SECTION_KEYS = ["colors", "editor", "terminal"] as const;
/** Retired section keys (the per-scope terminal split) — merged into
 *  `terminal` and stripped from settings.json by the migration. */
const OLD_TERMINAL_KEYS = ["terminalLocal", "terminalWsl", "terminalRemote"];

/** Which top-level keys belong to the hidden library file (theme.json);
 *  everything else — including the live color sections — is settings.json. */
const THEME_KEYS = new Set(["themes", "seeded"]);

/** Every confirm-dialog id, so the template documents them all. */
export const CONFIRM_IDS = [
  "exit",
  "unpin-folder",
  "remove-repo",
  "vcs-update",
  "vcs-push",
  "vcs-stash-pop",
  "vcs-amend-pushed",
  "usage-check",
  "close-agent",
];

const PANEL_DEFAULTS = {
  ports: true,
  containers: true,
  forwarding: true,
  transfers: true,
  portsInterval: 15,
  containersInterval: 30,
  hideSystemPorts: true,
  portsIgnoreHosts: [] as string[],
  containersIgnoreHosts: [] as string[],
};

function settingsTemplate(): Settings {
  return {
    zoom: 1,
    keybindings: {},
    terminalFont: { family: "Fira Code", size: 13 },
    confirms: Object.fromEntries(CONFIRM_IDS.map((id) => [id, true])),
    autoConnect: [],
    drafts: { enabled: true },
    panels: { ...PANEL_DEFAULTS },
    ui: { localOnly: false, disableChat: false },
    download: { dir: "" },
    sessionConnections: { max: 10 },
    transfers: { default: "background", backgroundLimitMBps: 10 },
    terminalHostColor: true,
  };
}

/** theme.json's full-template supplier, provided by the theme layer at startup
 *  (it owns the default color tables; a direct import would be circular). */
let themeTemplate: (() => Settings) | null = null;
export function setThemeTemplate(fn: () => Settings): void {
  themeTemplate = fn;
}

/** The default (Straylight) UI palette — mirrors src/theme/straylight.css.
 *  These key names are the theme.json `colors` contract. */
export const UI_COLOR_DEFAULTS: Record<string, string> = {
  "bg-primary": "#151013",
  "bg-secondary": "#0f0b0d",
  "bg-tertiary": "#241a1e",
  "bg-selected": "#3a2228",
  "fg-primary": "#f0e7e9",
  "fg-secondary": "#957a84",
  cyan: "#48b3ac",
  green: "#5ce626",
  orange: "#ff6a3d",
  pink: "#ff00ff",
  purple: "#9a73d1",
  red: "#f30100",
  yellow: "#ffb454",
  "tree-root": "#f0e7e9",
  "tree-dir": "#f0e7e9",
  "icon-folder": "#d76b83",
  "icon-folder-open": "#ff7a9c",
  pin: "#ff00ff",
  "section-fg": "#f5e6e8",
  "section-local": "#af011c",
  "section-wsl": "#cf1f8f",
  "section-remote": "#9b46d4",
  "section-remote-2": "#6a5ce6",
  "section-remote-3": "#3f86e6",
  titlebar: "#1a1216",
  "titlebar-fg": "#f5e6e8",
  border: "#3a2228",
  "border-focus": "#af011c",
  scrollbar: "#3a2228",
  "scrollbar-hover": "#5a3038",
  success: "#5ce626",
  warning: "#ffb454",
  error: "#f30100",
  info: "#48b3ac",
  accent: "#af011c",
};

let connId: string | null = null;
let settingsFile: string | null = null;
let themeFile: string | null = null;

/** Editor/terminal sections, held for the theme layer to consume. */
export let editorColors: Record<string, string> = {};
export let terminalColors: Record<string, string> = {};
/** Host identity color on every terminal's cursor + selection (default on). */
export let terminalHostColorConfig = true;
export let terminalFontConfig: { family?: string; size?: number } = {};
/** The live `colors` section (for "save current theme"). */
export let uiColors: Record<string, string> = {};
/** The theme library from theme.json. */
export let savedThemes: Record<string, ThemeData> = {};
/** The raw keybinding overrides (for the settings UI). */
export let keybindingOverrides: Record<string, string> = {};
/** The live zoom value from settings (for the settings UI). */
export let settingsZoom = 1;
/** Effective bottom-panel config (visibility + poll intervals, seconds). */
export let panelsConfig = { ...PANEL_DEFAULTS };
/** Host keys that reconnect on launch without asking (settings `autoConnect`). */
export let autoConnectHosts: string[] = [];
/** Hot-exit drafts on/off (settings `drafts.enabled`). */
export let draftsConfig: { enabled: boolean } = { enabled: true };
/** UI reduction switches (settings `ui`). Both are the raw wish — consumers
 *  honor `localOnly` only while nothing non-local is connected, and
 *  `disableChat` only while no terminal lives in the CHAT panel. */
export let uiConfig: { localOnly: boolean; disableChat: boolean } = {
  localOnly: false,
  disableChat: false,
};
/** Download destination (settings `download.dir`); "" = OS Downloads folder. */
export let downloadConfig: { dir: string } = { dir: "" };

/** Per-host cap on session lanes (dedicated SSH connections for SESSIONS/F11
 *  agents); 0 = always share the main connection. */
export let sessionConnConfig: { max: number } = { max: 10 };

/** Transfer speed defaults (Preferences → Transfers). */
export let transfersConfig: {
  default: "full" | "background";
  backgroundLimitMBps: number;
} = { default: "background", backgroundLimitMBps: 10 };
let confirms: Record<string, boolean> = {};

/** Snapshot of the confirm flags (for the settings UI). */
export function confirmFlags(): Record<string, boolean> {
  return { ...confirms };
}

/** Called after every (re)apply so the theme layer can push editor/terminal
 *  colors into Monaco and live terminals. */
let onApplied: (() => void) | null = null;

export function setOnSettingsApplied(cb: () => void): void {
  onApplied = cb;
}

export function settingsFilePath(): string | null {
  return settingsFile;
}

export function themeFilePath(): string | null {
  return themeFile;
}

/** Whether the ask-dialog `id` should show (default yes; settings can silence). */
export function confirmEnabled(id: string): boolean {
  return confirms[id] !== false;
}

/** Silence an ask-dialog permanently (the "don't ask again" checkbox). */
export async function disableConfirm(id: string): Promise<void> {
  await updateSettings({ confirms: { ...confirms, [id]: false } });
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

/** Read + parse one of the files. `missing` distinguishes "no file yet" (pure
 *  defaults, not an error) from a parse problem (reported). */
async function readJson(
  file: string,
  label: string,
  issues: string[],
): Promise<{ data: Settings; missing: boolean }> {
  let raw: string | null = null;
  try {
    raw = (await fsReadFile(connId!, file)).content;
  } catch {
    return { data: {}, missing: true };
  }
  if (!raw || !raw.trim()) return { data: {}, missing: true };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return { data: parsed as Settings, missing: false };
    issues.push(`${label}: top level must be an object`);
  } catch (e) {
    issues.push(`${label}: ${String(e).replace("SyntaxError: ", "")}`);
  }
  return { data: {}, missing: false };
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await fsWriteFile(connId!, file, `${JSON.stringify(data, null, 2)}\n`, null);
}

function splitKeys(data: Settings): { theme: Settings; rest: Settings } {
  const theme: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    (THEME_KEYS.has(k) ? theme : rest)[k] = v;
  }
  return { theme: theme as Settings, rest: rest as Settings };
}

async function loadAndApply(): Promise<void> {
  if (!settingsFile || !themeFile || !connId) return;
  const issues: string[] = [];

  const s = (await readJson(settingsFile, "settings.json", issues)).data;
  const t = (await readJson(themeFile, "theme.json", issues)).data;

  // Zoom
  if (s.zoom !== undefined) {
    if (typeof s.zoom === "number" && s.zoom >= 0.5 && s.zoom <= 3) {
      void applyZoom(s.zoom);
    } else {
      issues.push('settings.json: "zoom" must be a number between 0.5 and 3');
      void applyZoom(1);
    }
  } else {
    void applyZoom(1);
  }

  // Keybindings (invalid entries are reported and skipped, valid ones apply)
  keybindingOverrides = { ...(s.keybindings ?? {}) };
  issues.push(...applyKeybindingOverrides(s.keybindings ?? {}));
  settingsZoom =
    typeof s.zoom === "number" && s.zoom >= 0.5 && s.zoom <= 3 ? s.zoom : 1;

  // Terminal font (family string, size 6–40; invalid entries report + default)
  terminalFontConfig = {};
  const font = s.terminalFont;
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

  // Startup reconnect list: per-host keys; anything not listed asks.
  autoConnectHosts = [];
  if (s.autoConnect !== undefined) {
    if (Array.isArray(s.autoConnect)) {
      autoConnectHosts = [
        ...new Set(s.autoConnect.filter((v): v is string => typeof v === "string")),
      ];
    } else {
      issues.push(
        'autoConnect: now a list of host keys, e.g. ["wsl:Ubuntu", "user@host:22"] — the old {"wsl","remote"} modes were removed; unlisted hosts are asked on launch',
      );
    }
  }

  // Hot-exit drafts (enabled flag) and the restore-drafts policy.
  draftsConfig = { enabled: true };
  if (s.drafts !== undefined) {
    if (s.drafts && typeof s.drafts === "object") {
      if (s.drafts.enabled !== undefined) {
        if (typeof s.drafts.enabled === "boolean") {
          draftsConfig.enabled = s.drafts.enabled;
        } else {
          issues.push('drafts: "enabled" must be true or false');
        }
      }
    } else {
      issues.push('drafts: must be an object like { "enabled": true }');
    }
  }

  // Bottom-panel groups (visibility flags + poll intervals, 3–3600 s).
  const pl = s.panels ?? {};
  const secs = (v: unknown, dflt: number, name: string) => {
    if (v === undefined) return dflt;
    if (typeof v === "number" && v >= 3 && v <= 3600) return v;
    issues.push(`panels: "${name}" must be a number of seconds (3–3600)`);
    return dflt;
  };
  panelsConfig = {
    ports: pl.ports !== false,
    containers: pl.containers !== false,
    forwarding: pl.forwarding !== false,
    transfers: pl.transfers !== false,
    portsInterval: secs(pl.portsInterval, PANEL_DEFAULTS.portsInterval, "portsInterval"),
    containersInterval: secs(
      pl.containersInterval,
      PANEL_DEFAULTS.containersInterval,
      "containersInterval",
    ),
    hideSystemPorts: pl.hideSystemPorts !== false,
    portsIgnoreHosts: Array.isArray(pl.portsIgnoreHosts)
      ? pl.portsIgnoreHosts.filter((h): h is string => typeof h === "string")
      : [],
    containersIgnoreHosts: Array.isArray(pl.containersIgnoreHosts)
      ? pl.containersIgnoreHosts.filter((h): h is string => typeof h === "string")
      : [],
  };

  // UI reduction switches. Both gates live at the render sites (uiConfig
  // keeps the raw wish) — wishing the impossible gets flagged so the no-op
  // is explained.
  downloadConfig = {
    dir: typeof s.download?.dir === "string" ? s.download.dir : "",
  };

  sessionConnConfig = {
    max:
      typeof s.sessionConnections?.max === "number"
        ? Math.min(30, Math.max(0, Math.round(s.sessionConnections.max)))
        : 10,
  };

  transfersConfig = {
    default: s.transfers?.default === "full" ? "full" : "background",
    backgroundLimitMBps:
      typeof s.transfers?.backgroundLimitMBps === "number"
        ? Math.min(10000, Math.max(0, Math.round(s.transfers.backgroundLimitMBps)))
        : 10,
  };

  const ui = s.ui ?? {};
  if (s.ui !== undefined && (typeof s.ui !== "object" || s.ui === null)) {
    issues.push(
      'ui: must be an object like { "localOnly": false, "disableChat": false }',
    );
  }
  uiConfig = {
    localOnly: ui.localOnly === true,
    disableChat: ui.disableChat === true,
  };
  {
    const app = useAppStore.getState();
    if (uiConfig.localOnly && (app.wsls.length > 0 || app.remotes.length > 0)) {
      issues.push(
        "ui: localOnly is set but WSL/remote hosts are connected — it takes effect once they disconnect",
      );
    }
    if (uiConfig.disableChat && app.terminals.some((t) => t.inChat)) {
      issues.push(
        "ui: disableChat is set but terminals live in the CHAT panel — it takes effect once they're returned (−) or closed",
      );
    }
  }

  // Silenced ask-dialogs (non-boolean entries are reported and ignored).
  confirms = {};
  if (s.confirms !== undefined) {
    if (s.confirms && typeof s.confirms === "object") {
      for (const [k, v] of Object.entries(s.confirms)) {
        if (typeof v === "boolean") confirms[k] = v;
        else issues.push(`confirms: "${k}" must be true or false`);
      }
    } else {
      issues.push('confirms: must be an object like { "exit": false }');
    }
  }

  // The live color sections (bottom of settings.json). Files not yet migrated
  // may still carry the retired per-scope terminal split — first one wins
  // under the single section until migration rewrites the file.
  const src = (k: keyof Settings) => (s[k] ?? t[k]) as Record<string, string> | undefined;
  uiColors = src("colors") ?? {};
  applyUiColors(uiColors, issues);
  editorColors = src("editor") ?? {};
  const oldSplit = OLD_TERMINAL_KEYS.map(
    (k) => (s as Record<string, unknown>)[k] as Record<string, string> | undefined,
  ).find((v) => v && typeof v === "object");
  terminalColors = src("terminal") ?? oldSplit ?? {};
  terminalHostColorConfig = true;
  if (s.terminalHostColor !== undefined) {
    if (typeof s.terminalHostColor === "boolean") {
      terminalHostColorConfig = s.terminalHostColor;
    } else {
      issues.push("terminalHostColor: must be true or false");
    }
  }

  // The theme library (hidden file; lightly validated — entries = objects).
  savedThemes = {};
  if (t.themes !== undefined) {
    if (t.themes && typeof t.themes === "object") {
      for (const [name, data] of Object.entries(t.themes)) {
        if (data && typeof data === "object") savedThemes[name] = data;
        else issues.push(`themes: "${name}" must be an object of color sections`);
      }
    } else {
      issues.push("themes: must be an object of named themes");
    }
  }
  onApplied?.();

  // Components render off the module-level configs above — nudge them.
  useAppStore.getState().bumpSettingsRev();

  const prev = useAppStore.getState().settingsIssues;
  useAppStore.getState().setSettingsIssues(issues);
  if (issues.length > 0 && prev.join("\n") !== issues.join("\n")) {
    useAppStore
      .getState()
      .pushNotice("error", `Settings: ${issues.length} problem${issues.length === 1 ? "" : "s"} — see the command palette`);
  }
}

/** Merge a patch into the right file(s) (sections replace wholesale) and
 *  re-apply. Theme sections go to theme.json, everything else to settings.json. */
export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  // Self-heal: a dev hot-reload can reset this module's state — re-init from
  // the live local session instead of silently dropping the write.
  if (!settingsFile || !connId) {
    const localConnId = useAppStore.getState().localConnId;
    if (localConnId) await initSettings(localConnId);
  }
  if (!settingsFile || !themeFile || !connId) {
    useAppStore
      .getState()
      .pushNotice("error", "Settings not ready yet — try again in a moment.");
    return;
  }
  const { theme: themePatch, rest: settingsPatch } = splitKeys(patch as Settings);
  const issues: string[] = [];
  if (Object.keys(settingsPatch).length > 0) {
    const current = (await readJson(settingsFile, "settings.json", issues)).data;
    await writeJson(settingsFile, { ...current, ...settingsPatch });
  }
  if (Object.keys(themePatch).length > 0) {
    const current = (await readJson(themeFile, "theme.json", issues)).data;
    await writeJson(themeFile, { ...current, ...themePatch });
  }
  await loadAndApply();
}

/** Guard shared by the reset actions: self-heal after a dev hot-reload and
 *  refuse loudly (toast) when the files aren't resolvable yet. */
async function ensureFilesReady(): Promise<boolean> {
  if (!settingsFile || !connId) {
    const localConnId = useAppStore.getState().localConnId;
    if (localConnId) await initSettings(localConnId);
  }
  if (!settingsFile || !themeFile || !connId) {
    useAppStore
      .getState()
      .pushNotice("error", "Settings not ready yet — try again in a moment.");
    return false;
  }
  return true;
}

/** FULL reset: settings.json back to the shipped template — behavior keys
 *  AND color sections, every key at its default. theme.json (the saved-theme
 *  library) is untouched. The escape hatch for a hand-edit gone wrong. */
export async function resetSettingsFile(): Promise<void> {
  if (!(await ensureFilesReady())) return;
  const out: Settings = { ...settingsTemplate() };
  const templ = themeTemplate?.();
  if (templ) {
    for (const key of THEME_SECTION_KEYS) {
      out[key] = { ...(templ[key] ?? {}) } as never;
    }
  }
  await writeJson(settingsFile!, out);
  await loadAndApply();
  useAppStore
    .getState()
    .pushNotice("info", "settings.json reset to defaults.");
}

/** Restore the shipped built-in themes: re-added AND renewed to their
 *  current designs, listed before custom saves; custom-named themes are
 *  untouched. Also updates the seed ledger so they stay restored. */
export async function restoreBuiltinThemes(): Promise<void> {
  if (!(await ensureFilesReady())) return;
  const issues: string[] = [];
  const current = (await readJson(themeFile!, "theme.json", issues)).data;
  const builtins = themeTemplate?.()?.themes ?? {};
  const existing =
    current.themes && typeof current.themes === "object" ? current.themes : {};
  const customs = Object.fromEntries(
    Object.entries(existing).filter(([name]) => !(name in builtins)),
  );
  const rawSeeded = (current as { seeded?: unknown }).seeded;
  const seeded = new Set<string>(
    Array.isArray(rawSeeded)
      ? rawSeeded.filter((n): n is string => typeof n === "string")
      : [],
  );
  for (const name of Object.keys(builtins)) seeded.add(name);
  // Built-ins first (insertion order is display order), customs after.
  await writeJson(themeFile!, {
    themes: { ...builtins, ...customs },
    seeded: [...seeded].sort(),
  });
  await loadAndApply();
  useAppStore
    .getState()
    .pushNotice("info", "Built-in themes restored (your saved themes were kept).");
}

/** Migration + template seeding, run at every launch. settings.json is kept a
 *  complete template (behavior keys on top, the live color sections at the
 *  bottom, every key filled — user values always win). theme.json is reduced
 *  to the hidden library; its `themes` map is seeded with the built-ins ONCE
 *  (only when absent/empty), so UI deletions of built-ins stick. */
async function migrateAndSeed(): Promise<void> {
  const issues: string[] = [];
  const s = await readJson(settingsFile!, "settings.json", issues);
  const t = await readJson(themeFile!, "theme.json", issues);

  // Never seed without the theme template (a dev hot-reload can momentarily
  // leave it unset — writing then would produce degraded, half-empty files).
  const templ = themeTemplate?.();
  if (!templ) return;

  // settings.json: behavior template ← user's behavior; then per-key-filled
  // color sections (template ← sections parked in theme.json by the previous
  // layout ← sections already here). Confirms merge per-key so new dialog ids
  // appear over time.
  const templS = settingsTemplate();
  // Retired per-scope split (terminalLocal/Wsl/Remote): the first non-empty
  // section seeds the single `terminal`, and the old keys are dropped.
  const oldSplit = OLD_TERMINAL_KEYS.map(
    (k) => (s.data as Record<string, unknown>)[k] as Record<string, string> | undefined,
  ).find((v) => v && typeof v === "object");
  const settingsOut: Settings = {
    ...templS,
    ...Object.fromEntries(
      Object.entries(s.data).filter(
        ([k]) =>
          !THEME_KEYS.has(k) &&
          !OLD_TERMINAL_KEYS.includes(k) &&
          !THEME_SECTION_KEYS.includes(k as never),
      ),
    ),
    confirms: { ...templS.confirms, ...(s.data.confirms ?? {}) },
  };
  for (const key of THEME_SECTION_KEYS) {
    settingsOut[key] = {
      ...(templ[key] ?? {}),
      ...(key === "terminal" ? (oldSplit ?? {}) : {}),
      ...(t.data[key] ?? {}),
      ...(s.data[key] ?? {}),
    };
  }
  if (s.missing || JSON.stringify(settingsOut) !== JSON.stringify(s.data)) {
    await writeJson(settingsFile!, settingsOut);
  }

  // theme.json: the library plus a LEDGER of built-in names ever seeded.
  // A built-in whose name isn't in the ledger is ADDED (so new built-ins
  // reach existing installs); one that is stays untouched — user edits are
  // never overwritten and deletions stick (the name stays in the ledger).
  // Pre-ledger files treat whatever is present as already-seeded.
  const rawThemes = t.data.themes;
  const themes: Record<string, ThemeData> =
    rawThemes && typeof rawThemes === "object" ? { ...rawThemes } : {};
  const rawSeeded = (t.data as { seeded?: unknown }).seeded;
  const seeded = new Set<string>(
    Array.isArray(rawSeeded)
      ? rawSeeded.filter((n): n is string => typeof n === "string")
      : Object.keys(themes),
  );
  for (const [name, data] of Object.entries(templ.themes ?? {})) {
    if (!seeded.has(name)) {
      themes[name] = data;
      seeded.add(name);
    }
  }
  const themeOut: Settings = { themes, seeded: [...seeded].sort() };
  if (t.missing || JSON.stringify(themeOut) !== JSON.stringify(t.data)) {
    await writeJson(themeFile!, themeOut);
  }
}

/** Resolve the files, migrate/seed once, apply, and keep both live. */
export async function initSettings(localConnId: string): Promise<void> {
  connId = localConnId;
  settingsFile = await settingsPath();
  themeFile = settingsFile.replace(/settings\.json$/i, "theme.json");
  try {
    await migrateAndSeed();
  } catch {
    /* seeding is best-effort; missing files still apply as pure defaults */
  }
  await loadAndApply();
  fileWatch(localConnId, settingsFile).catch(() => {});
  fileWatch(localConnId, themeFile).catch(() => {});
  void onFileFsChange((c) => {
    if (c.path === settingsFile || c.path === themeFile) void loadAndApply();
  });
}
