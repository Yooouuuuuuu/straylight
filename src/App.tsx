/** Application shell: title bar, the resizable sidebar / editor / terminal
 *  layout, the status bar, and global overlays (connection dialog, toasts).
 *
 *  A window always has a local session (opened at startup) and may attach one
 *  remote SSH connection; the terminal belongs to the remote. */
import { useEffect, useRef } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";

import {
  localConnect,
  onPortForwardError,
  onSshStatus,
  onTransferProgress,
  onVcsFsChange,
} from "./lib/ipc";
import { useAppStore } from "./store/appStore";
import { useVcsStore } from "./store/vcsStore";
import { initFileWatching } from "./lib/fileWatch";
import { initSettings } from "./lib/settings";
import { initThemes } from "./lib/themes";
import { initSessionPersistence, restoreSession } from "./lib/session";
import { useKeyboard } from "./hooks/useKeyboard";
import { useSSH } from "./hooks/useSSH";
import { TitleBar } from "./components/layout/TitleBar";
import { Sidebar } from "./components/layout/Sidebar";
import { EditorArea } from "./components/layout/EditorArea";
import { TerminalPanel } from "./components/layout/TerminalPanel";
import { StatusBar } from "./components/layout/StatusBar";
import { ScmPanel } from "./components/vcs/ScmPanel";
import { HistoryPanel } from "./components/vcs/HistoryPanel";
import { ConnectionDialog } from "./components/connection/ConnectionDialog";
import { ConflictDialog } from "./components/editor/ConflictDialog";
import { CloseConfirmDialog } from "./components/editor/CloseConfirmDialog";
import { ContextMenu } from "./components/filetree/ContextMenu";
import { TabContextMenu } from "./components/editor/TabContextMenu";
import { NewEntryDialog } from "./components/filetree/NewEntryDialog";
import { DeleteConfirmDialog } from "./components/filetree/DeleteConfirmDialog";
import { PropertiesDialog } from "./components/filetree/PropertiesDialog";
import { DiscardDialog } from "./components/vcs/DiscardDialog";
import { VcsConfirmDialog } from "./components/vcs/VcsConfirmDialog";
import { CommandPalette } from "./components/CommandPalette";
import { Finder } from "./components/Finder";
import { SearchInFiles } from "./components/SearchInFiles";
import { PortForwards } from "./components/PortForwards";
import { ToastStack } from "./components/Toast";

export default function App() {
  const dialogOpen = useAppStore((s) => s.dialogOpen);
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);
  const terminalVisible = useAppStore((s) => s.terminalVisible);
  const localConnId = useAppStore((s) => s.localConnId);
  const setLocalConnId = useAppStore((s) => s.setLocalConnId);
  const setSidebarVisible = useAppStore((s) => s.setSidebarVisible);
  const setTerminalVisible = useAppStore((s) => s.setTerminalVisible);

  // Joined ids of ALL attached remotes, so connect/disconnect of any of them
  // re-resolves tracked repos.
  const remoteConnIds = useAppStore((s) =>
    s.remotes.map((r) => r.conn.connId).join(","),
  );
  const wslConnId = useAppStore((s) => s.wsl?.connId ?? null);
  const scmVisible = useVcsStore((s) => s.scmVisible);
  const setScmVisible = useVcsStore((s) => s.setScmVisible);
  const historyOpen = useVcsStore((s) => s.historyRepo != null);

  const sidebarPanel = useRef<ImperativePanelHandle>(null);
  const terminalPanel = useRef<ImperativePanelHandle>(null);
  const scmPanel = useRef<ImperativePanelHandle>(null);
  const restored = useRef(false);

  const { connect } = useSSH();

  useKeyboard();

  // Open the always-present local session once.
  useEffect(() => {
    if (localConnId) return;
    let active = true;
    localConnect()
      .then((id) => {
        if (active) setLocalConnId(id);
      })
      .catch((error) =>
        useAppStore
          .getState()
          .pushNotice("error", `Local filesystem unavailable: ${String(error)}`),
      );
    return () => {
      active = false;
    };
  }, [localConnId, setLocalConnId]);

  // Persist the session (open tabs, last remote, panel visibility) on change.
  useEffect(() => initSessionPersistence(), []);

  // Auto-reload clean open files when they change on disk (local: watcher;
  // remote/WSL: mtime poll) — watching a growing log just works.
  useEffect(() => initFileWatching(), []);

  // Theme layer first (it subscribes to settings), then load settings.json
  // (zoom, keybinding overrides, colors) and keep it live.
  useEffect(() => initThemes(), []);
  useEffect(() => {
    if (localConnId) void initSettings(localConnId);
  }, [localConnId]);

  // Once the local session is up, restore the previous session exactly once:
  // panel visibility, local tabs, and the last remote (auto-reconnect for key
  // hosts; pre-filled dialog for password hosts).
  useEffect(() => {
    if (!localConnId || restored.current) return;
    restored.current = true;
    void restoreSession(localConnId, connect);
  }, [localConnId, connect]);

  // Ensure there's always at least one terminal once the local session is up.
  useEffect(() => {
    if (!localConnId) return;
    const store = useAppStore.getState();
    if (store.terminals.length === 0) store.openTerminal(localConnId, "Local");
  }, [localConnId]);

  // Reflect backend-driven remote status (drops, reconnects, errors) in the
  // store. The connId is preserved across a reconnect, so tabs and the file tree
  // stay valid — but the old SFTP/PTY channels are dead, so on recovery we
  // refresh the tree and restart the terminal.
  useEffect(() => {
    const unlistenPromise = onSshStatus((status) => {
      const store = useAppStore.getState();
      const entry = store.remotes.find((r) => r.conn.connId === status.connId);
      if (!entry) return;
      const wasReconnecting = entry.state === "reconnecting";
      store.setRemoteState(status.connId, status.state, status.message);
      if (status.state === "connected" && wasReconnecting) {
        store.refreshRemote(status.connId);
        store.restartConnTerminals(status.connId);
        store.pushNotice("info", `Reconnected to ${entry.conn.name}.`);
      }
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // Reflect transfer progress (from fs_transfer_batch) into the global store, so
  // the bar shows in the status bar even after the transfer panel is closed.
  useEffect(() => {
    const unlistenPromise = onTransferProgress((p) =>
      useAppStore.getState().updateTransferProgress(p),
    );
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // Re-resolve tracked repos' live connId whenever the active connections change
  // (connect / disconnect / reconnect) — cached decorations then light up, local
  // repos get their fs watcher, and newly-online repos populate once.
  useEffect(() => {
    useVcsStore.getState().resolveConns();
  }, [localConnId, remoteConnIds, wslConnId]);

  // A watched local repo changed on disk (terminal git ops, external edits).
  useEffect(() => {
    const unlistenPromise = onVcsFsChange((c) =>
      useVcsStore.getState().onFsChange(c.connId, c.root),
    );
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // Remote/WSL repos have no watcher — catch up when the window regains focus
  // (e.g. after git ops in an external terminal), throttled per repo.
  useEffect(() => {
    const onFocus = () => useVcsStore.getState().refreshAll(5_000);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // A port forward's tunnel failed (e.g. nothing listening on the remote port)
  // — surface it even when the Ports dialog is closed.
  useEffect(() => {
    const unlistenPromise = onPortForwardError((e) =>
      useAppStore.getState().pushNotice("error", e.message),
    );
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // Suppress WebView2's native context menu (重新整理/列印/檢查…) everywhere
  // except text fields — Monaco, xterm, and the file tree bring their own menus.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable=true]")) return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // Drive the Source Control panel's collapse from the store.
  useEffect(() => {
    const panel = scmPanel.current;
    if (!panel) return;
    if (scmVisible && panel.isCollapsed()) panel.expand();
    else if (!scmVisible && !panel.isCollapsed()) panel.collapse();
  }, [scmVisible]);

  // The history panel sits on top of the explorer in the sidebar column (the
  // explorer is usually idle while browsing history, and this keeps the editor
  // free for comparing). It's mounted only while open — driving it through
  // collapse/expand instead caused spurious onCollapse events that closed it
  // right after opening. Opening also reveals the sidebar if it's hidden.
  useEffect(() => {
    if (historyOpen) setSidebarVisible(true);
  }, [historyOpen, setSidebarVisible]);

  // Drive the sidebar panel's collapse state from the store.
  useEffect(() => {
    const panel = sidebarPanel.current;
    if (!panel) return;
    if (sidebarVisible && panel.isCollapsed()) panel.expand();
    else if (!sidebarVisible && !panel.isCollapsed()) panel.collapse();
  }, [sidebarVisible]);

  // Drive the terminal panel's collapse state; blur it when hidden. Resizes
  // flow through useTerminal, which debounces them so ConPTY isn't repainted
  // per frame.
  useEffect(() => {
    const panel = terminalPanel.current;
    if (!panel) return;
    if (terminalVisible) {
      if (panel.isCollapsed()) panel.expand();
    } else {
      if (!panel.isCollapsed()) panel.collapse();
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest(".terminal-host")) {
        active.blur();
      }
    }
  }, [terminalVisible, localConnId]);

  return (
    <div className="app">
      <TitleBar />
      <div className="app-body">
        <PanelGroup direction="horizontal" autoSaveId="straylight.layout.h">
          <Panel
            id="sidebar"
            order={1}
            ref={sidebarPanel}
            collapsible
            collapsedSize={0}
            defaultSize={24}
            minSize={14}
            maxSize={50}
            onCollapse={() => setSidebarVisible(false)}
            onExpand={() => setSidebarVisible(true)}
          >
            <PanelGroup direction="vertical" autoSaveId="straylight.layout.sidebar">
              {historyOpen && (
                <>
                  <Panel id="history" order={1} defaultSize={45} minSize={15} maxSize={80}>
                    <HistoryPanel />
                  </Panel>
                  <PanelResizeHandle className="resize-handle" />
                </>
              )}
              <Panel id="explorer" order={2} minSize={20}>
                <Sidebar />
              </Panel>
            </PanelGroup>
          </Panel>
          <PanelResizeHandle className="resize-handle" />
          <Panel id="main" order={2} minSize={30}>
            <PanelGroup
              key={localConnId ? "with-terminal" : "no-terminal"}
              autoSaveId="straylight.layout.v"
              direction="vertical"
            >
              <Panel id="editor" order={1} minSize={0}>
                <EditorArea />
              </Panel>
              {localConnId && (
                <>
                  <PanelResizeHandle className="resize-handle" />
                  <Panel
                    id="terminal"
                    order={2}
                    ref={terminalPanel}
                    collapsible
                    collapsedSize={0}
                    defaultSize={30}
                    minSize={10}
                    onCollapse={() => setTerminalVisible(false)}
                    onExpand={() => setTerminalVisible(true)}
                  >
                    <TerminalPanel />
                  </Panel>
                </>
              )}
            </PanelGroup>
          </Panel>
          <PanelResizeHandle className="resize-handle" />
          <Panel
            id="scm"
            order={3}
            ref={scmPanel}
            collapsible
            collapsedSize={0}
            defaultSize={22}
            minSize={14}
            maxSize={40}
            onCollapse={() => setScmVisible(false)}
            onExpand={() => setScmVisible(true)}
          >
            <ScmPanel />
          </Panel>
        </PanelGroup>
      </div>
      <StatusBar />
      {dialogOpen && <ConnectionDialog />}
      <ConflictDialog />
      <CloseConfirmDialog />
      <NewEntryDialog />
      <DeleteConfirmDialog />
      <PropertiesDialog />
      <DiscardDialog />
      <VcsConfirmDialog />
      <CommandPalette />
      <Finder />
      <SearchInFiles />
      <PortForwards />
      <ContextMenu />
      <TabContextMenu />
      <ToastStack />
    </div>
  );
}
