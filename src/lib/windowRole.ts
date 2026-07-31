/** This window's Tauri label and the role derived from it, fixed for the
 *  window's whole life (docs/dev/multi-window.md).
 *
 *  - `main` — the primary window (full UI: explorer, editor, terminals, sessions).
 *  - `workspace` — the explorer + editor pop-out: same shell with the terminal
 *    panel and CHAT/sessions column hidden, no session-restore, no auto terminal.
 *  - `sessions` — the CHAT/sessions pop-out: renders the focus view only.
 *
 *  `workspace` and `sessions` are *secondary* windows — they adopt main's live
 *  connections rather than dialing their own, and never restore/persist a session.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";

const windowLabel = getCurrentWindow().label;
export const isWorkspace = windowLabel === "workspace";
export const isSessions = windowLabel === "sessions";
/** Any non-primary window: adopts main's connections, doesn't dial or restore. */
export const isSecondary = isWorkspace || isSessions;
