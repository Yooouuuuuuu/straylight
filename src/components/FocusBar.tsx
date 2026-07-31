/** The full-width bottom strip that stands in for the status bar wherever the
 *  sessions run alone — the F11 focus view (main window) and the popped-out
 *  Sessions window. Same footprint, with the notification bell in its usual
 *  bottom-right spot; a mode name sits at left (the F11 hint, or just the
 *  window's name when it's the pop-out). */
import { useAppStore } from "../store/appStore";
import { isSessions } from "../lib/windowRole";
import { BellPop } from "./BellPop";
import { IconBell } from "./icons";
import { Tip } from "./Tooltip";

export function FocusBar() {
  const noticeUnread = useAppStore((s) => s.noticeUnread);
  const bellOpen = useAppStore((s) => s.bellOpen);
  const setBellOpen = useAppStore((s) => s.setBellOpen);

  return (
    <footer className="statusbar focus-bar">
      <span className="focus-bar__label">
        {isSessions ? "Sessions" : "press F11 to exit Session focus mode"}
      </span>
      <span className="statusbar__spacer" />
      <Tip label="Notifications">
        <span
          className="statusbar__item statusbar__item--button statusbar__bell"
          onClick={() => setBellOpen(!bellOpen)}
        >
          <IconBell size={13} />
          {noticeUnread > 0 && <span className="statusbar__attn" />}
        </span>
      </Tip>
      <BellPop variant="status" />
    </footer>
  );
}
