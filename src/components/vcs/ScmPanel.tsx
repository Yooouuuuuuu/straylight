/** Right-side Source Control panel: a stack of per-repo cards. Repos are opened
 *  explicitly (validated as a real repo), don't auto-refresh until toggled
 *  "eager", and show a running indicator (which doubles as a manual cancel).
 *  Slice 1 is read-only — the change list, branch, and counts; commit/diff come
 *  in later slices. */
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
import { RelativeTime } from "../RelativeTime";
import { Tip } from "../Tooltip";
import { IconClose, IconPanelCollapse, IconPlus, IconRefresh } from "../icons";

interface ConnChoice {
  connId: string;
  label: string;
  showDrives: boolean;
}

export function ScmPanel() {
  const repos = useVcsStore((s) => s.repos);
  const setScmVisible = useVcsStore((s) => s.setScmVisible);
  const openRepo = useVcsStore((s) => s.openRepo);
  const localConnId = useAppStore((s) => s.localConnId);
  const remote = useAppStore((s) => s.remote);
  const wsl = useAppStore((s) => s.wsl);

  const [picking, setPicking] = useState(false);
  const [browse, setBrowse] = useState<ConnChoice | null>(null);

  const conns: ConnChoice[] = [
    localConnId
      ? { connId: localConnId, label: "Local", showDrives: true }
      : null,
    remote ? { connId: remote.connId, label: remote.name, showDrives: false } : null,
    wsl ? { connId: wsl.connId, label: wsl.name, showDrives: false } : null,
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
        <Tip label="Minimize Source Control (status bar to bring it back)">
          <button className="icon-btn" onClick={() => setScmVisible(false)}>
            <IconPanelCollapse size={14} dir="right" />
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

      <div className="scm__body">
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
  const updateFromRemote = useVcsStore((s) => s.updateFromRemote);
  const describe = useVcsStore((s) => s.describe);
  const squash = useVcsStore((s) => s.squash);
  const toggleCommitOpen = useVcsStore((s) => s.toggleCommitOpen);
  const askConfirm = useVcsStore((s) => s.askConfirm);
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [amendMode, setAmendMode] = useState(false);
  const [describeMode, setDescribeMode] = useState<"@" | "@-" | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  // Frame color = whose machine this repo lives on (host identity, not per-repo).
  const hostColors = useAppStore((s) => s.hostColors);
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

  const commitBoxOpen = !inactive && !!st && !!repo.uiCommitOpen;
  const canCommit =
    !inactive &&
    (isGit
      ? amendMode
        ? message.trim().length > 0 || staged.length > 0
        : message.trim().length > 0 && staged.length > 0
      : describeMode !== null
        ? message.trim().length > 0
        : message.trim().length > 0 && jjChanges.length > 0);

  const exitModes = () => {
    setAmendMode(false);
    setDescribeMode(null);
  };

  const runCommit = async () => {
    setCommitting(true);
    let ok: boolean;
    if (isGit && amendMode) {
      ok = await amend(repo.connKey, repo.root, message.trim());
    } else if (!isGit && describeMode !== null) {
      ok = await describe(repo.connKey, repo.root, describeMode, message.trim());
    } else {
      ok = await commit(repo.connKey, repo.root, message.trim());
    }
    setCommitting(false);
    if (ok) {
      setMessage("");
      exitModes();
    }
  };

  const doCommit = () => {
    // Amending a commit that's already upstream rewrites published history.
    if (isGit && amendMode && st?.ahead === 0) {
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
      title={`${c.path} — open diff`}
      onClick={() => void openDiff(repo, c)}
    >
      <span className={`change-row__badge ${vcsClass(c.kind)}`}>
        {vcsLetter(c.kind) || "•"}
      </span>
      <span className="change-row__path">{c.path}</span>
      <button
        className="change-row__act change-row__act--discard"
        title="Discard changes"
        onClick={(e) => {
          e.stopPropagation();
          requestDiscard(repo.connKey, repo.root, [c]);
        }}
      >
        ↩
      </button>
      {action}
    </div>
  );

  const dragId = `${repo.connKey}::${repo.root}`;

  return (
    <div
      className="repo-card"
      style={{ borderColor: hostColorForConnKey(hostColors, repo.connKey) }}
      title={`${repo.connKey} — ${repo.root}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("application/x-straylight-repo")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(e) => {
        const from = e.dataTransfer.getData("application/x-straylight-repo");
        if (from && from !== dragId) {
          e.preventDefault();
          moveRepo(from, dragId);
        }
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
          <button
            className={`repo-card__backend repo-card__backend--${repo.backend} repo-card__backend--toggle`}
            title={`Colocated repo — click to drive it with ${repo.backend === "jj" ? "git" : "jj"} instead`}
            onClick={() =>
              useVcsStore.getState().toggleBackend(repo.connKey, repo.root)
            }
          >
            {repo.backend}
          </button>
        ) : (
          <span
            className={`repo-card__backend repo-card__backend--${repo.backend}`}
            title="git repository"
          >
            {repo.backend}
          </span>
        )}
        <span className="repo-card__name" title={repo.root}>
          {repo.label}
        </span>
        <Tip label={historyShown ? "Hide history" : "Commit history (live)"}>
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
          <Tip label="Live — this repo is file-watched; changes appear by themselves">
            <span className="icon-btn icon-btn--active icon-btn--static">◉</span>
          </Tip>
        ) : (
          <Tip
            label={
              repo.eager
                ? "Live updates on (refresh after in-app saves) — click to pause"
                : "Live updates off — click to refresh after in-app saves"
            }
          >
            <button
              className={`icon-btn ${repo.eager ? "icon-btn--active" : ""}`}
              onClick={() => toggleEager(repo.connKey, repo.root)}
            >
              {repo.eager ? "◉" : "○"}
            </button>
          </Tip>
        )}
        {loading && (
          <Tip label="Refreshing — click to stop waiting">
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
            <span
              className="repo-card__branch repo-card__branch--btn"
              title="Switch / create branch"
              onClick={() => {
                setActionsOpen(false);
                setBranchOpen((o) => !o);
              }}
            >
              {st.ref || "—"} ▾
            </span>
            {(st.ahead || st.behind) && (
              <span className="repo-card__ab">
                {st.ahead ? `↑${st.ahead}` : ""}
                {st.behind ? `↓${st.behind}` : ""}
              </span>
            )}
            <span className="repo-card__count">{summarize(repo)}</span>
            <span className="repo-card__meta-btns">
              <Tip label="Commit / amend">
                <button
                  className={`icon-btn ${commitBoxOpen ? "icon-btn--active" : ""}`}
                  onClick={() => {
                    if (commitBoxOpen) exitModes();
                    toggleCommitOpen(repo.connKey, repo.root);
                  }}
                >
                  ✎
                </button>
              </Tip>
              <Tip
                label={
                  isGit
                    ? st.ahead
                      ? `Push ${st.ahead} commit${st.ahead === 1 ? "" : "s"}`
                      : "Push"
                    : "Push bookmarks (jj git push)"
                }
              >
                <button
                  className="icon-btn"
                  disabled={st.ahead === 0}
                  onClick={() =>
                    askConfirm(
                      "Push to the remote?",
                      isGit
                        ? `Push ${st.ahead ? `${st.ahead} commit${st.ahead === 1 ? "" : "s"}` : "your commits"} upstream?`
                        : "Push bookmarks to the remote (jj git push)?",
                      () => void remoteOp(repo.connKey, repo.root, "push"),
                      "vcs-push",
                    )
                  }
                >
                  {repo.remoteBusy === "push" ? (
                    <span className="spinner spinner--sm" />
                  ) : st.ahead ? (
                    `↑${st.ahead}`
                  ) : (
                    "↑"
                  )}
                </button>
              </Tip>
              <Tip label="Fetch & review incoming commits">
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
                    "⇣"
                  )}
                </button>
              </Tip>
              <Tip label={isGit ? "Stash & pop" : "Rebase & squash"}>
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
                    "⋯"
                  )}
                </button>
              </Tip>
            </span>
          </>
        ) : (
          <span className="repo-card__count">not loaded</span>
        )}
      </div>

      {branchOpen && !inactive && (
        <BranchMenu repo={repo} onClose={() => setBranchOpen(false)} />
      )}

      {actionsOpen && !inactive && st && (
        <div className="action-menu">
          {!isGit && !!st.ref && (
            <button
              className="action-menu__item"
              onClick={() => {
                setActionsOpen(false);
                askConfirm(
                  "Rebase onto the remote?",
                  `Rebase your work onto ${st.ref}@origin? This rewrites the local commits' parents.`,
                  () => void updateFromRemote(repo.connKey, repo.root),
                  "vcs-update",
                );
              }}
            >
              Rebase <span className="action-menu__hint">onto {st.ref}@origin</span>
            </button>
          )}
          {isGit && (
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
          )}
          {isGit && (
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
          )}
          {!isGit && (
            <button
              className="action-menu__item"
              disabled={jjChanges.length === 0}
              onClick={() => {
                setActionsOpen(false);
                askConfirm(
                  "Squash into the last commit?",
                  "Fold all working-copy changes into the last commit? Its message is kept.",
                  () => void squash(repo.connKey, repo.root),
                  "vcs-squash",
                );
              }}
            >
              Squash <span className="action-menu__hint">fold changes into last</span>
            </button>
          )}
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
            {isGit ? (
              <>
                <button
                  className={`repo-card__mode-btn ${!amendMode ? "repo-card__mode-btn--active" : ""}`}
                  onClick={() => setAmendMode(false)}
                >
                  Commit
                </button>
                <button
                  className={`repo-card__mode-btn ${amendMode ? "repo-card__mode-btn--active" : ""}`}
                  title="Amend the last commit (message and/or staged changes)"
                  onClick={() => setAmendMode(true)}
                >
                  Amend
                </button>
              </>
            ) : (
              <>
                <button
                  className={`repo-card__mode-btn ${describeMode === null ? "repo-card__mode-btn--active" : ""}`}
                  onClick={() => setDescribeMode(null)}
                >
                  Commit
                </button>
                <button
                  className={`repo-card__mode-btn ${describeMode === "@" ? "repo-card__mode-btn--active" : ""}`}
                  title="Set the current change's message without committing"
                  onClick={() => setDescribeMode("@")}
                >
                  Describe
                </button>
                <button
                  className={`repo-card__mode-btn ${describeMode === "@-" ? "repo-card__mode-btn--active" : ""}`}
                  title="Rewrite the last commit's message"
                  onClick={() => setDescribeMode("@-")}
                >
                  Fix last msg
                </button>
              </>
            )}
          </div>
          <textarea
            className="repo-card__msg input--mono"
            rows={2}
            placeholder={
              isGit
                ? amendMode
                  ? "New message (leave empty to keep the current one)"
                  : "Commit message (staged changes)"
                : describeMode === "@-"
                  ? "New message for the last commit"
                  : describeMode === "@"
                    ? "Message for the current change (no commit)"
                    : "Describe & commit this change"
            }
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <button
            className="btn btn--primary btn--block"
            disabled={!canCommit || committing}
            onClick={doCommit}
            title={
              isGit && !amendMode && staged.length === 0
                ? "Stage changes first"
                : "Commit"
            }
          >
            {committing
              ? "Working…"
              : isGit
                ? amendMode
                  ? "Amend"
                  : "Commit"
                : describeMode === "@-"
                  ? "Update message"
                  : describeMode === "@"
                    ? "Describe"
                    : "Commit"}
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
                title={`${c.path} — open to resolve the conflict markers`}
                onClick={() => openConflictFile(c.path)}
              >
                <span className={`change-row__badge ${vcsClass(c.kind)}`}>!</span>
                <span className="change-row__path">{c.path}</span>
                <button
                  className="change-row__act"
                  title="Open in the merge editor"
                  onClick={(e) => {
                    e.stopPropagation();
                    void openMergeEditor(repo, c.path);
                  }}
                >
                  ⚔
                </button>
                {isGit && (
                  <button
                    className="change-row__act"
                    title="Mark resolved (stage)"
                    onClick={(e) => {
                      e.stopPropagation();
                      void stage(repo.connKey, repo.root, [c.path]);
                    }}
                  >
                    ✓
                  </button>
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
                    <button
                      className="change-row__act"
                      title="Unstage"
                      onClick={(e) => {
                        e.stopPropagation();
                        void unstage(repo.connKey, repo.root, [c.path]);
                      }}
                    >
                      −
                    </button>,
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
                    <button
                      className="change-row__act"
                      title="Stage"
                      onClick={(e) => {
                        e.stopPropagation();
                        void stage(repo.connKey, repo.root, [c.path]);
                      }}
                    >
                      +
                    </button>,
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
          <div className="repo-card__stamp">
            updated <RelativeTime at={repo.lastUpdated} />
          </div>
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
                  disabled={b.current}
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
                <button
                  key={b.name}
                  className="branch-menu__item branch-menu__item--remote"
                  title={`Create a local tracking branch from ${b.name}`}
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
        <button
          className="icon-btn branch-menu__add"
          title={isJj ? "Create bookmark" : "Create branch"}
          disabled={!name.trim()}
          onClick={create}
        >
          ＋
        </button>
      </div>
    </div>
  );
}
