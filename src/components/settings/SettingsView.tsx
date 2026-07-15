/** The Settings editor tab: General (zoom, terminal font), Confirmations
 *  (ask/silent per dialog), and Keybindings (click a key, press new keys).
 *  Every control writes through updateSettings — the file stays the source of
 *  truth (hand-edits and this UI can be mixed freely). */
import { useState } from "react";

import { allCommands, commandKeyLabel } from "../../lib/commands";
import {
  clearAllDrafts,
  clearDraftsForHost,
  listDrafts,
} from "../../lib/drafts";
import { basename } from "../../lib/format";
import { allPinnedTabs, setTabPinned } from "../../lib/pinnedTabs";
import {
  CONFIRM_IDS,
  confirmFlags,
  draftsConfig,
  keybindingOverrides,
  restoreConfig,
  settingsZoom,
  terminalFontConfig,
  updateSettings,
} from "../../lib/settings";
import { remoteHostKey, useAppStore } from "../../store/appStore";
import { useVcsStore } from "../../store/vcsStore";

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

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
  // Bumped after a draft clear so the list below re-reads.
  const [, setDraftTick] = useState(0);
  const askConfirm = useVcsStore((s) => s.askConfirm);

  const flags = confirmFlags();
  const font = terminalFontConfig;

  const drafts = listDrafts();
  const draftHosts = new Map<string, { count: number; bytes: number }>();
  for (const d of drafts) {
    const g = draftHosts.get(d.connKey) ?? { count: 0, bytes: 0 };
    g.count += 1;
    g.bytes += d.bytes;
    draftHosts.set(d.connKey, g);
  }

  const pins = allPinnedTabs();
  const pinsByHost = new Map<string, string[]>();
  for (const p of pins) {
    pinsByHost.set(p.connKey, [...(pinsByHost.get(p.connKey) ?? []), p.path]);
  }
  /** Remove a pin here AND on any live tab, so the ⌖ badge can't go stale.
   *  (This list is also the only place to unpin a host you're not connected
   *  to — the tab that would carry the unpin button doesn't exist.) */
  const unpinEverywhere = (connKey: string, path: string) => {
    const s = useAppStore.getState();
    const connId =
      connKey === "local"
        ? s.localConnId
        : connKey.startsWith("wsl:")
          ? (s.wsls.find((w) => w.conn.name === connKey.slice(4))?.conn.connId ?? null)
          : (s.remotes.find((r) => remoteHostKey(r.conn) === connKey)?.conn.connId ??
            null);
    const tab = connId
      ? s.tabs.find(
          (t) =>
            t.connId === connId && t.path === path && (!t.kind || t.kind === "file"),
        )
      : undefined;
    if (tab?.pinned) s.pinTab(tab.id, false); // updates the map too
    else setTabPinned(connKey, path, false);
    setDraftTick((t) => t + 1);
  };

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

      <h3 className="app-tab__section">Pinned files</h3>
      <div className="app-tab__hint">
        Pinned (⌖) files reopen on every connect to their host — that part has
        no setting. Manage the lists here; this is also the only way to unpin
        a file on a host you're not connected to.
      </div>
      {[...pinsByHost.entries()].map(([host, paths]) => (
        <div key={host}>
          <div className="settings-row">
            <span className="settings-row__label" title={host}>
              {host} — {paths.length} pinned
            </span>
            <button
              className="btn btn--ghost"
              onClick={() => paths.forEach((p) => unpinEverywhere(host, p))}
            >
              Clear
            </button>
          </div>
          {paths.map((p) => (
            <div key={p} className="settings-row">
              <span className="settings-row__label mono" title={p}>
                &nbsp;&nbsp;⌖ {basename(p)}
              </span>
              <button
                className="icon-btn"
                title={`Unpin ${p}`}
                onClick={() => unpinEverywhere(host, p)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      ))}
      {pins.length > 1 && (
        <div className="settings-row">
          <span className="settings-row__label">
            All hosts — {pins.length} pinned files
          </span>
          <button
            className="btn btn--ghost"
            onClick={() =>
              askConfirm(
                "Unpin everything?",
                `Remove all ${pins.length} pinned files (every host)? The files themselves are untouched; they just stop auto-opening.`,
                () => pins.forEach((p) => unpinEverywhere(p.connKey, p.path)),
              )
            }
          >
            Clear all
          </button>
        </div>
      )}
      {pins.length === 0 && (
        <div className="app-tab__hint">
          Nothing pinned — pin a tab (right-click → Pin) to make a file part of
          a host's permanent workspace.
        </div>
      )}

      <h3 className="app-tab__section">Drafts</h3>
      <div className="app-tab__hint">
        Unsaved edits are cached locally (app config dir, drafts/) so a crash
        or close can't lose them. Drafts are plain-text copies of file content
        — turn this off for sensitive hosts.
      </div>
      <label className="settings-row settings-row--check">
        <input
          type="checkbox"
          checked={draftsConfig.enabled}
          onChange={(e) =>
            void updateSettings({ drafts: { enabled: e.target.checked } })
          }
        />
        Keep local drafts of unsaved edits
      </label>
      <div className="settings-row">
        <span className="settings-row__label">Restore drafts on launch</span>
        <select
          className="input"
          value={restoreConfig.openFiles}
          onChange={(e) =>
            void updateSettings({ restore: { openFiles: e.target.value } })
          }
        >
          <option value="ask">ask (per host)</option>
          <option value="always">always</option>
        </select>
      </div>
      {[...draftHosts.entries()].map(([host, g]) => (
        <div key={host} className="settings-row">
          <span className="settings-row__label" title={host}>
            {host} — {g.count} draft{g.count === 1 ? "" : "s"} · {fmtBytes(g.bytes)}
          </span>
          <button
            className="btn btn--ghost"
            onClick={() =>
              askConfirm(
                "Clear drafts?",
                `Delete ${g.count} draft${g.count === 1 ? "" : "s"} for "${host}"? Unsaved changes cached there are gone for good — files on the host are untouched.`,
                () =>
                  void clearDraftsForHost(host).then(() => setDraftTick((t) => t + 1)),
              )
            }
          >
            Clear
          </button>
        </div>
      ))}
      {drafts.length > 0 && (
        <div className="settings-row">
          <span className="settings-row__label">
            All hosts — {drafts.length} draft{drafts.length === 1 ? "" : "s"}
          </span>
          <button
            className="btn btn--ghost"
            onClick={() =>
              askConfirm(
                "Clear ALL drafts?",
                `Delete every cached draft (${drafts.length}), including strays from crashed sessions? Files on your hosts are untouched.`,
                () => void clearAllDrafts().then(() => setDraftTick((t) => t + 1)),
              )
            }
          >
            Clear all
          </button>
        </div>
      )}
      {drafts.length === 0 && (
        <div className="app-tab__hint">No drafts right now — all edits are saved.</div>
      )}

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
