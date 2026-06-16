/** Bottom terminal panel. Targets the remote shell when connected, otherwise
 *  the local shell. Keyed by the session id so it restarts on a switch. */
import { useAppStore } from "../../store/appStore";
import { Terminal } from "../terminal/Terminal";
import { IconClose } from "../icons";

export function TerminalPanel() {
  const remote = useAppStore((s) => s.remote);
  const localConnId = useAppStore((s) => s.localConnId);
  const terminalEpoch = useAppStore((s) => s.terminalEpoch);
  const setTerminalVisible = useAppStore((s) => s.setTerminalVisible);

  const connId = remote?.connId ?? localConnId;
  const label = remote ? remote.name : "local";

  return (
    <div className="terminal-panel">
      <div className="terminal-panel__header">
        <span className="terminal-panel__title">Terminal · {label}</span>
        <button
          className="icon-btn"
          title="Hide terminal (Ctrl+`)"
          onClick={() => setTerminalVisible(false)}
        >
          <IconClose />
        </button>
      </div>
      <div className="terminal-panel__body">
        {connId ? (
          <Terminal key={`${connId}:${terminalEpoch}`} connId={connId} />
        ) : (
          <div className="terminal-message">Starting…</div>
        )}
      </div>
    </div>
  );
}
