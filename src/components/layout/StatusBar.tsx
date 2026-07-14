/** Bottom status bar. LEFT: the panel buttons (Explorer · SC · Terminal ·
 *  Ports · Containers · Forwarding). RIGHT: everything about the active file —
 *  branch, path, cursor, line ending, encoding, language. Connection state
 *  lives on the host bars in the explorer, not here. */
import { useState } from "react";

import { setTabEol } from "../../lib/editorModels";
import { useAppStore } from "../../store/appStore";
import { useVcsStore } from "../../store/vcsStore";
import { IconBranch, IconFolder, IconTerminalGlyph } from "../icons";
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
  const wsl = useAppStore((s) => s.wsl);
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const toggleTerminal = useAppStore((s) => s.toggleTerminal);
  const vcsRepos = useVcsStore((s) => s.repos);
  const toggleScm = useVcsStore((s) => s.toggleScm);
  const setTabLineEnding = useAppStore((s) => s.setTabLineEnding);
  const [eolMenu, setEolMenu] = useState(false);

  const active = tabs.find((t) => t.id === activeTabId) ?? null;
  const eolSwitchable =
    active && (!active.kind || active.kind === "file") && !active.isBinary;

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
        <span
          className="statusbar__item statusbar__item--button statusbar__panel-btn"
          onClick={() => toggleScm()}
          title="Toggle Source Control"
        >
          <IconBranch size={13} /> SC
        </span>
      )}

      <span
        className="statusbar__item statusbar__item--button statusbar__panel-btn"
        onClick={() => toggleTerminal()}
        title="Toggle the terminal panel (Ctrl+`) — Ports/Containers/Forwarding live on its top bar"
      >
        <IconTerminalGlyph size={13} /> TERMINAL
      </span>

      {/* One dot per connection (WSL + every remote); state spelled out on
          hover only. WSL has no live state tracking yet (backlog) — its dot
          reads connected while attached. */}
      {wsl && (
        <Tip label={`${wsl.name} connected (${wsl.user}@${wsl.host})`}>
          <span className="statusbar__item statusbar__host">
            <span className="dot dot--connected" />
            {wsl.name}
          </span>
        </Tip>
      )}
      {remotes.map((r) => (
        <Tip
          key={r.conn.connId}
          label={`${r.conn.name} ${r.state} (${r.conn.user}@${r.conn.host})`}
        >
          <span className="statusbar__item statusbar__host">
            <span className={`dot dot--${r.state}`} />
            {r.conn.name}
          </span>
        </Tip>
      ))}

      <span className="statusbar__spacer" />

      <TransferProgressBar variant="status" />

      {activeRepo?.status && (
        <span
          className="statusbar__item"
          title={`${activeRepo.label} · ${activeRepo.status.ref}`}
        >
          ⑂ {activeRepo.status.ref}
          {activeRepo.status.ahead ? ` ↑${activeRepo.status.ahead}` : ""}
          {activeRepo.status.behind ? ` ↓${activeRepo.status.behind}` : ""}
        </span>
      )}

      {active && (
        <>
          <span className="statusbar__item statusbar__path" title={active.path}>
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
    </footer>
  );
}
