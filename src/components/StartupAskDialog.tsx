/** Startup asks, one at a time: "connect to last …?" per saved WSL distro and
 *  remote. The "don't ask again" checkbox adds THIS host's key to settings
 *  `autoConnect` — applied only on confirm, never on Skip; unmark in Storage →
 *  Auto-connect. (Drafts no longer ask: they always auto-restore.) */
import { useEffect, useState } from "react";

import { autoConnectHosts, updateSettings } from "../lib/settings";
import { useDialogKeys } from "../hooks/useDialogKeys";
import { useAppStore } from "../store/appStore";
import { Tip } from "./Tooltip";

export function StartupAskDialog() {
  const rawAsk = useAppStore((s) => s.connectAsks[0] ?? null);
  // Queued asks WAIT while the connect dialog is open — popping over it would
  // steal focus from someone mid-password. The next ask shows on close.
  const dialogOpen = useAppStore((s) => s.dialogOpen);
  const ask = dialogOpen ? null : rawAsk;
  const shiftConnectAsk = useAppStore((s) => s.shiftConnectAsk);
  const [always, setAlways] = useState(false);

  const skip = () => {
    ask?.onSkip?.();
    shiftConnectAsk();
  };
  const dlg = useDialogKeys(skip, ask);

  useEffect(() => {
    setAlways(false);
  }, [ask]); // fresh checkbox per ask

  if (!ask) return null;

  const confirm = () => {
    if (always) {
      void updateSettings({
        autoConnect: [...new Set([...autoConnectHosts, ask.hostKey])],
      });
    }
    const run = ask.run;
    shiftConnectAsk();
    run();
  };

  return (
    <div className="modal-overlay">
      <div
        className="modal exit-ask"
        role="dialog"
        ref={dlg.ref}
        onKeyDown={dlg.onKeyDown}
      >
        <div className="exit-ask__title">
          Connect to last {ask.kind === "wsl" ? "WSL distro" : "remote"} —{" "}
          {ask.label}?
        </div>
        <div className="exit-ask__hint">
          <kbd>Enter</kbd> connects · <kbd>Esc</kbd> skips
        </div>
        <div className="exit-ask__actions">
          <Tip label="Saved to autoConnect — undo in Storage → Auto-connect">
            <label className="confirm-silence">
              <input
                type="checkbox"
                checked={always}
                onChange={(e) => setAlways(e.target.checked)}
              />
              Don't ask again — always connect this host
            </label>
          </Tip>
          <button className="btn btn--ghost" onClick={skip}>
            Skip
          </button>
          <button className="btn btn--primary" data-dialog-primary onClick={confirm}>
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
