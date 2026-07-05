/** Bottom status bar: connection state, current file path, language, encoding,
 *  line ending, and cursor position (for the active tab). */
import { useAppStore } from "../../store/appStore";
import { useVcsStore } from "../../store/vcsStore";
import { useSSH } from "../../hooks/useSSH";
import type { ConnectionState } from "../../lib/ipc";
import { TransferProgressBar } from "../transfer/TransferProgressBar";

const STATE_TEXT: Record<ConnectionState, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
};

function prettyLanguage(language: string): string {
  if (language === "plaintext") return "Plain Text";
  if (language === "cpp") return "C++";
  if (language === "csharp") return "C#";
  return language.charAt(0).toUpperCase() + language.slice(1);
}

export function StatusBar() {
  const remote = useAppStore((s) => s.remote);
  const localConnId = useAppStore((s) => s.localConnId);
  const connState = useAppStore((s) => s.connState);
  const connMessage = useAppStore((s) => s.connMessage);
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const terminalVisible = useAppStore((s) => s.terminalVisible);
  const toggleTerminal = useAppStore((s) => s.toggleTerminal);
  const vcsRepos = useVcsStore((s) => s.repos);
  const toggleScm = useVcsStore((s) => s.toggleScm);
  const setPortsOpen = useAppStore((s) => s.setPortsOpen);
  const { reconnect } = useSSH();

  const active = tabs.find((t) => t.id === activeTabId) ?? null;

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
      <span className="statusbar__item" title={connMessage ?? undefined}>
        {remote ? (
          <>
            <span className={`dot dot--${connState}`} />
            {remote.name} · {STATE_TEXT[connState]}
          </>
        ) : (
          <>
            <span className="dot dot--local" />
            Local
          </>
        )}
      </span>

      {remote && connState === "disconnected" && (
        <span
          className="statusbar__item statusbar__item--button"
          onClick={() => void reconnect()}
          title="Reconnect to the server"
        >
          Reconnect
        </span>
      )}

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
        <span className="statusbar__item statusbar__path" title={active.path}>
          {active.path}
        </span>
      )}

      <span className="statusbar__spacer" />

      <TransferProgressBar variant="status" />

      {(vcsRepos.length > 0 || localConnId) && (
        <span
          className="statusbar__item statusbar__item--button"
          onClick={() => toggleScm()}
          title="Toggle Source Control"
        >
          Source Control
        </span>
      )}

      <span
        className="statusbar__item statusbar__item--button"
        onClick={() => useAppStore.getState().setPaletteOpen(true)}
        title="All commands (Ctrl+Shift+P)"
      >
        ⌘ Commands
      </span>

      <span
        className="statusbar__item statusbar__item--button"
        onClick={() => setPortsOpen(true)}
        title="Forward a port over SSH"
      >
        Ports
      </span>

      {(remote || localConnId) && (
        <span
          className="statusbar__item statusbar__item--button"
          onClick={() => toggleTerminal()}
          title="Toggle terminal (Ctrl+`)"
        >
          {terminalVisible ? "Hide terminal" : "Show terminal"}
        </span>
      )}

      {active && (
        <>
          <span className="statusbar__item">
            Ln {active.cursor.line}, Col {active.cursor.column}
          </span>
          <span className="statusbar__item">{active.lineEnding}</span>
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
