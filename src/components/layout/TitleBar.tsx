/** Custom (decorationless) title bar: brand, connection status, workspace color
 *  accent, an appearance menu (themes / settings — non-functional preferences
 *  live here, not in the command palette), and window controls. The center
 *  region is a Tauri drag handle. */
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import appIcon from "../../assets/icon.png";
import { remoteColor } from "../../lib/hostColors";
import { openFileByPath } from "../../lib/openFile";
import {
  confirmEnabled,
  disableConfirm,
  settingsFilePath,
} from "../../lib/settings";
import { applyTheme, savedThemeNames } from "../../lib/themes";
import { useDialogKeys } from "../../hooks/useDialogKeys";
import { useAppStore } from "../../store/appStore";
import {
  IconClose,
  IconMaximize,
  IconMinimize,
  IconRestore,
} from "../icons";

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

export function TitleBar() {
  const remote = useAppStore((s) => s.remote);
  const hostColors = useAppStore((s) => s.hostColors);
  const settingsIssues = useAppStore((s) => s.settingsIssues);
  const [menuOpen, setMenuOpen] = useState(false);
  const [exitAsk, setExitAsk] = useState(false);
  const [exitSilence, setExitSilence] = useState(false);
  const [maximized, setMaximized] = useState(false);

  const appWindow = getCurrentWindow();

  // Track maximize state so the button shows restore-down while maximized
  // (and its tooltip matches). Resizing is the only thing that changes it.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    appWindow.isMaximized().then(setMaximized).catch(() => {});
    appWindow
      .onResized(() => {
        appWindow.isMaximized().then(setMaximized).catch(() => {});
      })
      .then((un) => {
        unlisten = un;
      })
      .catch(() => {});
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requestClose = () => {
    if (confirmEnabled("exit")) {
      setExitSilence(false); // fresh checkbox per dialog
      setExitAsk(true);
    } else void appWindow.close();
  };

  // Confirming applies the checkbox; canceling discards it (no settings write).
  // The write must land BEFORE the window closes, or it dies with the process.
  const confirmClose = async () => {
    if (exitSilence) {
      try {
        await disableConfirm("exit");
      } catch {
        /* closing anyway */
      }
    }
    void appWindow.close();
  };

  // Keyboard contract from the shared hook: Enter closes (primary), Esc
  // stays, Tab/arrows cycle checkbox + buttons, focus trapped + restored.
  const dlg = useDialogKeys(() => setExitAsk(false), exitAsk);
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

  const openPrefFile = (path: string | null, name: string) => {
    setMenuOpen(false);
    const localConnId = useAppStore.getState().localConnId;
    if (path && localConnId) void openFileByPath(localConnId, path, name);
  };

  return (
    <header className="titlebar" style={{ borderLeftColor: accent }}>
      <div className="titlebar__drag" data-tauri-drag-region>
        <div className="titlebar__brand" data-tauri-drag-region>
          <Logo />
          <span className="titlebar__title">Straylight</span>
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
          title="Settings"
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
              <div className="titlebar__menu-label">Settings</div>
              <button
                className="terminal-menu__item"
                onClick={() => {
                  setMenuOpen(false);
                  useAppStore.getState().openAppTab("settings");
                }}
              >
                Preferences
              </button>
              <button
                className="terminal-menu__item"
                onClick={() => {
                  setMenuOpen(false);
                  useAppStore.getState().openAppTab("themes");
                }}
              >
                Theme
              </button>
              <button
                className="terminal-menu__item"
                onClick={() => openPrefFile(settingsFilePath(), "settings.json")}
              >
                Open settings.json
              </button>
              <div className="terminal-menu__sep" />
              {/* Inventories the app keeps for you — audit and prune, not knobs. */}
              <div className="titlebar__menu-label">Storage</div>
              <button
                className="terminal-menu__item"
                onClick={() => {
                  setMenuOpen(false);
                  useAppStore.getState().openAppTab("drafts");
                }}
              >
                Drafts
              </button>
              <button
                className="terminal-menu__item"
                onClick={() => {
                  setMenuOpen(false);
                  useAppStore.getState().openAppTab("pins");
                }}
              >
                Pinned files
              </button>
              <button
                className="terminal-menu__item"
                onClick={() => {
                  setMenuOpen(false);
                  useAppStore.getState().openAppTab("autoconnect");
                }}
              >
                Auto-connect
              </button>
              <div className="terminal-menu__sep" />
              <div className="titlebar__menu-label">Quick theme</div>
              {savedThemeNames().map((name) => (
                <button
                  key={name}
                  className="terminal-menu__item"
                  onClick={() => {
                    setMenuOpen(false);
                    void applyTheme(name);
                  }}
                >
                  {name}
                </button>
              ))}
            </div>
          </>
        )}
        <button
          className="titlebar__btn titlebar__btn--winctl titlebar__btn--live"
          title="Minimize"
          onClick={() => void appWindow.minimize()}
        >
          <IconMinimize />
        </button>
        <button
          className="titlebar__btn titlebar__btn--live"
          title={maximized ? "Restore" : "Maximize"}
          onClick={() => void appWindow.toggleMaximize()}
        >
          {maximized ? <IconRestore /> : <IconMaximize />}
        </button>
        <button
          className="titlebar__btn titlebar__btn--close"
          title="Close"
          onClick={requestClose}
        >
          <IconClose />
        </button>
      </div>
      {exitAsk && (
        <div className="modal-overlay" onClick={() => setExitAsk(false)}>
          <div
            ref={dlg.ref}
            className="modal exit-ask"
            role="dialog"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={dlg.onKeyDown}
          >
            <div className="exit-ask__title">Close Straylight?</div>
            <div className="exit-ask__hint">
              <kbd>Enter</kbd> closes · <kbd>Esc</kbd> stays
            </div>
            <div className="exit-ask__actions">
              <label
                className="confirm-silence"
                title='Saved to settings.json ("confirms") only if you close — Cancel discards it'
              >
                <input
                  type="checkbox"
                  checked={exitSilence}
                  onChange={(e) => setExitSilence(e.target.checked)}
                />
                Don't ask again
              </label>
              <button className="btn btn--ghost" onClick={() => setExitAsk(false)}>
                Cancel
              </button>
              <button
                className="btn btn--primary"
                data-dialog-primary
                onClick={() => void confirmClose()}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
