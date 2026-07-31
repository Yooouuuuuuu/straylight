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
  ptyConnId = null,
  attachPtyId = null,
}: {
  id: string;
  connId: string;
  active: boolean;
  command: string[] | null;
  initialInput?: string | null;
  scriptedInput?: { text: string; delayMs: number }[] | null;
  locked?: boolean;
  /** Dedicated session-lane connection carrying the PTY (null = `connId`).
   *  Theme/colors/tree-refresh still key off the host `connId`. */
  ptyConnId?: string | null;
  /** Re-attach to an existing backend PTY instead of opening one (the sessions
   *  pop-out window; docs/dev/multi-window.md). Null = own the PTY normally. */
  attachPtyId?: string | null;
}) {
  const containerRef = useTerminal(
    connId,
    active,
    command,
    id,
    initialInput,
    scriptedInput,
    locked,
    ptyConnId,
    attachPtyId,
  );
  // data-conn-id lets keyboard handlers resolve the focused terminal's host.
  return <div className="terminal-host" data-conn-id={connId} ref={containerRef} />;
}
