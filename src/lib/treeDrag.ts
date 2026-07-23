/** Nodes currently being dragged within a single host's explorer tree — the
 *  drag equivalent of cut/copy + paste. Module-level (like the transfer-pane
 *  drag) since the drag never leaves the app; dataTransfer only carries a label
 *  so the OS shows a drag image. */
import type { DragItem } from "./transferDrag";

let dragging: DragItem[] = [];

export function setTreeDrag(items: DragItem[]): void {
  dragging = items;
}

export function getTreeDrag(): DragItem[] {
  return dragging;
}

export function clearTreeDrag(): void {
  dragging = [];
}

/** Whether the current drag can land in `destPath` on `destConnId`: same host
 *  only, and never a folder into itself or its own subtree. (A same-parent drop
 *  is allowed — it's a no-op for Move, a real duplicate for Copy.) */
export function canDropInto(destConnId: string, destPath: string): boolean {
  if (!dragging.length) return false;
  if (dragging.some((i) => i.connId !== destConnId)) return false;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const dest = norm(destPath);
  return dragging.every((i) => {
    const src = norm(i.path);
    return !(i.isDir && (dest === src || dest.startsWith(src + "/")));
  });
}
