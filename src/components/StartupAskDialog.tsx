/** Startup asks, one at a time: restore unsaved drafts (first, if any), then
 *  "connect to last …?" per saved WSL distro and remote. The checkbox flips
 *  the matching setting to "always" — applied only on confirm, never on
 *  Skip. */
import { useEffect, useState } from "react";

import { autoConnectConfig, updateSettings } from "../lib/settings";
import { useDialogKeys } from "../hooks/useDialogKeys";
import { useAppStore } from "../store/appStore";

export function StartupAskDialog() {
  const ask = useAppStore((s) => s.connectAsks[0] ?? null);
  const shiftConnectAsk = useAppStore((s) => s.shiftConnectAsk);
  const [always, setAlways] = useState(false);
  // The connect asks' "also restore drafts" rider — default CHECKED.
  const [withDrafts, setWithDrafts] = useState(true);

  const skip = () => {
    ask?.onSkip?.();
    shiftConnectAsk();
  };
  const dlg = useDialogKeys(skip, ask);

  useEffect(() => {
    setAlways(false);
    setWithDrafts(true);
  }, [ask]); // fresh checkboxes per ask

  if (!ask) return null;

  const isDrafts = ask.kind === "drafts";

  const confirm = () => {
    if (always) {
      void updateSettings(
        isDrafts
          ? { restore: { openFiles: "always" } }
          : { autoConnect: { ...autoConnectConfig, [ask.kind]: "always" } },
      );
    }
    const run = ask.run;
    shiftConnectAsk();
    run(withDrafts);
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
          {isDrafts
            ? `Restore unsaved changes from your last session — ${ask.label}?`
            : `Connect to last ${ask.kind === "wsl" ? "WSL distro" : "remote"} — ${ask.label}?`}
        </div>
        <div className="exit-ask__hint">
          <kbd>Enter</kbd> {isDrafts ? "restores" : "connects"} · <kbd>Esc</kbd>{" "}
          skips{isDrafts ? " (drafts are kept on disk)" : ""}
        </div>
        <div className="exit-ask__actions">
          {!isDrafts && (ask.draftsCount ?? 0) > 0 && (
            <label
              className="confirm-silence"
              title="Unsaved edits cached from your last session load back into the reopened files"
            >
              <input
                type="checkbox"
                checked={withDrafts}
                onChange={(e) => setWithDrafts(e.target.checked)}
              />
              Also restore {ask.draftsCount} unsaved draft
              {ask.draftsCount === 1 ? "" : "s"}
            </label>
          )}
          <label
            className="confirm-silence"
            title={
              isDrafts
                ? 'Saved to settings.json ("restore.openFiles") only if you restore'
                : 'Saved to settings.json ("autoConnect") only if you connect'
            }
          >
            <input
              type="checkbox"
              checked={always}
              onChange={(e) => setAlways(e.target.checked)}
            />
            {isDrafts ? "Always restore automatically" : "Always connect automatically"}
          </label>
          <button className="btn btn--ghost" onClick={skip}>
            Skip
          </button>
          <button className="btn btn--primary" data-dialog-primary onClick={confirm}>
            {isDrafts ? "Restore" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}
