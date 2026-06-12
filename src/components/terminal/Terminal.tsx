/** A single xterm.js terminal bound to a remote PTY via {@link useTerminal}. */
import { useTerminal } from "../../hooks/useTerminal";

export function Terminal({ connId }: { connId: string }) {
  const containerRef = useTerminal(connId);
  return <div className="terminal-host" ref={containerRef} />;
}
