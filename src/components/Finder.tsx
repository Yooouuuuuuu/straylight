/** Fuzzy file finder (Ctrl+P). Indexes the files under every pinned folder
 *  across the active connections, fuzzy-matches with Fuse.js, and opens the
 *  pick. Arrow keys + Enter; Esc closes. */
import { useEffect, useMemo, useRef, useState } from "react";
import Fuse from "fuse.js";

import { basename } from "../lib/format";
import { fsFind } from "../lib/ipc";
import { openFileByPath } from "../lib/openFile";
import { useAppStore } from "../store/appStore";

interface Root {
  connId: string;
  root: string;
  tag: string;
}
interface Entry extends Root {
  rel: string;
}

export function Finder() {
  const open = useAppStore((s) => s.finderOpen);
  const setOpen = useAppStore((s) => s.setFinderOpen);
  if (!open) return null;
  return <FinderModal onClose={() => setOpen(false)} />;
}

function FinderModal({ onClose }: { onClose: () => void }) {
  const localConnId = useAppStore((s) => s.localConnId);
  const pinnedFolders = useAppStore((s) => s.pinnedFolders);
  const remote = useAppStore((s) => s.remote);
  const remotePins = useAppStore((s) => s.remotePins);
  const wsl = useAppStore((s) => s.wsl);
  const wslPins = useAppStore((s) => s.wslPins);

  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const roots = useMemo<Root[]>(() => {
    const r: Root[] = [];
    const add = (connId: string | null | undefined, pins: string[]) => {
      if (!connId) return;
      for (const p of pins) r.push({ connId, root: p, tag: basename(p) || p });
    };
    add(localConnId, pinnedFolders);
    add(remote?.connId, remotePins);
    add(wsl?.connId, wslPins);
    return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.all(
      roots.map((r) =>
        fsFind(r.connId, r.root)
          .then((rels) => rels.map((rel) => ({ ...r, rel })))
          .catch(() => [] as Entry[]),
      ),
    ).then((lists) => {
      if (alive) setEntries(lists.flat());
    });
    return () => {
      alive = false;
    };
  }, [roots]);

  const fuse = useMemo(
    () =>
      entries
        ? new Fuse(entries, { keys: ["rel"], threshold: 0.4, ignoreLocation: true })
        : null,
    [entries],
  );

  const results = useMemo<Entry[]>(() => {
    if (!entries) return [];
    if (!query.trim()) return entries.slice(0, 200);
    return fuse!.search(query).slice(0, 200).map((x) => x.item);
  }, [entries, fuse, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current
      ?.querySelector(".finder__item--active")
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const openEntry = (e: Entry | undefined) => {
    if (!e) return;
    const root = e.root.replace(/\\/g, "/").replace(/\/+$/, "");
    void openFileByPath(e.connId, `${root}/${e.rel}`, basename(e.rel));
    onClose();
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="finder" role="dialog" aria-modal="true">
        <input
          className="finder__input"
          autoFocus
          placeholder={
            roots.length === 0
              ? "No pinned folders to search"
              : entries === null
                ? "Indexing files…"
                : "Search files by name…"
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              openEntry(results[active]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="finder__list" ref={listRef}>
          {entries === null ? (
            <div className="finder__msg">
              <span className="spinner spinner--sm" /> Indexing files…
            </div>
          ) : results.length === 0 ? (
            <div className="finder__msg">
              {roots.length === 0 ? "Pin a folder to search it." : "No matches."}
            </div>
          ) : (
            results.map((e, i) => {
              const dir = e.rel.includes("/")
                ? e.rel.slice(0, e.rel.lastIndexOf("/"))
                : "";
              return (
                <div
                  key={`${e.connId}:${e.root}:${e.rel}`}
                  className={`finder__item ${i === active ? "finder__item--active" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => openEntry(e)}
                >
                  <span className="finder__name">{basename(e.rel)}</span>
                  <span className="finder__path">
                    {dir ? `${dir} · ` : ""}
                    {e.tag}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
