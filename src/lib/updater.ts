/** Auto-update via tauri-plugin-updater. The installed app polls the
 *  `latest.json` attached to the latest GitHub Release, verifies the download
 *  against the pubkey baked into the binary, installs, and relaunches.
 *
 *  A quiet check runs once on launch — it never interrupts: an available
 *  update only lights the green dot on ⚙ → Check for updates. The ⚙ item and
 *  the command palette run the manual check, which always reports its outcome
 *  (the up-to-date toast doubles as the app's "what version am I on"). Hosting
 *  + release flow live in docs/dev/release-plan.md. */
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

import { useAppStore } from "../store/appStore";
import { useVcsStore } from "../store/vcsStore";

// One check at a time — the ⚙ item, the palette, and the launch check share it.
let inFlight = false;

/** Manual "Check for updates" — always toasts the outcome (found / latest /
 *  error), and prompts to install when an update exists. */
export function checkForUpdate(): void {
  void runCheck(true);
}

/** Quiet launch check — no dialog, no toast: an available update only lights
 *  the ⚙ menu dot. Skipped in `tauri dev`, where there is no updater artifact
 *  to check against. */
export function checkForUpdateOnLaunch(): void {
  if (import.meta.env.DEV) return;
  void runCheck(false);
}

async function runCheck(manual: boolean): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  const notice = useAppStore.getState().pushNotice;
  try {
    const update = await check();
    if (!update) {
      useAppStore.getState().setUpdateAvailable(null);
      if (manual) {
        const version = await getVersion().catch(() => null);
        notice(
          "info",
          version
            ? `You're on the latest version (v${version}).`
            : "You're on the latest version.",
        );
      }
      return;
    }
    // Light the dot either way; if the user declines the manual prompt it
    // stays on as a quiet reminder.
    useAppStore.getState().setUpdateAvailable(update.version);
    if (!manual) return;
    // Manual check → the user asked, so offer the install now. What's new
    // leads (the release's `notes` from latest.json); mechanics follow.
    useVcsStore
      .getState()
      .askConfirm(
        `Update to ${update.version}?`,
        `${update.body ? `${update.body}\n\n` : ""}Downloads in the background; the app restarts to finish installing.`,
        () => void install(update),
      );
  } catch (e) {
    if (manual) notice("error", `Couldn't check for updates: ${String(e)}`);
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
