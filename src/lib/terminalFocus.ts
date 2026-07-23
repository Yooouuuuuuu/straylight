/** Tiny registry so a global action (Ctrl+`) can focus the active terminal's
 *  xterm without prop-drilling a ref through the panel. */
const registry = new Map<string, () => void>();

export function registerTerminalFocus(id: string, focus: () => void): void {
  registry.set(id, focus);
}

export function unregisterTerminalFocus(id: string): void {
  registry.delete(id);
}

/** Focus a terminal by id, deferred a frame so a just-expanded panel has laid
 *  out before the xterm grabs focus. */
export function focusTerminal(id: string | null): void {
  if (!id) return;
  const focus = registry.get(id);
  if (focus) requestAnimationFrame(focus);
}

/** Sibling registry: write raw bytes into an already-open PTY by terminal id
 *  (the usage probe's refresh sends Esc + /usage to the live claude). Backed
 *  by useTerminal once its PTY is up; a no-op before then. */
const inputs = new Map<string, (data: string) => void>();

export function registerTerminalInput(
  id: string,
  send: (data: string) => void,
): void {
  inputs.set(id, send);
}

export function unregisterTerminalInput(id: string): void {
  inputs.delete(id);
}

export function sendTerminalInput(id: string, data: string): boolean {
  const send = inputs.get(id);
  if (!send) return false;
  send(data);
  return true;
}

/** Read a terminal's current on-screen + scrollback text by id (the usage
 *  probe checks it to confirm `/usage` actually rendered vs. a "command not
 *  found" from a host without Claude Code). Empty string if unknown. */
const texts = new Map<string, () => string>();

export function registerTerminalText(id: string, read: () => string): void {
  texts.set(id, read);
}

export function unregisterTerminalText(id: string): void {
  texts.delete(id);
}

export function readTerminalText(id: string): string {
  return texts.get(id)?.() ?? "";
}
