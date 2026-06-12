/** Transient notifications (large-file warnings, errors). Auto-dismiss after a
 *  few seconds; errors linger longer. */
import { useEffect } from "react";

import { useAppStore, type Notice } from "../store/appStore";
import { IconClose } from "./icons";

function ToastItem({
  notice,
  onClose,
}: {
  notice: Notice;
  onClose: (id: number) => void;
}) {
  useEffect(() => {
    const timeout = window.setTimeout(
      () => onClose(notice.id),
      notice.kind === "error" ? 8000 : 5000,
    );
    return () => window.clearTimeout(timeout);
  }, [notice.id, notice.kind, onClose]);

  return (
    <div className={`toast toast--${notice.kind}`}>
      <span className="toast__text">{notice.text}</span>
      <button
        className="toast__close"
        onClick={() => onClose(notice.id)}
        title="Dismiss"
      >
        <IconClose size={14} />
      </button>
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
