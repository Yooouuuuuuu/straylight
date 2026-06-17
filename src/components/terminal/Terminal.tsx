/** A single xterm.js terminal bound to a PTY via {@link useTerminal}. `active`
 *  tells it to refit/focus when it becomes the visible tab; `command` selects a
 *  local shell profile (null = the session's default shell); `id` registers it
 *  so a global Ctrl+` can focus it. */
import { useTerminal } from "../../hooks/useTerminal";

export function Terminal({
  id,
  connId,
  active,
  command,
}: {
  id: string;
  connId: string;
  active: boolean;
  command: string[] | null;
}) {
  const containerRef = useTerminal(connId, active, command, id);
  return <div className="terminal-host" ref={containerRef} />;
}
