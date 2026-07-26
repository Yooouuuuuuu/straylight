/** Right-click menu for a CHAT agent (in the focus view AND the normal CHAT
 *  panel): move it into a purpose group, into a new one, or back out to its
 *  host. Purpose membership is the "move" model — one home at a time. */
import { useEffect } from "react";

import { useMenuClamp } from "../../hooks/useMenuClamp";
import { useAppStore } from "../../store/appStore";

export function ChatAgentMenu({
  termId,
  x,
  y,
  onClose,
}: {
  termId: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const purposes = useAppStore((s) => s.chatPurposes);
  const addToPurpose = useAppStore((s) => s.addToPurpose);
  const removeFromPurpose = useAppStore((s) => s.removeFromPurpose);
  const addPurpose = useAppStore((s) => s.addPurpose);
  const setChatActive = useAppStore((s) => s.setChatActive);
  const { ref, left, top } = useMenuClamp(x, y);

  useEffect(() => {
    ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = purposes.find((p) => p.termIds.includes(termId));
  const others = purposes.filter((p) => p.id !== current?.id);

  return (
    <>
      <div
        className="menu-backdrop"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        className="ctx-menu"
        style={{ left, top }}
        ref={ref}
        tabIndex={-1}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <div className="ctx-menu__label">Add to group</div>
        {others.map((p) => (
          <button
            key={p.id}
            className="terminal-menu__item"
            onClick={() => {
              addToPurpose(p.id, termId);
              onClose();
            }}
          >
            <span className="ctx-menu__swatch" style={{ background: p.color }} />
            {p.name}
          </button>
        ))}
        <button
          className="terminal-menu__item"
          onClick={() => {
            const id = addPurpose();
            addToPurpose(id, termId);
            setChatActive(termId);
            onClose();
          }}
        >
          ＋ New group…
        </button>
        {current && (
          <>
            <div className="ctx-menu__sep" />
            <button
              className="terminal-menu__item"
              onClick={() => {
                removeFromPurpose(termId);
                onClose();
              }}
            >
              Remove from {current.name}
            </button>
          </>
        )}
      </div>
    </>
  );
}
