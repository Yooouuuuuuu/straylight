/** Custom (decorationless) title bar: brand, connection status, workspace color
 *  accent, and window controls. The center region is a Tauri drag handle. */
import { getCurrentWindow } from "@tauri-apps/api/window";

import { useAppStore } from "../../store/appStore";
import type { ConnectionState } from "../../lib/ipc";
import { IconClose, IconMaximize, IconMinimize } from "../icons";

function Logo({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className="titlebar__logo"
      aria-hidden
    >
      <rect width="16" height="16" rx="4" fill="#bd93f9" />
      <path
        d="M10.4 5.4c-.5-.6-1.3-1-2.3-1-1.4 0-2.4.7-2.4 1.8 0 1 .7 1.5 2 1.8l.8.2c.7.2 1 .4 1 .8 0 .5-.5.8-1.2.8-.8 0-1.4-.3-1.8-.9l-1.2.8c.6.9 1.6 1.4 2.9 1.4 1.6 0 2.7-.8 2.7-2 0-1-.6-1.6-2-1.9l-.8-.2c-.7-.2-1-.4-1-.8 0-.4.4-.7 1.1-.7.7 0 1.2.3 1.5.8l1.2-.8Z"
        fill="#282A36"
      />
    </svg>
  );
}

const STATE_LABELS: Record<ConnectionState, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
};

export function TitleBar() {
  const connection = useAppStore((s) => s.connection);
  const connState = useAppStore((s) => s.connState);

  const appWindow = getCurrentWindow();
  const accent = connection?.color ?? "transparent";

  return (
    <header className="titlebar" style={{ borderLeftColor: accent }}>
      <div className="titlebar__drag" data-tauri-drag-region>
        <div className="titlebar__brand" data-tauri-drag-region>
          <Logo />
          <span className="titlebar__title">Straylight</span>
        </div>
        <div className="titlebar__status" data-tauri-drag-region>
          <span className={`dot dot--${connState}`} />
          {connection ? (
            <span>
              {connection.name}{" "}
              <span className="mono">
                ({connection.user}@{connection.host})
              </span>{" "}
              · {STATE_LABELS[connState]}
            </span>
          ) : (
            <span>Not connected</span>
          )}
        </div>
      </div>
      <div className="titlebar__controls">
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
