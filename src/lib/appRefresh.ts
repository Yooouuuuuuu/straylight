/** App-wide refresh (F5 / Ctrl+R — replaces the WebView page reload): refresh
 *  every explorer section and every tracked repo, and reload open **clean** file
 *  tabs from disk. Dirty tabs keep their edits (the save-conflict flow covers
 *  divergence); connections, terminals, and port forwards are never touched. */
import { setTabContentInPlace } from "./activeEditor";
import { fsReadFile } from "./ipc";
import { useAppStore } from "../store/appStore";
import { useVcsStore } from "../store/vcsStore";

let running = false;

export async function refreshApp(): Promise<void> {
  if (running) return; // debounce a held-down F5
  running = true;
  try {
    const app = useAppStore.getState();
    app.refreshLocal();
    app.refreshRemote();
    app.refreshWsl();
    useVcsStore.getState().refreshAll(0); // history views follow via lastUpdated

    const candidates = app.tabs.filter(
      (t) => (!t.kind || t.kind === "file") && !t.dirty && !t.isBinary && !t.truncated,
    );
    await Promise.all(
      candidates.map(async (t) => {
        try {
          const file = await fsReadFile(t.connId, t.path);
          const cur = useAppStore.getState().tabs.find((x) => x.id === t.id);
          // Skip if closed or edited meanwhile, unreadable as text, or unchanged.
          if (!cur || cur.dirty || file.isBinary) return;
          if (file.modified === cur.modified && file.content === cur.content) return;
          useAppStore.getState().reloadTabContent(t.id, file);
          setTabContentInPlace(t.id, file.content);
        } catch {
          /* unreadable right now (deleted?) — leave the tab as-is */
        }
      }),
    );
    useAppStore.getState().pushNotice("info", "Refreshed.");
  } finally {
    running = false;
  }
}
