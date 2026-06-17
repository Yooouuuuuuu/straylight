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
import { draculaTermTheme } from "../lib/xtermTheme";
import { useAppStore } from "../store/appStore";

export function useTerminal(
  connId: string | null,
  active = true,
  command: string[] | null = null,
  id = "",
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!connId || !container) return;

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
    const isWindowsConpty =
      navigator.userAgent.includes("Windows") &&
      connId === useAppStore.getState().localConnId;
    const windowsPty = isWindowsConpty
      ? ({ backend: "conpty", buildNumber: 19045 } as const)
      : undefined;

    const term = new Terminal({
      fontFamily:
        "'Fira Code', 'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.1,
      cursorBlink: true,
      allowProposedApi: true,
      theme: draculaTermTheme,
      scrollback: 5000,
      windowsPty,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;
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
      // the whole buffer into it, wiping the scrollback.
      if (!useAppStore.getState().terminalVisible) return;
      if (!container.clientWidth || !container.clientHeight) return;
      try {
        fit.fit();
      } catch {
        /* container not measured yet */
      }
    };
    safeFit();

    // Forward backend PTY output to the terminal.
    void onPtyOutput((output) => {
      if (disposed || output.ptyId !== ptyId) return;
      if (output.data.length > 0) {
        term.write(new Uint8Array(output.data));
      }
    }).then((un) => {
      if (disposed) un();
      else unlisten = un;
    });

    // Open the PTY sized to the current terminal.
    void ptyOpen(connId, term.cols, term.rows, command)
      .then((id) => {
        if (disposed) {
          void ptyClose(id);
          return;
        }
        ptyId = id;
        term.focus();
      })
      .catch((error) => {
        term.writeln(`\r\n\x1b[31mFailed to open terminal: ${error}\x1b[0m`);
      });

    const dataSub = term.onData((data) => {
      if (ptyId) void ptyWrite(ptyId, encoder.encode(data));
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (ptyId) void ptyResize(ptyId, cols, rows);
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
    container.addEventListener("contextmenu", onContextMenu);

    // Debounce resizes: a drag (or a panel toggle) fires a burst of resize
    // events, and resizing the PTY on each one makes the local ConPTY re-emit
    // its whole screen every time — duplicating/scrambling the scrollback.
    // Coalesce the burst into one fit once the size has settled.
    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(fitTimer);
      fitTimer = setTimeout(safeFit, 100);
    });
    observer.observe(container);

    return () => {
      disposed = true;
      clearTimeout(fitTimer);
      observer.disconnect();
      container.removeEventListener("contextmenu", onContextMenu);
      dataSub.dispose();
      resizeSub.dispose();
      if (unlisten) unlisten();
      if (ptyId) void ptyClose(ptyId);
      if (id) unregisterTerminalFocus(id);
      termRef.current = null;
      fitRef.current = null;
      term.dispose();
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
