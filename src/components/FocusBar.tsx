/** The Sessions focus bottom bar — a full-width strip standing in for the
 *  status bar (hidden in the focus view). Same footprint and the notification
 *  bell in its usual bottom-right spot; the mode name at left and a quiet
 *  "back to editor" hint before the bell. */
import { useAppStore } from "../store/appStore";
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
        press F11 to exit Session focus mode
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
