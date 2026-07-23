/** The Themes editor tab: the live color sections as pickable color cards,
 *  plus the library — save the current colors under a name, apply or delete
 *  any saved theme (built-ins included; deletions are permanent). */
import { useState } from "react";

import {
  terminalColors,
  editorColors,
  UI_COLOR_DEFAULTS,
  uiColors,
  updateSettings,
} from "../../lib/settings";
import {
  applyTheme,
  deleteTheme,
  EDITOR_DEFAULTS,
  saveCurrentTheme,
  savedThemeNames,
  TERMINAL_DEFAULTS,
} from "../../lib/themes";
import { useAppStore } from "../../store/appStore";
import { IconChevron, IconClose } from "../icons";
import { Tip } from "../Tooltip";

const SECTIONS: {
  key: "colors" | "editor" | "terminal";
  title: string;
  defaults: Record<string, string>;
  live: () => Record<string, string>;
}[] = [
  { key: "colors", title: "UI colors", defaults: UI_COLOR_DEFAULTS, live: () => uiColors },
  { key: "editor", title: "Editor", defaults: EDITOR_DEFAULTS, live: () => editorColors },
  { key: "terminal", title: "Terminal", defaults: TERMINAL_DEFAULTS, live: () => terminalColors },
];

const HEX_RE = /^#[0-9a-f]{6}$/i;

export function ThemesView() {
  // Re-render on every settings (re)apply.
  useAppStore((s) => s.settingsIssues);
  const [saveName, setSaveName] = useState("");
  const [open, setOpen] = useState<string>("colors");

  const doSave = () => {
    if (!saveName.trim()) return;
    void saveCurrentTheme(saveName.trim());
    setSaveName("");
  };

  return (
    <div className="app-tab">
      <h2 className="app-tab__title">Themes</h2>

      <h3 className="app-tab__section">Saved themes</h3>
      <div className="theme-manage__save">
        <input
          className="input"
          placeholder="Save current colors as…"
          value={saveName}
          onChange={(e) => setSaveName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") doSave();
          }}
        />
        <button className="btn btn--primary" disabled={!saveName.trim()} onClick={doSave}>
          Save
        </button>
      </div>
      <div className="app-tab__hint">
        Same name overwrites. Deleting is permanent (built-ins included).
      </div>
      {savedThemeNames().map((name) => (
        <div key={name} className="theme-manage__row">
          <span className="theme-manage__name">{name}</span>
          <button className="btn btn--ghost" onClick={() => void applyTheme(name)}>
            Use
          </button>
          <Tip label={`Delete "${name}"`}>
            <button
              className="icon-btn icon-btn--danger"
              onClick={() => void deleteTheme(name)}
            >
              <IconClose size={12} />
            </button>
          </Tip>
        </div>
      ))}

      <h3 className="app-tab__section">Current colors</h3>
      <div className="app-tab__hint">
        Click a swatch to change it — applied live, saved to settings.json.
      </div>
      {SECTIONS.map((sec) => {
        const effective = { ...sec.defaults, ...sec.live() };
        const isOpen = open === sec.key;
        return (
          <div key={sec.key}>
            <button
              className="theme-cards__head"
              onClick={() => setOpen(isOpen ? "" : sec.key)}
            >
              <IconChevron size={12} dir={isOpen ? "down" : "right"} /> {sec.title}
            </button>
            {isOpen && (
              <div className="theme-cards">
                {Object.entries(effective).map(([key, value]) => (
                  <Tip key={key} label={`${key}: ${value}`}>
                    <label className="theme-card">
                      <input
                        type="color"
                        value={HEX_RE.test(value) ? value.toLowerCase() : "#000000"}
                        onChange={(e) =>
                          void updateSettings({
                            [sec.key]: { ...effective, [key]: e.target.value },
                          })
                        }
                      />
                      <span className="theme-card__name">{key}</span>
                    </label>
                  </Tip>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
