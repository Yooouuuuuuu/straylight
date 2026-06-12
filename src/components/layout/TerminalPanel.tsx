/** Bottom terminal panel. Mounts a fresh terminal per connection (keyed by
 *  connId so a reconnect starts a clean session). */
import { useAppStore } from "../../store/appStore";
import { Terminal } from "../terminal/Terminal";
import { IconClose } from "../icons";

export function TerminalPanel() {
  const remote = useAppStore((s) => s.remote);
  const setTerminalVisible = useAppStore((s) => s.setTerminalVisible);

  return (
    <div className="terminal-panel">
      <div className="terminal-panel__header">
        <span className="terminal-panel__title">Terminal</span>
        <button
          className="icon-btn"
          title="Hide terminal (Ctrl+`)"
          onClick={() => setTerminalVisible(false)}
        >
          <IconClose />
        </button>
      </div>
      <div className="terminal-panel__body">
        {remote ? (
          <Terminal key={remote.connId} connId={remote.connId} />
        ) : (
          <div className="terminal-message">Not connected</div>
        )}
      </div>
    </div>
  );
}
