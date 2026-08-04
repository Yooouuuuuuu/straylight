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
import { startTour } from "../../lib/tour";
import { isSecondary, isSessions, isWorkspace } from "../../lib/windowRole";
import { popOutSessions } from "../../lib/sessionReplay";
import { openWorkspaceWindow } from "../../lib/workspaceWindow";
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
  const settingsIssues = useAppStore((s) => s.settingsIssues);
  // F11: the palette button and the ⚙ menu (except Quick theme) LOCK — still
  // visible, not clickable. Disabled buttons don't fire the themed Tip, so
  // the explainer rides the native title.
  const focusView = useAppStore((s) => s.focusView);
  const lockedTitle = focusView ? "Locked in session focus (F11)" : undefined;
  // Multi-window button locks (docs/dev/multi-window.md): the sessions button and
  // focus mode lock while the sessions are popped out; the workspace button locks
  // while its window is open.
  const sessionsPoppedOut = useAppStore((s) => s.sessionsPoppedOut);
  const workspaceOpen = useAppStore((s) => s.workspaceOpen);
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
    // Secondary windows (workspace / sessions) just close — no "quit the app?"
    // prompt; closing the sessions window simply pops back.
    if (!isSecondary && confirmEnabled("exit")) {
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
  useEffect(() => {
    // Per-window title so the taskbar / Alt+Tab distinguishes the pop-outs
    // instead of three identical "Straylight" (docs/dev/multi-window.md).
    const title = isWorkspace
      ? "Straylight — Workspace"
      : isSessions
        ? "Straylight — Sessions"
        : "Straylight";
    appWindow.setTitle(title).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openPrefFile = (path: string | null, name: string) => {
    setMenuOpen(false);
    const localConnId = useAppStore.getState().localConnId;
    if (path && localConnId) void openFileByPath(localConnId, path, name);
  };

  return (
    <header
      className={`titlebar${isWorkspace ? " titlebar--workspace" : isSessions ? " titlebar--sessions" : ""}`}
    >
      {/* Two clusters positioned over the explorer's W and R toggles
          (--gauge-w-x / --gauge-r-x, derived from the sidebar width). */}
      <ConnectionGauge />
      <div className="titlebar__drag" data-tauri-drag-region>
        <div className="titlebar__brand" data-tauri-drag-region>
          <Logo />
          <span className="titlebar__title">Straylight</span>
          {/* A colored chip marks a pop-out window as a sibling of main. */}
          {isWorkspace && (
            <span className="titlebar__role titlebar__role--workspace">
              Workspace
            </span>
          )}
          {isSessions && (
            <span className="titlebar__role titlebar__role--sessions">
              Sessions
            </span>
          )}
        </div>
      </div>
      <div className="titlebar__controls">
        {/* Palette — main + workspace, but not the sessions pop-out. */}
        {!isSessions && (
          <Tip
            label={
              settingsIssues.length > 0
                ? `All commands (Ctrl+Shift+P) — ${settingsIssues.length} settings problem${settingsIssues.length === 1 ? "" : "s"}`
                : "All commands (Ctrl+Shift+P)"
            }
          >
            <button
              className={`titlebar__btn ${settingsIssues.length > 0 ? "titlebar__btn--warn" : ""}`}
              data-tour="palette"
              disabled={focusView}
              title={lockedTitle}
              onClick={() => useAppStore.getState().setPaletteOpen(true)}
            >
              ⌘
            </button>
          </Tip>
        )}
        {/* Settings — main only. The wrapper anchors the dropdown DIRECTLY
            under the gear, wherever the button order puts it. */}
        {!isSecondary && (
          <div className="titlebar__menuwrap">
            <Tip label="Settings">
              <button
                className="titlebar__btn"
                data-tour="settings"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
              >
                ⚙
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
                  <button
                    className="terminal-menu__item"
                    disabled={focusView}
                    title={lockedTitle}
                    onClick={() => {
                      setMenuOpen(false);
                      startTour();
                    }}
                  >
                    Walkthrough
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
          </div>
        )}
        {/* Multi-window group — main only: workspace · sessions · focus, spaced
            off from the app actions and the window controls. */}
        {!isSecondary && (
          <>
            <span className="titlebar__gap" />
            <Tip label="Workspace window">
              <button
                className="titlebar__btn"
                data-tour="workspace"
                disabled={focusView || workspaceOpen}
                title={workspaceOpen ? "Workspace window is open" : lockedTitle}
                onClick={() => void openWorkspaceWindow()}
              >
                ⧉
              </button>
            </Tip>
            <Tip label="Pop out sessions">
              <button
                className="titlebar__btn"
                data-tour="popout"
                disabled={focusView || sessionsPoppedOut}
                title={sessionsPoppedOut ? "Sessions are popped out" : lockedTitle}
                onClick={() => void popOutSessions()}
              >
                ⬒
              </button>
            </Tip>
            <Tip label="Session focus mode (F11)">
              <button
                className="titlebar__btn"
                data-tour="focus"
                disabled={sessionsPoppedOut}
                title={sessionsPoppedOut ? "Sessions are popped out" : undefined}
                onClick={() => toggleFocusView()}
              >
                ⛶
              </button>
            </Tip>
            {/* Trailing side of the group is spaced by the window controls'
                own --winctl margin — no spacer needed here. */}
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
        <Tip label={isSessions ? "Return to main window" : "Close"}>
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
