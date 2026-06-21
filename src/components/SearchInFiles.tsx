/** Search-in-files (Ctrl+Shift+F). Runs a literal search across every pinned
 *  folder on the active connections (local scans in Rust; remote/WSL use grep),
 *  groups hits by file, and opens a hit at its line. */
import { useEffect, useMemo, useState } from "react";

import { basename } from "../lib/format";
import { fsSearch, type SearchMatch } from "../lib/ipc";
import { openFileAtLine } from "../lib/openFile";
import { useAppStore } from "../store/appStore";

interface Root {
  connId: string;
  root: string;
  tag: string;
}
type Hit = Root & SearchMatch;

export function SearchInFiles() {
  const open = useAppStore((s) => s.searchOpen);
  const setOpen = useAppStore((s) => s.setSearchOpen);
  if (!open) return null;
  return <SearchModal onClose={() => setOpen(false)} />;
}

function SearchModal({ onClose }: { onClose: () => void }) {
  const localConnId = useAppStore((s) => s.localConnId);
  const pinnedFolders = useAppStore((s) => s.pinnedFolders);
  const remote = useAppStore((s) => s.remote);
  const remotePins = useAppStore((s) => s.remotePins);
  const wsl = useAppStore((s) => s.wsl);
  const wslPins = useAppStore((s) => s.wslPins);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Hit[] | null>(null);
  const [searching, setSearching] = useState(false);

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
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    let alive = true;
    const handle = window.setTimeout(() => {
      setSearching(true);
      Promise.all(
        roots.map((r) =>
          fsSearch(r.connId, r.root, q)
            .then((ms) => ms.map((m) => ({ ...r, ...m })))
            .catch(() => [] as Hit[]),
        ),
      ).then((lists) => {
        if (!alive) return;
        setResults(lists.flat());
        setSearching(false);
      });
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(handle);
    };
  }, [query, roots]);

  const groups = useMemo(() => {
    if (!results) return [];
    const map = new Map<string, { hit: Hit; hits: Hit[] }>();
    for (const h of results) {
      const key = `${h.connId}:${h.root}:${h.path}`;
      if (!map.has(key)) map.set(key, { hit: h, hits: [] });
      map.get(key)!.hits.push(h);
    }
    return [...map.values()];
  }, [results]);

  const total = results?.length ?? 0;

  const openHit = (h: Hit) => {
    const root = h.root.replace(/\\/g, "/").replace(/\/+$/, "");
    void openFileAtLine(h.connId, `${root}/${h.path}`, basename(h.path), h.line);
    onClose();
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="search-panel" role="dialog" aria-modal="true">
        <div className="search-panel__head">
          <input
            className="search-panel__input"
            autoFocus
            placeholder={
              roots.length === 0 ? "No pinned folders to search" : "Search in files…"
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
          {results && (
            <span className="search-panel__count">
              {total} in {groups.length} file{groups.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <div className="search-panel__results">
          {!query.trim() ? (
            <div className="search-panel__msg">Type to search across your folders.</div>
          ) : searching ? (
            <div className="search-panel__msg">
              <span className="spinner spinner--sm" /> Searching…
            </div>
          ) : groups.length === 0 ? (
            <div className="search-panel__msg">No matches.</div>
          ) : (
            groups.map((g) => {
              const f = g.hit;
              const dir = f.path.includes("/")
                ? f.path.slice(0, f.path.lastIndexOf("/"))
                : "";
              return (
                <div className="search-group" key={`${f.connId}:${f.root}:${f.path}`}>
                  <div className="search-group__file" title={f.path}>
                    <span className="search-group__name">{basename(f.path)}</span>
                    <span className="search-group__dir">
                      {dir ? `${dir} · ` : ""}
                      {f.tag}
                    </span>
                    <span className="search-group__num">{g.hits.length}</span>
                  </div>
                  {g.hits.map((h, i) => (
                    <div
                      className="search-hit"
                      key={i}
                      onClick={() => openHit(h)}
                      title="Open at this line"
                    >
                      <span className="search-hit__line">{h.line}</span>
                      <span className="search-hit__text">{h.text}</span>
                    </div>
                  ))}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
