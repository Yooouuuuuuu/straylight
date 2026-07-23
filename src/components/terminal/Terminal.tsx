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
  initialInput = null,
  scriptedInput = null,
  locked = false,
}: {
  id: string;
  connId: string;
  active: boolean;
  command: string[] | null;
  initialInput?: string | null;
  scriptedInput?: { text: string; delayMs: number }[] | null;
  locked?: boolean;
}) {
  const containerRef = useTerminal(
    connId,
    active,
    command,
    id,
    initialInput,
    scriptedInput,
    locked,
  );
  // data-conn-id lets keyboard handlers resolve the focused terminal's host.
  return <div className="terminal-host" data-conn-id={connId} ref={containerRef} />;
}
