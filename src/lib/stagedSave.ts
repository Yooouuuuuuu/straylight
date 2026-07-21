/** Staged remote saves — frontend driver for docs/atomic-save.md, background-
 *  ack revision (2026-07-15).
 *
 *  A save is OPTIMISTIC: the tab is marked saved the moment its content is
 *  uploaded to a `.straysave` temp and the detached server-side commit is
 *  dispatched (S1–S3). Confirmation runs in the BACKGROUND (S4) and only
 *  matters when it fails — any non-confirmed exit re-dirties the tab loudly. A
 *  local draft, written BEFORE the dispatch (`ensureDraftForSave`) so it holds
 *  even for a save fired inside the edit debounce, keeps the content until the
 *  ok is truly confirmed. Nothing rests on the optimistic signal.
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
import { checkInDraft, ensureDraftForSave, hasDraft, updateStub } from "./drafts";
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

/** Re-raise the dirty dot on an open tab whose save didn't confirm — the local
 *  draft still holds the content, but the tab must not keep looking saved.
 *  No-op if the tab isn't open, or is already dirty. */
function reDirtyOpenTab(connId: string, path: string): void {
  const s = useAppStore.getState();
  const tab = s.tabs.find(
    (t) =>
      t.connId === connId &&
      t.path === path &&
      (!t.kind || t.kind === "file") &&
      !t.dirty,
  );
  if (tab) markTabUnsaved(tab.id);
}

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
 *  newest pending save; only it is ever dispatched. `startedAt` stamps the
 *  running dispatch so a reconnect-reconcile can tell a doomed attempt (began
 *  before the link died) from a healthy live one. */
const queues = new Map<
  string,
  { running: boolean; next: QueueEntry | null; startedAt?: number }
>();
/** The hash last committed (or in flight) per file, so a rapid follow-up save
 *  guards against what WE are about to write, not a stale disk read. */
const lastHash = new Map<string, string>();

/** Reset the guard chain after an attempt resolves WITHOUT landing: the next
 *  save must expect the last content confirmed on the server — not the content
 *  the dead attempt optimistically advanced the tab to (which would make its
 *  guard refuse as "changed" on every retry). `"-"` (a force save) or `null`
 *  (an external change: server content now unknown) drops the chain, falling
 *  back to the tab's seed. */
function resetGuard(key: string, expected: string | null): void {
  if (expected === null || expected === "-") lastHash.delete(key);
  else lastHash.set(key, expected);
}

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

  // Guarantee a local draft backs this content BEFORE the dirty dot clears, so
  // an in-flight save that never confirms is always recoverable (the invariant
  // this file's header promises). checkInDraft removes it once the ok lands.
  await ensureDraftForSave(tabId, content, entry.contentHash);
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
  s.setTabDraft(entry.tabId, { draftApplied: false });
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
    q.startedAt = Date.now();
    await dispatchOne(entry);
    // Doomed and replaced while we were stuck on a dead link? A fresh worker
    // owns this file now — exit without touching its state.
    if (queues.get(key) !== q) return;
  }
  q.running = false;
  if (queues.get(key) === q && !q.next) queues.delete(key);
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

  // A parked earlier attempt for this file is superseded — sweep its temp
  // best-effort, so replacing its record below can't orphan the temp. (A
  // young record is a just-dispatched attempt whose server-side commit may
  // still be running; its markers resolve it — leave it alone.)
  const prev = loadRecs().find((r) => r.connKey === connKey && r.path === path);
  if (prev && Date.now() - prev.at >= 30_000) {
    await fsRemove(connId, prev.tmp).catch(() => {});
  }

  // Record BEFORE the first network byte (localStorage is synchronous), so an
  // upload cut short — dropped link, killed app — always leaves a record, and
  // reconcile owns its temp: sweep the partial, re-dirty the tab. Without
  // this, an interrupted upload was an untracked orphan that accumulated.
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

  // S1 — stage upload.
  try {
    await fsWriteFile(connId, tmp, content, null);
  } catch {
    // The upload died (drop, host error). If a reconnect-reconcile already
    // resolved this record it also re-dirtied — stay silent then; the id
    // check tells the two apart (a newer save reuses the slot, fresh id).
    const owned = loadRecs().some(
      (r) => r.connKey === connKey && r.path === path && r.id === id,
    );
    const cleaned = await fsRemove(connId, tmp).then(() => true).catch(() => false);
    if (owned) {
      // The attempt died before landing — the next save (queued or future)
      // must guard against the server's REAL content again.
      resetGuard(key, guard);
      // Keep the record while the temp is unreachable (mid-outage) — the
      // next connected reconcile sweeps both.
      if (cleaned) removeRec({ connKey, path, id });
      if (!queues.get(key)?.next) {
        reDirtyOpenTab(connId, path);
        notice(
          "error",
          `Couldn't stage ${basename(path)} on the server — your changes are safe in this tab.`,
        );
      }
    }
    return;
  }

  // Chain the guard immediately so a rapid follow-up save expects THIS
  // content, then dispatch the detached commit.
  lastHash.set(key, entry.contentHash);
  try {
    await saveCommit(connId, dir, tmp, path, ok, err, guard);
  } catch {
    // Same shape as the upload catch: silent if a reconcile already owns it.
    const owned = loadRecs().some(
      (r) => r.connKey === connKey && r.path === path && r.id === id,
    );
    const cleaned = await fsRemove(connId, tmp).then(() => true).catch(() => false);
    if (owned) {
      resetGuard(key, guard); // roll back the chained-in-flight hash above
      if (cleaned) removeRec({ connKey, path, id });
      if (!queues.get(key)?.next) {
        reDirtyOpenTab(connId, path);
        notice(
          "error",
          `Couldn't finish saving ${basename(path)} on the server — your changes are safe in this tab.`,
        );
      }
    }
    return;
  }
  await awaitAck(entry, { id, tmp, ok, err, guard });
}

/** S4 — background acknowledgement. Poll fast then slow, then PARK. Only acts
 *  on FAILURE (changed / fail): the optimistic finalize already handled
 *  success at the UI; ok just cleans up + checks the draft in. */
async function awaitAck(
  entry: QueueEntry,
  h: { id: string; tmp: string; ok: string; err: string; guard: string },
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
        // The attempt resolved without landing — reset the guard chain so the
        // NEXT save expects the server's real content ("changed" drops the
        // chain entirely: the server moved to unknown content). Skip if a
        // newer save already owns the chain.
        if (lastHash.get(key) === entry.contentHash) {
          resetGuard(key, kind.startsWith("changed") ? null : h.guard);
        }
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

/** Whether a host is currently connected. Local always is; a reconnecting or
 *  dropped host is not — reconcile waits for the reconnect to call it. */
function connReady(connKey: string): boolean {
  const s = useAppStore.getState();
  if (connKey === "local") return true;
  if (connKey.startsWith("wsl:")) {
    return s.wsls.find((w) => w.conn.name === connKey.slice(4))?.state === "connected";
  }
  return (
    s.remotes.find(
      (r) => `${r.conn.user}@${r.conn.host}:${r.conn.port}` === connKey,
    )?.state === "connected"
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
  staleBefore?: number,
): Promise<void> {
  // Only reconcile a reachable host — running mid-outage would half-resolve
  // records (e.g. drop a record whose temp we couldn't actually remove).
  if (!connReady(connKey)) return;
  for (const rec of loadRecs().filter((r) => r.connKey === connKey)) {
    try {
      // A live queue worker owns its file's record — unless the running
      // dispatch began before `staleBefore` (a reconnect: that attempt died
      // with the old link and will never confirm on its own; resolve it now).
      let doomed = false;
      const q = queues.get(fkey(connKey, rec.path));
      if (q?.running) {
        doomed = staleBefore !== undefined && (q.startedAt ?? 0) < staleBefore;
        if (!doomed) continue;
        // Detach the queue from the doomed worker so nothing waits on the old
        // transport's ~45 s death: a save queued behind the dead attempt (or
        // the user's next Ctrl+S) dispatches NOW on the fresh link. The old
        // worker exits via the identity check in runQueue; its op can't land
        // anything (dead transport, distinct temp path).
        const k = fkey(connKey, rec.path);
        queues.delete(k);
        const next = q.next;
        q.next = null;
        if (next) {
          queues.set(k, { running: false, next });
          void runQueue(k);
        }
      }
      const okFile = await fsReadFile(connId, rec.ok).catch(() => null);
      if (okFile) {
        // Confirmed landed — the chain now truthfully expects this content.
        lastHash.set(fkey(connKey, rec.path), rec.contentHash);
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
        reDirtyOpenTab(connId, rec.path);
        resetGuard(
          fkey(connKey, rec.path),
          kind.startsWith("changed") ? null : rec.expectedHash,
        );
        removeRec(rec);
        await fsRemove(connId, rec.err).catch(() => {});
        continue;
      }
      // No marker — the job may still be running (or a live ack loop owns
      // it). A doomed attempt can't still be running: its link is gone.
      if (!doomed && Date.now() - rec.at < 30_000) continue;

      if (hasDraft(connKey, rec.path)) {
        reDirtyOpenTab(connId, rec.path);
        resetGuard(fkey(connKey, rec.path), rec.expectedHash);
        await fsRemove(connId, rec.tmp).catch(() => {});
        removeRec(rec);
        continue;
      }
      const tmpSt = await fsStat(connId, rec.tmp).catch(() => null);
      if (!tmpSt || tmpSt.size !== rec.byteSize) {
        reDirtyOpenTab(connId, rec.path);
        resetGuard(fkey(connKey, rec.path), rec.expectedHash);
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
          lastHash.set(fkey(connKey, rec.path), rec.contentHash);
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
      reDirtyOpenTab(connId, rec.path);
      resetGuard(fkey(connKey, rec.path), null);
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
