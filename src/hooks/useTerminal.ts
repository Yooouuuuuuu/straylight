/** Wire an xterm.js terminal to a remote SSH PTY for the lifetime of a mount.
 *
 *  Output streams in over the `pty-output` event; input and resize go back out
 *  through the pty_* commands. The WebGL renderer is used when available and
 *  silently falls back to the DOM renderer otherwise. */
import { useEffect, useRef } from "react";

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
import { draculaTermTheme } from "../lib/xtermTheme";

export function useTerminal(connId: string | null) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!connId || !container) return;

    let disposed = false;
    let ptyId: string | null = null;
    let unlisten: UnlistenFn | null = null;
    const encoder = new TextEncoder();

    const term = new Terminal({
      fontFamily:
        "'Fira Code', 'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.1,
      cursorBlink: true,
      allowProposedApi: true,
      theme: draculaTermTheme,
      scrollback: 5000,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // No WebGL in this webview — the canvas/DOM renderer is used instead.
    }

    const safeFit = () => {
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
    void ptyOpen(connId, term.cols, term.rows)
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

    const observer = new ResizeObserver(() => safeFit());
    observer.observe(container);

    return () => {
      disposed = true;
      observer.disconnect();
      container.removeEventListener("contextmenu", onContextMenu);
      dataSub.dispose();
      resizeSub.dispose();
      if (unlisten) unlisten();
      if (ptyId) void ptyClose(ptyId);
      term.dispose();
    };
  }, [connId]);

  return containerRef;
}
