/** The Preferences tab: General (zoom, terminal font), Interface (local-only,
 *  CHAT), Confirmations (ask/silent per dialog), and Keybindings. Every
 *  control writes through updateSettings — settings.json stays the source of
 *  truth (hand-edits and this UI mix freely). The pinned-files and drafts
 *  INVENTORIES live under ⚙ → Storage (StorageViews), not here. */
import { useState } from "react";

import { allCommands, commandKeyLabel } from "../../lib/commands";
import {
  CONFIRM_IDS,
  confirmFlags,
  downloadConfig,
  keybindingOverrides,
  resetSettingsFile,
  sessionConnConfig,
  settingsZoom,
  terminalFontConfig,
  terminalHostColorConfig,
  uiConfig,
  updateSettings,
} from "../../lib/settings";
import { useAppStore } from "../../store/appStore";
import { useVcsStore } from "../../store/vcsStore";
import { IconUndo } from "../icons";
import { Tip } from "../Tooltip";

const CONFIRM_LABELS: Record<string, string> = {
  exit: "Closing the app",
  "unpin-folder": "Unpinning a folder",
  "remove-repo": "Removing a repository",
  "vcs-update": "Merging the fetched upstream (Update)",
  "vcs-push": "Pushing to the remote",
  "vcs-stash-pop": "Popping a stash",
  "vcs-amend-pushed": "Amending a pushed commit",
  "usage-check": "Checking Claude usage on a host",
  "close-agent": "Closing a session",
};

export function SettingsView() {
  // Re-render on every settings (re)apply — the issues array is replaced then.
  useAppStore((s) => s.settingsIssues);
  useAppStore((s) => s.settingsRev);
  const [recording, setRecording] = useState<string | null>(null);
  // Local-only can't hide live connections — the checkbox locks while any
  // WSL/remote host is up. Same shape for CHAT: it can't be disabled while
  // terminals live in the panel.
  const hasNonLocal = useAppStore(
    (s) => s.wsls.length > 0 || s.remotes.length > 0,
  );
  const hasChatResidents = useAppStore((s) =>
    s.terminals.some((t) => t.inChat),
  );

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
      <h2 className="app-tab__title">Preferences</h2>
      <div className="app-tab__hint">
        Everything here lives in settings.json (⚙ → Open settings.json) — this
        page and hand-edits mix freely. Pinned files and drafts moved to
        ⚙ → Storage.
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
        <Tip label="Where Download sends files. Empty = your OS Downloads folder.">
          <span className="settings-row__label">Download folder</span>
        </Tip>
        <input
          className="input"
          placeholder="Downloads (default)"
          defaultValue={downloadConfig.dir}
          onBlur={(e) =>
            void updateSettings({ download: { dir: e.target.value.trim() } })
          }
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

      <h3 className="app-tab__section">Interface</h3>
      <Tip
        label={
          hasNonLocal
            ? "Disconnect all WSL/remote hosts first"
            : "Hides every non-local surface"
        }
      >
      <label
        className="settings-row settings-row--check"
        style={hasNonLocal ? { cursor: "not-allowed", opacity: 0.65 } : undefined}
        onClick={() => {
          if (hasNonLocal) {
            useAppStore
              .getState()
              .pushNotice(
                "warn",
                "Local only is locked while WSL/remote hosts are connected — disconnect them first.",
              );
          }
        }}
      >
        <input
          type="checkbox"
          checked={uiConfig.localOnly}
          disabled={hasNonLocal}
          onChange={(e) =>
            void updateSettings({
              ui: {
                localOnly: e.target.checked,
                disableChat: uiConfig.disableChat,
              },
            })
          }
        />
        Local only
      </label>
      </Tip>
      <Tip
        label={
          hasChatResidents
            ? "Return (−) or close the Sessions terminals first"
            : "Removes the Sessions column entirely"
        }
      >
      <label
        className="settings-row settings-row--check"
        style={
          hasChatResidents ? { cursor: "not-allowed", opacity: 0.65 } : undefined
        }
        onClick={() => {
          if (hasChatResidents) {
            useAppStore
              .getState()
              .pushNotice(
                "warn",
                "Sessions can't be disabled while terminals live in it — return (−) or close them first.",
              );
          }
        }}
      >
        <input
          type="checkbox"
          checked={uiConfig.disableChat}
          disabled={hasChatResidents}
          onChange={(e) =>
            void updateSettings({
              ui: {
                localOnly: uiConfig.localOnly,
                disableChat: e.target.checked,
              },
            })
          }
        />
        Disable Sessions
      </label>
      </Tip>
      <Tip label="Each terminal's cursor + selection take its host's identity color (Local / WSL / remote slots)">
        <label className="settings-row settings-row--check">
          <input
            type="checkbox"
            checked={terminalHostColorConfig}
            onChange={(e) =>
              void updateSettings({ terminalHostColor: e.target.checked })
            }
          />
          Host color in terminals
        </label>
      </Tip>

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

      <h3 className="app-tab__section">Session connections</h3>
      <div className="app-tab__hint">
        Every session opened from the SESSIONS panel (or F11) gets its own SSH
        connection, so one busy agent can't slow down or take out the others.
        This caps how many per host — past it, new sessions share the host's
        main connection instead. Each one costs an extra sshd process on the
        server (a few MB): raising it is fine on your own machines, heavier on
        shared or corporate hosts. 0 = never dedicate, always share.
      </div>
      <div className="settings-row">
        <span className="settings-row__label">Max per host</span>
        <input
          type="number"
          className="input settings-row__num"
          min={0}
          max={30}
          value={sessionConnConfig.max}
          onChange={(e) => {
            const v = Math.round(Number(e.target.value));
            if (v >= 0 && v <= 30)
              void updateSettings({ sessionConnections: { max: v } });
          }}
        />
      </div>

      <h3 className="app-tab__section">Keybindings</h3>
      <div className="app-tab__hint">
        Click a key, then press the new combination (Esc cancels). The undo
        button resets an override to its default.
      </div>
      {allCommands().map((c) => (
        <div key={c.id} className="settings-row">
          <Tip label={c.id}>
            <span className="settings-row__label">{c.title}</span>
          </Tip>
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
            <Tip label="Reset to default">
              <button className="icon-btn" onClick={() => setKeybinding(c.id, null)}>
                <IconUndo size={13} />
              </button>
            </Tip>
          )}
        </div>
      ))}

      <h3 className="app-tab__section">Restore</h3>
      <div className="app-tab__hint">
        Hand-edited settings.json into a broken state? This rewrites it with the
        shipped defaults. Saved themes (theme.json) are untouched.
      </div>
      <div className="settings-row">
        <span className="settings-row__label">Restore settings.json defaults</span>
        <button
          className="btn btn--ghost"
          onClick={() =>
            useVcsStore
              .getState()
              .askConfirm(
                "Restore settings.json defaults?",
                "Every setting returns to its shipped value — keybindings, confirmations, auto-connect hosts, panels, and colors. Your saved themes (theme.json) are untouched.",
                () => void resetSettingsFile(),
              )
          }
        >
          Restore
        </button>
      </div>
    </div>
  );
}
