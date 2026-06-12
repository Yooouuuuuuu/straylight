/** Application shell: title bar, the resizable sidebar / editor / terminal
 *  layout, the status bar, and global overlays (connection dialog, toasts).
 *
 *  Panels are collapsible rather than conditionally mounted, so toggling the
 *  sidebar or terminal never tears down the terminal's PTY. */
import { useEffect, useRef } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";

import { onSshStatus } from "./lib/ipc";
import { useAppStore } from "./store/appStore";
import { useKeyboard } from "./hooks/useKeyboard";
import { TitleBar } from "./components/layout/TitleBar";
import { Sidebar } from "./components/layout/Sidebar";
import { EditorArea } from "./components/layout/EditorArea";
import { TerminalPanel } from "./components/layout/TerminalPanel";
import { StatusBar } from "./components/layout/StatusBar";
import { ConnectionDialog } from "./components/connection/ConnectionDialog";
import { ToastStack } from "./components/Toast";

export default function App() {
  const dialogOpen = useAppStore((s) => s.dialogOpen);
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);
  const terminalVisible = useAppStore((s) => s.terminalVisible);
  const connection = useAppStore((s) => s.connection);
  const setConnState = useAppStore((s) => s.setConnState);
  const setSidebarVisible = useAppStore((s) => s.setSidebarVisible);
  const setTerminalVisible = useAppStore((s) => s.setTerminalVisible);

  const sidebarPanel = useRef<ImperativePanelHandle>(null);
  const terminalPanel = useRef<ImperativePanelHandle>(null);

  useKeyboard();

  // Reflect backend-driven connection status (drops, errors) in the store.
  useEffect(() => {
    const unlistenPromise = onSshStatus((status) => {
      const current = useAppStore.getState().connection;
      if (current && status.connId === current.connId) {
        setConnState(status.state, status.message);
      }
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [setConnState]);

  // Drive the sidebar panel's collapse state from the store.
  useEffect(() => {
    const panel = sidebarPanel.current;
    if (!panel) return;
    if (sidebarVisible && panel.isCollapsed()) panel.expand();
    else if (!sidebarVisible && !panel.isCollapsed()) panel.collapse();
  }, [sidebarVisible]);

  // Drive the terminal panel's collapse state; blur it when hidden so keystrokes
  // don't keep going to an invisible terminal.
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
  }, [terminalVisible, connection]);

  return (
    <div className="app">
      <TitleBar />
      <div className="app-body">
        <PanelGroup direction="horizontal">
          <Panel
            id="sidebar"
            order={1}
            ref={sidebarPanel}
            collapsible
            collapsedSize={0}
            defaultSize={22}
            minSize={12}
            maxSize={45}
            onCollapse={() => setSidebarVisible(false)}
            onExpand={() => setSidebarVisible(true)}
          >
            <Sidebar />
          </Panel>
          <PanelResizeHandle className="resize-handle" />
          <Panel id="main" order={2} minSize={30}>
            {/* Remounts only when the connection itself changes — never on a
                sidebar/terminal toggle — so the PTY is preserved. */}
            <PanelGroup
              key={connection ? "connected" : "idle"}
              direction="vertical"
            >
              <Panel id="editor" order={1} minSize={20}>
                <EditorArea />
              </Panel>
              {connection && (
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
        </PanelGroup>
      </div>
      <StatusBar />
      {dialogOpen && <ConnectionDialog />}
      <ToastStack />
    </div>
  );
}
