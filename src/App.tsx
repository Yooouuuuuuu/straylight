/** Application shell: title bar, the resizable sidebar / editor / terminal
 *  layout, the status bar, and global overlays (connection dialog, toasts).
 *
 *  A window always has a local session (opened at startup) and can attach a
 *  WSL distro plus up to three SSH remotes at once; trees, terminals, and
 *  tracked repos are all per-host. */
import { Fragment, useEffect, useRef, useState } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";

import {
  backendReset,
  localConnect,
  onDiagAlert,
  onOpenPath,
  onPortForwardError,
  onSshStatus,
  onTransferProgress,
  onVcsFsChange,
  takeOpenPath,
} from "./lib/ipc";
import { openLocalTarget } from "./lib/openFile";
import { connKeyForConnId, useAppStore, type DockToken } from "./store/appStore";
import { useVcsStore } from "./store/vcsStore";
import { initDrafts } from "./lib/drafts";
import { initFileWatching } from "./lib/fileWatch";
import {
  BAND,
  clampedWidths,
  EDITOR_MIN_Y,
  SUPPRESS_ORDER,
  TERMINAL_MIN_Y,
  useWindowSize,
  xSuppressionFor,
  Y_STATUSBAR,
  Y_TITLEBAR,
  type SuppressKey,
} from "./lib/layoutBudget";
import { initTreeWatching } from "./lib/treeWatch";
import { initSettings, uiConfig } from "./lib/settings";
import { reconcilePendingSaves, startSaveSweep } from "./lib/stagedSave";
import { initThemes } from "./lib/themes";
import { initSessionPersistence, restoreSession } from "./lib/session";
import { checkForUpdateOnLaunch } from "./lib/updater";
import { useKeyboard } from "./hooks/useKeyboard";
import { useSSH } from "./hooks/useSSH";
import { TitleBar } from "./components/layout/TitleBar";
import { Sidebar } from "./components/layout/Sidebar";
import { EditorArea } from "./components/layout/EditorArea";
import { TerminalPanel } from "./components/layout/TerminalPanel";
import { StatusBar } from "./components/layout/StatusBar";
import { ScmPanel } from "./components/vcs/ScmPanel";
import { ChatPanel } from "./components/chat/ChatPanel";
import { HistoryPanel } from "./components/vcs/HistoryPanel";
import { ConnectionDialog } from "./components/connection/ConnectionDialog";
import { PassphraseDialog } from "./components/connection/PassphraseDialog";
import { HostKeyDialog } from "./components/connection/HostKeyDialog";
import { CloseConfirmDialog } from "./components/editor/CloseConfirmDialog";
import { ContextMenu } from "./components/filetree/ContextMenu";
import { TabContextMenu } from "./components/editor/TabContextMenu";
import { NewEntryDialog } from "./components/filetree/NewEntryDialog";
import { DeleteConfirmDialog } from "./components/filetree/DeleteConfirmDialog";
import { PropertiesDialog } from "./components/filetree/PropertiesDialog";
import { DiscardDialog } from "./components/vcs/DiscardDialog";
import { VcsConfirmDialog } from "./components/vcs/VcsConfirmDialog";
import { CommandPalette } from "./components/CommandPalette";
import { TabSwitcher } from "./components/TabSwitcher";
import { StartupAskDialog } from "./components/StartupAskDialog";
import { TextContextMenu } from "./components/TextContextMenu";
import { FocusView } from "./components/FocusView";
import { FocusBar } from "./components/FocusBar";
import { Finder } from "./components/Finder";
import { SearchInFiles } from "./components/SearchInFiles";
import { ToastStack } from "./components/Toast";

/** The full left→right layout tokens; "explorer" is pinned first, the rest are
 *  the reorderable dock tokens. */
type FullToken = "explorer" | DockToken;

interface HWidths {
  sidebar: number;
  scm: number;
  chat: number;
}
const HW_KEY = "straylight.hwidths";
const HW_DEFAULT: HWidths = { sidebar: 260, scm: 300, chat: 340 };
/** Per-column drag bounds (px). CHAT's max is proportional instead — see
 *  chatMax; the value here is only its narrow-window nominal. */
const HW_BOUNDS: Record<keyof HWidths, { min: number; max: number }> = {
  sidebar: { min: 160, max: 520 },
  scm: { min: 200, max: 620 },
  chat: { min: 220, max: 680 },
};
/** The Sessions (CHAT) column drags up to 4/5 of the window — far wider than
 *  the fixed sidebar/SC maxes. The layout budget still shrinks it to protect
 *  the editor's floor on narrow windows, so this only opens up on a wide one. */
const chatMax = (winW: number) => Math.round(winW * 0.8);

function loadHWidths(): HWidths {
  try {
    const parsed = JSON.parse(localStorage.getItem(HW_KEY) ?? "");
    if (parsed && typeof parsed === "object") {
      const maxOf = (k: keyof HWidths) =>
        k === "chat" ? chatMax(window.innerWidth) : HW_BOUNDS[k].max;
      const pick = (k: keyof HWidths) =>
        typeof parsed[k] === "number"
          ? Math.min(maxOf(k), Math.max(HW_BOUNDS[k].min, parsed[k]))
          : HW_DEFAULT[k];
      return { sidebar: pick("sidebar"), scm: pick("scm"), chat: pick("chat") };
    }
  } catch {
    /* default below */
  }
  return { ...HW_DEFAULT };
}

function saveHWidths(w: HWidths): void {
  try {
    localStorage.setItem(HW_KEY, JSON.stringify(w));
  } catch {
    /* prefs only */
  }
}

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
  const wslConnIds = useAppStore((s) =>
    s.wsls.map((w) => w.conn.connId).join(","),
  );
  const scmVisible = useVcsStore((s) => s.scmVisible);
  const chatVisible = useAppStore((s) => s.chatVisible);
  const dockOrder = useAppStore((s) => s.dockOrder);
  useAppStore((s) => s.settingsRev); // re-render when settings.json changes
  const hasChatResidents = useAppStore((s) =>
    s.terminals.some((t) => t.inChat),
  );
  const historyOpen = useVcsStore((s) => s.historyRepo != null);
  const focusView = useAppStore((s) => s.focusView);

  const terminalPanel = useRef<ImperativePanelHandle>(null);
  const restored = useRef(false);
  const tookLaunchPath = useRef(false);

  // Horizontal widths (px) for the fixed-width columns. The editor is flex:1
  // and absorbs everything else, so hiding a column gives its space to the
  // editor — never to the other column, and each column keeps its own width.
  const [hw, setHw] = useState(loadHWidths);
  const setColWidth = (key: keyof HWidths, w: number) => {
    const next = { ...hw, [key]: w };
    setHw(next);
    saveHWidths(next);
  };
  const dragWidth =
    (key: keyof HWidths, dir: 1 | -1, min: number, max: number) =>
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const start = hw[key];
      const onMove = (ev: MouseEvent) => {
        const w = Math.min(max, Math.max(min, start + dir * (ev.clientX - startX)));
        setColWidth(key, w);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
    };

  const { connect } = useSSH();

  useKeyboard();

  // Open the always-present local session once. First, sweep whatever a
  // PREVIOUS page left in the backend — after a dev reload or a renderer
  // crash-recovery this page knows no connection ids, so every session, lane,
  // PTY, forward, and (worst) still-running transfer back there is an orphan
  // that would keep holding server slots and bandwidth forever.
  useEffect(() => {
    if (localConnId) return;
    let active = true;
    backendReset()
      .catch(() => {})
      .then(() => localConnect())
      .then((id) => {
        if (active && id) setLocalConnId(id);
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

  // Local explorer trees auto-refresh: a recursive watcher per pinned folder
  // (VS Code-style). Needs the local session for the watch calls.
  useEffect(() => {
    if (localConnId) initTreeWatching();
  }, [localConnId]);

  // Re-check parked staged-save records on connected hosts (~60 s).
  useEffect(() => startSaveSweep(), []);

  // Theme layer first (it subscribes to settings), then load settings.json
  // (zoom, keybinding overrides, colors) and keep it live. Drafts follow
  // settings (they read draftsConfig) and must init even if settings failed —
  // session restore awaits the draft index.
  useEffect(() => initThemes(), []);
  // Quiet auto-update check once on launch (no-op in dev; never interrupts —
  // an available update only lights the green dot on ⚙ → Check for updates).
  useEffect(() => checkForUpdateOnLaunch(), []);
  useEffect(() => {
    if (localConnId)
      void initSettings(localConnId).finally(() => void initDrafts(localConnId));
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

  // "Open with Straylight" (Windows right-click). Two arrival paths:
  //  - first launch: the backend stashed the argv path; take it once the local
  //    session is ready (a folder pins as a root, a file opens as a tab).
  //  - already running: a second launch forwards its path here as an event
  //    (single-instance) — the window is focused backend-side.
  useEffect(() => {
    if (!localConnId || tookLaunchPath.current) return;
    tookLaunchPath.current = true;
    void takeOpenPath().then((t) => {
      if (t) void openLocalTarget(localConnId, t);
    });
  }, [localConnId]);
  useEffect(() => {
    const un = onOpenPath((t) => {
      const id = useAppStore.getState().localConnId;
      if (id) void openLocalTarget(id, t);
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // Reflect backend-driven remote status (drops, reconnects, errors) in the
  // store. The connId is preserved across a reconnect, so tabs and the file tree
  // stay valid — but the old SFTP/PTY channels are dead, so on recovery we
  // refresh the tree and restart the terminal.
  useEffect(() => {
    // Host state-transition toasts (docs/connections.md). Only the MAIN lane —
    // i.e. the host itself — toasts; a distinct transition says what happened
    // and what it means for the user's terminals. Secondary lanes (data,
    // session, transfer) are plumbing and stay silent (see the `::` branch),
    // so a whole-host bounce reads as one host toast, not a per-lane wall.
    // Same-state updates (reconnect attempts, still-stalled pings) never
    // re-toast.
    const toastTransition = (
      name: string,
      prev: string,
      next: string,
      message: string | null,
    ) => {
      const store = useAppStore.getState();
      if (prev === next) return;
      if (next === "degraded") {
        store.pushNotice(
          "warn",
          `${name}: ${message ?? "connection stalled — terminals stay open."}`,
        );
      } else if (next === "connected" && prev === "degraded") {
        store.pushNotice(
          "info",
          `${name}: connection recovered — nothing was restarted.`,
        );
      } else if (next === "reconnecting") {
        store.pushNotice(
          "warn",
          `${name}: ${message ?? "connection lost — reconnecting…"}`,
        );
      } else if (next === "failed") {
        // Reconnect gave up and parked (incident 2026-07-29) — an actionable
        // error, not the transient "reconnecting" warning.
        store.pushNotice(
          "error",
          `${name}: ${message ?? "reconnect stopped — click Reconnect to try again."}`,
        );
      } else if (next === "disconnected") {
        store.pushNotice(
          message ? "error" : "info",
          `${name}: disconnected${message ? ` — ${message}` : "."}`,
        );
      }
      // reconnecting → connected keeps its dedicated "Reconnected to X." toast
      // in the branches below (it also restarts terminals + reconciles saves).
    };

    // Last-seen state of each secondary lane (`<connId>::data`,
    // `<connId>::session-<k>`) — they aren't in the store (no dot of their
    // own); tracked here so their transitions toast without fighting the main
    // lane's state.
    const lanePrev = new Map<string, string>();

    const unlistenPromise = onSshStatus((status) => {
      const store = useAppStore.getState();
      // Secondary lanes (docs/connections.md): the data lane (SFTP + exec)
      // and per-agent session lanes. Toast their transitions with a clear
      // tag; the host's dot stays owned by the main lane.
      const sep = status.connId.indexOf("::");
      if (sep !== -1) {
        // Secondary lanes (data, per-agent session, transfer) are internal
        // plumbing (docs/connections.md) — they NEVER toast. Their state shows
        // where it truly belongs: an agent's CHAT dot, the transfer's progress
        // bar, the file tree. A whole-host bounce takes the main lane too, and
        // THAT toasts once (below) — so the host's own toast is already the
        // coalesced summary, with no per-lane wall. We only ACT on recovery.
        const parent = status.connId.slice(0, sep);
        const kind = status.connId.slice(sep + 2); // data | session-<k> | transfer-<k>
        const prev = lanePrev.get(status.connId) ?? "connected";
        lanePrev.set(status.connId, status.state);
        if (status.state === "connected" && prev === "reconnecting") {
          if (kind === "data") {
            // File ops rode this lane — refresh the tree and settle saves
            // stranded by the drop (terminals were never involved).
            store.refreshConn(parent);
            const connKey = connKeyForConnId(parent);
            if (connKey) void reconcilePendingSaves(parent, connKey, Date.now());
          } else if (kind.startsWith("session-")) {
            // The agent's shell died with its lane — restart just that one.
            store.restartConnTerminals(status.connId);
          }
          // transfer-*: the transfer's own retry loop redials; nothing here.
        }
        return;
      }
      const entry = store.remotes.find((r) => r.conn.connId === status.connId);
      if (entry) {
        const prev = entry.state;
        const wasReconnecting = prev === "reconnecting";
        store.setRemoteState(status.connId, status.state, status.message);
        toastTransition(entry.conn.name, prev, status.state, status.message);
        if (status.state === "connected" && wasReconnecting) {
          store.refreshRemote(status.connId);
          store.restartConnTerminals(status.connId);
          store.pushNotice("info", `Reconnected to ${entry.conn.name} — terminals restarted.`);
          // Same recovery as a relaunch: resolve saves stranded by the drop.
          // Anything dispatched before this instant died with the old link.
          const connKey = connKeyForConnId(status.connId);
          if (connKey) void reconcilePendingSaves(status.connId, connKey, Date.now());
        }
        return;
      }
      // WSL links are normal SSH connections — track their state too, so
      // the status-bar dots go red/orange when sshd dies in a distro.
      // (Auto re-provisioning is a separate, later feature — a reconnect
      // only succeeds here if sshd is still alive.)
      const w = store.wsls.find((x) => x.conn.connId === status.connId);
      if (w) {
        const prev = w.state;
        const wasReconnecting = prev === "reconnecting";
        store.setWslConnState(status.connId, status.state);
        toastTransition(w.conn.name, prev, status.state, status.message);
        if (status.state === "connected" && wasReconnecting) {
          store.refreshConn(status.connId);
          store.restartConnTerminals(status.connId);
          store.pushNotice("info", `Reconnected to ${w.conn.name} — terminals restarted.`);
          const connKey = connKeyForConnId(status.connId);
          if (connKey) void reconcilePendingSaves(status.connId, connKey, Date.now());
        }
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
  }, [localConnId, remoteConnIds, wslConnIds]);

  // A watched local repo changed on disk (terminal git ops, external edits).
  useEffect(() => {
    const unlistenPromise = onVcsFsChange((c) =>
      useVcsStore.getState().onFsChange(c.connId, c.root),
    );
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // Window refocus = an extra poll tick for MONITORED (◉) remote/WSL repos —
  // ◉ off means "don't touch this repo except for my own in-app actions",
  // and local repos are watcher-live, so both are skipped by the poll.
  // The explorer trees refresh on the same trigger (throttled): the common
  // "added a file in Windows Explorer, came back" case — the stand-in until
  // real tree auto-refresh (future-work) lands.
  useEffect(() => {
    let lastTreeRefresh = 0;
    const onFocus = () => {
      useVcsStore.getState().pollEagerRemotes();
      const now = Date.now();
      if (now - lastTreeRefresh > 3_000) {
        lastTreeRefresh = now;
        const s = useAppStore.getState();
        s.refreshLocal();
        s.refreshWsl();
        s.refreshRemote();
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // ◉ on a WSL/remote repo = live polling: refresh every ~5 s while the
  // window is focused, so terminal-driven git/jj ops inside the app show up
  // without a refocus/F5 (local repos are watcher-live instead).
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hasFocus()) return;
      useVcsStore.getState().pollEagerRemotes();
    }, 5_000);
    return () => window.clearInterval(timer);
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

  // Self-diagnostics alerts (CPU spin tripwire, connection recycle, strict
  // server cap) — the backend already wrote the detail to the diag ring buffer;
  // this just surfaces the one-line notice (incident 2026-07-29).
  useEffect(() => {
    const unlistenPromise = onDiagAlert((a) =>
      useAppStore.getState().pushNotice(a.level, a.message),
    );
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // The native WebView2 context menu (重新整理/列印/檢查…) never shows —
  // TextContextMenu owns right-click app-wide: the six-entry edit menu on
  // text fields and the file editor, nothing elsewhere (xterm and the file
  // tree bring their own menus and preventDefault before it).

  // The history panel sits on top of the explorer in the sidebar column (the
  // explorer is usually idle while browsing history, and this keeps the editor
  // free for comparing). Opening it reveals the sidebar if it's hidden.
  useEffect(() => {
    if (historyOpen) setSidebarVisible(true);
  }, [historyOpen, setSidebarVisible]);

  // Window-size budget: suppress panels (Sessions → SC → explorer, plus the
  // terminal on Y) when the window can't hold them — a derived overlay that
  // never touches the user's visibility flags, restored in reverse on grow.
  const win = useWindowSize();
  const suppressed = useAppStore((s) => s.suppressed);
  useEffect(() => {
    const s = useAppStore.getState();
    const shown: Record<SuppressKey, boolean> = {
      chat: chatVisible && (!uiConfig.disableChat || hasChatResidents),
      scm: scmVisible,
      sidebar: sidebarVisible,
    };
    const want = xSuppressionFor(win.w, shown);
    // Hysteresis: a currently-suppressed panel only comes back when it would
    // also fit at (width − BAND), so the boundary doesn't flap while dragging.
    const stable = xSuppressionFor(win.w - BAND, shown);
    const next = { ...s.suppressed };
    for (const k of SUPPRESS_ORDER) {
      next[k] = want.has(k) || (s.suppressed[k] && stable.has(k));
    }
    // The explorer is never suppressed (the window floor holds it) — also
    // clears any state stuck from before this rule.
    next.sidebar = false;
    const bodyH = win.h - Y_TITLEBAR - Y_STATUSBAR;
    next.terminal =
      bodyH < EDITOR_MIN_Y + TERMINAL_MIN_Y ||
      (s.suppressed.terminal && bodyH < EDITOR_MIN_Y + TERMINAL_MIN_Y + BAND);
    if (
      next.chat !== s.suppressed.chat ||
      next.scm !== s.suppressed.scm ||
      next.sidebar !== s.suppressed.sidebar ||
      next.terminal !== s.suppressed.terminal
    ) {
      s.setSuppressed(next);
    }
  }, [win, sidebarVisible, scmVisible, chatVisible, hasChatResidents]);

  // Drive the terminal panel's collapse state (user intent OR the Y budget);
  // blur it when hidden. Resizes flow through useTerminal, which debounces
  // them so ConPTY isn't repainted per frame.
  useEffect(() => {
    const panel = terminalPanel.current;
    if (!panel) return;
    if (terminalVisible && !suppressed.terminal) {
      if (panel.isCollapsed()) panel.expand();
    } else {
      if (!panel.isCollapsed()) panel.collapse();
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest(".terminal-host")) {
        active.blur();
      }
    }
  }, [terminalVisible, suppressed.terminal, localConnId]);

  // Left→right layout after the pinned explorer. The editor is one of the
  // tokens, so a column can step past it — sitting the editor next to the
  // explorer (both columns right) or at the right edge (both columns left).
  // ui.disableChat removes the CHAT column entirely — but never while
  // terminals still live in it (the wish waits until they're returned).
  const chatEnabled = !uiConfig.disableChat || hasChatResidents;
  const full: FullToken[] = [
    "explorer",
    ...(chatEnabled ? dockOrder : dockOrder.filter((t) => t !== "chat")),
  ];
  const editorIdx = full.indexOf("editor");

  // Effective visibility = the user's flag minus the window-size suppression.
  const tokenVisible = (t: FullToken) =>
    t === "explorer"
      ? sidebarVisible && !suppressed.sidebar
      : t === "editor"
        ? true
        : t === "scm"
          ? scmVisible && !suppressed.scm
          : chatVisible && !suppressed.chat;
  const widthKeyOf = (t: FullToken): keyof HWidths =>
    t === "explorer" ? "sidebar" : (t as "scm" | "chat");
  // Before anything is suppressed, columns SHRINK toward their minimums
  // (Sessions gives first) so the editor holds its floor. Persisted widths
  // are untouched — grow the window and they come back.
  const rendered = clampedWidths(
    win.w,
    {
      chat: chatEnabled && tokenVisible("chat"),
      scm: tokenVisible("scm"),
      sidebar: tokenVisible("explorer"),
    },
    hw,
  );

  const renderElement = (t: FullToken) => {
    if (t === "editor") {
      return (
        <div className="hcol hcol--editor" key="editor">
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
                  onCollapse={() => {
                    // A collapse driven by the Y budget must not rewrite the
                    // user's intent — only a user collapse hides for real.
                    if (!useAppStore.getState().suppressed.terminal)
                      setTerminalVisible(false);
                  }}
                  onExpand={() => setTerminalVisible(true)}
                >
                  <TerminalPanel />
                </Panel>
              </>
            )}
          </PanelGroup>
        </div>
      );
    }
    if (t === "explorer") {
      return (
        <div
          className="hcol hcol--sidebar"
          key="explorer"
          style={{ width: tokenVisible("explorer") ? rendered.sidebar : 0 }}
        >
          {/* History takes the whole column while open; the explorer stays
              mounted underneath (hidden) so its state survives. */}
          <div style={{ display: historyOpen ? "block" : "none", height: "100%" }}>
            {historyOpen && <HistoryPanel />}
          </div>
          <div style={{ display: historyOpen ? "none" : "block", height: "100%" }}>
            <Sidebar />
          </div>
        </div>
      );
    }
    // A movable column (SC / CHAT): fixed width, its own persisted size.
    // Hidden (by the user or the window budget) = width 0 but still mounted,
    // so CHAT residents keep running.
    const width = t === "scm" ? rendered.scm : rendered.chat;
    return (
      <div className="hcol" key={t} style={{ width: tokenVisible(t) ? width : 0 }}>
        {t === "scm" ? <ScmPanel /> : <ChatPanel />}
      </div>
    );
  };

  // A handle for the gap between full[g] and full[g+1]. It resizes the fixed
  // element on the editor-facing side (never the editor — that flexes); a
  // handle whose target is hidden isn't rendered.
  const renderHandle = (g: number) => {
    const leftSide = g + 1 <= editorIdx;
    const target: FullToken = leftSide ? full[g] : full[g + 1];
    if (target === "editor" || !tokenVisible(target)) return null;
    const key = widthKeyOf(target);
    return (
      <div
        className="hdrag"
        onMouseDown={dragWidth(
          key,
          leftSide ? 1 : -1,
          HW_BOUNDS[key].min,
          key === "chat" ? chatMax(win.w) : HW_BOUNDS[key].max,
        )}
      />
    );
  };

  return (
    <div
      // app--slim-sb: the explorer is too narrow for its trimmings — the
      // L/W/R toggles, the connection gauge, and file sizes hide (the point
      // where the "Explorer" title would touch the L button).
      className={`app${tokenVisible("explorer") && rendered.sidebar < 224 ? " app--slim-sb" : ""}`}
      // Sidebar width drives the connection gauge's W/R alignment: the LIVE
      // (clamped) width while shown, held at the last user width when hidden
      // so the gauge keeps its place.
      style={
        {
          "--sidebar-w": `${tokenVisible("explorer") ? rendered.sidebar : hw.sidebar}px`,
        } as React.CSSProperties
      }
    >
      <TitleBar />
      {/* The normal layout stays MOUNTED under the focus overlay — unmounting
          TerminalPanel would dispose every terminal. The overlay covers the
          body (never the title bar) and reparents the active agent's xterm
          into its own pane. */}
      <div className="app-body">
        {full.map((t, k) => (
          <Fragment key={t}>
            {k > 0 && renderHandle(k - 1)}
            {renderElement(t)}
          </Fragment>
        ))}
        {/* Focus view (F11): a full-window CHAT workspace over the body. */}
        {focusView && <FocusView />}
      </div>
      {/* In the focus view the status bar is replaced by a slim full-width
          bar (same footprint, just the notification bell). */}
      {focusView ? <FocusBar /> : <StatusBar />}
      {dialogOpen && <ConnectionDialog />}
      <PassphraseDialog />
      <HostKeyDialog />
      <CloseConfirmDialog />
      <NewEntryDialog />
      <DeleteConfirmDialog />
      <PropertiesDialog />
      <DiscardDialog />
      <VcsConfirmDialog />
      <StartupAskDialog />
      <TextContextMenu />
      <CommandPalette />
      <TabSwitcher />
      <Finder />
      <SearchInFiles />
      <ContextMenu />
      <TabContextMenu />
      <ToastStack />
    </div>
  );
}
