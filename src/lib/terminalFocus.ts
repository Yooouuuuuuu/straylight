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
