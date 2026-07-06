/** Live terminal DOM registry. Each terminal's xterm lives in a plain div that
 *  React never reconciles; "moving a terminal to the editor area" reparents
 *  that div into an editor-pane slot (the shell keeps running — nothing
 *  remounts). The panel keeps the React-owned wrapper ("home"); parking puts
 *  the div back there. Targets survive component remounts (epoch bumps): a
 *  re-registered terminal re-appears wherever it was last mounted. */

interface Slot {
  el: HTMLElement;
  home: HTMLElement;
}

const slots = new Map<string, Slot>();
/** Where each terminal should live right now (absent = its panel home). */
const targets = new Map<string, HTMLElement>();

export function registerTerminalSlot(
  id: string,
  el: HTMLElement,
  home: HTMLElement,
): void {
  slots.set(id, { el, home });
  const target = targets.get(id);
  if (target && target.isConnected) target.appendChild(el);
}

export function unregisterTerminalSlot(id: string, el: HTMLElement): void {
  const slot = slots.get(id);
  if (slot?.el === el) slots.delete(id);
}

/** Reparent a terminal into an editor-pane slot. */
export function mountTerminalIn(id: string, target: HTMLElement): void {
  targets.set(id, target);
  const slot = slots.get(id);
  if (slot) target.appendChild(slot.el);
}

/** Return a terminal to its panel home (editor tab closed / unmounted). */
export function parkTerminal(id: string): void {
  targets.delete(id);
  const slot = slots.get(id);
  if (slot && slot.home.isConnected) slot.home.appendChild(slot.el);
}
