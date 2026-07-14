/** Commit-history panel, taking the whole left column while open (the
 *  explorer hides behind it). The log itself carries the Incoming block and
 *  per-commit details (click a commit to expand its files); ⧉→ opens the full
 *  log as an editor tab AND closes this panel. */
import { useAppStore } from "../../store/appStore";
import { useVcsStore } from "../../store/vcsStore";
import { hostColorForConnKey } from "../../lib/hostColors";
import { IconClose, IconPanelToEditor } from "../icons";
import { VcsLogView } from "./VcsLogView";

export function HistoryPanel() {
  const historyRepo = useVcsStore((s) => s.historyRepo);
  const closeHistory = useVcsStore((s) => s.closeHistory);
  const repos = useVcsStore((s) => s.repos);
  const openLogTab = useAppStore((s) => s.openLogTab);
  const hostColors = useAppStore((s) => s.hostColors);

  const repo =
    historyRepo != null
      ? repos.find(
          (r) => r.connKey === historyRepo.connKey && r.root === historyRepo.root,
        )
      : undefined;

  if (!repo || !repo.connId) {
    return (
      <div className="history-panel">
        <div className="history-panel__head">
          <span className="history-panel__title">History</span>
          <button className="icon-btn" title="Close" onClick={() => closeHistory()}>
            <IconClose />
          </button>
        </div>
        <div className="vcs-log__msg">
          {historyRepo ? "Repository not connected." : "No repository selected."}
        </div>
      </div>
    );
  }

  return (
    <div className="history-panel">
      {/* Row 1: which lens (live — follows the colocated badge toggle). */}
      <div className="history-panel__head">
        <span className="history-panel__title">
          {repo.backend === "jj" ? "jj history" : "git history"}
        </span>
        <button
          className="icon-btn"
          title="Open in the editor (closes this panel)"
          onClick={() => {
            openLogTab({
              connId: repo.connId!,
              root: repo.root,
              backend: repo.backend,
              label: repo.label,
            });
            closeHistory();
          }}
        >
          <IconPanelToEditor size={14} />
        </button>
        <button className="icon-btn" title="Close" onClick={() => closeHistory()}>
          <IconClose />
        </button>
      </div>
      {/* Row 2: which repo, on which machine (host identity color). */}
      <div
        className="history-panel__repo"
        title={repo.root}
        style={{ borderLeftColor: hostColorForConnKey(hostColors, repo.connKey) }}
      >
        {repo.label}
      </div>
      {/* Colocated repos: an explicit lens swap on its own line. */}
      {repo.colocated && (
        <button
          className="history-swap"
          onClick={() =>
            useVcsStore.getState().toggleBackend(repo.connKey, repo.root)
          }
        >
          swap to {repo.backend === "jj" ? "git" : "jj"} history
        </button>
      )}
      <div className="history-panel__body">
        <VcsLogView connId={repo.connId} root={repo.root} backend={repo.backend} />
      </div>
    </div>
  );
}
