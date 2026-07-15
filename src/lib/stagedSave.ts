/** Staged remote saves — frontend driver for docs/atomic-save.md, background-
 *  ack revision (2026-07-15).
 *
 *  A save is OPTIMISTIC: the tab is marked saved the moment its content is
 *  uploaded to a `.straysave` temp and the detached server-side commit is
 *  dispatched (S1–S3). Confirmation runs in the BACKGROUND (S4) and only
 *  matters when it fails — a hash-guard refusal ("changed") or a commit error
 *  ("fail") re-dirties the tab loudly; the local draft holds the content until
 *  the ok is truly confirmed, so nothing rests on the optimistic signal.
 *
 *  Commits for one file are SERIALIZED through a per-file queue that collapses
 *  to the newest pending content (superseded versions are never dispatched),
 *  so two `cp`s can't interleave on one inode and expected-hashes chain
 *  cleanly. Uploads for different files run in parallel.
 *
 *  Local files never come here (no network to tear); the "fallback" outcome is
 *  the caller re-routing to the legacy direct write when the staged path can't
 *  even start (jailed SFTP-only host). */
import { getTabVersionId, markTabSavedVersion } from "./activeEditor";
import { markTabUnsaved } from "./editorModels";
import { checkInDraft, hasDraft, updateStub } from "./drafts";
import { basename } from "./format";
import { sha256Hex } from "./hash";
import { fsReadFile, fsRemove, fsStat, fsWriteFile, saveCommit } from "./ipc";
import { connKeyForConnId, useAppStore } from "../store/appStore";
import { useVcsStore } from "../store/vcsStore";

/** "queued" = accepted optimistically (upload + dispatch ok, ack pending; a
 *  later guard refusal surfaces the conflict asynchronously). "fallback" = the
 *  staged path couldn't start; the target is untouched, use the direct write. */
export type StagedOutcome = "queued" | "fallback" | "error";

interface PendingSave {
  connKey: string;
  path: string;
  id: string;
  tmp: string;
  ok: string;
  err: string;
  /** Uploaded payload size — a smaller temp on reconcile = died mid-upload. */
  byteSize: number;
  /** sha256 of the target the guard expects (the previous content). */
  expectedHash: string;
  /** sha256 of THIS save's content — for the draft check-in + reconcile. */
  contentHash: string;
  /** The target's mtime at dispatch — moved on reconcile = external edit. */
  baselineMtime: number;
  at: number;
}

const REC_KEY = "straylight.pendingSaves";

function loadRecs(): PendingSave[] {
  try {
    const arr = JSON.parse(localStorage.getItem(REC_KEY) ?? "[]");
    return Array.isArray(arr) ? (arr as PendingSave[]) : [];
  } catch {
    return [];
  }
}

function saveRecs(recs: PendingSave[]): void {
  try {
    localStorage.setItem(REC_KEY, JSON.stringify(recs));
  } catch {
    /* storage full — the marker files still resolve the save */
  }
}

function addRec(rec: PendingSave): void {
  saveRecs([
    ...loadRecs().filter((r) => !(r.connKey === rec.connKey && r.path === rec.path)),
    rec,
  ]);
}

function removeRec(rec: Pick<PendingSave, "connKey" | "path" | "id">): void {
  saveRecs(
    loadRecs().filter(
      (r) => !(r.connKey === rec.connKey && r.path === rec.path && r.id === rec.id),
    ),
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nowSecs = () => Math.floor(Date.now() / 1000);
const dirOf = (path: string) => {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "/";
};

const notice = (kind: "info" | "warn" | "error", text: string) =>
  useAppStore.getState().pushNotice(kind, text);

let counter = 0;

// ---- per-file commit queue --------------------------------------------------

interface QueueEntry {
  connId: string;
  connKey: string;
  path: string;
  tabId: string;
  content: string;
  force: boolean;
  /** sha256 of `content` — becomes the NEXT save's expected hash (guards chain
   *  across the queue) and the draft check-in key. */
  contentHash: string;
  /** The Monaco version this save captures. Only THIS version is marked
   *  clean, so edits typed during the async ack keep the tab dirty. */
  versionId: number | null;
  /** sha256 of what the tab was based on (its seed) — the guard baseline for
   *  the first save of a file this session, before the chain takes over. */
  baseHash: string;
}

/** file key (`connKey::path`) → { running, next }. `next` collapses to the
 *  newest pending save; only it is ever dispatched. */
const queues = new Map<string, { running: boolean; next: QueueEntry | null }>();
/** The hash last committed (or in flight) per file, so a rapid follow-up save
 *  guards against what WE are about to write, not a stale disk read. */
const lastHash = new Map<string, string>();

const fkey = (connKey: string, path: string) => `${connKey}::${path}`;

/** Enqueue a save. Returns as soon as it's accepted (the upload+dispatch of
 *  THIS or a superseding entry happens on the queue worker). */
export async function stagedSaveTab(
  tabId: string,
  content: string,
  versionId: number | null,
  opts?: { force?: boolean },
): Promise<StagedOutcome> {
  const store = useAppStore.getState();
  const tab = store.tabs.find((t) => t.id === tabId);
  if (!tab) return "error";
  const connKey = connKeyForConnId(tab.connId);
  if (!connKey) return "error";

  const key = fkey(connKey, tab.path);
  const entry: QueueEntry = {
    connId: tab.connId,
    connKey,
    path: tab.path,
    tabId,
    content,
    force: !!opts?.force,
    contentHash: await sha256Hex(content),
    versionId,
    // The tab's seed is "what we last read/wrote" = the guard baseline for
    // the first save; the chain (lastHash) overrides it after that.
    baseHash: await sha256Hex(tab.content),
  };

  const q = queues.get(key) ?? { running: false, next: null };
  queues.set(key, q);
  q.next = entry; // collapse — newest content wins

  // Accept immediately (optimistic): the tab is finalized now; the upload +
  // dispatch happen on the queue worker (this call, or the running one).
  finalizeOptimistic(entry);
  if (q.running) return "queued";
  void runQueue(key);
  return "queued";
}

/** Optimistically mark the tab saved for THIS captured version: dirty clears,
 *  draft state resets (the draft file itself lingers until the commit
 *  confirms via checkInDraft), the stub advances. Edits made after this
 *  version re-dirty the tab normally and enqueue their own save. */
function finalizeOptimistic(entry: QueueEntry): void {
  const s = useAppStore.getState();
  const tab = s.tabs.find((t) => t.id === entry.tabId);
  if (!tab) return;
  s.markTabSaved(entry.tabId, tab.modified, entry.content);
  if (entry.versionId !== null) markTabSavedVersion(entry.tabId, entry.versionId);
  s.setTabDraft(entry.tabId, { draftApplied: false, draftAvailable: false });
  updateStub(entry.connId, entry.path, tab.modified, entry.content.length);
}

/** Run one file's queue: dispatch the collapsed newest entry, loop while newer
 *  ones arrive. All iterations are background — the caller already returned. */
async function runQueue(key: string): Promise<void> {
  const q = queues.get(key);
  if (!q || q.running) return;
  q.running = true;
  while (q.next) {
    const entry = q.next;
    q.next = null;
    await dispatchOne(entry);
  }
  q.running = false;
  if (!q.next) queues.delete(key);
}

/** Upload + dispatch one save, record it, and kick off its background ack. */
async function dispatchOne(entry: QueueEntry): Promise<void> {
  const { connId, connKey, path, content } = entry;
  const key = fkey(connKey, path);
  const store = useAppStore.getState();
  const baselineMtime = store.tabs.find((t) => t.id === entry.tabId)?.modified ?? 0;

  const dir = dirOf(path);
  const name = path.slice(dir === "/" ? 1 : dir.length + 1);
  const id = `${Date.now().toString(36)}${(counter++).toString(36)}`;
  const tmp = `${dir}/.${name}.straysave.${id}`;
  const ok = `${dir}/.straysave.${id}.ok`;
  const err = `${dir}/.straysave.${id}.err`;

  // Guard baseline: what we last committed for this file (chained), else the
  // tab's seed hash (first save this session). Overwrite skips the guard.
  const guard = entry.force ? "-" : (lastHash.get(key) ?? entry.baseHash);

  // S1 — stage upload. Failure with the target untouched → fallback.
  try {
    await fsWriteFile(connId, tmp, content, null);
  } catch {
    // Undo the optimism for this attempt — the save didn't happen and no
    // newer save is queued to cover it.
    if (!queues.get(key)?.next) {
      const s = useAppStore.getState();
      if (s.tabs.find((t) => t.id === entry.tabId)) markTabUnsaved(entry.tabId);
      notice(
        "error",
        `Couldn't stage ${basename(path)} on the server — your changes are still in this tab. Saving to disk directly instead.`,
      );
    }
    return;
  }

  // Chain the guard immediately so a rapid follow-up save expects THIS
  // content, then record (death here is recoverable) and dispatch detached.
  lastHash.set(key, entry.contentHash);
  addRec({
    connKey,
    path,
    id,
    tmp,
    ok,
    err,
    byteSize: new Blob([content]).size,
    expectedHash: guard,
    contentHash: entry.contentHash,
    baselineMtime,
    at: Date.now(),
  });
  try {
    await saveCommit(connId, dir, tmp, path, ok, err, guard);
  } catch {
    removeRec({ connKey, path, id });
    await fsRemove(connId, tmp).catch(() => {});
    return;
  }
  await awaitAck(entry, { id, tmp, ok, err });
}

/** S4 — background acknowledgement. Poll fast then slow, then PARK. Only acts
 *  on FAILURE (changed / fail): the optimistic finalize already handled
 *  success at the UI; ok just cleans up + checks the draft in. */
async function awaitAck(
  entry: QueueEntry,
  h: { id: string; tmp: string; ok: string; err: string },
): Promise<void> {
  const { connId, connKey, path } = entry;
  const key = fkey(connKey, path);
  const started = Date.now();
  const rec = { connKey, path, id: h.id };
  while (true) {
    const elapsed = Date.now() - started;
    await sleep(elapsed < 2_000 ? 250 : 1_000);
    if (Date.now() - started > 30_000) return; // park — the sweep / reconcile takes over
    try {
      const okFile = await fsReadFile(connId, h.ok).catch(() => null);
      if (okFile) {
        // A newer save may have superseded this one (queue collapse); only
        // the latest commit advances the tab's baseline, else we'd regress
        // the seed/mtime under a newer in-flight save.
        const latest = lastHash.get(key) === entry.contentHash;
        if (latest) {
          const st = await fsStat(connId, path).catch(() => null);
          const mtime = st?.modified ?? nowSecs();
          useAppStore.getState().markTabSaved(entry.tabId, mtime, entry.content);
          updateStub(connId, path, mtime, entry.content.length);
        }
        checkInDraft(connId, path, entry.contentHash);
        useVcsStore.getState().onFileChanged(connId, path);
        removeRec(rec);
        await fsRemove(connId, h.ok).catch(() => {});
        return;
      }
      const errFile = await fsReadFile(connId, h.err).catch(() => null);
      if (errFile) {
        const kind = errFile.content.trim();
        removeRec(rec);
        await fsRemove(connId, h.err).catch(() => {});
        // "changed" keeps the temp per the script but it's redundant (the
        // content is live in the tab + draft) — clean it. "fail" keeps it as
        // the safe copy.
        if (kind.startsWith("changed")) await fsRemove(connId, h.tmp).catch(() => {});
        reDirty(entry, h.tmp, kind);
        return;
      }
    } catch {
      /* transient (reconnect) — keep polling; reconcile also covers us */
    }
  }
}

/** A background save turned out NOT to have landed — undo the optimism: the
 *  tab goes dirty again with a banner/conflict, and the draft (never deleted
 *  before confirmation) still holds the content. Skipped if a newer save has
 *  already superseded this one — that save's ack is authoritative. */
function reDirty(entry: QueueEntry, tmp: string, kind: string): void {
  if (lastHash.get(fkey(entry.connKey, entry.path)) !== entry.contentHash) return;
  const s = useAppStore.getState();
  const tab = s.tabs.find((t) => t.id === entry.tabId);
  if (!tab) return;
  markTabUnsaved(entry.tabId);
  if (kind.startsWith("changed")) {
    // The target was modified by someone else before our commit — a genuine
    // conflict. Flag the tab (bar + Ctrl+S block); our content stays in the
    // buffer for Overwrite / Compare.
    s.setTabConflict(entry.tabId, true);
    notice(
      "warn",
      `${basename(entry.path)} changed on the server — your save was held back. Your version is safe in this tab; choose how to resolve it.`,
    );
  } else {
    // Commit failed (permissions, disk). The temp is kept as the safe copy.
    notice(
      "error",
      `Saving ${basename(entry.path)} failed on the server — your changes are safe in this tab and at ${tmp}.`,
    );
  }
}

// ---- lazy sweep of parked records ------------------------------------------

let sweepTimer: number | null = null;

/** Re-check parked pending saves on connected hosts every ~60 s (decision 13).
 *  Idempotent to start; runs for the app's life. */
export function startSaveSweep(): void {
  if (sweepTimer !== null) return;
  sweepTimer = window.setInterval(() => {
    const recs = loadRecs();
    if (recs.length === 0) return;
    for (const connKey of new Set(recs.map((r) => r.connKey))) {
      const connId = connIdForConnKey(connKey);
      if (connId) void reconcilePendingSaves(connId, connKey);
    }
  }, 60_000);
}

function connIdForConnKey(connKey: string): string | null {
  const s = useAppStore.getState();
  if (connKey === "local") return s.localConnId;
  if (connKey.startsWith("wsl:")) {
    return s.wsls.find((w) => w.conn.name === connKey.slice(4))?.conn.connId ?? null;
  }
  return (
    s.remotes.find(
      (r) => `${r.conn.user}@${r.conn.host}:${r.conn.port}` === connKey,
    )?.conn.connId ?? null
  );
}

// ---- S5 reconcile (reconnect / relaunch / sweep) ---------------------------

/** Reconcile a host's pending saves. Markers found are consumed; with no
 *  marker, drafts are the primary recovery, a complete temp with an unmoved
 *  baseline is committed ("finish the interrupted save"), and anything
 *  ambiguous keeps the temp — never delete the only complete copy. */
export async function reconcilePendingSaves(
  connId: string,
  connKey: string,
): Promise<void> {
  for (const rec of loadRecs().filter((r) => r.connKey === connKey)) {
    try {
      const okFile = await fsReadFile(connId, rec.ok).catch(() => null);
      if (okFile) {
        checkInDraft(connId, rec.path, rec.contentHash);
        useVcsStore.getState().onFileChanged(connId, rec.path);
        removeRec(rec);
        await fsRemove(connId, rec.ok).catch(() => {});
        continue;
      }
      const errFile = await fsReadFile(connId, rec.err).catch(() => null);
      if (errFile) {
        const kind = errFile.content.trim();
        notice(
          kind.startsWith("changed") ? "warn" : "error",
          kind.startsWith("changed")
            ? `${basename(rec.path)} changed on the server before an earlier save could apply — that version is kept at ${rec.tmp}.`
            : `An earlier save of ${basename(rec.path)} failed on the server — the unsaved version is kept at ${rec.tmp}.`,
        );
        removeRec(rec);
        await fsRemove(connId, rec.err).catch(() => {});
        continue;
      }
      // No marker — job may still be running (or a live ack loop owns it).
      if (Date.now() - rec.at < 30_000) continue;

      if (hasDraft(connKey, rec.path)) {
        await fsRemove(connId, rec.tmp).catch(() => {});
        removeRec(rec);
        continue;
      }
      const tmpSt = await fsStat(connId, rec.tmp).catch(() => null);
      if (!tmpSt || tmpSt.size !== rec.byteSize) {
        if (tmpSt) await fsRemove(connId, rec.tmp).catch(() => {});
        removeRec(rec);
        continue;
      }
      const origSt = await fsStat(connId, rec.path).catch(() => null);
      if (origSt && origSt.modified === rec.baselineMtime) {
        // Finish what Ctrl+S started (also the self-heal for a mid-cp power
        // loss). Re-dispatch with the SAME guard the original used.
        await saveCommit(
          connId,
          dirOf(rec.path),
          rec.tmp,
          rec.path,
          rec.ok,
          rec.err,
          rec.expectedHash,
        );
        await sleep(1_000);
        const ok2 = await fsReadFile(connId, rec.ok).catch(() => null);
        if (ok2) {
          removeRec(rec);
          await fsRemove(connId, rec.ok).catch(() => {});
          notice("info", `Finished an interrupted save of ${basename(rec.path)}.`);
        }
        continue;
      }
      notice(
        "warn",
        `${basename(rec.path)} changed on the server after an interrupted save — that unsaved version is kept at ${rec.tmp}.`,
      );
      removeRec(rec);
    } catch {
      /* per-record best-effort; the record survives for the next pass */
    }
  }
}

/** Whether a file has a staged save awaiting confirmation — the auto-reload
 *  poll skips these so it doesn't reload the tab from our own in-flight
 *  commit. */
export function hasPendingSave(connId: string, path: string): boolean {
  const connKey = connKeyForConnId(connId);
  if (!connKey) return false;
  return loadRecs().some((r) => r.connKey === connKey && r.path === path);
}

/** Conflict dialog's Overwrite on a remote tab: force past the guard. */
export async function stagedOverwrite(
  tabId: string,
  content: string,
): Promise<StagedOutcome> {
  return stagedSaveTab(tabId, content, getTabVersionId(tabId), { force: true });
}
