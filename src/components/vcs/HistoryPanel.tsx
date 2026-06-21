/** Commit-history panel, shown as a column just left of the Source Control
 *  panel and expanded by the ⎇ button on a repo card. It renders the same log
 *  view used by the editor-tab version, plus a button to pop it out into a
 *  full-width editor tab. */
import { useAppStore } from "../../store/appStore";
import { useVcsStore } from "../../store/vcsStore";
import { IconClose } from "../icons";
import { VcsLogView } from "./VcsLogView";

export function HistoryPanel() {
  const historyRepo = useVcsStore((s) => s.historyRepo);
  const closeHistory = useVcsStore((s) => s.closeHistory);
  const repos = useVcsStore((s) => s.repos);
  const openLogTab = useAppStore((s) => s.openLogTab);

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
      <div className="history-panel__head">
        <span className="history-panel__title" title={repo.root}>
          {repo.label} — History
        </span>
        <button
          className="icon-btn"
          title="Open in editor"
          onClick={() =>
            openLogTab({
              connId: repo.connId!,
              root: repo.root,
              backend: repo.backend,
              label: repo.label,
            })
          }
        >
          ⧉
        </button>
        <button className="icon-btn" title="Close" onClick={() => closeHistory()}>
          <IconClose />
        </button>
      </div>
      <div className="history-panel__body">
        <VcsLogView connId={repo.connId} root={repo.root} backend={repo.backend} />
      </div>
    </div>
  );
}
