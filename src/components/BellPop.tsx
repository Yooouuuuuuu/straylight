/** The notification popover (every toast lands here after it fades) — shared
 *  by the status bar's bell and the focus view's HOSTS-header bell. Renders
 *  only while `bellOpen`; the `variant` picks where it anchors (fixed
 *  bottom-right over the status bar, or inside the focus view's left panel). */
import { RelativeTime } from "./RelativeTime";
import { Tip } from "./Tooltip";
import { IconClose, IconCopy } from "./icons";
import { useAppStore } from "../store/appStore";

export function BellPop({ variant }: { variant: "status" | "focus" }) {
  const bellOpen = useAppStore((s) => s.bellOpen);
  const setBellOpen = useAppStore((s) => s.setBellOpen);
  const noticeLog = useAppStore((s) => s.noticeLog);
  const clearNoticeLog = useAppStore((s) => s.clearNoticeLog);

  if (!bellOpen) return null;
  return (
    <>
      <div className="menu-backdrop" onClick={() => setBellOpen(false)} />
      <div className={`bell-pop${variant === "focus" ? " bell-pop--focus" : ""}`}>
        <div className="bell-pop__head">
          <span>Notifications</span>
          <span className="bell-pop__spacer" />
          {noticeLog.length > 0 && (
            <button className="bell-pop__clear" onClick={() => clearNoticeLog()}>
              Clear all
            </button>
          )}
          <Tip label="Close">
            <button className="icon-btn" onClick={() => setBellOpen(false)}>
              <IconClose size={11} />
            </button>
          </Tip>
        </div>
        {noticeLog.length === 0 ? (
          <div className="bell-pop__empty">
            Nothing yet — toasts land here after they fade.
          </div>
        ) : (
          <div className="bell-pop__list">
            {noticeLog.map((n) => (
              <div key={n.id} className={`bell-pop__item bell-pop__item--${n.kind}`}>
                {/* Selectable AND one-click copyable — error texts get pasted
                    into searches and bug reports. */}
                <span className="bell-pop__text">{n.text}</span>
                <Tip label="Copy message">
                  <button
                    className="icon-btn bell-pop__copy"
                    onClick={() =>
                      void navigator.clipboard.writeText(n.text).catch(() => {})
                    }
                  >
                    <IconCopy size={12} />
                  </button>
                </Tip>
                <span className="bell-pop__time">
                  <RelativeTime at={n.time} title={null} />
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
