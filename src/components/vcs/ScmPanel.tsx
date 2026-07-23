/** Right-side Source Control panel: a stack of per-repo cards. Repos are opened
 *  explicitly (validated as a real repo). Local repos are file-watched live;
 *  WSL/remote repos are ◉-monitored (silent ~5 s polls while the window is
 *  focused) unless toggled off. A manual refresh shows a spinner that doubles
 *  as a cancel; git cards carry the full mutation surface while jj cards are
 *  view-first (bookmark switch/create, discard, fetch — see
 *  docs/version-control.md). */
import { useEffect, useState, type ReactNode } from "react";

import { useAppStore } from "../../store/appStore";
import { useVcsStore, type TrackedRepo } from "../../store/vcsStore";
import { hostColorForConnKey } from "../../lib/hostColors";
import { basename } from "../../lib/format";
import { openDiff, openMergeEditor } from "../../lib/openDiff";
import { openFileByPath } from "../../lib/openFile";
import { vcsBranches, type VcsBranch } from "../../lib/ipc";
import { vcsClass, vcsLetter } from "../../lib/vcsDecorations";
import { FolderBrowser } from "../FolderBrowser";
import { RelativeTime, formatAgo } from "../RelativeTime";
import { Tip } from "../Tooltip";
import {
  IconArrowDown,
  IconArrowUp,
  IconChevron,
  IconClose,
  IconMore,
  IconPanelHide,
  IconPencil,
  IconPlus,
  IconPulse,
  IconToBar,
  IconPulseOff,
  IconRefresh,
  IconUndo,
} from "../icons";

interface ConnChoice {
  connId: string;
  label: string;
  showDrives: boolean;
}

export function ScmPanel() {
  const repos = useVcsStore((s) => s.repos);
  const setScmVisible = useVcsStore((s) => s.setScmVisible);
  const openRepo = useVcsStore((s) => s.openRepo);
  const dockOrder = useAppStore((s) => s.dockOrder);
  const stepDock = useAppStore((s) => s.stepDock);
  const scmPos = dockOrder.indexOf("scm");
  const localConnId = useAppStore((s) => s.localConnId);
  const remotes = useAppStore((s) => s.remotes);
  const wsls = useAppStore((s) => s.wsls);

  const [picking, setPicking] = useState(false);
  const [browse, setBrowse] = useState<ConnChoice | null>(null);

  // Explorer ⑂ handoff: scroll the requested repo's card into view (the card
  // list can be taller than the panel), then clear the request.
  const revealRepo = useVcsStore((s) => s.revealRepo);
  const clearReveal = useVcsStore((s) => s.clearReveal);
  useEffect(() => {
    if (!revealRepo) return;
    document
      .querySelector(`[data-repo-id="${CSS.escape(revealRepo)}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    clearReveal();
  }, [revealRepo, clearReveal]);

  const conns: ConnChoice[] = [
    localConnId
      ? { connId: localConnId, label: "Local", showDrives: true }
      : null,
    ...wsls.map((w) => ({
      connId: w.conn.connId,
      label: w.conn.name,
      showDrives: false,
    })),
    ...remotes.map((r) => ({
      connId: r.conn.connId,
      label: r.conn.name,
      showDrives: false,
    })),
  ].filter((c): c is ConnChoice => c !== null);

  const startOpen = () => {
    if (conns.length === 1) setBrowse(conns[0]);
    else setPicking(true);
  };

  return (
    <div className="scm">
      <div className="scm__head">
        <span className="scm__title">Source Control</span>
        <Tip label="Open a repository">
          <button
            className="icon-btn"
            disabled={conns.length === 0}
            onClick={startOpen}
          >
            <IconPlus />
          </button>
        </Tip>
        <Tip label="Refresh all repositories">
          <button
            className="icon-btn"
            disabled={repos.length === 0}
            onClick={() => useVcsStore.getState().refreshAll(0)}
          >
            <IconRefresh />
          </button>
        </Tip>
        <Tip label="Move left">
          <button
            className="icon-btn"
            disabled={scmPos <= 0}
            onClick={() => stepDock("scm", -1)}
          >
            <IconToBar size={13} dir="left" />
          </button>
        </Tip>
        <Tip label="Move right">
          <button
            className="icon-btn"
            disabled={scmPos === dockOrder.length - 1}
            onClick={() => stepDock("scm", 1)}
          >
            <IconToBar size={13} dir="right" />
          </button>
        </Tip>
        <Tip label="Minimize">
          <button
            className="icon-btn panel-head__hide"
            onClick={() => setScmVisible(false)}
          >
            <IconPanelHide size={14} />
          </button>
        </Tip>
      </div>

      {picking && (
        <div className="scm__picker">
          <div className="scm__picker-label">Open a repository on…</div>
          {conns.map((c) => (
            <button
              key={c.connId}
              className="scm__picker-item"
              onClick={() => {
                setPicking(false);
                setBrowse(c);
              }}
            >
              {c.label}
            </button>
          ))}
          <button className="btn btn--ghost" onClick={() => setPicking(false)}>
            Cancel
          </button>
        </div>
      )}

      <div
        className="scm__body"
        // Never show the blocked cursor while dragging a card around the
        // panel — dropping on empty space just puts it back (no-op).
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("application/x-straylight-repo")) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }
        }}
      >
        {repos.length === 0 ? (
          <div className="scm__empty">No repositories. Click + to open one.</div>
        ) : (
          repos.map((r) => <RepoCard key={`${r.connKey}::${r.root}`} repo={r} />)
        )}
      </div>

      {browse && (
        <FolderBrowser
          connId={browse.connId}
          title={`Open a repository on ${browse.label}`}
          showDrives={browse.showDrives}
          onPick={(path) => {
            const connId = browse.connId;
            setBrowse(null);
            void openRepo(connId, path);
          }}
          onClose={() => setBrowse(null)}
        />
      )}
    </div>
  );
}

function summarize(repo: TrackedRepo): string {
  if (!repo.status) return "";
  const n = repo.status.changes.filter((c) => c.kind !== "ignored").length;
  return n === 0 ? "no changes" : `${n} change${n === 1 ? "" : "s"}`;
}

function RepoCard({ repo }: { repo: TrackedRepo }) {
  const localConnId = useAppStore((s) => s.localConnId);
  const isLocal = repo.connId !== null && repo.connId === localConnId;
  const cancelRefresh = useVcsStore((s) => s.cancelRefresh);
  const toggleEager = useVcsStore((s) => s.toggleEager);
  const removeRepo = useVcsStore((s) => s.removeRepo);
  const showHistory = useVcsStore((s) => s.showHistory);
  const closeHistory = useVcsStore((s) => s.closeHistory);
  const historyShown = useVcsStore(
    (s) => s.historyRepo?.connKey === repo.connKey && s.historyRepo?.root === repo.root,
  );
  const stage = useVcsStore((s) => s.stage);
  const unstage = useVcsStore((s) => s.unstage);
  const commit = useVcsStore((s) => s.commit);
  const remoteOp = useVcsStore((s) => s.remoteOp);
  const cancelRemoteOp = useVcsStore((s) => s.cancelRemoteOp);
  const requestDiscard = useVcsStore((s) => s.requestDiscard);
  const amend = useVcsStore((s) => s.amend);
  const stash = useVcsStore((s) => s.stash);
  const toggleCommitOpen = useVcsStore((s) => s.toggleCommitOpen);
  const askConfirm = useVcsStore((s) => s.askConfirm);
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [amendMode, setAmendMode] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  // Frame color = whose machine this repo lives on (host identity, not
  // per-repo; positional — re-render on remote reorder).
  useAppStore((s) => s.remotes);
  const moveRepo = useVcsStore((s) => s.moveRepo);

  const st = repo.status;
  const inactive = !repo.connId;
  const loading = repo.activity === "loading";
  const isGit = repo.backend !== "jj";
  // Ignored entries exist only to dim the explorer — never in the panel lists.
  const changes = (st?.changes ?? []).filter((c) => c.kind !== "ignored");
  const conflicted = changes.filter((c) => c.kind === "conflicted");
  const staged = changes.filter((c) => c.staged && c.kind !== "conflicted");
  const unstaged = changes.filter((c) => !c.staged && c.kind !== "conflicted");
  const jjChanges = changes.filter((c) => c.kind !== "conflicted");

  // The commit box is git-only: jj mutations are terminal-driven by design
  // (jj is visualized, not wrapped — drive a colocated repo as git for
  // buttons). See docs/version-control.md.
  const commitBoxOpen = !inactive && !!st && isGit && !!repo.uiCommitOpen;
  const canCommit =
    !inactive &&
    (amendMode
      ? message.trim().length > 0 || staged.length > 0
      : message.trim().length > 0 && staged.length > 0);

  const exitModes = () => {
    setAmendMode(false);
  };

  const runCommit = async () => {
    setCommitting(true);
    const ok = amendMode
      ? await amend(repo.connKey, repo.root, message.trim())
      : await commit(repo.connKey, repo.root, message.trim());
    setCommitting(false);
    if (ok) {
      setMessage("");
      exitModes();
    }
  };

  const doCommit = () => {
    // Amending a commit that's already upstream rewrites published history.
    if (amendMode && st?.ahead === 0) {
      askConfirm(
        "Amend a pushed commit?",
        "The last commit is already on the remote — amending rewrites published history.",
        () => void runCommit(),
        "vcs-amend-pushed",
      );
    } else {
      void runCommit();
    }
  };

  const openConflictFile = (path: string) => {
    if (!repo.connId) return;
    const root = repo.root.replace(/\\/g, "/").replace(/\/+$/, "");
    void openFileByPath(repo.connId, `${root}/${path}`, basename(path));
  };

  const changeRow = (c: (typeof changes)[number], action: ReactNode) => (
    <div
      className="change-row"
      key={c.path}
      onClick={() => void openDiff(repo, c)}
    >
      <span className={`change-row__badge ${vcsClass(c.kind)}`}>
        {vcsLetter(c.kind) || "•"}
      </span>
      <Tip label={`${c.path} — open diff`}>
        <span className="change-row__path">{c.path}</span>
      </Tip>
      <Tip label="Discard changes">
        <button
          className="change-row__act change-row__act--discard"
          onClick={(e) => {
            e.stopPropagation();
            requestDiscard(repo.connKey, repo.root, [c]);
          }}
        >
          <IconUndo size={13} />
        </button>
      </Tip>
      {action}
    </div>
  );

  const dragId = `${repo.connKey}::${repo.root}`;
  // Insertion preview while another card is dragged over this one — above or
  // below the midpoint decides where it would land (tab-strip style).
  const [dropPos, setDropPos] = useState<"before" | "after" | null>(null);

  return (
    <div
      className={`repo-card ${dropPos ? `repo-card--drop-${dropPos}` : ""}`}
      data-repo-id={`${repo.connKey}::${repo.root}`}
      style={{ "--host-color": hostColorForConnKey(repo.connKey) } as React.CSSProperties}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("application/x-straylight-repo")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const rect = e.currentTarget.getBoundingClientRect();
          setDropPos(e.clientY < rect.top + rect.height / 2 ? "before" : "after");
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropPos(null);
      }}
      onDrop={(e) => {
        const from = e.dataTransfer.getData("application/x-straylight-repo");
        if (from && from !== dragId) {
          e.preventDefault();
          moveRepo(from, dragId, dropPos === "after");
        }
        setDropPos(null);
      }}
    >
      <div
        className="repo-card__head"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-straylight-repo", dragId);
          e.dataTransfer.effectAllowed = "move";
        }}
      >
        {repo.backend === "jj" || repo.colocated ? (
          <Tip
            label={`Colocated — drive with ${repo.backend === "jj" ? "git" : "jj"} instead`}
          >
            <button
              className={`repo-card__backend repo-card__backend--${repo.backend} repo-card__backend--toggle`}
              onClick={() =>
                useVcsStore.getState().toggleBackend(repo.connKey, repo.root)
              }
            >
              {repo.backend}
            </button>
          </Tip>
        ) : (
          <Tip label="git repository">
            <span
              className={`repo-card__backend repo-card__backend--${repo.backend}`}
            >
              {repo.backend}
            </span>
          </Tip>
        )}
        <Tip label={`${repo.connKey} — ${repo.root}`}>
          <span className="repo-card__name">{repo.label}</span>
        </Tip>
        <Tip label={historyShown ? "Hide history" : "Commit history"}>
          <button
            className={`icon-btn ${historyShown ? "icon-btn--active" : ""}`}
            disabled={inactive}
            onClick={() =>
              historyShown ? closeHistory() : showHistory(repo.connKey, repo.root)
            }
          >
            ⎇
          </button>
        </Tip>
        {isLocal ? (
          <Tip label="Watched live">
            <span className="icon-btn icon-btn--static">
              <IconPulse size={14} />
            </span>
          </Tip>
        ) : (
          <Tip
            label={
              repo.eager
                ? "Monitoring every 5 s — click to stop"
                : "Not monitored — click to monitor"
            }
          >
            <button
              className="icon-btn"
              onClick={() => toggleEager(repo.connKey, repo.root)}
            >
              {repo.eager ? <IconPulse size={14} /> : <IconPulseOff size={14} />}
            </button>
          </Tip>
        )}
        {loading && (
          <Tip label="Refreshing — click to cancel">
            <button
              className="icon-btn"
              onClick={() => cancelRefresh(repo.connKey, repo.root)}
            >
              <span className="spinner spinner--sm" />
            </button>
          </Tip>
        )}
        <Tip label="Remove from Source Control">
          <button
            className="icon-btn icon-btn--danger"
            onClick={() =>
              askConfirm(
                "Remove repository?",
                `Remove "${repo.label}" from Source Control? Nothing on disk is touched — you can re-add it any time.`,
                () => removeRepo(repo.connKey, repo.root),
                "remove-repo",
              )
            }
          >
            <IconClose />
          </button>
        </Tip>
      </div>

      <div className="repo-card__meta">
        {inactive ? (
          <span className="repo-card__offline">offline</span>
        ) : st ? (
          <>
            <Tip label="Switch / create branch">
              <span
                className="repo-card__branch repo-card__branch--btn"
                onClick={() => {
                  setActionsOpen(false);
                  setBranchOpen((o) => !o);
                }}
              >
                {st.ref || "—"} <IconChevron size={11} dir="down" />
              </span>
            </Tip>
            {(st.ahead || st.behind) && (
              <span className="repo-card__ab">
                {st.ahead ? (
                  <>
                    ↑<sup className="sup-count">{st.ahead}</sup>
                  </>
                ) : null}
                {st.behind ? (
                  <>
                    ↓<sup className="sup-count">{st.behind}</sup>
                  </>
                ) : null}
              </span>
            )}
            <span className="repo-card__count">{summarize(repo)}</span>
            <span className="repo-card__meta-btns">
              {isGit && (
                <Tip label="Commit / amend">
                  <button
                    className={`icon-btn ${commitBoxOpen ? "icon-btn--active" : ""}`}
                    onClick={() => {
                      if (commitBoxOpen) exitModes();
                      toggleCommitOpen(repo.connKey, repo.root);
                    }}
                  >
                    <IconPencil size={13} />
                  </button>
                </Tip>
              )}
              {isGit && (
                <Tip
                  label={
                    st.ahead
                      ? `Push ${st.ahead} commit${st.ahead === 1 ? "" : "s"}`
                      : "Push"
                  }
                >
                  <button
                    className="icon-btn"
                    disabled={st.ahead === 0}
                    onClick={() =>
                      askConfirm(
                        "Push to the remote?",
                        `Push ${st.ahead ? `${st.ahead} commit${st.ahead === 1 ? "" : "s"}` : "your commits"} upstream?`,
                        () => void remoteOp(repo.connKey, repo.root, "push"),
                        "vcs-push",
                      )
                    }
                  >
                    {repo.remoteBusy === "push" ? (
                      <span className="spinner spinner--sm" />
                    ) : (
                      <>
                        <IconArrowUp size={13} />
                        {st.ahead ? (
                          <sup className="sup-count">{st.ahead}</sup>
                        ) : null}
                      </>
                    )}
                  </button>
                </Tip>
              )}
              <Tip label="Fetch incoming commits">
                <button
                  className="icon-btn"
                  onClick={() => {
                    const s = useVcsStore.getState();
                    s.unhideIncoming(repo.connKey, repo.root);
                    void remoteOp(repo.connKey, repo.root, "fetch");
                    s.showHistory(repo.connKey, repo.root);
                  }}
                >
                  {repo.remoteBusy === "fetch" || repo.remoteBusy === "pull" ? (
                    <span className="spinner spinner--sm" />
                  ) : (
                    <IconArrowDown size={13} />
                  )}
                </button>
              </Tip>
              {isGit && (
                <Tip label="Stash & pop">
                  <button
                    className={`icon-btn ${actionsOpen ? "icon-btn--active" : ""}`}
                    onClick={() => {
                      setBranchOpen(false);
                      setActionsOpen((o) => !o);
                    }}
                  >
                    {repo.remoteBusy === "update" ? (
                      <span className="spinner spinner--sm" />
                    ) : (
                      <IconMore size={13} />
                    )}
                  </button>
                </Tip>
              )}
            </span>
          </>
        ) : (
          <span className="repo-card__count">not loaded</span>
        )}
      </div>

      {branchOpen && !inactive && (
        <BranchMenu repo={repo} onClose={() => setBranchOpen(false)} />
      )}

      {actionsOpen && !inactive && st && isGit && (
        <div className="action-menu">
          <button
            className="action-menu__item"
            disabled={changes.length === 0}
            onClick={() => {
              setActionsOpen(false);
              void stash(repo.connKey, repo.root, "push", "");
            }}
          >
            Stash <span className="action-menu__hint">set changes aside</span>
          </button>
          <button
            className="action-menu__item"
            onClick={() => {
              setActionsOpen(false);
              askConfirm(
                "Pop the latest stash?",
                "Apply the most recent stash to your working tree? Conflicts are possible.",
                () => void stash(repo.connKey, repo.root, "pop", ""),
                "vcs-stash-pop",
              );
            }}
          >
            Pop stash
          </button>
        </div>
      )}

      {repo.error && <div className="repo-card__error">{repo.error}</div>}

      {repo.remoteBusy && (
        <div className="repo-card__banner">
          <span>
            <span className="spinner spinner--sm" /> {repo.remoteBusy} running — an
            auth prompt can hang here (no TTY).
          </span>
          <button
            className="repo-card__group-act"
            onClick={() => cancelRemoteOp(repo.connKey, repo.root)}
          >
            Cancel
          </button>
        </div>
      )}

      {commitBoxOpen && (
        <div className="repo-card__commit">
          <div className="repo-card__mode-switch">
            <button
              className={`repo-card__mode-btn ${!amendMode ? "repo-card__mode-btn--active" : ""}`}
              onClick={() => setAmendMode(false)}
            >
              Commit
            </button>
            <Tip label="Amend the last commit">
              <button
                className={`repo-card__mode-btn ${amendMode ? "repo-card__mode-btn--active" : ""}`}
                onClick={() => setAmendMode(true)}
              >
                Amend
              </button>
            </Tip>
          </div>
          <textarea
            className="repo-card__msg input--mono"
            rows={2}
            placeholder={
              amendMode
                ? "New message (leave empty to keep the current one)"
                : "Commit message (staged changes)"
            }
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <button
            className="btn btn--primary btn--block"
            disabled={!canCommit || committing}
            onClick={doCommit}
            title={
              !amendMode && staged.length === 0 ? "Stage changes first" : "Commit"
            }
          >
            {committing ? "Working…" : amendMode ? "Amend" : "Commit"}
          </button>
        </div>
      )}

      {repo.stashConflict && !inactive && (
        <div className="repo-card__banner">
          <span>Stash pop hit conflicts — resolve them, then drop the stash.</span>
          <button
            className="repo-card__group-act"
            onClick={() => void stash(repo.connKey, repo.root, "drop", "")}
          >
            Drop stash
          </button>
        </div>
      )}

      {conflicted.length > 0 && (
        <div className="repo-card__group">
          <div className="repo-card__group-head repo-card__group-head--conflict">
            <span>⚠ Conflicts ({conflicted.length})</span>
          </div>
          <div className="repo-card__changes">
            {conflicted.map((c) => (
              <div
                className="change-row"
                key={c.path}
                onClick={() => openConflictFile(c.path)}
              >
                <span className={`change-row__badge ${vcsClass(c.kind)}`}>!</span>
                <Tip label={`${c.path} — open to resolve the conflicts`}>
                  <span className="change-row__path">{c.path}</span>
                </Tip>
                <Tip label="Open in the merge editor">
                  <button
                    className="change-row__act"
                    onClick={(e) => {
                      e.stopPropagation();
                      void openMergeEditor(repo, c.path);
                    }}
                  >
                    ⚔
                  </button>
                </Tip>
                {isGit && (
                  <Tip label="Mark resolved (stage)">
                  <button
                    className="change-row__act"
                    onClick={(e) => {
                      e.stopPropagation();
                      void stage(repo.connKey, repo.root, [c.path]);
                    }}
                  >
                    ✓
                  </button>
                  </Tip>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {isGit ? (
        <>
          {staged.length > 0 && (
            <div className="repo-card__group">
              <div className="repo-card__group-head repo-card__group-head--staged">
                <span>✓ Staged Changes ({staged.length})</span>
                <button
                  className="repo-card__group-act"
                  onClick={() =>
                    void unstage(repo.connKey, repo.root, staged.map((c) => c.path))
                  }
                >
                  Unstage all
                </button>
              </div>
              <div className="repo-card__changes">
                {staged.map((c) =>
                  changeRow(
                    c,
                    <Tip label="Unstage">
                      <button
                        className="change-row__act"
                        onClick={(e) => {
                          e.stopPropagation();
                          void unstage(repo.connKey, repo.root, [c.path]);
                        }}
                      >
                        −
                      </button>
                    </Tip>,
                  ),
                )}
              </div>
            </div>
          )}
          {unstaged.length > 0 && (
            <div className="repo-card__group">
              <div className="repo-card__group-head">
                <span>Changes ({unstaged.length})</span>
                <button
                  className="repo-card__group-act"
                  onClick={() =>
                    void stage(repo.connKey, repo.root, unstaged.map((c) => c.path))
                  }
                >
                  Stage all
                </button>
              </div>
              <div className="repo-card__changes">
                {unstaged.map((c) =>
                  changeRow(
                    c,
                    <Tip label="Stage">
                      <button
                        className="change-row__act"
                        onClick={(e) => {
                          e.stopPropagation();
                          void stage(repo.connKey, repo.root, [c.path]);
                        }}
                      >
                        +
                      </button>
                    </Tip>,
                  ),
                )}
              </div>
            </div>
          )}
        </>
      ) : (
        jjChanges.length > 0 && (
          <div className="repo-card__changes">
            {jjChanges.map((c) => changeRow(c, null))}
          </div>
        )
      )}

      {loading ? (
        <div className="repo-card__stamp">updating…</div>
      ) : (
        repo.lastUpdated && (
          <Tip
            label={
              repo.lastChecked
                ? `${!isLocal && !repo.eager ? "not monitored — " : ""}checked ${formatAgo(
                    Math.max(0, Math.floor((Date.now() - repo.lastChecked) / 1000)),
                  )}${repo.lastCheckFailed ? " — last check failed" : ""}`
                : "not checked yet this session"
            }
          >
            <div className="repo-card__stamp">
              changed <RelativeTime at={repo.lastUpdated} title={null} />
            </div>
          </Tip>
        )
      )}
    </div>
  );
}

function BranchMenu({
  repo,
  onClose,
}: {
  repo: TrackedRepo;
  onClose: () => void;
}) {
  const switchBranch = useVcsStore((s) => s.switchBranch);
  const createBranch = useVcsStore((s) => s.createBranch);
  const [branches, setBranches] = useState<VcsBranch[] | null>(null);
  const [name, setName] = useState("");
  const isJj = repo.backend === "jj";

  const create = () => {
    if (!name.trim()) return;
    void createBranch(repo.connKey, repo.root, name.trim());
    onClose();
  };

  useEffect(() => {
    if (!repo.connId) return;
    let active = true;
    vcsBranches(repo.connId, repo.root, repo.backend)
      .then((b) => active && setBranches(b))
      .catch(() => active && setBranches([]));
    return () => {
      active = false;
    };
  }, [repo.connId, repo.root, repo.backend]);

  return (
    <div className="branch-menu">
      <div className="branch-menu__list">
        {branches === null ? (
          <div className="branch-menu__msg">
            <span className="spinner spinner--sm" /> Loading…
          </div>
        ) : branches.length === 0 ? (
          <div className="branch-menu__msg">
            No {isJj ? "bookmarks" : "branches"} yet.
          </div>
        ) : (
          <>
            {branches
              .filter((b) => !b.remote)
              .map((b) => (
                <button
                  key={b.name}
                  className={`branch-menu__item ${b.current ? "branch-menu__item--current" : ""}`}
                  // git: switching to the current branch is a no-op — disable.
                  // jj: "current" is the NEAREST bookmark (@ or @-), and
                  // `jj new <bookmark>` is always a valid move — never disable.
                  disabled={!isJj && b.current}
                  onClick={() => {
                    void switchBranch(repo.connKey, repo.root, b.name);
                    onClose();
                  }}
                >
                  {b.current ? "● " : ""}
                  {b.name}
                </button>
              ))}
            {branches.some((b) => b.remote) && (
              <div className="branch-menu__label">remote — click to check out</div>
            )}
            {branches
              .filter((b) => b.remote)
              .map((b) => (
                <Tip key={b.name} label={`Track ${b.name} locally`}>
                <button
                  className="branch-menu__item branch-menu__item--remote"
                  onClick={() => {
                    // "origin/x" → checkout "x": git's DWIM creates the
                    // tracking branch automatically.
                    const short = b.name.split("/").slice(1).join("/") || b.name;
                    void switchBranch(repo.connKey, repo.root, short);
                    onClose();
                  }}
                >
                  {b.name}
                </button>
                </Tip>
              ))}
          </>
        )}
      </div>
      <div className="branch-menu__create">
        <input
          className="input input--mono branch-menu__new"
          placeholder={isJj ? "New bookmark…" : "New branch…"}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
            else if (e.key === "Escape") onClose();
          }}
        />
        <Tip label={isJj ? "Create bookmark" : "Create branch"}>
          <button
            className="icon-btn branch-menu__add"
            disabled={!name.trim()}
            onClick={create}
          >
            ＋
          </button>
        </Tip>
      </div>
    </div>
  );
}
