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

import { localConnect, onSshStatus, onTransferProgress } from "./lib/ipc";
import { useAppStore } from "./store/appStore";
import { useVcsStore } from "./store/vcsStore";
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
import { NewEntryDialog } from "./components/filetree/NewEntryDialog";
import { DeleteConfirmDialog } from "./components/filetree/DeleteConfirmDialog";
import { PropertiesDialog } from "./components/filetree/PropertiesDialog";
import { DiscardDialog } from "./components/vcs/DiscardDialog";
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

  const remoteConnId = useAppStore((s) => s.remote?.connId ?? null);
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
      const current = store.remote;
      if (!current || status.connId !== current.connId) return;
      const wasReconnecting = store.connState === "reconnecting";
      store.setConnState(status.state, status.message);
      if (status.state === "connected" && wasReconnecting) {
        store.refreshRemote();
        store.restartConnTerminals(current.connId);
        store.pushNotice("info", "Reconnected.");
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
  // (connect / disconnect / reconnect) — cached decorations then light up.
  useEffect(() => {
    useVcsStore.getState().resolveConns();
  }, [localConnId, remoteConnId, wslConnId]);

  // Drive the Source Control panel's collapse from the store.
  useEffect(() => {
    const panel = scmPanel.current;
    if (!panel) return;
    if (scmVisible && panel.isCollapsed()) panel.expand();
    else if (!scmVisible && !panel.isCollapsed()) panel.collapse();
  }, [scmVisible]);

  // When history appends inside the VC panel, make sure that panel is open and
  // wide enough to hold both the history and the cards.
  useEffect(() => {
    const panel = scmPanel.current;
    if (!panel || !historyOpen) return;
    if (panel.isCollapsed()) panel.expand();
    if (panel.getSize() < 40) panel.resize(44);
  }, [historyOpen]);

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
            <Sidebar />
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
            maxSize={60}
            onCollapse={() => setScmVisible(false)}
            onExpand={() => setScmVisible(true)}
          >
            <div className="vc-region">
              {historyOpen && <HistoryPanel />}
              <ScmPanel />
            </div>
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
      <Finder />
      <SearchInFiles />
      <PortForwards />
      <ContextMenu />
      <ToastStack />
    </div>
  );
}
