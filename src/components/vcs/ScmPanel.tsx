/** Right-side Source Control panel: a stack of per-repo cards. Repos are opened
 *  explicitly (validated as a real repo), don't auto-refresh until toggled
 *  "eager", and show a running indicator (which doubles as a manual cancel).
 *  Slice 1 is read-only — the change list, branch, and counts; commit/diff come
 *  in later slices. */
import { useEffect, useState, type ReactNode } from "react";

import { useAppStore } from "../../store/appStore";
import { useVcsStore, type TrackedRepo } from "../../store/vcsStore";
import { openDiff } from "../../lib/openDiff";
import { vcsBranches, type VcsBranch } from "../../lib/ipc";
import { vcsClass, vcsLetter } from "../../lib/vcsDecorations";
import { FolderBrowser } from "../FolderBrowser";
import { RelativeTime } from "../RelativeTime";
import { IconClose, IconPlus, IconRefresh } from "../icons";

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
        <button
          className="icon-btn"
          title="Open a repository"
          disabled={conns.length === 0}
          onClick={startOpen}
        >
          <IconPlus />
        </button>
        <button
          className="icon-btn"
          title="Hide Source Control"
          onClick={() => setScmVisible(false)}
        >
          <IconClose />
        </button>
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
  const n = repo.status.changes.length;
  return n === 0 ? "no changes" : `${n} change${n === 1 ? "" : "s"}`;
}

function RepoCard({ repo }: { repo: TrackedRepo }) {
  const refreshRepo = useVcsStore((s) => s.refreshRepo);
  const cancelRefresh = useVcsStore((s) => s.cancelRefresh);
  const toggleEager = useVcsStore((s) => s.toggleEager);
  const removeRepo = useVcsStore((s) => s.removeRepo);
  const showHistory = useVcsStore((s) => s.showHistory);
  const stage = useVcsStore((s) => s.stage);
  const unstage = useVcsStore((s) => s.unstage);
  const commit = useVcsStore((s) => s.commit);
  const remoteOp = useVcsStore((s) => s.remoteOp);
  const requestDiscard = useVcsStore((s) => s.requestDiscard);
  const amend = useVcsStore((s) => s.amend);
  const stash = useVcsStore((s) => s.stash);
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [amendMode, setAmendMode] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);

  const st = repo.status;
  const inactive = !repo.connId;
  const loading = repo.activity === "loading";
  const isGit = repo.backend !== "jj";
  const changes = st?.changes ?? [];
  const staged = changes.filter((c) => c.staged);
  const unstaged = changes.filter((c) => !c.staged);
  const canCommit =
    !inactive &&
    (amendMode
      ? message.trim().length > 0
      : message.trim().length > 0 && (isGit ? staged.length > 0 : changes.length > 0));

  const doCommit = async () => {
    setCommitting(true);
    const ok = amendMode
      ? await amend(repo.connKey, repo.root, message.trim())
      : await commit(repo.connKey, repo.root, message.trim());
    setCommitting(false);
    if (ok) {
      setMessage("");
      setAmendMode(false);
    }
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

  const remoteBtn = (op: "fetch" | "pull" | "push", label: string) => (
    <button
      className="repo-card__remote-btn"
      disabled={inactive || repo.remoteBusy != null}
      onClick={() => void remoteOp(repo.connKey, repo.root, op)}
      title={label}
    >
      {repo.remoteBusy === op ? "…" : label}
    </button>
  );

  return (
    <div className="repo-card">
      <div className="repo-card__head">
        <span
          className={`repo-card__backend repo-card__backend--${repo.backend}`}
          title={repo.backend === "jj" ? "Jujutsu repository" : "git repository"}
        >
          {repo.backend}
        </span>
        <span className="repo-card__name" title={repo.root}>
          {repo.label}
        </span>
        {loading ? (
          <button
            className="icon-btn"
            title="Refreshing — click to stop waiting"
            onClick={() => cancelRefresh(repo.connKey, repo.root)}
          >
            <span className="spinner spinner--sm" />
          </button>
        ) : (
          <button
            className="icon-btn"
            title={inactive ? "Connection not active" : "Refresh"}
            disabled={inactive}
            onClick={() => void refreshRepo(repo.connKey, repo.root)}
          >
            <IconRefresh />
          </button>
        )}
        <button
          className="icon-btn"
          title="Commit history"
          disabled={inactive}
          onClick={() => showHistory(repo.connKey, repo.root)}
        >
          ⎇
        </button>
        <button
          className={`icon-btn ${repo.eager ? "icon-btn--active" : ""}`}
          title={repo.eager ? "Live updates on — click to pause" : "Live updates off"}
          onClick={() => toggleEager(repo.connKey, repo.root)}
        >
          {repo.eager ? "◉" : "○"}
        </button>
        <button
          className="icon-btn icon-btn--danger"
          title="Remove from Source Control"
          onClick={() => removeRepo(repo.connKey, repo.root)}
        >
          <IconClose />
        </button>
      </div>

      <div className="repo-card__meta">
        {inactive ? (
          <span className="repo-card__offline">offline</span>
        ) : st ? (
          <>
            <span
              className="repo-card__branch repo-card__branch--btn"
              title="Switch / create branch"
              onClick={() => setBranchOpen((o) => !o)}
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
          </>
        ) : (
          <span className="repo-card__count">not loaded</span>
        )}
      </div>

      {branchOpen && !inactive && (
        <BranchMenu repo={repo} onClose={() => setBranchOpen(false)} />
      )}

      {repo.error && <div className="repo-card__error">{repo.error}</div>}

      {!inactive && st && (
        <div className="repo-card__remote">
          {remoteBtn("fetch", "Fetch")}
          {isGit && remoteBtn("pull", "Pull")}
          {remoteBtn("push", "Push")}
          {isGit && (
            <button
              className="repo-card__remote-btn"
              onClick={() => void stash(repo.connKey, repo.root, "push", message.trim())}
              title="Stash all changes"
            >
              Stash
            </button>
          )}
          {isGit && (
            <button
              className="repo-card__remote-btn"
              onClick={() => void stash(repo.connKey, repo.root, "pop", "")}
              title="Pop the latest stash"
            >
              Pop
            </button>
          )}
        </div>
      )}

      {!inactive && st && (changes.length > 0 || isGit) && (
        <div className="repo-card__commit">
          <textarea
            className="repo-card__msg input--mono"
            rows={2}
            placeholder={
              isGit ? "Commit message (staged changes)" : "Describe & commit this change"
            }
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          {isGit && (
            <label className="repo-card__amend">
              <input
                type="checkbox"
                checked={amendMode}
                onChange={(e) => setAmendMode(e.target.checked)}
              />
              Amend last commit
            </label>
          )}
          <button
            className="btn btn--primary btn--block"
            disabled={!canCommit || committing}
            onClick={() => void doCommit()}
            title={
              !amendMode && isGit && staged.length === 0 ? "Stage changes first" : "Commit"
            }
          >
            {committing
              ? amendMode
                ? "Amending…"
                : "Committing…"
              : amendMode
                ? "Amend"
                : "Commit"}
          </button>
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
        changes.length > 0 && (
          <div className="repo-card__changes">
            {changes.map((c) => changeRow(c, null))}
          </div>
        )
      )}

      {repo.lastUpdated && !loading && (
        <div className="repo-card__stamp">
          updated <RelativeTime at={repo.lastUpdated} />
        </div>
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
          branches.map((b) => (
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
          ))
        )}
      </div>
      <input
        className="input input--mono branch-menu__new"
        placeholder={isJj ? "New bookmark…" : "New branch…"}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim()) {
            void createBranch(repo.connKey, repo.root, name.trim());
            onClose();
          } else if (e.key === "Escape") {
            onClose();
          }
        }}
      />
    </div>
  );
}
