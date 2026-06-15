/** Bridge so the save logic can read open tabs' live content / version (held in
 *  their Monaco models). The editor registers it while mounted.
 *
 *  Dirty state is derived from Monaco's "alternative version id", which returns
 *  to the same value when you undo back to a saved state — so undoing all edits
 *  clears the dirty flag. */

export interface EditorBridge {
  getContent(tabId: string): string | null;
  getVersionId(tabId: string): number | null;
  /** Record `versionId` as this tab's saved state and re-evaluate its dirty flag. */
  markSavedVersion(tabId: string, versionId: number): void;
}

let bridge: EditorBridge | null = null;

export function setEditorBridge(value: EditorBridge | null): void {
  bridge = value;
}

export function getTabContent(tabId: string): string | null {
  return bridge ? bridge.getContent(tabId) : null;
}

export function getTabVersionId(tabId: string): number | null {
  return bridge ? bridge.getVersionId(tabId) : null;
}

export function markTabSavedVersion(tabId: string, versionId: number): void {
  bridge?.markSavedVersion(tabId, versionId);
}
