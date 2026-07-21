/** Bottom status bar. LEFT: the panel buttons (Explorer · SC · Terminal ·
 *  Ports · Containers · Forwarding). RIGHT: everything about the active file —
 *  branch, path, cursor, line ending, encoding, language. Connection state
 *  lives on the host bars in the explorer, not here. */
import { useState } from "react";

import { setTabEol } from "../../lib/editorModels";
import { tabHostColor } from "../../lib/hostColors";
import { uiConfig } from "../../lib/settings";
import { useAppStore } from "../../store/appStore";
import { useVcsStore } from "../../store/vcsStore";
import {
  IconBell,
  IconBranch,
  IconChatBubble,
  IconClose,
  IconCopy,
  IconFolder,
  IconTerminalGlyph,
} from "../icons";
import { RelativeTime } from "../RelativeTime";
import { Tip } from "../Tooltip";
import { TransferProgressBar } from "../transfer/TransferProgressBar";

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
  const noticeLog = useAppStore((s) => s.noticeLog);
  const noticeUnread = useAppStore((s) => s.noticeUnread);
  const bellOpen = useAppStore((s) => s.bellOpen);
  const setBellOpen = useAppStore((s) => s.setBellOpen);
  const clearNoticeLog = useAppStore((s) => s.clearNoticeLog);

  // A bell in a HIDDEN home badges that home's button — visible homes show it
  // on the entry/dot itself.
  const bellInPanel =
    !terminalVisible && terminals.some((t) => !t.inChat && belled[t.id]);
  const bellInChat =
    !chatVisible && terminals.some((t) => t.inChat && belled[t.id]);
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

  return (
    <footer className="statusbar">
      <span
        className="statusbar__item statusbar__item--button statusbar__panel-btn"
        onClick={() => useAppStore.getState().toggleSidebar()}
        title="Toggle the explorer (Ctrl+B)"
      >
        <IconFolder size={13} /> EXPLORER
      </span>

      {(vcsRepos.length > 0 || localConnId) && (
        <>
          <span className="statusbar__sep" />
          <span
            className="statusbar__item statusbar__item--button statusbar__panel-btn"
            onClick={() => toggleScm()}
            title="Toggle Source Control"
          >
            <IconBranch size={13} /> SC
          </span>
        </>
      )}

      <span className="statusbar__sep" />
      <span
        className="statusbar__item statusbar__item--button statusbar__panel-btn"
        onClick={() => toggleTerminal()}
        title="Toggle the terminal panel (Ctrl+`) — Ports/Containers/Forwarding live on its top bar"
      >
        <IconTerminalGlyph size={13} /> TERMINAL
        {bellInPanel && <IconBell size={10} className="statusbar__panelbell" />}
      </span>

      {(!uiConfig.disableChat || terminals.some((t) => t.inChat)) && (
        <>
          <span className="statusbar__sep" />
          <span
            className="statusbar__item statusbar__item--button statusbar__panel-btn"
            onClick={() => toggleChat()}
            title="Toggle CHAT — a terminal column for Claude Code or any CLI"
          >
            <IconChatBubble size={13} /> CHAT
            {bellInChat && <IconBell size={10} className="statusbar__panelbell" />}
          </span>
        </>
      )}

      {/* Connection dots, sectioned: WSL first, then remotes — a section only
          exists while something is connected. State spells out on hover. */}
      {wsls.length > 0 && (
        <>
          <span className="statusbar__sep" />
          <span className="statusbar__seclabel">WSL</span>
          {wsls.map((w) => (
            <Tip
              key={w.conn.connId}
              label={`${w.conn.name} ${w.state} (${w.conn.user}@${w.conn.host})`}
            >
              <span className="statusbar__item statusbar__host">
                <span className={`dot dot--${w.state}`} />
                {w.conn.user}
              </span>
            </Tip>
          ))}
        </>
      )}
      {remotes.length > 0 && (
        <>
          <span className="statusbar__sep" />
          <span className="statusbar__seclabel">REMOTE</span>
          {remotes.map((r) => (
            <Tip
              key={r.conn.connId}
              label={`${r.conn.name} ${r.state} (${r.conn.user}@${r.conn.host})`}
            >
              <span className="statusbar__item statusbar__host">
                <span className={`dot dot--${r.state}`} />
                {r.conn.user}@{r.conn.host}
              </span>
            </Tip>
          ))}
        </>
      )}

      <span className="statusbar__spacer" />

      <TransferProgressBar variant="status" />

      {activeRepo?.status && (
        <span
          className="statusbar__item statusbar__branch"
          title={`${activeRepo.label} · ${activeRepo.status.ref}`}
        >
          <IconBranch size={12} /> {activeRepo.status.ref}
          {activeRepo.status.ahead ? ` ↑${activeRepo.status.ahead}` : ""}
          {activeRepo.status.behind ? ` ↓${activeRepo.status.behind}` : ""}
        </span>
      )}

      {active && (
        <>
          <span
            className="statusbar__item statusbar__path"
            title={activeHost ? `${activeHost}: ${active.path}` : active.path}
          >
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
          <span className="statusbar__item">
            Ln {active.cursor.line}, Col {active.cursor.column}
          </span>
          {eolSwitchable ? (
            <span className="statusbar__eol">
              <span
                className="statusbar__item statusbar__item--button"
                title="Change line endings (converts the file; save to keep it)"
                onClick={() => setEolMenu((v) => !v)}
              >
                {active.lineEnding}
              </span>
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
          )}
          <span className="statusbar__item">
            {active.encoding.toUpperCase()}
          </span>
          <span className="statusbar__item">
            {active.isBinary ? "Binary" : prettyLanguage(active.language)}
          </span>
        </>
      )}

      <span className="statusbar__sep" />
      <span
        className="statusbar__item statusbar__item--button statusbar__bell"
        onClick={() => setBellOpen(!bellOpen)}
        title="Notifications — every toast lands here after it fades"
      >
        <IconBell size={13} />
        {noticeUnread > 0 && <span className="statusbar__attn" />}
      </span>
      {bellOpen && (
        <>
          <div className="menu-backdrop" onClick={() => setBellOpen(false)} />
          <div className="bell-pop">
            <div className="bell-pop__head">
              <span>Notifications</span>
              <span className="bell-pop__spacer" />
              {noticeLog.length > 0 && (
                <button
                  className="bell-pop__clear"
                  onClick={() => clearNoticeLog()}
                >
                  Clear all
                </button>
              )}
              <button
                className="icon-btn"
                title="Close"
                onClick={() => setBellOpen(false)}
              >
                <IconClose size={11} />
              </button>
            </div>
            {noticeLog.length === 0 ? (
              <div className="bell-pop__empty">
                Nothing yet — toasts land here after they fade.
              </div>
            ) : (
              <div className="bell-pop__list">
                {noticeLog.map((n) => (
                  <div key={n.id} className={`bell-pop__item bell-pop__item--${n.kind}`}>
                    {/* Selectable AND one-click copyable — error texts get
                        pasted into searches and bug reports. */}
                    <span className="bell-pop__text">{n.text}</span>
                    <button
                      className="icon-btn bell-pop__copy"
                      title="Copy message"
                      onClick={() =>
                        void navigator.clipboard.writeText(n.text).catch(() => {})
                      }
                    >
                      <IconCopy size={12} />
                    </button>
                    <span className="bell-pop__time">
                      <RelativeTime at={n.time} title={null} />
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </footer>
  );
}
