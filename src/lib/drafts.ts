/** Hot-exit drafts (docs/data-safety.md): local copies of unsaved edits, so a
 *  crash / close / power loss can't take dirty buffers with it.
 *
 *  Two tiers:
 *  - DIRTY tabs → full content drafts in `<config dir>/drafts/`, debounced
 *    (~1.5 s of idle) as you type. Two files per draft — `<stem>.body` (raw
 *    text) written first, `<stem>.json` (meta) last, so a complete meta
 *    always describes a complete body; `chars` re-verifies on read.
 *  - CLEAN tabs → a metadata stub in localStorage ({ mtime, size } at last
 *    sight) — phase-2 groundwork ("changed while away?"), no content stored.
 *
 *  A draft is deleted only when RESOLVED: saved, explicitly discarded, or
 *  found identical to the file. Declining the restore ask keeps drafts on
 *  disk (safety and convenience are separate questions — see the doc). */
import { getTabContent } from "./activeEditor";
import {
  acquireModel,
  applyDraftContent,
  setOnModelEdited,
} from "./editorModels";
import { sha256Hex } from "./hash";
import {
  fsCreate,
  fsListDir,
  fsReadFile,
  fsRemove,
  fsWriteFile,
  settingsPath,
} from "./ipc";
import { draftsConfig } from "./settings";
import {
  connKeyForConnId,
  useAppStore,
  type EditorTab,
} from "../store/appStore";

export interface DraftMeta {
  v: 1;
  connKey: string;
  path: string;
  /** Basename, for the cleanup panel and the diff-tab title. */
  name: string;
  language: string;
  /** The file's mtime when the drafted tab last loaded/saved — the anchor for
   *  "did the server change while you were away?". */
  baselineMtime: number;
  draftedAt: number;
  /** Content length in UTF-16 units — integrity check for the body file. */
  chars: number;
  /** Approximate byte size, for display. */
  bytes: number;
  /** SHA-256 of the content — lets a closed tab's draft be checked in when a
   *  background save confirms exactly this content landed (atomic-save.md
   *  decision 12). Absent on drafts written before 2026-07-15. */
  contentHash?: string;
}

const DEBOUNCE_MS = 1500;
const STUBS_KEY = "straylight.tabStubs";

// ---- module state ----------------------------------------------------------

let localConnId: string | null = null;
let dir: string | null = null;
let sep = "/";
/** Draft key (`connKey::path`) → meta, loaded once at init. */
const cache = new Map<string, DraftMeta>();
const timers = new Map<string, number>();

let readyResolve: (() => void) | null = null;
const ready = new Promise<void>((resolve) => {
  readyResolve = resolve;
});

/** Resolved once the draft index is loaded — session restore awaits this so
 *  tabs opened during restore can see their drafts. */
export function whenDraftsReady(): Promise<void> {
  return ready;
}

// ---- keys and paths --------------------------------------------------------

const dkey = (connKey: string, path: string) => `${connKey}::${path}`;

/** 32-bit FNV-1a in base36; two different-seed passes give the filename ~64
 *  collision bits. Reads verify meta.connKey/path anyway. */
function fnv(s: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function stemFor(key: string): string {
  return `d-${fnv(key, 0x811c9dc5)}-${fnv(key, 0x1b873593)}`;
}

const bodyPath = (stem: string) => `${dir}${sep}${stem}.body`;
const metaPath = (stem: string) => `${dir}${sep}${stem}.json`;

// ---- init ------------------------------------------------------------------

/** Resolve the drafts dir, load the index, and decide the restore mode. Runs
 *  after initSettings (it reads draftsConfig / restoreConfig). */
export async function initDrafts(connId: string): Promise<void> {
  try {
    localConnId = connId;
    const settingsFile = await settingsPath();
    sep = settingsFile.includes("\\") ? "\\" : "/";
    const configDir = settingsFile.replace(/[\\/]settings\.json$/i, "");
    dir = configDir + sep + "drafts";
    try {
      await fsCreate(connId, configDir, "drafts", true);
    } catch {
      /* already exists */
    }
    const listing = await fsListDir(connId, dir);
    for (const entry of listing.entries) {
      if (entry.isDir || !entry.name.endsWith(".json")) continue;
      try {
        const meta = JSON.parse(
          (await fsReadFile(connId, entry.path)).content,
        ) as DraftMeta;
        if (meta && meta.v === 1 && meta.connKey && meta.path) {
          cache.set(dkey(meta.connKey, meta.path), meta);
        }
      } catch {
        /* torn meta — the cleanup panel's Clear all removes strays */
      }
    }
  } finally {
    readyResolve?.();
  }
}

setOnModelEdited((tabId) => scheduleFlush(tabId));

// ---- the debounced writer --------------------------------------------------

function draftable(tab: EditorTab | undefined): tab is EditorTab {
  return (
    !!tab &&
    (!tab.kind || tab.kind === "file") &&
    !tab.isBinary &&
    !tab.truncated &&
    !tab.lossy
  );
}

function scheduleFlush(tabId: string): void {
  if (!dir || !draftsConfig.enabled) return;
  const prev = timers.get(tabId);
  if (prev !== undefined) window.clearTimeout(prev);
  timers.set(
    tabId,
    window.setTimeout(() => {
      timers.delete(tabId);
      void flush(tabId);
    }, DEBOUNCE_MS),
  );
}

/** Write a tab's draft (body then meta, so a complete meta always describes a
 *  complete body) for `content`. Shared by the debounced flush and the
 *  save-time guarantee below. */
async function writeDraftFile(
  tab: EditorTab,
  connKey: string,
  content: string,
  contentHash: string,
): Promise<void> {
  if (!localConnId) return;
  const key = dkey(connKey, tab.path);
  const meta: DraftMeta = {
    v: 1,
    connKey,
    path: tab.path,
    name: tab.name,
    language: tab.language,
    baselineMtime: tab.draftApplied
      ? (tab.draftBaselineMtime ?? tab.modified)
      : tab.modified,
    draftedAt: Date.now(),
    chars: content.length,
    bytes: new Blob([content]).size,
    contentHash,
  };
  try {
    const stem = stemFor(key);
    await fsWriteFile(localConnId, bodyPath(stem), content, null);
    await fsWriteFile(localConnId, metaPath(stem), JSON.stringify(meta), null);
    cache.set(key, meta);
  } catch {
    /* disk unavailable — the buffer itself is unaffected; retried next edit */
  }
}

async function flush(tabId: string): Promise<void> {
  if (!dir || !localConnId) return;
  const tab = useAppStore.getState().tabs.find((t) => t.id === tabId);
  if (!draftable(tab)) return;
  const connKey = connKeyForConnId(tab.connId);
  if (!connKey) return;
  const key = dkey(connKey, tab.path);
  // Undone back to the saved state: the draft is obsolete.
  if (!tab.dirty) {
    if (cache.has(key)) await removeDraftFiles(key);
    return;
  }
  const content = getTabContent(tabId);
  if (content === null) return;
  await writeDraftFile(tab, connKey, content, await sha256Hex(content));
}

/** Guarantee a draft exists for CONTENT a staged save is about to send, BEFORE
 *  the tab's dirty dot is cleared — so an in-flight save that never confirms is
 *  always recoverable (the staged-save invariant; see stagedSave.ts). Cancels
 *  any pending debounced flush so a late flush can't see the (now-clean) tab
 *  and delete the very draft we're relying on. No-op if the debounce already
 *  captured exactly this content. */
export async function ensureDraftForSave(
  tabId: string,
  content: string,
  contentHash: string,
): Promise<void> {
  if (!dir || !localConnId || !draftsConfig.enabled) return;
  const tab = useAppStore.getState().tabs.find((t) => t.id === tabId);
  if (!draftable(tab)) return;
  const connKey = connKeyForConnId(tab.connId);
  if (!connKey) return;
  const timer = timers.get(tabId);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timers.delete(tabId);
  }
  if (cache.get(dkey(connKey, tab.path))?.contentHash === contentHash) return;
  await writeDraftFile(tab, connKey, content, contentHash);
}

// ---- read / delete ---------------------------------------------------------

async function readDraftContent(meta: DraftMeta): Promise<string | null> {
  if (!localConnId) return null;
  try {
    const file = await fsReadFile(
      localConnId,
      bodyPath(stemFor(dkey(meta.connKey, meta.path))),
    );
    return file.content.length === meta.chars ? file.content : null;
  } catch {
    return null;
  }
}

async function removeDraftFiles(key: string): Promise<void> {
  cache.delete(key);
  if (!localConnId) return;
  const stem = stemFor(key);
  await fsRemove(localConnId, metaPath(stem)).catch(() => {});
  await fsRemove(localConnId, bodyPath(stem)).catch(() => {});
}

/** Whether a draft exists for a host's file (staged-save reconcile uses this:
 *  drafts are the primary relaunch recovery, the server temp the fallback). */
export function hasDraft(connKey: string, path: string): boolean {
  return cache.has(dkey(connKey, path));
}

/** Paths on a host that have an unresolved draft — reopened on every connect
 *  (Issue 1: an unsaved draft always comes back with its host, like a pin). */
export function filesWithDraft(connKey: string): string[] {
  return [...cache.values()].filter((m) => m.connKey === connKey).map((m) => m.path);
}

/** Check a draft in after the file's LAST save confirmed on the server
 *  (atomic-save.md decision 12): wait a ~500 ms grace, then delete the draft
 *  only if the buffer is still clean — edits typed meanwhile own it. A
 *  closed tab's draft is checked in only when its content hash matches what
 *  the save committed. */
export function checkInDraft(
  connId: string,
  path: string,
  savedContentHash: string,
): void {
  const connKey = connKeyForConnId(connId);
  if (!connKey) return;
  window.setTimeout(() => {
    const key = dkey(connKey, path);
    const meta = cache.get(key);
    if (!meta) return;
    const tab = useAppStore
      .getState()
      .tabs.find(
        (t) =>
          t.connId === connId && t.path === path && (!t.kind || t.kind === "file"),
      );
    if (tab) {
      if (!tab.dirty) void removeDraftFiles(key);
      return; // dirty again — the draft now holds newer content
    }
    if (meta.contentHash && meta.contentHash === savedContentHash) {
      void removeDraftFiles(key);
    }
  }, 500);
}

/** Resolve a draft after a successful save (or explicit "Don't save"). */
export function deleteDraftFor(connId: string, path: string): void {
  const connKey = connKeyForConnId(connId);
  if (!connKey) return;
  // Cancel any in-flight debounce for the owning tab, so a scheduled flush
  // can't resurrect the draft right after it was resolved.
  const tab = useAppStore
    .getState()
    .tabs.find(
      (t) => t.connId === connId && t.path === path && (!t.kind || t.kind === "file"),
    );
  if (tab) {
    const timer = timers.get(tab.id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.delete(tab.id);
    }
  }
  const key = dkey(connKey, path);
  if (cache.has(key)) void removeDraftFiles(key);
}

// ---- restore flow ----------------------------------------------------------

/** Called for every opened file tab: a hot-exit draft always auto-restores
 *  into the buffer (dirty by construction). The crumbs Compare button diffs it
 *  against the saved file; Ctrl+Z / close-without-save discard it. */
export async function maybeAttachDraft(tabId: string): Promise<void> {
  if (!draftsConfig.enabled) return;
  const s = useAppStore.getState();
  const tab = s.tabs.find((t) => t.id === tabId);
  if (!draftable(tab) || tab.dirty) return;
  const connKey = connKeyForConnId(tab.connId);
  if (!connKey) return;
  const meta = cache.get(dkey(connKey, tab.path));
  if (!meta) return;
  await applyDraft(tabId, meta);
}

async function applyDraft(tabId: string, meta: DraftMeta): Promise<boolean> {
  const s = useAppStore.getState();
  const tab = s.tabs.find((t) => t.id === tabId);
  if (!tab) return false;
  const content = await readDraftContent(meta);
  if (content === null) {
    // Torn/missing body — nothing restorable; drop the stray meta.
    void removeDraftFiles(dkey(meta.connKey, meta.path));
    return false;
  }
  // Identical to what's on disk now → the draft is obsolete (resolved).
  if (!tab.dirty && content === tab.content) {
    void removeDraftFiles(dkey(meta.connKey, meta.path));
    return false;
  }
  // Make sure the model exists seeded with the DISK content (tab.content),
  // then lay the draft over it as one undoable edit — Ctrl+Z steps back to
  // the original, where the dirty flag clears (the saved version is the
  // disk seed).
  acquireModel(tab);
  applyDraftContent(tabId, content);
  s.setTabDraft(tabId, {
    draftApplied: true,
    draftBaselineMtime: meta.baselineMtime,
  });
  // If the file moved on the server since this draft's baseline, the restored
  // buffer conflicts with it — flag the tab (conflict bar + Ctrl+S block).
  if (tab.modified !== meta.baselineMtime) s.setTabConflict(tabId, true);
  return true;
}

// ---- clean-tab stubs (phase-2 groundwork) -----------------------------------

/** Record where a tab last saw its file ({ mtime, size }) — cheap metadata so
 *  a later phase can answer "changed while you were away?" for clean tabs. */
export function updateStub(
  connId: string,
  path: string,
  mtime: number,
  size: number,
): void {
  const connKey = connKeyForConnId(connId);
  if (!connKey) return;
  try {
    const stubs = JSON.parse(localStorage.getItem(STUBS_KEY) ?? "{}") as Record<
      string,
      { mtime: number; size: number; at: number }
    >;
    stubs[dkey(connKey, path)] = { mtime, size, at: Date.now() };
    localStorage.setItem(STUBS_KEY, JSON.stringify(stubs));
  } catch {
    /* storage full — stubs are best-effort */
  }
}

// ---- cleanup panel ----------------------------------------------------------

export function listDrafts(): DraftMeta[] {
  return [...cache.values()];
}

export async function clearDraftsForHost(connKey: string): Promise<void> {
  for (const [key, meta] of [...cache]) {
    if (meta.connKey === connKey) await removeDraftFiles(key);
  }
}

/** The cookies-style wipe: every draft file, strays included. */
export async function clearAllDrafts(): Promise<void> {
  if (!dir || !localConnId) return;
  cache.clear();
  try {
    const listing = await fsListDir(localConnId, dir);
    for (const entry of listing.entries) {
      if (!entry.isDir && /\.(json|body)$/.test(entry.name)) {
        await fsRemove(localConnId, entry.path).catch(() => {});
      }
    }
  } catch {
    /* dir unreadable — nothing to clear */
  }
}
