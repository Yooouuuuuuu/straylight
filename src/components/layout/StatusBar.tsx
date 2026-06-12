/** Bottom status bar: connection state, current file path, language, encoding,
 *  line ending, and cursor position. */
import { useAppStore } from "../../store/appStore";
import type { ConnectionState } from "../../lib/ipc";

const STATE_TEXT: Record<ConnectionState, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
};

export function StatusBar() {
  const connection = useAppStore((s) => s.connection);
  const connState = useAppStore((s) => s.connState);
  const connMessage = useAppStore((s) => s.connMessage);
  const openFile = useAppStore((s) => s.openFile);
  const cursor = useAppStore((s) => s.cursor);
  const terminalVisible = useAppStore((s) => s.terminalVisible);
  const toggleTerminal = useAppStore((s) => s.toggleTerminal);

  return (
    <footer className="statusbar">
      <span className="statusbar__item" title={connMessage ?? undefined}>
        <span className={`dot dot--${connState}`} />
        {connection ? connection.name : "—"} · {STATE_TEXT[connState]}
      </span>

      {openFile && (
        <span className="statusbar__item statusbar__path" title={openFile.path}>
          {openFile.path}
        </span>
      )}

      <span className="statusbar__spacer" />

      {connection && (
        <span
          className="statusbar__item statusbar__item--button"
          onClick={() => toggleTerminal()}
          title="Toggle terminal (Ctrl+`)"
        >
          {terminalVisible ? "Hide terminal" : "Show terminal"}
        </span>
      )}

      {openFile && (
        <>
          <span className="statusbar__item">
            Ln {cursor.line}, Col {cursor.column}
          </span>
          <span className="statusbar__item">{openFile.lineEnding}</span>
          <span className="statusbar__item">
            {openFile.encoding.toUpperCase()}
          </span>
          <span className="statusbar__item">
            {openFile.isBinary ? "Binary" : prettyLanguage(openFile.language)}
          </span>
        </>
      )}
    </footer>
  );
}

function prettyLanguage(language: string): string {
  if (language === "plaintext") return "Plain Text";
  if (language === "cpp") return "C++";
  if (language === "csharp") return "C#";
  return language.charAt(0).toUpperCase() + language.slice(1);
}
