/** The items currently being dragged / copied between transfer panes. In-app
 *  only, so module-level values are simpler than threading them through
 *  dataTransfer. Both buffers are arrays to support multi-select. */
export interface DragItem {
  connId: string;
  path: string;
  name: string;
  isDir: boolean;
}

let dragItems: DragItem[] = [];

export function setDragItems(items: DragItem[]): void {
  dragItems = items;
}

export function getDragItems(): DragItem[] {
  return dragItems;
}

// Copy/paste buffer between transfer panes (Ctrl+C in one, Ctrl+V in the other).
let clipboard: DragItem[] = [];

export function setTransferClipboard(items: DragItem[]): void {
  clipboard = items;
}

export function getTransferClipboard(): DragItem[] {
  return clipboard;
}
