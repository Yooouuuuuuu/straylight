/** Wire an xterm.js terminal to a remote SSH PTY for the lifetime of a mount.
 *
 *  Output streams in over the `pty-output` event; input and resize go back out
 *  through the pty_* commands. The WebGL renderer is used when available and
 *  silently falls back to the DOM renderer otherwise. */
import { useEffect, useLayoutEffect, useRef } from "react";

import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { UnlistenFn } from "@tauri-apps/api/event";

import {
  onPtyOutput,
  ptyClose,
  ptyOpen,
  ptyResize,
  ptyWrite,
} from "../lib/ipc";
import { isPassthroughShortcut } from "../lib/shortcuts";
import {
  registerTerminalFocus,
  unregisterTerminalFocus,
} from "../lib/terminalFocus";
import {
  registerTerminalSlot,
  unregisterTerminalSlot,
} from "../lib/terminalSlots";
import {
  currentTermFont,
  currentTermTheme,
  registerTerminal,
  unregisterTerminal,
} from "../lib/themes";
import { useAppStore } from "../store/appStore";

export function useTerminal(
  connId: string | null,
  active = true,
  command: string[] | null = null,
  id = "",
  initialInput: string | null = null,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!connId || !container) return;

    // xterm lives in a plain (non-React) div so it can be reparented into an
    // editor-pane slot without a remount — React never reconciles it, so
    // moving it can't crash a later reconciliation.
    const host = document.createElement("div");
    host.className = "terminal-host__inner";
    container.appendChild(host);
    if (id) registerTerminalSlot(id, host, container);

    let disposed = false;
    let ptyId: string | null = null;
    let unlisten: UnlistenFn | null = null;
    const encoder = new TextEncoder();

    // ConPTY (Windows local & WSL terminals) needs xterm's windows-pty
    // heuristics, or resize reflow drops/duplicates scrollback lines. SSH
    // terminals are real remote PTYs and must NOT use it. buildNumber is
    // hardcoded below 21376 to force the always-safe heuristic on both Win10
    // and Win11. FUTURE WORK: detect the real Windows build for native reflow
    // on Win11 (and verify behavior on Linux), once the feature set settles.
    const appState = useAppStore.getState();
    const isWindowsConpty =
      navigator.userAgent.includes("Windows") && connId === appState.localConnId;
    const windowsPty = isWindowsConpty
      ? ({ backend: "conpty", buildNumber: 19045 } as const)
      : undefined;
    // Each shell kind has its own settings section (terminalLocal /
    // terminalWsl / terminalRemote).
    const scope =
      connId === appState.localConnId
        ? "local"
        : connId === appState.wsl?.connId
          ? "wsl"
          : "remote";
    const font = currentTermFont();

    const term = new Terminal({
      fontFamily: font.family,
      fontSize: font.size,
      lineHeight: 1.1,
      cursorBlink: true,
      allowProposedApi: true,
      theme: currentTermTheme(scope),
      scrollback: 5000,
      windowsPty,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    // Re-themed (and refit on font changes) live when settings.json changes.
    registerTerminal(term, { scope, refit: () => fit.fit() });
    fitRef.current = fit;
    if (id) registerTerminalFocus(id, () => term.focus());

    // Let our app shortcuts (toggle/new/next/prev terminal, etc.) reach the
    // window handler instead of being sent to the shell.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && isPassthroughShortcut(e)) {
        // Suppress xterm's default for the combo (and don't send it to the
        // shell); the event still bubbles to the window handler, which acts.
        e.preventDefault();
        return false;
      }
      return true;
    });

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // No WebGL in this webview — the canvas/DOM renderer is used instead.
    }

    const safeFit = () => {
      // Never fit while the panel is hidden. A collapsed panel still leaves the
      // terminal a few px tall (its padding), so a plain 0-height check isn't
      // enough — fit() would resize the PTY to ~1 row and ConPTY would reflow
      // the whole buffer into it, wiping the scrollback. (An editor-hosted
      // terminal ignores the panel's visibility — it lives elsewhere.)
      const state = useAppStore.getState();
      const inChat = !!state.terminals.find((t) => t.id === id)?.inChat;
      // A resident's visibility is the chat column's, not the panel's.
      if (inChat ? !state.chatVisible : !state.terminalVisible) return;
      if (!host.clientWidth || !host.clientHeight) return;
      try {
        fit.fit();
      } catch {
        /* container not measured yet */
      }
    };
    safeFit();

    // "Running" indicator: a shell producing output is busy (Claude Code
    // updating its status counts). Cleared after a short idle so the dot goes
    // back to blank/done. Coalesced to transitions to avoid per-chunk writes.
    // NOTE: output must NOT clear a pending "your turn" bell — the BEL arrives
    // mid-burst (Claude rings, then keeps rendering the response and prompt
    // box), so trailing chunks would wipe the green milliseconds after it lit.
    // The bell clears when the user types instead (onData below).
    let busyTimer: ReturnType<typeof setTimeout> | undefined;
    const markBusy = () => {
      if (!id) return;
      const st = useAppStore.getState();
      if (!st.busy[id]) st.setBusy(id, true);
      clearTimeout(busyTimer);
      busyTimer = setTimeout(() => {
        useAppStore.getState().setBusy(id, false);
      }, 1200);
    };

    // Forward backend PTY output to the terminal. An EMPTY chunk is the
    // backend's "this PTY closed" signal — the shell exited.
    void onPtyOutput((output) => {
      if (disposed || output.ptyId !== ptyId) return;
      if (output.data.length > 0) {
        term.write(new Uint8Array(output.data));
        markBusy();
      } else if (id) {
        clearTimeout(busyTimer);
        useAppStore.getState().setBusy(id, false);
        useAppStore.getState().setPtyDead(id, true);
      }
    }).then((un) => {
      if (disposed) un();
      else unlisten = un;
    });

    // Open the PTY sized to the current terminal.
    void ptyOpen(connId, term.cols, term.rows, command)
      .then((openedId) => {
        if (disposed) {
          void ptyClose(openedId);
          return;
        }
        ptyId = openedId;
        // A fresh PTY (first open or an epoch restart) is alive again.
        if (id) useAppStore.getState().setPtyDead(id, false);
        term.focus();
        // Type the requested command into the fresh shell (e.g. a container
        // exec from the Containers tab) — visible and cancelable like any input.
        if (initialInput) {
          void ptyWrite(openedId, encoder.encode(`${initialInput}\r`));
        }
      })
      .catch((error) => {
        term.writeln(`\r\n\x1b[31mFailed to open terminal: ${error}\x1b[0m`);
        if (id) useAppStore.getState().setPtyDead(id, true);
      });

    const dataSub = term.onData((data) => {
      // Typing into the shell takes your turn — the "done" green clears here
      // (and only here), not on focus and not on the shell's own output.
      if (id && useAppStore.getState().belled[id]) {
        useAppStore.getState().clearBell(id);
      }
      if (ptyId) void ptyWrite(ptyId, encoder.encode(data));
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (ptyId) void ptyResize(ptyId, cols, rows);
    });
    // OSC 0/2 titles (pwsh's cwd, claude's status, vim's file…) feed the
    // terminal's auto name; a user rename (customName) keeps winning over it.
    const titleSub = term.onTitleChange((title) => {
      if (id) useAppStore.getState().setTerminalTitle(id, title);
    });
    // BEL = "done / your turn" (Claude Code rings when it finishes or needs
    // input). Show it even while you're watching the terminal — the whole
    // point is to know it's your turn — and clear "running" so the dot goes
    // straight to green. It stays green until you type (onData above).
    const bellSub = term.onBell(() => {
      if (!id) return;
      const st = useAppStore.getState();
      clearTimeout(busyTimer);
      st.setBusy(id, false);
      st.markBell(id);
    });

    // Right-click: copy the selection if there is one, otherwise paste.
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        term.clearSelection();
      } else {
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (text) term.paste(text);
          })
          .catch(() => {});
      }
    };
    host.addEventListener("contextmenu", onContextMenu);

    // Debounce resizes: a drag (or a panel toggle) fires a burst of resize
    // events, and resizing the PTY on each one makes the local ConPTY re-emit
    // its whole screen every time — duplicating/scrambling the scrollback.
    // Coalesce the burst into one fit once the size has settled.
    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(fitTimer);
      fitTimer = setTimeout(safeFit, 100);
    });
    // Observe the host (it moves with the terminal), not the panel wrapper.
    observer.observe(host);

    return () => {
      disposed = true;
      clearTimeout(fitTimer);
      clearTimeout(busyTimer);
      if (id) useAppStore.getState().setBusy(id, false);
      observer.disconnect();
      host.removeEventListener("contextmenu", onContextMenu);
      dataSub.dispose();
      resizeSub.dispose();
      titleSub.dispose();
      bellSub.dispose();
      if (unlisten) unlisten();
      if (ptyId) void ptyClose(ptyId);
      if (id) unregisterTerminalFocus(id);
      unregisterTerminal(term);
      termRef.current = null;
      fitRef.current = null;
      term.dispose();
      if (id) unregisterTerminalSlot(id, host);
      host.remove();
    };
  }, [connId]);

  // A terminal that was hidden (display:none) couldn't measure itself. Refit it
  // the moment it becomes the active tab — synchronously, after React has
  // committed display:block but *before* paint, so `fit()` measures the real
  // size (no 0x0 flicker) and the resulting onResize syncs the PTY dimensions.
  useLayoutEffect(() => {
    if (!active) return;
    const el = containerRef.current;
    if (
      useAppStore.getState().terminalVisible &&
      el &&
      el.clientWidth > 0 &&
      el.clientHeight > 0
    ) {
      try {
        fitRef.current?.fit();
      } catch {
        /* not measured yet — the ResizeObserver will catch up */
      }
    }
    termRef.current?.focus();
  }, [active]);

  return containerRef;
}
