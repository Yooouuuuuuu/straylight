/** Bottom status bar. LEFT: the panel buttons (Explorer · SC · Terminal ·
 *  Ports · Containers · Forwarding). RIGHT: everything about the active file —
 *  branch, path, cursor, line ending, encoding, language. Connection state
 *  lives on the host bars in the explorer, not here. */
import { useAppStore } from "../../store/appStore";
import { useVcsStore } from "../../store/vcsStore";
import { IconBranch, IconFolder, IconTerminalGlyph } from "../icons";
import { TransferProgressBar } from "../transfer/TransferProgressBar";

function prettyLanguage(language: string): string {
  if (language === "plaintext") return "Plain Text";
  if (language === "cpp") return "C++";
  if (language === "csharp") return "C#";
  return language.charAt(0).toUpperCase() + language.slice(1);
}

export function StatusBar() {
  const localConnId = useAppStore((s) => s.localConnId);
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const toggleTerminal = useAppStore((s) => s.toggleTerminal);
  const vcsRepos = useVcsStore((s) => s.repos);
  const toggleScm = useVcsStore((s) => s.toggleScm);

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
