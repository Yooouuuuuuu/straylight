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
  IconFolder,
  IconTerminalGlyph,
} from "../icons";
import { BellPop } from "../BellPop";
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
  const noticeUnread = useAppStore((s) => s.noticeUnread);
  const bellOpen = useAppStore((s) => s.bellOpen);
  const setBellOpen = useAppStore((s) => s.setBellOpen);

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

  return (
    <footer className="statusbar">
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

      {/* Connected hosts, always listed (they matter). Each carries an ISSUE
          LIGHT: near-invisible while the host is fine, colored the moment
          something happens — a light that brightens is calmer than one that
          suddenly appears. The explorer host bars keep their full state dots. */}
      {wsls.length > 0 && (
        <span className="sb-group sb-d1">
          <span className="statusbar__sep" />
          <span className="statusbar__seclabel">WSL</span>
          {wsls.map((w) => (
            <Tip
              key={w.conn.connId}
              label={`${w.conn.name} ${w.state} (${w.conn.user}@${w.conn.host})`}
            >
              <span className="statusbar__item statusbar__host">
                <span
                  className={`dot ${w.state === "connected" ? "dot--fine" : `dot--${w.state}`}`}
                />
                {w.conn.user}
              </span>
            </Tip>
          ))}
        </span>
      )}
      {remotes.length > 0 && (
        <span className="sb-group sb-d2">
          <span className="statusbar__sep" />
          <span className="statusbar__seclabel">REMOTE</span>
          {remotes.map((r) => (
            <Tip
              key={r.conn.connId}
              label={`${r.conn.name} ${r.state} (${r.conn.user}@${r.conn.host})`}
            >
              <span className="statusbar__item statusbar__host">
                <span
                  className={`dot ${r.state === "connected" ? "dot--fine" : `dot--${r.state}`}`}
                />
                {r.conn.user}@{r.conn.host}
              </span>
            </Tip>
          ))}
        </span>
      )}

      <span className="statusbar__spacer" />

      <TransferProgressBar variant="status" />

      {activeRepo?.status && (
        <span className="sb-group sb-d3">
          <Tip label={`${activeRepo.label} · ${activeRepo.status.ref}`}>
            <span className="statusbar__item statusbar__branch">
              <IconBranch size={12} /> {activeRepo.status.ref}
              {activeRepo.status.ahead ? ` ↑${activeRepo.status.ahead}` : ""}
              {activeRepo.status.behind ? ` ↓${activeRepo.status.behind}` : ""}
            </span>
          </Tip>
        </span>
      )}

      {active && (
        <>
          <span className="sb-group sb-d4">
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
          </span>
          <span className="statusbar__item sb-d5">
            Ln {active.cursor.line}, Col {active.cursor.column}
          </span>
          {eolSwitchable ? (
            <span className="statusbar__eol sb-d6">
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
            <span className="statusbar__item sb-d6">{active.lineEnding}</span>
          )}
          <span className="statusbar__item sb-d7">
            {active.encoding.toUpperCase()}
          </span>
          <span className="statusbar__item sb-d8">
            {active.isBinary ? "Binary" : prettyLanguage(active.language)}
          </span>
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
