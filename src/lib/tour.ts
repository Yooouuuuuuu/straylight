/** The guided tour (0.13.0): a spotlight walkthrough of the real UI for
 *  fresh installs, re-runnable from Settings → Preferences and the palette.
 *
 *  Steps anchor to `data-tour="…"` attributes on the live elements; a step
 *  whose target doesn't exist in the current state (sessions popped out,
 *  connect form hidden by a live connection…) is skipped in the direction of
 *  travel, so the same tour works on a fresh install and on a loaded
 *  workspace. `prepare` may reveal a panel first; the visibility the tour
 *  touched is restored when it ends. Main window only. */
import { create } from "zustand";

import { useAppStore } from "../store/appStore";
import { useVcsStore } from "../store/vcsStore";

/** Which surfaces a step needs on screen. Everything ABSENT is closed — the
 *  walkthrough runs on a cleared stage and reveals one surface at a time,
 *  closing it again as the tour moves on. */
export interface PanelSet {
  sidebar?: boolean;
  scm?: boolean;
  terminal?: boolean;
  chat?: boolean;
}

export function showPanels(p: PanelSet): void {
  const a = useAppStore.getState();
  a.setSidebarVisible(!!p.sidebar);
  a.setTerminalVisible(!!p.terminal);
  a.setChatVisible(!!p.chat);
  useVcsStore.getState().setScmVisible(!!p.scm);
}

export interface TourStep {
  /** `data-tour` anchor; null = a centered card (welcome / finish). */
  target: string | null;
  title: string;
  body: string;
  /** Surfaces open DURING this step (all others closed). */
  panels?: PanelSet;
}

export const TOUR_STEPS: TourStep[] = [
  {
    target: null,
    title: "Welcome to Straylight",
    body:
      "A lightweight home for remote work — files, terminals, and an editor " +
      "over plain SSH. Your local machine is already connected. This tour " +
      "takes about a minute; Esc skips it.",
  },
  {
    target: "connect",
    title: "Connect a server",
    panels: { sidebar: true },
    body:
      "Add an SSH host here. Saved hosts come back with one click, and can " +
      "auto-connect at launch; WSL distros connect from the W section.",
  },
  {
    target: "explorer",
    title: "The explorer",
    panels: { sidebar: true },
    body:
      "Local, WSL, and SSH remotes each get a section here — every host " +
      "keeps its own file trees, and they remember what you left open.",
  },
  {
    target: "sections",
    title: "L · W · R",
    panels: { sidebar: true },
    body:
      "These toggles show or hide each section — Local, WSL, Remotes. Not " +
      "using one? Switch it off; the explorer stays exactly as lean as you " +
      "want it.",
  },
  {
    target: "pin",
    title: "Pin a folder",
    panels: { sidebar: true },
    body:
      "＋ pins a folder to the Local section. Pinned folders come back every " +
      "launch — they're your workspace roots.",
  },
  {
    target: "sc",
    title: "Source Control",
    panels: { scm: true },
    body:
      "Track git and jj repos here — ＋ opens one, and the branch icon on " +
      "any explorer folder does the same. Status, commit, and push live in " +
      "this column.",
  },
  {
    target: "terminal",
    title: "Terminals",
    panels: { terminal: true },
    body:
      "Every connected host gets its own shells here, grouped by host — " +
      "starting with your local PowerShell.",
  },
  {
    target: "tools",
    title: "Ports · Containers · Forwarding · Transfers",
    panels: { terminal: true },
    body:
      "Live views on your hosts: listening ports, running containers " +
      "(podman & docker), port forwarding, and file transfers between " +
      "machines.",
  },
  {
    target: "panels",
    title: "The panel buttons",
    body:
      "Explorer, Source Control, Terminal, and Sessions toggle from down " +
      "here; the right side always describes the active file.",
  },
  {
    target: "sessions",
    title: "Sessions",
    panels: { chat: true },
    body:
      "A column for long-running terminals — made for Claude Code and " +
      "friends. The bell rings when it's your turn.",
  },
  {
    target: "focus",
    title: "Focus view",
    body:
      "F11 (or this button) turns your sessions into a full-screen " +
      "workspace — every agent on one screen.",
  },
  {
    target: "popout",
    title: "Pop the sessions out",
    body:
      "⬒ moves the sessions into their own window — put your agents on " +
      "another monitor. Shells keep running; closing it brings everything " +
      "back.",
  },
  {
    target: "workspace",
    title: "A second workspace",
    body:
      "⧉ opens another explorer + editor window on the same connections — " +
      "browse and edit on one screen while the first does something else.",
  },
  {
    target: "palette",
    title: "Every command",
    body: "Ctrl+Shift+P lists everything the app can do, searchable.",
  },
  {
    target: "settings",
    title: "Settings",
    body:
      "Preferences, themes, and storage live under ⚙ — and settings.json " +
      "is a plain file you can hand-edit.",
  },
  {
    target: null,
    title: "That's the walkthrough",
    // The hand-off: the two most-used surfaces open behind this card.
    panels: { sidebar: true, terminal: true },
    body: "Take it again anytime from ⚙ → Walkthrough. Enjoy.",
  },
];

const DONE_KEY = "straylight.tourDone";

interface TourState {
  /** Current step index, or null when the tour is closed. */
  step: number | null;
  start: () => void;
  /** `completed` = walked to the end (vs Esc/Skip). Either way the tour
   *  never auto-starts again. */
  stop: (completed: boolean) => void;
  next: () => void;
  prev: () => void;
}

/** The user's layout before the tour cleared the stage — restored on stop. */
let layoutSnapshot: {
  sidebar: boolean;
  scm: boolean;
  terminal: boolean;
  chat: boolean;
} | null = null;

export const useTourStore = create<TourState>()((set) => ({
  step: null,
  start: () => {
    const a = useAppStore.getState();
    layoutSnapshot = {
      sidebar: a.sidebarVisible,
      scm: useVcsStore.getState().scmVisible,
      terminal: a.terminalVisible,
      chat: a.chatVisible,
    };
    set({ step: 0 });
  },
  stop: (completed) => {
    markTourDone();
    if (layoutSnapshot) {
      const a = useAppStore.getState();
      // Esc/Skip: the layout goes back exactly as it was. Finished: same,
      // then the hand-off — explorer + terminal (the most-used surfaces)
      // stay open for the user to take over.
      a.setSidebarVisible(completed || layoutSnapshot.sidebar);
      a.setTerminalVisible(completed || layoutSnapshot.terminal);
      a.setChatVisible(layoutSnapshot.chat);
      useVcsStore.getState().setScmVisible(layoutSnapshot.scm);
      layoutSnapshot = null;
    }
    set({ step: null });
  },
  next: () => set((s) => (s.step === null ? s : { step: s.step + 1 })),
  prev: () =>
    set((s) => (s.step === null || s.step === 0 ? s : { step: s.step - 1 })),
}));

export function startTour(): void {
  useTourStore.getState().start();
}

/** True while the first-run tour hasn't been taken (or skipped) yet. */
export function tourPending(): boolean {
  try {
    return !localStorage.getItem(DONE_KEY);
  } catch {
    return false;
  }
}

export function markTourDone(): void {
  try {
    localStorage.setItem(DONE_KEY, "1");
  } catch {
    /* prefs only */
  }
}
