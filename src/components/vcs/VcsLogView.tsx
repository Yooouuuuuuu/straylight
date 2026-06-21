/** A repo's commit history (newest first), rendered as a single-lane graph: a
 *  rail of dots with each commit's refs, subject, author, and time. Works for
 *  git and jj (the backend differs only in how the log is fetched). Full
 *  multi-lane graph rendering is a later UX pass. */
import { useEffect, useState } from "react";

import {
  vcsCommitFiles,
  vcsLog,
  type VcsChange,
  type VcsCommit,
} from "../../lib/ipc";
import { openCommitDiff } from "../../lib/openDiff";
import { vcsClass, vcsLetter } from "../../lib/vcsDecorations";
import { RelativeTime } from "../RelativeTime";

type FileState = VcsChange[] | "loading" | "error";

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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [files, setFiles] = useState<Record<string, FileState>>({});
  const isJj = backend === "jj";

  useEffect(() => {
    let active = true;
    setCommits(null);
    setError(null);
    setExpanded(new Set());
    setFiles({});
    vcsLog(connId, root, backend, 200)
      .then((c) => active && setCommits(c))
      .catch((e) => active && setError(String(e)));
    return () => {
      active = false;
    };
  }, [connId, root, backend]);

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
          {commits.map((c, i) => {
            const open = expanded.has(c.id);
            const fs = files[c.id];
            return (
              <div className="commit-group" key={`${c.id}-${i}`}>
                <div
                  className="commit-row"
                  onClick={() => toggle(c.id)}
                  title="Show changed files"
                >
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
                {open && (
                  <div className="commit-files">
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
                        <div
                          className="change-row"
                          key={ch.path}
                          title={`${ch.path} — open diff at this commit`}
                          onClick={() =>
                            void openCommitDiff({ connId, root, backend }, c.id, ch)
                          }
                        >
                          <span className={`change-row__badge ${vcsClass(ch.kind)}`}>
                            {vcsLetter(ch.kind) || "•"}
                          </span>
                          <span className="change-row__path">{ch.path}</span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
