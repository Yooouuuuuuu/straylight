/** The Settings editor tab: General (zoom, terminal font), Confirmations
 *  (ask/silent per dialog), and Keybindings (click a key, press new keys).
 *  Every control writes through updateSettings — the file stays the source of
 *  truth (hand-edits and this UI can be mixed freely). */
import { useState } from "react";

import { allCommands, commandKeyLabel } from "../../lib/commands";
import {
  CONFIRM_IDS,
  confirmFlags,
  keybindingOverrides,
  settingsZoom,
  terminalFontConfig,
  updateSettings,
} from "../../lib/settings";
import { useAppStore } from "../../store/appStore";

const CONFIRM_LABELS: Record<string, string> = {
  exit: "Closing the app",
  "unpin-folder": "Unpinning a folder",
  "track-repo": "Adding a repository to Source Control",
  "remove-repo": "Removing a repository",
  "vcs-update": "Merging the fetched upstream (Update)",
  "vcs-push": "Pushing to the remote",
  "vcs-stash-pop": "Popping a stash",
  "vcs-amend-pushed": "Amending a pushed commit",
};

export function SettingsView() {
  // Re-render on every settings (re)apply — the issues array is replaced then.
  useAppStore((s) => s.settingsIssues);
  const [recording, setRecording] = useState<string | null>(null);

  const flags = confirmFlags();
  const font = terminalFontConfig;

  const setKeybinding = (id: string, spec: string | null) => {
    const next = { ...keybindingOverrides };
    if (spec === null) delete next[id];
    else next[id] = spec;
    void updateSettings({ keybindings: next });
  };

  const onRecordKey = (id: string, e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      setRecording(null);
      return;
    }
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
    const spec = [
      e.ctrlKey || e.metaKey ? "ctrl" : "",
      e.shiftKey ? "shift" : "",
      e.altKey ? "alt" : "",
      e.key.toLowerCase(),
    ]
      .filter(Boolean)
      .join("+");
    setKeybinding(id, spec);
    setRecording(null);
  };

  return (
    <div className="app-tab">
      <h2 className="app-tab__title">Settings</h2>
      <div className="app-tab__hint">
        Everything here lives in settings.json (⚙ → Open settings.json) — this
        page and hand-edits mix freely.
      </div>

      <h3 className="app-tab__section">General</h3>
      <div className="settings-row">
        <span className="settings-row__label">Zoom</span>
        <input
          type="number"
          className="input settings-row__num"
          min={0.5}
          max={3}
          step={0.1}
          value={settingsZoom}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (v >= 0.5 && v <= 3) void updateSettings({ zoom: v });
          }}
        />
      </div>
      <div className="settings-row">
        <span className="settings-row__label">Terminal font family</span>
        <input
          className="input"
          defaultValue={font.family ?? "Fira Code"}
          onBlur={(e) => {
            const family = e.target.value.trim();
            if (family) void updateSettings({ terminalFont: { ...font, family } });
          }}
        />
      </div>
      <div className="settings-row">
        <span className="settings-row__label">Terminal font size</span>
        <input
          type="number"
          className="input settings-row__num"
          min={6}
          max={40}
          value={font.size ?? 13}
          onChange={(e) => {
            const size = Number(e.target.value);
            if (size >= 6 && size <= 40)
              void updateSettings({ terminalFont: { ...font, size } });
          }}
        />
      </div>

      <h3 className="app-tab__section">Confirmations</h3>
      <div className="app-tab__hint">Checked = ask first; unchecked = just do it.</div>
      {CONFIRM_IDS.map((id) => (
        <label key={id} className="settings-row settings-row--check">
          <input
            type="checkbox"
            checked={flags[id] !== false}
            onChange={(e) =>
              void updateSettings({ confirms: { ...flags, [id]: e.target.checked } })
            }
          />
          {CONFIRM_LABELS[id] ?? id}
        </label>
      ))}

      <h3 className="app-tab__section">Keybindings</h3>
      <div className="app-tab__hint">
        Click a key, then press the new combination (Esc cancels). ↩ resets to
        the default.
      </div>
      {allCommands().map((c) => (
        <div key={c.id} className="settings-row">
          <span className="settings-row__label" title={c.id}>
            {c.title}
          </span>
          <button
            className={`kbd-btn ${recording === c.id ? "kbd-btn--recording" : ""}`}
            onClick={() => setRecording(c.id)}
            onKeyDown={recording === c.id ? (e) => onRecordKey(c.id, e) : undefined}
            onBlur={() => setRecording((r) => (r === c.id ? null : r))}
          >
            {recording === c.id
              ? "press keys…"
              : (commandKeyLabel(c.id) ?? "unbound")}
          </button>
          {keybindingOverrides[c.id] && (
            <button
              className="icon-btn"
              title="Reset to default"
              onClick={() => setKeybinding(c.id, null)}
            >
              ↩
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
