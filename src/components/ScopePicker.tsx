/** Step-1 host chooser shared by Ctrl+P and Ctrl+Shift+F: top-down
 *  1 Local / 2 WSL / 3 Remote / 4 All. Number keys pick directly; ↑/↓ + Enter
 *  or the mouse also work; the last-used scope starts highlighted. */
import { useEffect, useMemo, useRef, useState } from "react";

import {
  availableKinds,
  loadScope,
  SCOPES,
  type SearchScope,
} from "../lib/searchScope";

export function ScopePicker({
  title,
  onPick,
  onClose,
}: {
  title: string;
  onPick: (scope: SearchScope) => void;
  onClose: () => void;
}) {
  const kinds = useMemo(() => availableKinds(), []);
  const [cursor, setCursor] = useState(() =>
    Math.max(0, SCOPES.findIndex((s) => s.id === loadScope())),
  );
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const enabled = (id: SearchScope) => id === "all" || kinds.has(id);
  const pick = (id: SearchScope) => {
    if (enabled(id)) onPick(id);
  };
  const move = (dir: 1 | -1) => {
    setCursor((c) => {
      let next = c;
      for (let i = 0; i < SCOPES.length; i += 1) {
        next = (next + dir + SCOPES.length) % SCOPES.length;
        if (enabled(SCOPES[next].id)) return next;
      }
      return c;
    });
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="scope-picker"
        role="dialog"
        aria-modal="true"
        tabIndex={0}
        ref={ref}
        onKeyDown={(e) => {
          if (["1", "2", "3", "4"].includes(e.key)) {
            e.preventDefault();
            pick(SCOPES[Number(e.key) - 1].id);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            move(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            move(-1);
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(SCOPES[cursor].id);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <div className="scope-picker__title">{title}</div>
        {SCOPES.map((s, i) => (
          <button
            key={s.id}
            className={`scope-picker__item ${i === cursor ? "scope-picker__item--active" : ""}`}
            disabled={!enabled(s.id)}
            onMouseEnter={() => enabled(s.id) && setCursor(i)}
            onClick={() => pick(s.id)}
          >
            <span className="scope-chip__num">{i + 1}</span>
            <span>{s.id === "all" ? "All hosts" : s.label}</span>
            {s.id !== "all" && !kinds.has(s.id) && (
              <span className="scope-picker__off">not connected</span>
            )}
          </button>
        ))}
        <div className="scope-picker__hint">1–4, ↑↓ + Enter, or click — Esc closes</div>
      </div>
    </div>
  );
}
