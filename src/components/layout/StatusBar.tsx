/** Bottom status bar. LEFT: the panel buttons (Explorer · SC · Terminal ·
 *  Sessions). RIGHT: an in-flight transfer, then everything about the active
 *  file — branch, path, cursor, line ending, encoding, language — then the
 *  bell. Connection state lives on the host bars in the explorer, not here.
 *
 *  Degradation is COLLISION-DRIVEN (measured, not window-width breakpoints):
 *  when the content overflows, a single `level` escalates and sheds items in
 *  priority order, de-escalating with exact hysteresis when the room returns.
 *    L1        panel buttons → icon-only (all at once, the moment they touch)
 *    L2…L7     file info, left→right: branch, path, Ln/Col, EOL, encoding, language
 *    L8…L11    transfer pieces, left→right: label, file-count, bytes, percent
 *  Never shed: the button icons, the transfer floor (rate · ETA · ✕), the bell. */
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { setTabEol } from "../../lib/editorModels";
import { tabHostColor } from "../../lib/hostColors";
import { uiConfig } from "../../lib/settings";
import { useAppStore } from "../../store/appStore";
import { useVcsStore } from "../../store/vcsStore";
import {
  IconBell,
  IconBranch,
  IconChatBubble,
  IconFolder,
  IconTerminalGlyph,
} from "../icons";
import { BellPop } from "../BellPop";
import { Tip } from "../Tooltip";
import { TransferProgressBar } from "../transfer/TransferProgressBar";

const MAX_LEVEL = 11;

function prettyLanguage(language: string): string {
  if (language === "plaintext") return "Plain Text";
  if (language === "cpp") return "C++";
  if (language === "csharp") return "C#";
  return language.charAt(0).toUpperCase() + language.slice(1);
}

export function StatusBar() {
  const localConnId = useAppStore((s) => s.localConnId);
  const remotes = useAppStore((s) => s.remotes);
  const wsls = useAppStore((s) => s.wsls);
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const toggleTerminal = useAppStore((s) => s.toggleTerminal);
  const toggleChat = useAppStore((s) => s.toggleChat);
  useAppStore((s) => s.settingsRev); // re-render when settings.json changes
  const terminalVisible = useAppStore((s) => s.terminalVisible);
  const chatVisible = useAppStore((s) => s.chatVisible);
  const terminals = useAppStore((s) => s.terminals);
  const belled = useAppStore((s) => s.belled);
  const noticeUnread = useAppStore((s) => s.noticeUnread);
  const bellOpen = useAppStore((s) => s.bellOpen);
  const setBellOpen = useAppStore((s) => s.setBellOpen);
  // Transfer presence + a coarse progress tick (every ~4 MB) so the bar
  // re-measures as the readout's width changes, without re-rendering per frame.
  const transferId = useAppStore((s) => s.activeTransfer?.id ?? null);
  const transferTick = useAppStore((s) =>
    s.activeTransfer ? Math.round(s.activeTransfer.doneBytes / 4_000_000) : -1,
  );

  // A bell in a HIDDEN home badges that home's button — visible homes show it
  // on the entry/dot itself. Suppressed-by-window-size counts as hidden.
  const suppressed = useAppStore((s) => s.suppressed);
  const bellInPanel =
    (!terminalVisible || suppressed.terminal) &&
    terminals.some((t) => !t.inChat && belled[t.id]);
  const bellInChat =
    (!chatVisible || suppressed.chat) &&
    terminals.some((t) => t.inChat && belled[t.id]);
  const vcsRepos = useVcsStore((s) => s.repos);
  const toggleScm = useVcsStore((s) => s.toggleScm);
  const setTabLineEnding = useAppStore((s) => s.setTabLineEnding);
  const [eolMenu, setEolMenu] = useState(false);

  const active = tabs.find((t) => t.id === activeTabId) ?? null;
  const eolSwitchable =
    active && (!active.kind || active.kind === "file") && !active.isBinary;

  // Host label + color for the active file's path (null for Local).
  const activeHost = active
    ? active.connId === localConnId
      ? null
      : (wsls.find((w) => w.conn.connId === active.connId)?.conn.name ??
        remotes.find((r) => r.conn.connId === active.connId)?.conn.name ??
        null)
    : null;
  const activeHostColor =
    activeHost && active ? tabHostColor(active.connId) : null;

  const pickEol = (eol: "LF" | "CRLF") => {
    setEolMenu(false);
    if (!active || active.lineEnding === eol) return;
    if (setTabEol(active.id, eol)) {
      setTabLineEnding(active.id, eol);
    } else {
      useAppStore
        .getState()
        .pushNotice("warn", "Open the file in the editor first to convert it.");
    }
  };

  // Contextual branch hint: the repo that owns the focused file (if tracked).
  const norm = (p: string) => p.replace(/\\/g, "/");
  const activeRepo =
    active != null
      ? vcsRepos.find(
          (r) =>
            r.connId === active.connId &&
            r.status != null &&
            norm(active.path).startsWith(norm(r.root).replace(/\/+$/, "") + "/"),
        )
      : undefined;

  // ---- Collision-driven degradation ----------------------------------------
  const barRef = useRef<HTMLElement>(null);
  const [level, setLevel] = useState(0);
  // marks[L] = the content width (scrollWidth) that overflowed when we
  // escalated TO level L; de-escalate only once the window is that wide again,
  // so re-showing the shed item can't immediately re-overflow (no flicker).
  const marks = useRef<Record<number, number>>({});
  const measure = useCallback(() => {
    const el = barRef.current;
    if (!el) return;
    setLevel((cur) => {
      if (el.scrollWidth > el.clientWidth + 1) {
        if (cur >= MAX_LEVEL) return cur;
        marks.current[cur + 1] = el.scrollWidth;
        return cur + 1;
      }
      if (cur > 0 && el.clientWidth + 1 >= (marks.current[cur] ?? Infinity)) {
        return cur - 1;
      }
      return cur;
    });
  }, []);

  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  // Re-measure whenever the level or the width-relevant content changes; each
  // level change re-runs this, cascading until it fits.
  const contentKey = [
    active?.path,
    active?.cursor.line,
    active?.cursor.column,
    active?.lineEnding,
    active?.encoding,
    active?.language,
    activeRepo?.status?.ref,
    activeRepo?.status?.ahead,
    activeRepo?.status?.behind,
    vcsRepos.length > 0 || localConnId ? 1 : 0,
    uiConfig.disableChat ? 0 : 1,
    transferId,
    transferTick,
  ].join("|");
  useLayoutEffect(() => {
    measure();
  }, [level, contentKey, measure]);

  const iconOnly = level >= 1;
  const showBranch = level < 2;
  const showPath = level < 3;
  const showCursor = level < 4;
  const showEol = level < 5;
  const showEncoding = level < 6;
  const showLanguage = level < 7;
  const transferShrink = Math.max(0, level - 7); // 0…4

  return (
    <footer ref={barRef} className={`statusbar${iconOnly ? " statusbar--slim" : ""}`}>
      {/* The four panel blocks label themselves — no tooltip. */}
      <span
        className="statusbar__item statusbar__item--button statusbar__panel-btn"
        onClick={() => useAppStore.getState().toggleSidebar()}
      >
        <IconFolder size={13} />
        <span className="statusbar__panel-label">EXPLORER</span>
      </span>

      {(vcsRepos.length > 0 || localConnId) && (
        <>
          <span className="statusbar__sep" />
          <span
            className="statusbar__item statusbar__item--button statusbar__panel-btn"
            onClick={() => toggleScm()}
          >
            <IconBranch size={13} />
            <span className="statusbar__panel-label">SC</span>
          </span>
        </>
      )}

      <span className="statusbar__sep" />
      <span
        className="statusbar__item statusbar__item--button statusbar__panel-btn"
        onClick={() => toggleTerminal()}
      >
        <IconTerminalGlyph size={13} />
        <span className="statusbar__panel-label">TERMINAL</span>
        {bellInPanel && <IconBell size={10} className="statusbar__panelbell" />}
      </span>

      {(!uiConfig.disableChat || terminals.some((t) => t.inChat)) && (
        <>
          <span className="statusbar__sep" />
          <span
            className="statusbar__item statusbar__item--button statusbar__panel-btn"
            onClick={() => toggleChat()}
          >
            <IconChatBubble size={13} />
            <span className="statusbar__panel-label">SESSIONS</span>
            {bellInChat && <IconBell size={10} className="statusbar__panelbell" />}
          </span>
        </>
      )}

      {/* Connection state deliberately does NOT live here — the title-bar
          gauge and the explorer host bars carry it; the bar stays about
          panels, in-flight work, and the active file. */}
      <span className="statusbar__spacer" />

      {/* In-flight transfer — sheds left-to-right but never below rate·ETA·✕. */}
      <TransferProgressBar variant="status" shrink={transferShrink} />

      {showBranch && activeRepo?.status && (
        <Tip label={`${activeRepo.label} · ${activeRepo.status.ref}`}>
          <span className="statusbar__item statusbar__branch">
            <IconBranch size={12} /> {activeRepo.status.ref}
            {activeRepo.status.ahead ? ` ↑${activeRepo.status.ahead}` : ""}
            {activeRepo.status.behind ? ` ↓${activeRepo.status.behind}` : ""}
          </span>
        </Tip>
      )}

      {active && (
        <>
          {showPath && (
            <Tip label={activeHost ? `${activeHost}: ${active.path}` : active.path}>
              <span className="statusbar__item statusbar__path">
                {/* Non-local files carry their host up front (local stays plain) —
                    two hosts' identical paths stop looking alike. */}
                {activeHost && (
                  <span
                    className="statusbar__pathhost"
                    style={activeHostColor ? { color: activeHostColor } : undefined}
                  >
                    {activeHost}:
                  </span>
                )}
                {active.path}
              </span>
            </Tip>
          )}
          {showCursor && (
            <span className="statusbar__item">
              Ln {active.cursor.line}, Col {active.cursor.column}
            </span>
          )}
          {showEol &&
            (eolSwitchable ? (
              <span className="statusbar__eol">
                <Tip label="Change line endings">
                  <span
                    className="statusbar__item statusbar__item--button"
                    onClick={() => setEolMenu((v) => !v)}
                  >
                    {active.lineEnding}
                  </span>
                </Tip>
                {eolMenu && (
                  <>
                    <div className="menu-backdrop" onClick={() => setEolMenu(false)} />
                    <div className="statusbar__eol-menu" role="menu">
                      <button className="terminal-menu__item" onClick={() => pickEol("LF")}>
                        LF <span className="terminal-menu__hint">\n · Unix</span>
                      </button>
                      <button className="terminal-menu__item" onClick={() => pickEol("CRLF")}>
                        CRLF <span className="terminal-menu__hint">\r\n · Windows</span>
                      </button>
                    </div>
                  </>
                )}
              </span>
            ) : (
              <span className="statusbar__item">{active.lineEnding}</span>
            ))}
          {showEncoding && (
            <span className="statusbar__item">{active.encoding.toUpperCase()}</span>
          )}
          {showLanguage && (
            <span className="statusbar__item">
              {active.isBinary ? "Binary" : prettyLanguage(active.language)}
            </span>
          )}
        </>
      )}

      <span className="statusbar__sep" />
      <Tip label="Notifications">
        <span
          className="statusbar__item statusbar__item--button statusbar__bell"
          onClick={() => setBellOpen(!bellOpen)}
        >
          <IconBell size={13} />
          {noticeUnread > 0 && <span className="statusbar__attn" />}
        </span>
      </Tip>
      <BellPop variant="status" />
    </footer>
  );
}
