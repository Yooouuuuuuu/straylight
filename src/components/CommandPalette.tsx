/** The command palette (Ctrl+Shift+P): every command, fuzzy-searchable, with
 *  its effective keybinding (overrides included). Opened empty it lists
 *  everything — it doubles as the "menu" for anything without a button. A
 *  broken settings.json shows a warning row that opens the file. */
import { useEffect, useMemo, useRef, useState } from "react";
import Fuse from "fuse.js";

import { allCommands, commandKeyLabel, type Command } from "../lib/commands";
import { useAppStore } from "../store/appStore";

export function CommandPalette() {
  const open = useAppStore((s) => s.paletteOpen);
  const setOpen = useAppStore((s) => s.setPaletteOpen);
  if (!open) return null;
  return <PaletteModal onClose={() => setOpen(false)} />;
}

function PaletteModal({ onClose }: { onClose: () => void }) {
  const settingsIssues = useAppStore((s) => s.settingsIssues);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo(() => allCommands(), []);
  const fuse = useMemo(
    () => new Fuse(commands, { keys: ["title", "id"], threshold: 0.4, ignoreLocation: true }),
    [commands],
  );
  const results = useMemo<Command[]>(
    () => (query.trim() ? fuse.search(query).map((r) => r.item) : commands),
    [commands, fuse, query],
  );

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current
      ?.querySelector(".finder__item--active")
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const runCommand = (cmd: Command | undefined) => {
    if (!cmd) return;
    onClose();
    void cmd.run();
  };

  const openSettings = () => {
    runCommand(commands.find((c) => c.id === "preferences.openSettings"));
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="finder" role="dialog" aria-modal="true">
        {settingsIssues.length > 0 && (
          <button className="palette__warning" onClick={openSettings}>
            ⚠ settings.json has {settingsIssues.length} problem
            {settingsIssues.length === 1 ? "" : "s"}: {settingsIssues[0]}
            {settingsIssues.length > 1 ? " …" : ""} — click to open
          </button>
        )}
        <input
          className="finder__input"
          autoFocus
          placeholder="Type a command… (all commands listed below)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              runCommand(results[active]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="finder__list" ref={listRef}>
          {results.length === 0 ? (
            <div className="finder__msg">No matching command.</div>
          ) : (
            results.map((cmd, i) => {
              const key = commandKeyLabel(cmd.id);
              return (
                <div
                  key={cmd.id}
                  className={`finder__item ${i === active ? "finder__item--active" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => runCommand(cmd)}
                >
                  <span className="finder__name">{cmd.title}</span>
                  <span className="palette__spacer" />
                  {key && <span className="palette__kbd">{key}</span>}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
