/** Startup "connect to last …?" asks, one at a time (WSL first, then each
 *  remote). The checkbox flips that kind's autoConnect setting to "always" —
 *  applied only when you actually connect, never on Skip. */
import { useEffect, useState } from "react";

import { autoConnectConfig, updateSettings } from "../lib/settings";
import { useAppStore } from "../store/appStore";

export function StartupAskDialog() {
  const ask = useAppStore((s) => s.connectAsks[0] ?? null);
  const shiftConnectAsk = useAppStore((s) => s.shiftConnectAsk);
  const [always, setAlways] = useState(false);

  useEffect(() => setAlways(false), [ask]); // fresh checkbox per ask

  useEffect(() => {
    if (!ask) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        confirm();
      } else if (e.key === "Escape") {
        e.preventDefault();
        skip();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask, always]);

  if (!ask) return null;

  const skip = () => {
    ask.onSkip?.();
    shiftConnectAsk();
  };

  const confirm = () => {
    if (always) {
      void updateSettings({
        autoConnect: { ...autoConnectConfig, [ask.kind]: "always" },
      });
    }
    const run = ask.run;
    shiftConnectAsk();
    run();
  };

  return (
    <div className="modal-overlay">
      <div className="modal exit-ask" role="dialog">
        <div className="exit-ask__title">
          Connect to last {ask.kind === "wsl" ? "WSL distro" : "remote"} — {ask.label}?
        </div>
        <div className="exit-ask__hint">
          <kbd>Enter</kbd> connects · <kbd>Esc</kbd> skips
        </div>
        <div className="exit-ask__actions">
          <label
            className="confirm-silence"
            title='Saved to settings.json ("autoConnect") only if you connect'
          >
            <input
              type="checkbox"
              checked={always}
              onChange={(e) => setAlways(e.target.checked)}
            />
            Always connect automatically
          </label>
          <button className="btn btn--ghost" onClick={skip}>
            Skip
          </button>
          <button className="btn btn--primary" onClick={confirm}>
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
