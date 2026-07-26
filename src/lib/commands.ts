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
import {
  resetSettingsFile,
  restoreBuiltinThemes,
  settingsFilePath,
  updateSettings,
} from "./settings";
import { closeAllTabs, closeSavedTabs } from "./tabActions";
import { keyLabelFor } from "./shortcuts";
import { toggleFocusView } from "./focusMode";
import { cycleTerminalPanelTab } from "./terminalTabs";
import { pickTerminalTarget } from "./terminalTarget";
import { focusExplorer } from "./treeNav";
import { currentZoom, zoomBy, applyZoom } from "./zoom";
import { checkForUpdate } from "./updater";
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

/** Ctrl+1..3, VS Code-style: focus the nth group; asking for the NEXT index
 *  creates a new empty group (with one group, Ctrl+2 creates, Ctrl+3 is
 *  locked until a second exists). */
function focusEditorGroup(n: number): void {
  const s = app();
  const gid = s.editorGroups[n];
  if (gid !== undefined) {
    s.setActiveGroup(gid);
    s.requestEditorFocus();
  } else if (n === s.editorGroups.length) {
    s.addEmptyGroup();
  }
}

/** Ctrl+\: split half/half. More than one file here → the active file moves
 *  to the new split; a single (or no) file stays put and the new split opens
 *  EMPTY (app icon + its own close button). */
function splitRightSmart(): void {
  const s = app();
  const inGroup = s.tabs.filter((t) => (t.groupId ?? 0) === s.activeGroupId);
  if (inGroup.length > 1 && s.activeTabId) {
    s.splitRight(s.activeTabId);
    s.requestEditorFocus(); // land the cursor in the new split
  } else {
    s.addEmptyGroup();
  }
}

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
    { id: "app.checkForUpdates", title: "App: Check for Updates", run: () => checkForUpdate() },
    { id: "connection.connect", title: "Connection: Connect to Server", run: () => app().openDialog() },
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
      run: splitRightSmart,
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
    { id: "file.quickOpen", title: "File: Quick Open", run: () => app().setFinderOpen(true) },
    { id: "file.save", title: "File: Save", run: () => saveActiveFile() },
    {
      id: "preferences.settings",
      title: "Preferences: Open",
      run: () => app().openAppTab("settings"),
    },
    {
      id: "preferences.themes",
      title: "Preferences: Theme",
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
    {
      id: "restore.settings",
      title: "Restore: settings.json defaults",
      run: () =>
        useVcsStore
          .getState()
          .askConfirm(
            "Restore settings.json defaults?",
            "Every setting returns to its shipped value — keybindings, confirmations, auto-connect hosts, panels, and colors. Your saved themes (theme.json) are untouched.",
            () => void resetSettingsFile(),
          ),
    },
    {
      id: "restore.builtinThemes",
      title: "Restore: built-in themes",
      run: () =>
        useVcsStore
          .getState()
          .askConfirm(
            "Restore built-in themes?",
            "The six shipped themes come back at the top of the list, renewed to their current designs — any edits under their names are replaced. Your own saved themes are kept.",
            () => void restoreBuiltinThemes(),
          ),
    },
    {
      id: "storage.drafts",
      title: "Storage: Drafts",
      run: () => app().openAppTab("drafts"),
    },
    {
      id: "storage.pins",
      title: "Storage: Pinned files",
      run: () => app().openAppTab("pins"),
    },
    {
      id: "storage.autoconnect",
      title: "Storage: Auto-connect hosts",
      run: () => app().openAppTab("autoconnect"),
    },
    { id: "search.inFiles", title: "Search: In Files", run: () => app().setSearchOpen(true) },
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
    {
      id: "terminal.next",
      title: "Terminal: Next Tab (hosts, then tools)",
      run: () => {
        app().setTerminalVisible(true);
        cycleTerminalPanelTab(1);
      },
    },
    {
      id: "terminal.previous",
      title: "Terminal: Previous Tab (hosts, then tools)",
      run: () => {
        app().setTerminalVisible(true);
        cycleTerminalPanelTab(-1);
      },
    },
    {
      id: "terminal.showContainers",
      title: "Terminal: Show Containers",
      run: () => {
        app().setTerminalVisible(true);
        app().setTerminalView("containers");
      },
    },
    { id: "terminal.toggle", title: "Terminal: Toggle", run: () => app().setTerminalVisible(!app().terminalVisible) },
    { id: "view.portForwarding", title: "View: Port Forwarding", run: () => { app().setTerminalView("forwarding"); app().setTerminalVisible(true); } },
    { id: "view.toggleSidebar", title: "View: Toggle Sidebar", run: () => app().toggleSidebar() },
    { id: "view.toggleSourceControl", title: "View: Toggle Source Control", run: () => vcs().toggleScm() },
    { id: "view.toggleChat", title: "View: Toggle CHAT", run: () => app().toggleChat() },
    {
      id: "view.togglePanel",
      title: "View: Toggle Panel",
      run: () => app().setTerminalVisible(!app().terminalVisible),
    },
    { id: "view.focusView", title: "View: Toggle Focus View", run: toggleFocusView },
    {
      id: "editor.focusGroup1",
      title: "Editor: Focus Group 1",
      run: () => focusEditorGroup(0),
    },
    {
      id: "editor.focusGroup2",
      title: "Editor: Focus Group 2",
      run: () => focusEditorGroup(1),
    },
    {
      id: "editor.focusGroup3",
      title: "Editor: Focus Group 3",
      run: () => focusEditorGroup(2),
    },
    { id: "view.zoomIn", title: "View: Zoom In", run: () => setZoomAndPersist(currentZoom() + 0.1) },
    { id: "view.zoomOut", title: "View: Zoom Out", run: () => setZoomAndPersist(currentZoom() - 0.1) },
    { id: "view.zoomReset", title: "View: Zoom Reset", run: () => setZoomAndPersist(1) },
  ];
}

/** The effective keybinding label for a command (overrides included). */
export function commandKeyLabel(id: string): string | null {
  return keyLabelFor(id);
}
