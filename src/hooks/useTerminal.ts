/** Wire an xterm.js terminal to a remote SSH PTY for the lifetime of a mount.
 *
 *  Output streams in over the `pty-output` event; input and resize go back out
 *  through the pty_* commands. The WebGL renderer is used when available and
 *  silently falls back to the DOM renderer otherwise. */
import { useEffect, useLayoutEffect, useRef } from "react";

import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { readText } from "@tauri-apps/plugin-clipboard-manager";

import {
  onPtyOutput,
  ptyClose,
  ptyOpen,
  ptyResize,
  ptyWrite,
  setPtyOwner,
  takeSessionReplay,
  windowsBuildNumber,
} from "../lib/ipc";
import { isPassthroughShortcut } from "../lib/shortcuts";
import { terminalScrollback } from "../lib/settings";
import {
  registerTerminalFit,
  registerTerminalFocus,
  registerTerminalInput,
  registerTerminalSerialize,
  registerTerminalText,
  unregisterTerminalFit,
  unregisterTerminalFocus,
  unregisterTerminalInput,
  unregisterTerminalSerialize,
  unregisterTerminalText,
} from "../lib/terminalFocus";
import {
  registerTerminalSlot,
  unregisterTerminalSlot,
} from "../lib/terminalSlots";
import { refreshTreesOnIdle } from "../lib/treeWatch";
import {
  currentTermFont,
  currentTermTheme,
  registerTerminal,
  unregisterTerminal,
} from "../lib/themes";
import { useAppStore } from "../store/appStore";

/** Decode a pty-output payload: base64 → bytes (see PtyOutput in ipc.ts —
 *  the number-array envelope cost 3-4x on both serialize and parse). */
function b64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// The real Windows build, for xterm's ConPTY heuristics — modern Win11 ConPTY
// reflows natively on resize; older builds need xterm's compensation. Fetched
// once; until (or unless) it lands, the safe Win10 build is assumed.
let winBuild = 19045;
void windowsBuildNumber()
  .then((b) => {
    if (b > 0) winBuild = b;
    // Verifiable in DevTools (Ctrl+Shift+I) — cross-check against
    // `[Environment]::OSVersion.Version.Build` in pwsh.
    console.info(
      `[straylight] windows build ${b || "unknown"} → conpty buildNumber ${winBuild}`,
    );
  })
  .catch(() => {});

export function useTerminal(
  connId: string | null,
  active = true,
  command: string[] | null = null,
  id = "",
  initialInput: string | null = null,
  scriptedInput: { text: string; delayMs: number }[] | null = null,
  locked = false,
  // Dedicated session-lane connection carrying the PTY (null = connId). Only
  // the PTY rides it — theme, host color, and tree refresh stay on connId.
  ptyConnId: string | null = null,
  // ATTACH mode (sessions pop-out, docs/dev/multi-window.md): when set, this view
  // re-attaches to an ALREADY-OPEN backend PTY instead of opening its own — no
  // `pty_open`, and crucially no `pty_close` on unmount (the shell is owned by
  // another window and must survive). Null = normal owning behavior (unchanged).
  attachPtyId: string | null = null,
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
    // In attach mode the PTY id is known up front (we're re-attaching to it), so
    // the output filter below matches immediately; otherwise it's set once our
    // own `pty_open` resolves.
    let ptyId: string | null = attachPtyId;
    let unlisten: UnlistenFn | null = null;
    const encoder = new TextEncoder();
    const scriptTimers: number[] = [];
    // The serialize addon captures alt-screen/mouse/paste modes but NOT cursor
    // visibility (DECTCEM `?25`), so we track it ourselves from the stream and
    // append it to the serialized state — otherwise a re-attaching view shows a
    // stray cursor over a full-screen TUI that hid it (docs/dev/multi-window.md).
    let cursorHidden = false;
    const scanCursorMode = (data: ArrayLike<number>) => {
      for (let i = data.length - 6; i >= 0; i--) {
        if (
          data[i] === 0x1b && // ESC
          data[i + 1] === 0x5b && // [
          data[i + 2] === 0x3f && // ?
          data[i + 3] === 0x32 && // 2
          data[i + 4] === 0x35 // 5
        ) {
          if (data[i + 5] === 0x6c) cursorHidden = true; // ?25l — hide
          else if (data[i + 5] === 0x68) cursorHidden = false; // ?25h — show
          break; // last one in the chunk wins
        }
      }
    };

    // ConPTY (Windows local & WSL terminals) needs xterm's windows-pty
    // heuristics, or resize reflow drops/duplicates scrollback lines. SSH
    // terminals are real remote PTYs and must NOT use it. The REAL build
    // number is passed (fetched above): modern Win11 ConPTY gets native
    // reflow, older builds get the safe compensation.
    const appState = useAppStore.getState();
    const isWindowsConpty =
      navigator.userAgent.includes("Windows") && connId === appState.localConnId;
    const windowsPty = isWindowsConpty
      ? ({ backend: "conpty", buildNumber: winBuild } as const)
      : undefined;
    const font = currentTermFont();

    const term = new Terminal({
      fontFamily: font.family,
      fontSize: font.size,
      lineHeight: 1.1,
      cursorBlink: true,
      allowProposedApi: true,
      // One scheme for every shell; the host's identity colors the cursor +
      // selection (terminalHostColor).
      theme: currentTermTheme(connId),
      // Lines kept per terminal (settings `terminalScrollback`, default 5000)
      // — the main RAM knob for many-terminal sessions; applied live to open
      // terminals by the theme layer when settings change.
      scrollback: terminalScrollback,
      windowsPty,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    // Serialize full state (buffer + scrollback + modes + cursor + alt-screen) so
    // a re-attaching view in another window can reconstruct a TUI exactly
    // (docs/dev/multi-window.md).
    const serializeAddon = new SerializeAddon();
    term.loadAddon(serializeAddon);
    term.open(host);
    termRef.current = term;
    // Re-themed (and refit on font changes) live when settings.json changes.
    registerTerminal(term, { connId, refit: () => fit.fit() });
    fitRef.current = fit;
    if (id) registerTerminalFocus(id, () => term.focus());
    if (id)
      registerTerminalSerialize(
        id,
        () => serializeAddon.serialize() + (cursorHidden ? "\x1b[?25l" : "\x1b[?25h"),
      );
    // Serialize the buffer (last ~400 lines) on demand — the usage probe reads
    // this to tell a rendered /usage panel from a "command not found".
    if (id)
      registerTerminalText(id, () => {
        const buf = term.buffer.active;
        const from = Math.max(0, buf.length - 400);
        let out = "";
        for (let i = from; i < buf.length; i++) {
          out += (buf.getLine(i)?.translateToString(true) ?? "") + "\n";
        }
        return out;
      });

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

    // WebGL renderer only while VISIBLE (docs/dev/code-scan-2026-08.md B1):
    // each WebglAddon is its own WebGL context + glyph atlas, and the webview
    // caps ~16 contexts per page — past that the OLDEST context is lost and
    // that terminal silently drops to the slower DOM renderer forever.
    // Attaching the addon only while the host is on screen keeps 1-3 contexts
    // live no matter how many terminals exist, every visible terminal always
    // gets the fast renderer, and a lost context self-heals on the next show.
    // The linger avoids atlas churn while flipping between tabs.
    let webgl: WebglAddon | null = null;
    let webglLinger: ReturnType<typeof setTimeout> | undefined;
    const attachWebgl = () => {
      if (webgl || disposed) return;
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          addon.dispose();
          if (webgl === addon) webgl = null; // re-acquired on the next show
        });
        term.loadAddon(addon);
        webgl = addon;
      } catch {
        // No WebGL in this webview — the canvas/DOM renderer is used instead.
      }
    };
    const detachWebgl = () => {
      webgl?.dispose();
      webgl = null;
    };
    // The host is watched, not app flags: intersection goes false for every
    // hide route (inactive tab, collapsed panel, hidden column, popped away)
    // and survives the FocusView/ChatPanel reparenting.
    const vis = new IntersectionObserver((entries) => {
      const shown = entries.some((e) => e.isIntersecting);
      clearTimeout(webglLinger);
      if (shown) attachWebgl();
      else webglLinger = setTimeout(detachWebgl, 5000);
    });
    vis.observe(host);
    // Seed synchronously so the active terminal never paints its first frames
    // on the DOM renderer waiting for the observer's initial callback.
    if (host.clientWidth > 0) attachWebgl();

    const safeFit = () => {
      // GEOMETRY gate, not app flags. (The old chatVisible/terminalVisible
      // checks mis-modeled F11 and the sessions pop-out — an agent fits into
      // the focus pane with the chat COLUMN hidden — leaving terminals at a
      // stale width, docs/dev/code-scan-2026-08.md.) A hidden host measures
      // 0×0 and a collapsed panel leaves only its padding, so a minimum-size
      // check reads the truth off the element in every layout: fitting under
      // it would resize the PTY to ~1 row and ConPTY would reflow the whole
      // buffer into it, wiping the scrollback.
      if (host.clientWidth < 40 || host.clientHeight < 40) return;
      // Preserve bottom-follow: a fit whose row count changes can unpin the
      // viewport a few lines; over an always-on day those drifts accumulate
      // into "my terminal is scrolled up". If the user was at the bottom
      // before the fit, keep them there.
      const buf = term.buffer.active;
      const atBottom = buf.viewportY >= buf.baseY;
      try {
        fit.fit();
      } catch {
        return; /* container not measured yet */
      }
      if (atBottom) term.scrollToBottom();
    };
    safeFit();
    // Reparent sites (FocusView / ChatPanel) refit deterministically right
    // after moving the host — no ResizeObserver-debounce roulette.
    if (id) registerTerminalFit(id, safeFit);

    // "Running" indicator: a shell producing output is busy (Claude Code
    // updating its status counts). Cleared after a short idle so the dot goes
    // back to blank/done. Coalesced to transitions to avoid per-chunk writes.
    // NOTE: output must NOT clear a pending "your turn" bell — the BEL arrives
    // mid-burst (Claude rings, then keeps rendering the response and prompt
    // box), so trailing chunks would wipe the green milliseconds after it lit.
    // The bell clears when the user types instead (onData below).
    // "busy" = output flowing (any redraw counts). "thinking" = busy that has
    // been SUSTAINED — output must keep coming for BOTH a chunk count AND a
    // time span within one active window. A tool streaming a response clears
    // both; a one-shot repaint (focus / resize / Ctrl+±) is a fast burst that
    // clears neither, so thinking never flickers on interaction. (The finish
    // time is stamped when the spell ends / on the BEL, not here.)
    const THINK_CHUNKS = 14;
    const THINK_SUSTAIN_MS = 1500;
    let busyTimer: ReturnType<typeof setTimeout> | undefined;
    let chunkCount = 0;
    let busyStart = 0;
    const markBusy = () => {
      if (!id) return;
      const st = useAppStore.getState();
      const now = Date.now();
      if (!st.busy[id]) {
        st.setBusy(id, true);
        busyStart = now;
      }
      chunkCount += 1;
      if (chunkCount >= THINK_CHUNKS && now - busyStart > THINK_SUSTAIN_MS) {
        st.setThinking(id, true);
      }
      clearTimeout(busyTimer);
      busyTimer = setTimeout(() => {
        chunkCount = 0;
        busyStart = 0;
        const s = useAppStore.getState();
        s.setBusy(id, false);
        s.setThinking(id, false);
        // Output just stopped — the command that ran likely changed files.
        // WSL/remote trees have no watcher, so freshen them here (throttled;
        // local is covered by the real watcher).
        refreshTreesOnIdle(connId);
      }, 1200);
    };

    // Forward backend PTY output to the terminal. An EMPTY chunk is the
    // backend's "this PTY closed" signal — the shell exited.
    void onPtyOutput((output) => {
      if (disposed || output.ptyId !== ptyId) return;
      if (output.data.length > 0) {
        const bytes = b64Bytes(output.data);
        term.write(bytes);
        scanCursorMode(bytes);
        markBusy();
      } else if (id) {
        clearTimeout(busyTimer);
        chunkCount = 0;
        useAppStore.getState().setBusy(id, false);
        useAppStore.getState().setThinking(id, false);
        useAppStore.getState().setPtyDead(id, true);
      }
    }).then((un) => {
      if (disposed) un();
      else unlisten = un;
    });

    if (attachPtyId) {
      // Attach to an already-open backend PTY (sessions pop-out): output is
      // already subscribed above (ptyId was preset to it), so we neither open a
      // PTY nor run fresh-shell scripting. Input leaves by the same registered
      // path the owning branch uses below.
      if (!document.querySelector(".modal-overlay")) term.focus();
      // This window now renders it → claim its output (targeted emit); a brief
      // overlap with the releasing window during a pop is fine (last claim wins).
      void setPtyOwner(attachPtyId);
      // Reconstruct the session in this fresh view. A full-screen TUI (htop/vim)
      // sets its modes (alt-screen, hidden cursor) ONCE at startup and then only
      // sends cell updates, so a bare attach shows a live-but-broken screen
      // (cursor stuck, flashing). The releasing window stashed a full serialized
      // state; replay it to restore modes + cursor + screen exactly. The
      // ResizeObserver then fits us to this pane and the app repaints at our size
      // (docs/dev/multi-window.md).
      if (id) {
        void takeSessionReplay(id).then((data) => {
          if (!data || disposed) return;
          // Land the replay at the FINAL size: by the time this IPC round
          // trip resolves the reparent (FocusView) has run, so fit first —
          // PTY and xterm at this pane's cols BEFORE old-width content
          // writes — then pin to the bottom (a fresh attach shows the
          // latest, and replayed content never leaves the view scrolled up).
          safeFit();
          term.write(data, () => term.scrollToBottom());
          // Seed cursor tracking from the replay — it arrives via this direct
          // write, not the live stream scanned above — so a later re-stash on
          // pop-back keeps the right cursor state.
          const hide = data.lastIndexOf("\x1b[?25l");
          const show = data.lastIndexOf("\x1b[?25h");
          if (hide !== show) cursorHidden = hide > show;
        });
        registerTerminalInput(id, (data) => {
          if (!disposed && ptyId) void ptyWrite(ptyId, encoder.encode(data));
        });
      }
    }

    // Open the PTY sized to the current terminal (on the session lane when this
    // agent has one). Skipped in attach mode — the shell already exists.
    if (!attachPtyId) {
      void ptyOpen(ptyConnId ?? connId, term.cols, term.rows, command)
        .then((openedId) => {
          if (disposed) {
            void ptyClose(openedId);
            return;
          }
          ptyId = openedId;
          // A fresh PTY (first open or an epoch restart) is alive again. Record
          // its id on the session so a re-attaching view (sessions pop-out) can
          // find this same shell (docs/dev/multi-window.md).
          if (id) {
            useAppStore.getState().setPtyDead(id, false);
            useAppStore.getState().setTerminalPtyId(id, openedId);
          }
          // This window renders it → claim its output (targeted emit, not broadcast).
          void setPtyOwner(openedId);
          // Take focus for an interactively opened shell — but never yank it
          // out of an open dialog (session restore opens WSL/remote terminals
          // while the user may be typing a password).
          if (!document.querySelector(".modal-overlay")) term.focus();
          // Type the requested command into the fresh shell (e.g. a container
          // exec from the Containers tab) — visible and cancelable like any input.
          if (initialInput) {
            void ptyWrite(openedId, encoder.encode(`${initialInput}\r`));
          }
          // Let external actions (the usage probe's Esc + /usage refresh) write
          // into this live PTY by id.
          if (id) {
            registerTerminalInput(id, (data) => {
              if (!disposed && ptyId) {
                void ptyWrite(ptyId, encoder.encode(data));
              }
            });
          }
          // Timed keystrokes (the usage probe's claude / trust-prompt enters /
          // /usage) — delays measured from PTY-open, generous for slow machines.
          // Cancelled with the terminal.
          for (const step of scriptedInput ?? []) {
            scriptTimers.push(
              window.setTimeout(() => {
                if (!disposed && ptyId) {
                  void ptyWrite(ptyId, encoder.encode(step.text));
                }
              }, step.delayMs),
            );
          }
        })
        .catch((error) => {
          term.writeln(`\r\n\x1b[31mFailed to open terminal: ${error}\x1b[0m`);
          if (id) useAppStore.getState().setPtyDead(id, true);
        });
    }

    const dataSub = term.onData((data) => {
      // A locked terminal (usage probe) is display-only — drop the keyboard.
      if (locked) return;
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
      chunkCount = 0;
      st.setBusy(id, false);
      st.setThinking(id, false);
      st.markBell(id); // stamps finishedAt + belled (unread / your turn)
      // A bell is also a completion signal (Claude finishing a task that
      // edited files) — same tree freshen as the idle transition.
      refreshTreesOnIdle(connId);
    });

    // Right-click: copy the selection if there is one, otherwise paste.
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        term.clearSelection();
      } else {
        void readText()
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
      clearTimeout(webglLinger);
      vis.disconnect();
      for (const t of scriptTimers) clearTimeout(t);
      if (id) useAppStore.getState().setBusy(id, false);
      observer.disconnect();
      host.removeEventListener("contextmenu", onContextMenu);
      dataSub.dispose();
      resizeSub.dispose();
      titleSub.dispose();
      bellSub.dispose();
      if (unlisten) unlisten();
      // The view NEVER closes the PTY on unmount — a terminal's shell outlives
      // its view (docs/dev/multi-window.md): popping the sessions out, or moving
      // them back, just tears down and re-creates views on the same live shells.
      // `closeTerminal` and `restartConnTerminals` own the close; this teardown
      // only disposes the xterm and its listeners.
      if (id) unregisterTerminalFocus(id);
      if (id) unregisterTerminalFit(id);
      if (id) unregisterTerminalInput(id);
      if (id) unregisterTerminalText(id);
      if (id) unregisterTerminalSerialize(id);
      unregisterTerminal(term);
      termRef.current = null;
      fitRef.current = null;
      term.dispose();
      if (id) unregisterTerminalSlot(id, host);
      host.remove();
    };
    // attachPtyId is intentionally NOT a dep: it's captured at mount so a fresh
    // open (which sets the session's ptyId) can't retrigger this effect into a
    // re-attach. A restart bumps `epoch`, which remounts the whole view, and a
    // pop-out/back remounts it too — so re-attach always rides a remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, ptyConnId]);

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
