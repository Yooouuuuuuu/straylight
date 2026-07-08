/** The command registry: every user-invocable action, by stable id. The ids
 *  and titles are part of the 1.0 contract (keybinding overrides and muscle
 *  memory reference them) — add freely, never rename or remove.
 *
 *  Commands deliberately NOT here: Monaco's own editor commands (Ctrl+D,
 *  Ctrl+/, Ctrl+G… — the editor is VS Code's, those stay its), and per-repo VCS
 *  operations (the repo card is the better surface). */
import { refreshApp } from "./appRefresh";
import { copyPath } from "./fileOps";
import { sshReconnect } from "./ipc";
import { openFileByPath } from "./openFile";
import { saveActiveFile } from "./saveFile";
import { settingsFilePath, updateSettings } from "./settings";
import { closeAllTabs, closeSavedTabs } from "./tabActions";
import { keyLabelFor } from "./shortcuts";
import { pickTerminalTarget } from "./terminalTarget";
import { focusExplorer } from "./treeNav";
import { currentZoom, zoomBy, applyZoom } from "./zoom";
import { useAppStore } from "../store/appStore";
import { useVcsStore } from "../store/vcsStore";

export interface Command {
  /** Stable id — the contract (also the keybinding-override key). */
  id: string;
  /** "Area: Action" display name — also contract-ish; rename with care. */
  title: string;
  run: () => void | Promise<void>;
}

const app = () => useAppStore.getState();
const vcs = () => useVcsStore.getState();

async function setZoomAndPersist(factor: number | null): Promise<void> {
  const applied = factor === null ? await zoomBy(0) : await applyZoom(factor);
  await updateSettings({ zoom: applied });
}

function openMarkdownPreview(): void {
  const s = app();
  const active = s.tabs.find((t) => t.id === s.activeTabId);
  if (active && (!active.kind || active.kind === "file") && /\.(md|markdown)$/i.test(active.name)) {
    s.openPreviewTab({
      connId: active.connId,
      path: active.path,
      name: `${active.name} (preview)`,
      content: active.content,
    });
  } else {
    s.pushNotice("warn", "Markdown preview needs an open .md file.");
  }
}

/** Every command, in display order. Computed fresh so `run` reads live state. */
export function allCommands(): Command[] {
  return [
    { id: "app.commandPalette", title: "App: Show All Commands", run: () => app().setPaletteOpen(true) },
    { id: "app.refreshAll", title: "App: Refresh Everything", run: () => refreshApp() },
    { id: "connection.connect", title: "Connection: Connect to Server…", run: () => app().openDialog() },
    {
      id: "connection.reconnect",
      title: "Connection: Reconnect Remote",
      run: () => {
        const r = app().remote;
        if (r) void sshReconnect(r.connId);
        else app().pushNotice("warn", "No remote connection to reconnect.");
      },
    },
    { id: "editor.closeAllTabs", title: "Editor: Close All Tabs", run: closeAllTabs },
    { id: "editor.closeSavedTabs", title: "Editor: Close Saved Tabs", run: closeSavedTabs },
    {
      id: "editor.closeTab",
      title: "Editor: Close Tab",
      run: () => {
        const s = app();
        if (s.activeTabId) s.closeTab(s.activeTabId);
      },
    },
    { id: "editor.nextTab", title: "Editor: Next Tab", run: () => app().cycleTab(1) },
    { id: "editor.previousTab", title: "Editor: Previous Tab", run: () => app().cycleTab(-1) },
    {
      id: "editor.splitRight",
      title: "Editor: Split Right",
      run: () => {
        const s = app();
        if (s.activeTabId) s.splitRight(s.activeTabId);
        else s.pushNotice("warn", "No active tab to split.");
      },
    },
    {
      id: "explorer.copyPath",
      title: "Explorer: Copy Path of Selection",
      run: () => {
        const sel = app().selected;
        if (sel) void copyPath(sel.path);
        else app().pushNotice("warn", "Nothing selected in the explorer.");
      },
    },
    { id: "explorer.focus", title: "Explorer: Focus", run: () => { app().setSidebarVisible(true); focusExplorer(); } },
    {
      id: "explorer.properties",
      title: "Explorer: Properties of Selection",
      run: () => {
        const s = app();
        const targets = s.selection.length ? s.selection : s.selected ? [s.selected] : [];
        if (targets.length) s.openProperties(targets);
        else s.pushNotice("warn", "Nothing selected in the explorer.");
      },
    },
    { id: "explorer.refreshTrees", title: "Explorer: Refresh Trees", run: () => { app().refreshLocal(); app().refreshRemote(); app().refreshWsl(); } },
    { id: "file.markdownPreview", title: "File: Markdown Preview", run: openMarkdownPreview },
    { id: "file.quickOpen", title: "File: Quick Open…", run: () => app().setFinderOpen(true) },
    { id: "file.save", title: "File: Save", run: () => saveActiveFile() },
    {
      id: "preferences.settings",
      title: "Preferences: Settings",
      run: () => app().openAppTab("settings"),
    },
    {
      id: "preferences.themes",
      title: "Preferences: Themes",
      run: () => app().openAppTab("themes"),
    },
    {
      id: "preferences.openSettings",
      title: "Preferences: Open settings.json",
      run: () => {
        const s = app();
        const path = settingsFilePath();
        if (path && s.localConnId) void openFileByPath(s.localConnId, path, "settings.json");
      },
    },
    { id: "search.inFiles", title: "Search: In Files…", run: () => app().setSearchOpen(true) },
    {
      id: "terminal.new",
      title: "Terminal: New",
      run: () => {
        const target = pickTerminalTarget();
        if (target) {
          app().openTerminal(target.connId, target.label);
          app().setTerminalVisible(true);
        }
      },
    },
    { id: "terminal.next", title: "Terminal: Next", run: () => app().cycleTerminal(1) },
    { id: "terminal.previous", title: "Terminal: Previous", run: () => app().cycleTerminal(-1) },
    {
      id: "terminal.showContainers",
      title: "Terminal: Show Containers",
      run: () => {
        app().setTerminalVisible(true);
        app().setTerminalView("containers");
      },
    },
    { id: "terminal.toggle", title: "Terminal: Toggle", run: () => app().setTerminalVisible(!app().terminalVisible) },
    { id: "view.portForwarding", title: "View: Port Forwarding…", run: () => app().setPortsOpen(true) },
    { id: "view.toggleSidebar", title: "View: Toggle Sidebar", run: () => app().toggleSidebar() },
    { id: "view.toggleSourceControl", title: "View: Toggle Source Control", run: () => vcs().toggleScm() },
    { id: "view.zoomIn", title: "View: Zoom In", run: () => setZoomAndPersist(currentZoom() + 0.1) },
    { id: "view.zoomOut", title: "View: Zoom Out", run: () => setZoomAndPersist(currentZoom() - 0.1) },
    { id: "view.zoomReset", title: "View: Zoom Reset", run: () => setZoomAndPersist(1) },
  ];
}

/** The effective keybinding label for a command (overrides included). */
export function commandKeyLabel(id: string): string | null {
  return keyLabelFor(id);
}
