/** The STORAGE tabs — inventories the app keeps on your behalf, split out of
 *  Preferences (they're things you audit and prune, not knobs you set):
 *  - DraftsView: cached unsaved edits per host (with the two switches that
 *    govern them, kept beside the list they control);
 *  - PinsView: pinned files per host.
 *  Both live in their existing stores (drafts/ dir, localStorage) — nothing
 *  here touches settings.json except the drafts on/off + restore policy. */
import { useState } from "react";

import {
  clearAllDrafts,
  clearDraftsForHost,
  listDrafts,
} from "../../lib/drafts";
import { basename } from "../../lib/format";
import { allPinnedTabs, setTabPinned } from "../../lib/pinnedTabs";
import { draftsConfig, restoreConfig, updateSettings } from "../../lib/settings";
import { remoteHostKey, useAppStore } from "../../store/appStore";
import { useVcsStore } from "../../store/vcsStore";
import { IconClose } from "../icons";

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

export function DraftsView() {
  useAppStore((s) => s.settingsRev); // the switches re-render on settings apply
  const [, setTick] = useState(0);
  const askConfirm = useVcsStore((s) => s.askConfirm);

  const drafts = listDrafts();
  const draftHosts = new Map<string, { count: number; bytes: number }>();
  for (const d of drafts) {
    const g = draftHosts.get(d.connKey) ?? { count: 0, bytes: 0 };
    g.count += 1;
    g.bytes += d.bytes;
    draftHosts.set(d.connKey, g);
  }

  return (
    <div className="app-tab">
      <h2 className="app-tab__title">Drafts</h2>
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
                () => void clearDraftsForHost(host).then(() => setTick((t) => t + 1)),
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
                () => void clearAllDrafts().then(() => setTick((t) => t + 1)),
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
    </div>
  );
}

export function PinsView() {
  const [, setTick] = useState(0);
  const askConfirm = useVcsStore((s) => s.askConfirm);

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
    setTick((t) => t + 1);
  };

  return (
    <div className="app-tab">
      <h2 className="app-tab__title">Pinned files</h2>
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
                <IconClose size={12} />
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
    </div>
  );
}
