/** A repo's commit history (newest first) as a **multi-lane graph**: branches
 *  and merges get their own lanes (git shows all local branches + HEAD; jj its
 *  default revset). Works for git and jj — the backend differs only in how the
 *  log is fetched; the lane layout comes from `lib/commitGraph`. */
import { useEffect, useMemo, useRef, useState } from "react";

import { computeGraph } from "../../lib/commitGraph";
import { PALETTE } from "../../lib/connectionColor";
import {
  vcsCommitFiles,
  vcsIncoming,
  vcsLog,
  type IncomingInfo,
  type VcsChange,
  type VcsCommit,
} from "../../lib/ipc";
import { openCommitDiff } from "../../lib/openDiff";
import { vcsClass, vcsLetter } from "../../lib/vcsDecorations";
import { basename } from "../../lib/format";
import { hostColorForConnKey } from "../../lib/hostColors";
import { useAppStore } from "../../store/appStore";
import { useVcsStore } from "../../store/vcsStore";
import { RelativeTime } from "../RelativeTime";
import { Tip } from "../Tooltip";

/** One-line header for the pop-out editor tab (the sidebar panel has its own
 *  two-row header): "GIT HISTORY · repo", host-colored. `backend` comes from
 *  the tab and stays in step with the repo card in BOTH directions: the swap
 *  button below flips the card, and the card/panel toggle patches this tab
 *  (vcsStore.toggleBackend → setLogTabBackend). */
export function VcsLogTabHead({
  connId,
  root,
  backend,
}: {
  connId: string;
  root: string;
  backend: string;
}) {
  const repos = useVcsStore((s) => s.repos);
  const hostColors = useAppStore((s) => s.hostColors);
  const repo = repos.find((r) => r.connId === connId && r.root === root);
  const color = repo
    ? hostColorForConnKey(hostColors, repo.connKey)
    : "var(--border)";
  return (
    <>
      <Tip label={root}>
        <div className="vcs-logtab__head" style={{ borderLeftColor: color }}>
          <span className="vcs-logtab__kind">
            {backend === "jj" ? "jj history" : "git history"}
          </span>
          {" · "}
          {repo?.label ?? basename(root)}
        </div>
      </Tip>
      {repo?.colocated && (
        <button
          className="history-swap history-swap--tab"
          onClick={() => {
            // Flip this tab's lens, and keep the repo card in agreement.
            const next = backend === "jj" ? "git" : "jj";
            useAppStore.getState().setLogTabBackend(connId, root, next);
            if (repo.backend !== next)
              useVcsStore.getState().toggleBackend(repo.connKey, repo.root);
          }}
        >
          swap to {backend === "jj" ? "git" : "jj"} history
        </button>
      )}
    </>
  );
}

type FileState = VcsChange[] | "loading" | "error";

// Rail geometry: must match `.commit-row` height in the CSS.
const LANE_W = 12;
const ROW_H = 46;
const MAX_LANES = 10;

/** Fetched-but-unmerged upstream commits (git), shown above the history in
 *  BOTH the sidebar panel and the editor log tab. Dismiss hides it (session-
 *  only) — the fetched refs stay put, and ⇣ Fetch brings the block back. */
function IncomingBlock({
  connId,
  root,
  backend,
}: {
  connId: string;
  root: string;
  backend: string;
}) {
  const repo = useVcsStore((s) =>
    s.repos.find((r) => r.connId === connId && r.root === root),
  );
  const hidden = useVcsStore(
    (s) => !!repo && s.incomingHidden[`${repo.connKey}::${repo.root}`],
  );
  const dismissIncoming = useVcsStore((s) => s.dismissIncoming);
  const updateFromRemote = useVcsStore((s) => s.updateFromRemote);
  const askConfirm = useVcsStore((s) => s.askConfirm);

  const [incoming, setIncoming] = useState<IncomingInfo | null>(null);
  const ref = repo?.status?.ref ?? null;
  const lastUpdated = repo?.lastUpdated ?? null;

  useEffect(() => {
    setIncoming(null);
    if (backend === "jj") return;
    let live = true;
    vcsIncoming(connId, root, backend)
      .then((info) => live && setIncoming(info))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [connId, root, backend, ref, lastUpdated]);

  if (!repo || backend === "jj" || hidden || !incoming) return null;
  if (incoming.upstream === null || incoming.commits.length === 0) return null;

  const merge = () => {
    const n = incoming.commits.length;
    askConfirm(
      `Merge into ${ref ?? "the current branch"}?`,
      `Merge ${n} fetched commit${n === 1 ? "" : "s"} from ${incoming.upstream} into your working tree?`,
      () => void updateFromRemote(repo.connKey, repo.root),
      "vcs-update",
    );
  };

  return (
    <div className="incoming">
      <div className="incoming__head">
        <span className="incoming__title">
          Incoming from {incoming.upstream} · {incoming.commits.length}
        </span>
        <span className="incoming__actions">
          <button className="btn btn--primary incoming__merge" onClick={merge}>
            Merge into {ref ?? "branch"}
          </button>
          <Tip label="Nothing is merged — ⇣ Fetch shows it again">
            <button
              className="btn btn--ghost incoming__merge"
              onClick={() => dismissIncoming(repo.connKey, repo.root)}
            >
              Dismiss
            </button>
          </Tip>
        </span>
      </div>
      {incoming.commits.map((c) => (
        <Tip key={c.id} label={`${c.id} · ${c.author}`}>
          <div className="incoming__row">
            <span className="incoming__id mono">{c.id}</span>
            <span className="incoming__subject">{c.subject}</span>
            {c.timestamp ? (
              <span className="incoming__when">
                <RelativeTime at={c.timestamp * 1000} title={null} />
              </span>
            ) : null}
          </div>
        </Tip>
      ))}
    </div>
  );
}
const laneX = (i: number) => 7 + i * LANE_W;
const laneColor = (i: number) => PALETTE[i % PALETTE.length];

export function VcsLogView({
  connId,
  root,
  backend,
}: {
  connId: string;
  root: string;
  backend: string;
}) {
  const [commits, setCommits] = useState<VcsCommit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [files, setFiles] = useState<Record<string, FileState>>({});
  const [limit, setLimit] = useState(200);
  const isJj = backend === "jj";

  const graph = useMemo(() => (commits ? computeGraph(commits) : null), [commits]);
  const railW = 7 + Math.min(graph?.width ?? 1, MAX_LANES) * LANE_W;

  // The history has no refresh of its own: it re-fetches whenever its repo's
  // status refreshes (watcher / focus / manual / mutation — one policy).
  const lastUpdated = useVcsStore(
    (s) => s.repos.find((r) => r.connId === connId && r.root === root)?.lastUpdated ?? null,
  );
  const repoKey = `${connId}::${root}::${backend}`;
  const prevKeyRef = useRef(repoKey);

  useEffect(() => {
    // Only blank the view when it's a different repo — a same-repo re-fetch
    // keeps the old list on screen until the new one lands (no flash).
    if (prevKeyRef.current !== repoKey) {
      prevKeyRef.current = repoKey;
      setCommits(null);
      setExpanded(new Set());
      setFiles({});
    }
    let active = true;
    setError(null);
    setSyncing(true);
    vcsLog(connId, root, backend, limit)
      .then((c) => {
        if (!active) return;
        setCommits(c);
        setSyncing(false);
      })
      .catch((e) => {
        if (!active) return;
        setError(String(e));
        setSyncing(false);
      });
    return () => {
      active = false;
    };
  }, [repoKey, connId, root, backend, lastUpdated, limit]);

  // Details are opt-in per commit: the list is a plain tree until you click.
  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        next.add(id);
        if (!files[id]) {
          setFiles((f) => ({ ...f, [id]: "loading" }));
          vcsCommitFiles(connId, root, backend, id)
            .then((list) => setFiles((f) => ({ ...f, [id]: list })))
            .catch(() => setFiles((f) => ({ ...f, [id]: "error" })));
        }
      }
      return next;
    });
  };

  return (
    <div className="vcs-log">
      <IncomingBlock connId={connId} root={root} backend={backend} />
      {error ? (
        <div className="vcs-log__msg">{error}</div>
      ) : commits === null ? (
        <div className="vcs-log__msg">
          <span className="spinner spinner--sm" /> Loading history…
        </div>
      ) : commits.length === 0 ? (
        <div className="vcs-log__msg">No commits.</div>
      ) : (
        <div className="vcs-log__list">
          {syncing && (
            <div className="vcs-log__sync">
              <span className="spinner spinner--sm" /> syncing…
            </div>
          )}
          {commits.map((c, i) => {
            const open = expanded.has(c.id);
            const fs = files[c.id];
            const row = graph?.rows[i];
            const dotX = laneX(row?.lane ?? 0);
            const dotColor = c.current
              ? "var(--green)"
              : c.parents.length > 1
                ? "var(--purple)"
                : laneColor(row?.lane ?? 0);
            return (
              <div className="commit-group" key={`${c.id}-${i}`}>
                <div
                  className="commit-row"
                  onClick={() => toggle(c.id)}
                >
                  <svg
                    className="commit-row__graph"
                    width={railW}
                    height={ROW_H}
                    aria-hidden="true"
                  >
                    {row?.through.map((l) => (
                      <line
                        key={`t${l}`}
                        x1={laneX(l)}
                        y1={0}
                        x2={laneX(l)}
                        y2={ROW_H}
                        stroke={laneColor(l)}
                      />
                    ))}
                    {row?.incoming.map((l) => (
                      <line
                        key={`i${l}`}
                        x1={laneX(l)}
                        y1={0}
                        x2={dotX}
                        y2={ROW_H / 2}
                        stroke={laneColor(l)}
                      />
                    ))}
                    {row?.outgoing.map((l) => (
                      <line
                        key={`o${l}`}
                        x1={dotX}
                        y1={ROW_H / 2}
                        x2={laneX(l)}
                        y2={ROW_H}
                        stroke={laneColor(l)}
                      />
                    ))}
                    <circle
                      cx={dotX}
                      cy={ROW_H / 2}
                      r={c.current ? 4.5 : 3.5}
                      fill={dotColor}
                    />
                  </svg>
                  <div className="commit-row__body">
                    <div className="commit-row__top">
                      {c.current && (
                        <span className="commit-row__ref commit-row__ref--head">
                          {isJj ? "@" : "HEAD"}
                        </span>
                      )}
                      {c.refs.map((r) => (
                        <span className="commit-row__ref" key={r}>
                          {r}
                        </span>
                      ))}
                      <span className="commit-row__subject">
                        {c.subject || "(no description)"}
                      </span>
                    </div>
                    <div className="commit-row__meta">
                      <span className="commit-row__id">{c.id}</span>
                      {c.author ? <span> · {c.author}</span> : null}
                      {c.timestamp ? (
                        <span>
                          {" · "}
                          <RelativeTime at={c.timestamp * 1000} title={null} />
                        </span>
                      ) : null}
                      {c.parents.length > 1 ? <span> · merge</span> : null}
                    </div>
                  </div>
                </div>
                {open && (
                  <div className="commit-files" style={{ paddingLeft: railW + 4 }}>
                    {fs === "loading" ? (
                      <div className="commit-files__msg">
                        <span className="spinner spinner--sm" /> Loading…
                      </div>
                    ) : fs === "error" || fs === undefined ? (
                      <div className="commit-files__msg">Couldn’t load files.</div>
                    ) : fs.length === 0 ? (
                      <div className="commit-files__msg">No file changes.</div>
                    ) : (
                      fs.map((ch) => (
                        <Tip
                          key={ch.path}
                          label={`${ch.path} — open diff at this commit`}
                        >
                          <div
                            className="change-row"
                            onClick={() =>
                              void openCommitDiff({ connId, root, backend }, c.id, ch)
                            }
                          >
                            <span className={`change-row__badge ${vcsClass(ch.kind)}`}>
                              {vcsLetter(ch.kind) || "•"}
                            </span>
                            <span className="change-row__path">{ch.path}</span>
                          </div>
                        </Tip>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {commits.length >= limit && (
            <button
              className="btn btn--ghost vcs-log__more"
              onClick={() => setLimit((l) => l + 300)}
            >
              Load older commits…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
