/** Auto-update via tauri-plugin-updater. The installed app polls the
 *  `latest.json` attached to the latest GitHub Release, verifies the download
 *  against the pubkey baked into the binary, installs, and relaunches. A quiet
 *  check runs once on launch; the ⚙ menu and the command palette expose a
 *  manual check that always reports its result. Hosting + release flow live in
 *  docs/dev/release-plan.md. */
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

import { useAppStore } from "../store/appStore";
import { useVcsStore } from "../store/vcsStore";

// One check at a time — the ⚙ item, the palette, and the launch check share it.
let inFlight = false;

/** Manual "Check for updates" — always toasts the outcome (found / latest /
 *  error), so the user gets feedback either way. */
export function checkForUpdate(): void {
  void runCheck(true);
}

/** Quiet launch check — silent unless an update is found. Skipped in `tauri
 *  dev`, where there is no updater artifact to check against. */
export function checkForUpdateOnLaunch(): void {
  if (import.meta.env.DEV) return;
  void runCheck(false);
}

async function runCheck(announceNoResult: boolean): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  const notice = useAppStore.getState().pushNotice;
  try {
    const update = await check();
    if (!update) {
      if (announceNoResult) notice("info", "You're on the latest version.");
      return;
    }
    // Found one → let the user decide; installing restarts the app.
    useVcsStore
      .getState()
      .askConfirm(
        `Update to ${update.version}?`,
        `A new version of Straylight is available. It downloads in the background, then the app restarts to finish installing.${update.body ? `\n\n${update.body}` : ""}`,
        () => void install(update),
      );
  } catch (e) {
    if (announceNoResult) notice("error", `Couldn't check for updates: ${String(e)}`);
  } finally {
    inFlight = false;
  }
}

async function install(update: Update): Promise<void> {
  const notice = useAppStore.getState().pushNotice;
  try {
    notice("info", `Downloading ${update.version}…`);
    await update.downloadAndInstall();
    await relaunch();
  } catch (e) {
    notice("error", `Update failed: ${String(e)}`);
  }
}
