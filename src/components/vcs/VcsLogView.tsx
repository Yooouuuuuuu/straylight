/** A repo's commit history (newest first), rendered as a single-lane graph: a
 *  rail of dots with each commit's refs, subject, author, and time. Works for
 *  git and jj (the backend differs only in how the log is fetched). Full
 *  multi-lane graph rendering is a later UX pass. */
import { useEffect, useState } from "react";

import { vcsLog, type VcsCommit } from "../../lib/ipc";
import type { EditorTab } from "../../store/appStore";
import { RelativeTime } from "../RelativeTime";

export function VcsLogView({ tab }: { tab: EditorTab }) {
  const [commits, setCommits] = useState<VcsCommit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isJj = tab.vcsBackend === "jj";

  useEffect(() => {
    let active = true;
    setCommits(null);
    setError(null);
    vcsLog(tab.connId, tab.path, tab.vcsBackend ?? "git", 200)
      .then((c) => active && setCommits(c))
      .catch((e) => active && setError(String(e)));
    return () => {
      active = false;
    };
  }, [tab.id, tab.connId, tab.path, tab.vcsBackend]);

  return (
    <div className="vcs-log">
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
          {commits.map((c, i) => (
            <div className="commit-row" key={`${c.id}-${i}`}>
              <div className="commit-row__rail">
                <span
                  className={[
                    "commit-row__dot",
                    c.current ? "commit-row__dot--current" : "",
                    c.parents.length > 1 ? "commit-row__dot--merge" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                />
              </div>
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
                      <RelativeTime at={c.timestamp * 1000} />
                    </span>
                  ) : null}
                  {c.parents.length > 1 ? <span> · merge</span> : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
