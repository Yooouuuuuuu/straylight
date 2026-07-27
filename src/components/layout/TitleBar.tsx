/** Custom (decorationless) title bar: brand, connection status, workspace color
 *  accent, an appearance menu (themes / settings — non-functional preferences
 *  live here, not in the command palette), and window controls. The center
 *  region is a Tauri drag handle. */
import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";

import appIcon from "../../assets/icon.png";
import { openFileByPath } from "../../lib/openFile";
import {
  confirmEnabled,
  disableConfirm,
  settingsFilePath,
} from "../../lib/settings";
import { toggleFocusView } from "../../lib/focusMode";
import { checkForUpdate } from "../../lib/updater";
import {
  applyTheme,
  DEFAULT_THEME_NAME,
  savedThemeNames,
} from "../../lib/themes";
import { useDialogKeys } from "../../hooks/useDialogKeys";
import { useAppStore } from "../../store/appStore";
import { ConnectionGauge } from "../ConnectionGauge";
import {
  IconClose,
  IconMaximize,
  IconMinimize,
  IconRestore,
} from "../icons";
import { Tip } from "../Tooltip";

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
  const settingsIssues = useAppStore((s) => s.settingsIssues);
  // F11: the palette button and the ⚙ menu (except Quick theme) LOCK — still
  // visible, not clickable. Disabled buttons don't fire the themed Tip, so
  // the explainer rides the native title.
  const focusView = useAppStore((s) => s.focusView);
  const lockedTitle = focusView ? "Locked in session focus (F11)" : undefined;
  const updateAvailable = useAppStore((s) => s.updateAvailable);
  // Shown dim on the Check-for-updates row — the app's at-a-glance version.
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    void getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);
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
    <header className="titlebar">
      {/* Two clusters positioned over the explorer's W and R toggles
          (--gauge-w-x / --gauge-r-x, derived from the sidebar width). */}
      <ConnectionGauge />
      <div className="titlebar__drag" data-tauri-drag-region>
        <div className="titlebar__brand" data-tauri-drag-region>
          <Logo />
          <span className="titlebar__title">Straylight</span>
        </div>
      </div>
      <div className="titlebar__controls">
        <Tip
          label={
            settingsIssues.length > 0
              ? `All commands (Ctrl+Shift+P) — ${settingsIssues.length} settings problem${settingsIssues.length === 1 ? "" : "s"}`
              : "All commands (Ctrl+Shift+P)"
          }
        >
          <button
            className={`titlebar__btn ${settingsIssues.length > 0 ? "titlebar__btn--warn" : ""}`}
            disabled={focusView}
            title={lockedTitle}
            onClick={() => useAppStore.getState().setPaletteOpen(true)}
          >
            ⌘
          </button>
        </Tip>
        <Tip label="Settings">
          <button
            className="titlebar__btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            ⚙
          </button>
        </Tip>
        <Tip label="Session focus mode (F11)">
          <button className="titlebar__btn" onClick={() => toggleFocusView()}>
            ⛶
          </button>
        </Tip>
        {menuOpen && (
          <>
            <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
            <div className="titlebar__menu" role="menu">
              <div className="titlebar__menu-label">Settings</div>
              <button
                className="terminal-menu__item"
                disabled={focusView}
                title={lockedTitle}
                onClick={() => {
                  setMenuOpen(false);
                  useAppStore.getState().openAppTab("settings");
                }}
              >
                Preferences
              </button>
              <button
                className="terminal-menu__item"
                disabled={focusView}
                title={lockedTitle}
                onClick={() => {
                  setMenuOpen(false);
                  useAppStore.getState().openAppTab("themes");
                }}
              >
                Theme
              </button>
              <button
                className="terminal-menu__item"
                disabled={focusView}
                title={lockedTitle}
                onClick={() => openPrefFile(settingsFilePath(), "settings.json")}
              >
                Open settings.json
              </button>
              <button
                className="terminal-menu__item"
                disabled={focusView}
                title={
                  lockedTitle ??
                  (updateAvailable
                    ? `v${updateAvailable} is ready to install`
                    : undefined)
                }
                onClick={() => {
                  setMenuOpen(false);
                  checkForUpdate();
                }}
              >
                Check for updates
                <span className="menu-right">
                  {updateAvailable && <span className="menu-dot" aria-hidden />}
                  {appVersion && (
                    <span className="menu-hint">v{appVersion}</span>
                  )}
                </span>
              </button>
              <div className="terminal-menu__sep" />
              {/* Inventories the app keeps for you — audit and prune, not knobs. */}
              <div className="titlebar__menu-label">Storage</div>
              <button
                className="terminal-menu__item"
                disabled={focusView}
                title={lockedTitle}
                onClick={() => {
                  setMenuOpen(false);
                  useAppStore.getState().openAppTab("drafts");
                }}
              >
                Drafts
              </button>
              <button
                className="terminal-menu__item"
                disabled={focusView}
                title={lockedTitle}
                onClick={() => {
                  setMenuOpen(false);
                  useAppStore.getState().openAppTab("pins");
                }}
              >
                Pinned files
              </button>
              <button
                className="terminal-menu__item"
                disabled={focusView}
                title={lockedTitle}
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
                  {name === DEFAULT_THEME_NAME && (
                    <span className="theme-badge">default</span>
                  )}
                </button>
              ))}
            </div>
          </>
        )}
        <Tip label="Minimize">
          <button
            className="titlebar__btn titlebar__btn--winctl titlebar__btn--live"
            onClick={() => void appWindow.minimize()}
          >
            <IconMinimize />
          </button>
        </Tip>
        <Tip label={maximized ? "Restore" : "Maximize"}>
          <button
            className="titlebar__btn titlebar__btn--live"
            onClick={() => void appWindow.toggleMaximize()}
          >
            {maximized ? <IconRestore /> : <IconMaximize />}
          </button>
        </Tip>
        <Tip label="Close">
          <button
            className="titlebar__btn titlebar__btn--close"
            onClick={requestClose}
          >
            <IconClose />
          </button>
        </Tip>
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
              <Tip label="Saved to settings.json only if you close">
                <label className="confirm-silence">
                  <input
                    type="checkbox"
                    checked={exitSilence}
                    onChange={(e) => setExitSilence(e.target.checked)}
                  />
                  Don't ask again
                </label>
              </Tip>
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
