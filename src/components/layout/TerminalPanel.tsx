/** Bottom terminal panel, VS Code style: the active terminal fills the left, a
 *  vertical list of terminal instances sits on the right. The "+" opens a new
 *  terminal on the current workspace; its caret opens a shell-profile menu
 *  (PowerShell / cmd / Git Bash / WSL distros / the remote login shell). */
import { useEffect, useState } from "react";

import { listTerminalProfiles, type TerminalProfile } from "../../lib/ipc";
import { pickTerminalTarget } from "../../lib/terminalTarget";
import { useAppStore } from "../../store/appStore";
import { ContainersView } from "../terminal/ContainersView";
import { Terminal } from "../terminal/Terminal";
import { IconClose, IconPlus } from "../icons";

const TARGET_OPTIONS = ["auto", "remote", "wsl", "local"] as const;
const TARGET_LABELS: Record<(typeof TARGET_OPTIONS)[number], string> = {
  auto: "Auto",
  remote: "Remote",
  wsl: "WSL",
  local: "Local",
};

export function TerminalPanel() {
  const remote = useAppStore((s) => s.remote);
  const wsl = useAppStore((s) => s.wsl);
  const localConnId = useAppStore((s) => s.localConnId);
  const terminals = useAppStore((s) => s.terminals);
  const activeTerminalId = useAppStore((s) => s.activeTerminalId);
  const openTerminal = useAppStore((s) => s.openTerminal);
  const closeTerminal = useAppStore((s) => s.closeTerminal);
  const setActiveTerminal = useAppStore((s) => s.setActiveTerminal);
  const setTerminalVisible = useAppStore((s) => s.setTerminalVisible);
  const newTerminalTarget = useAppStore((s) => s.newTerminalTarget);
  const setNewTerminalTarget = useAppStore((s) => s.setNewTerminalTarget);
  const terminalView = useAppStore((s) => s.terminalView);
  const setTerminalView = useAppStore((s) => s.setTerminalView);
  const moveTerminalToEditor = useAppStore((s) => s.moveTerminalToEditor);
  // Terminals living in the editor area stay mounted here (their xterm DOM is
  // reparented into the editor pane) but leave the panel's tab list.
  const panelTerminals = terminals.filter((t) => !t.inEditor);

  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    let active = true;
    listTerminalProfiles()
      .then((p) => {
        if (active) setProfiles(p);
      })
      .catch(() => {
        /* no profiles — the + still opens the default shell */
      });
    return () => {
      active = false;
    };
  }, []);

  const newDefault = () => {
    const target = pickTerminalTarget();
    if (target) {
      openTerminal(target.connId, target.label);
      setTerminalVisible(true);
    }
  };

  const openProfile = (p: TerminalProfile) => {
    setMenuOpen(false);
    if (localConnId) openTerminal(localConnId, p.label, p.command);
  };

  const openRemoteShell = () => {
    setMenuOpen(false);
    if (remote) openTerminal(remote.connId, remote.name);
  };

  const openWslShell = () => {
    setMenuOpen(false);
    if (wsl) openTerminal(wsl.connId, wsl.name);
  };

  return (
    <div className="terminal-panel">
      <div className="terminal-panel__body">
        {terminalView === "containers" && <ContainersView />}
        {panelTerminals.length === 0 && terminalView === "terminals" ? (
          <div className="terminal-message">No terminals — click + to start one.</div>
        ) : (
          terminals.map((t) => (
            <div
              key={t.id}
              className="terminal-instance"
              style={{
                display:
                  terminalView === "terminals" &&
                  t.id === activeTerminalId &&
                  !t.inEditor
                    ? "block"
                    : "none",
              }}
            >
              <Terminal
                key={`${t.id}:${t.epoch}`}
                id={t.id}
                connId={t.connId}
                active={terminalView === "terminals" && t.id === activeTerminalId}
                command={t.command}
                initialInput={t.initialInput ?? null}
              />
            </div>
          ))
        )}
      </div>

      <div className="terminal-sidebar">
        <div className="terminal-sidebar__actions">
          <div className="terminal-new">
            <button
              className="icon-btn"
              title="New terminal (Ctrl+Shift+`)"
              onClick={newDefault}
            >
              <IconPlus size={15} />
            </button>
            <button
              className="icon-btn terminal-new__caret"
              title="Select a shell…"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              ▾
            </button>
          </div>
          <button
            className="icon-btn"
            title="Hide terminal (Ctrl+`)"
            onClick={() => setTerminalVisible(false)}
          >
            <IconClose />
          </button>
        </div>

        {menuOpen && (
          <>
            <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
            <div className="terminal-menu" role="menu">
              {remote && (
                <>
                  <button className="terminal-menu__item" onClick={openRemoteShell}>
                    {remote.name}
                    <span className="terminal-menu__hint">remote</span>
                  </button>
                  <div className="terminal-menu__sep" />
                </>
              )}
              {wsl && (
                <>
                  <button className="terminal-menu__item" onClick={openWslShell}>
                    {wsl.name}
                    <span className="terminal-menu__hint">WSL</span>
                  </button>
                  <div className="terminal-menu__sep" />
                </>
              )}
              {profiles.length === 0 ? (
                <div className="terminal-menu__empty">No local shells found</div>
              ) : (
                profiles.map((p) => (
                  <button
                    key={p.id}
                    className="terminal-menu__item"
                    onClick={() => openProfile(p)}
                  >
                    {p.label}
                  </button>
                ))
              )}
              <div className="terminal-menu__sep" />
              <div className="terminal-menu__pref">
                <span className="terminal-menu__pref-label">New opens</span>
                {TARGET_OPTIONS.map((opt) => (
                  <button
                    key={opt}
                    className={`terminal-menu__pref-btn${newTerminalTarget === opt ? " terminal-menu__pref-btn--active" : ""}`}
                    title={
                      opt === "auto" ? "remote → WSL → local" : `Prefer ${opt}`
                    }
                    onClick={() => setNewTerminalTarget(opt)}
                  >
                    {TARGET_LABELS[opt]}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        <div className="terminal-sidebar__list" role="tablist">
          <div
            role="tab"
            aria-selected={terminalView === "containers"}
            className={`terminal-entry${terminalView === "containers" ? " terminal-entry--active" : ""}`}
            title="Running containers (podman / docker) — click one to shell in"
            onClick={() => setTerminalView("containers")}
          >
            <span className="terminal-entry__label">▣ Containers</span>
          </div>
          {panelTerminals.map((t) => (
            <div
              key={t.id}
              role="tab"
              aria-selected={t.id === activeTerminalId}
              className={`terminal-entry${t.id === activeTerminalId ? " terminal-entry--active" : ""}`}
              title={t.title}
              onClick={() => setActiveTerminal(t.id)}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeTerminal(t.id);
                }
              }}
            >
              <span className="terminal-entry__label">{t.title}</span>
              <button
                className="terminal-entry__close terminal-entry__move"
                title="Move to the editor area (the shell keeps running)"
                onClick={(e) => {
                  e.stopPropagation();
                  moveTerminalToEditor(t.id);
                }}
              >
                ⇱
              </button>
              <button
                className="terminal-entry__close"
                title="Close terminal"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTerminal(t.id);
                }}
              >
                <IconClose size={11} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
