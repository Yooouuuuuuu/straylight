/** Transient notifications (large-file warnings, errors). Auto-dismiss after a
 *  few seconds — paused while hovered so the text can be selected or copied. */
import { useEffect, useState } from "react";

import { useAppStore, type Notice } from "../store/appStore";
import { IconCheck, IconClose, IconCopy } from "./icons";
import { Tip } from "./Tooltip";

function ToastItem({
  notice,
  onClose,
}: {
  notice: Notice;
  onClose: (id: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (hovered) return; // pause auto-dismiss while the user is on it
    const timeout = window.setTimeout(
      () => onClose(notice.id),
      notice.kind === "error" ? 8000 : 5000,
    );
    return () => window.clearTimeout(timeout);
  }, [notice.id, notice.kind, onClose, hovered]);

  const copy = () => {
    navigator.clipboard
      .writeText(notice.text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <div
      className={`toast toast--${notice.kind}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="toast__text">{notice.text}</span>
      {/* tabIndex -1: a toast must never take keyboard focus — it's transient
          chrome, and stealing focus mid-typing (e.g. a password) is the worst
          possible moment. Mouse-only controls. */}
      <Tip label={copied ? "Copied" : "Copy message"}>
        <button className="toast__close" tabIndex={-1} onClick={copy}>
          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
        </button>
      </Tip>
      <Tip label="Dismiss">
        <button
          className="toast__close"
          tabIndex={-1}
          onClick={() => onClose(notice.id)}
        >
          <IconClose size={14} />
        </button>
      </Tip>
    </div>
  );
}

export function ToastStack() {
  const notices = useAppStore((s) => s.notices);
  const dismissNotice = useAppStore((s) => s.dismissNotice);

  if (notices.length === 0) return null;

  return (
    <div className="toast-stack">
      {notices.map((notice) => (
        <ToastItem key={notice.id} notice={notice} onClose={dismissNotice} />
      ))}
    </div>
  );
}
