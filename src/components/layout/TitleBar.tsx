/** Custom (decorationless) title bar: brand, connection status, workspace color
 *  accent, an appearance menu (themes / settings — non-functional preferences
 *  live here, not in the command palette), and window controls. The center
 *  region is a Tauri drag handle. */
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import appIcon from "../../assets/icon.png";
import { remoteColor } from "../../lib/hostColors";
import { openFileByPath } from "../../lib/openFile";
import { settingsFilePath } from "../../lib/settings";
import { applyThemePreset, THEME_PRESETS } from "../../lib/themes";
import { useAppStore } from "../../store/appStore";
import type { ConnectionState } from "../../lib/ipc";
import { IconClose, IconMaximize, IconMinimize } from "../icons";

function Logo({ size = 16 }: { size?: number }) {
  return (
    <img
      src={appIcon}
      width={size}
      height={size}
      className="titlebar__logo"
      alt=""
      aria-hidden
    />
  );
}

const STATE_LABELS: Record<ConnectionState, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
};

export function TitleBar() {
  const remote = useAppStore((s) => s.remote);
  const connState = useAppStore((s) => s.connState);
  const hostColors = useAppStore((s) => s.hostColors);
  const settingsIssues = useAppStore((s) => s.settingsIssues);
  const [menuOpen, setMenuOpen] = useState(false);

  const appWindow = getCurrentWindow();
  // The window carries its remote's identity color (host bars use the same).
  const accent = remote ? remoteColor(hostColors, remote) : "transparent";

  // Native title = the connected host, so the taskbar and Alt+Tab can tell
  // windows apart (the in-window title bar is custom-drawn).
  useEffect(() => {
    const title = remote
      ? `${remote.user}@${remote.host} — Straylight`
      : "Straylight";
    appWindow.setTitle(title).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote?.connId]);

  const openSettingsFile = () => {
    setMenuOpen(false);
    const path = settingsFilePath();
    const localConnId = useAppStore.getState().localConnId;
    if (path && localConnId) void openFileByPath(localConnId, path, "settings.json");
  };

  return (
    <header className="titlebar" style={{ borderLeftColor: accent }}>
      <div className="titlebar__drag" data-tauri-drag-region>
        <div className="titlebar__brand" data-tauri-drag-region>
          <Logo />
          <span className="titlebar__title">Straylight</span>
        </div>
        <div className="titlebar__status" data-tauri-drag-region>
          {remote ? (
            <>
              <span className={`dot dot--${connState}`} />
              <span>
                {remote.name}{" "}
                <span className="mono">
                  ({remote.user}@{remote.host})
                </span>{" "}
                · {STATE_LABELS[connState]}
              </span>
            </>
          ) : (
            <>
              <span className="dot dot--local" />
              <span>Local</span>
            </>
          )}
        </div>
      </div>
      <div className="titlebar__controls">
        <button
          className={`titlebar__btn ${settingsIssues.length > 0 ? "titlebar__btn--warn" : ""}`}
          title={
            settingsIssues.length > 0
              ? `All commands (Ctrl+Shift+P) — ${settingsIssues.length} settings problem${settingsIssues.length === 1 ? "" : "s"}`
              : "All commands (Ctrl+Shift+P)"
          }
          onClick={() => useAppStore.getState().setPaletteOpen(true)}
        >
          ⌘
        </button>
        <button
          className="titlebar__btn"
          title="Appearance & settings"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          ⚙
        </button>
        {menuOpen && (
          <>
            <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
            <div className="titlebar__menu" role="menu">
              <div className="titlebar__menu-label">Color theme</div>
              {THEME_PRESETS.map((p) => (
                <button
                  key={p.id}
                  className="terminal-menu__item"
                  onClick={() => {
                    setMenuOpen(false);
                    void applyThemePreset(p);
                  }}
                >
                  {p.title.replace("Theme: ", "")}
                </button>
              ))}
              <div className="terminal-menu__sep" />
              <button className="terminal-menu__item" onClick={openSettingsFile}>
                Open settings.json
              </button>
            </div>
          </>
        )}
        <button
          className="titlebar__btn"
          title="Minimize"
          onClick={() => void appWindow.minimize()}
        >
          <IconMinimize />
        </button>
        <button
          className="titlebar__btn"
          title="Maximize"
          onClick={() => void appWindow.toggleMaximize()}
        >
          <IconMaximize />
        </button>
        <button
          className="titlebar__btn titlebar__btn--close"
          title="Close"
          onClick={() => void appWindow.close()}
        >
          <IconClose />
        </button>
      </div>
    </header>
  );
}
