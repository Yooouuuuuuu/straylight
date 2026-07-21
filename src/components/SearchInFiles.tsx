/** Search-in-files (Ctrl+Shift+F), in two steps:
 *  1. Pick the scope — Local / WSL / Remote / All, top-down. Number keys 1–4,
 *     ↑/↓ + Enter, or the mouse.
 *  2. Search that scope's **pinned folders**. The row above the search bar
 *     lists the pins — Tab (or click) switches between "All pins" and one pin.
 *  Each pin searches independently and its hits stream in as they arrive, with
 *  a per-pin status line. Esc steps back, then closes. */
import { useEffect, useMemo, useRef, useState } from "react";

import { basename } from "../lib/format";
import { fsSearch, type SearchMatch } from "../lib/ipc";
import { openFileAtLine } from "../lib/openFile";
import {
  collectRoots,
  loadScope,
  rootsForScope,
  saveScope,
  SCOPES,
  type SearchRoot,
  type SearchScope,
} from "../lib/searchScope";
import { useAppStore } from "../store/appStore";
import { ScopePicker } from "./ScopePicker";
import { Tip } from "./Tooltip";

type Hit = SearchRoot & SearchMatch;
type RootState = "searching" | "done" | "failed";

const rootKey = (r: SearchRoot) => `${r.connId}::${r.root}`;

export function SearchInFiles() {
  const open = useAppStore((s) => s.searchOpen);
  const setOpen = useAppStore((s) => s.setSearchOpen);
  if (!open) return null;
  return <SearchModal onClose={() => setOpen(false)} />;
}

function SearchModal({ onClose }: { onClose: () => void }) {
  const allRoots = useMemo(() => collectRoots(), []);

  const [step, setStep] = useState<"scope" | "search">("scope");
  const [scope, setScope] = useState<SearchScope>(loadScope);

  const [pinIdx, setPinIdx] = useState(0); // 0 = all pins, 1..n = one pin
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [rootStates, setRootStates] = useState<Record<string, RootState>>({});
  const runRef = useRef(0);

  const scopeRoots = useMemo(() => rootsForScope(allRoots, scope), [allRoots, scope]);
  const activeRoots = useMemo(
    () =>
      pinIdx > 0 && scopeRoots[pinIdx - 1] ? [scopeRoots[pinIdx - 1]] : scopeRoots,
    [scopeRoots, pinIdx],
  );

  // Debounced, streaming search over the active pins: every root runs
  // independently and appends its hits when it finishes; a bumped run id
  // discards stale results.
  useEffect(() => {
    const q = query.trim();
    runRef.current += 1;
    const run = runRef.current;
    setHits([]);
    setRootStates({});
    if (!q || step !== "search") return;
    const handle = window.setTimeout(() => {
      setRootStates(
        Object.fromEntries(
          activeRoots.map((r) => [rootKey(r), "searching" as RootState]),
        ),
      );
      for (const r of activeRoots) {
        fsSearch(r.connId, r.root, q)
          .then((ms) => {
            if (runRef.current !== run) return;
            setHits((h) => [...h, ...ms.map((m) => ({ ...r, ...m }))]);
            setRootStates((s) => ({ ...s, [rootKey(r)]: "done" }));
          })
          .catch(() => {
            if (runRef.current !== run) return;
            setRootStates((s) => ({ ...s, [rootKey(r)]: "failed" }));
          });
      }
    }, 300);
    return () => window.clearTimeout(handle);
  }, [query, activeRoots, step]);

  const searching = Object.values(rootStates).some((s) => s === "searching");

  /** Per-pin progress, e.g. "straylight: 12 hits · notes: searching…". */
  const statusLine = useMemo(() => {
    if (!query.trim() || activeRoots.length === 0) return null;
    return activeRoots
      .map((r) => {
        const st = rootStates[rootKey(r)];
        const n = hits.filter((h) => rootKey(h) === rootKey(r)).length;
        const label = scope === "all" ? `${r.tag}·${r.kind}` : r.tag;
        return `${label}: ${
          st === "searching"
            ? "searching…"
            : st === "failed"
              ? "failed"
              : `${n} hit${n === 1 ? "" : "s"}`
        }`;
      })
      .join(" · ");
  }, [query, activeRoots, rootStates, hits, scope]);

  const groups = useMemo(() => {
    const map = new Map<string, { hit: Hit; hits: Hit[] }>();
    for (const h of hits) {
      const key = `${h.connId}:${h.root}:${h.path}`;
      if (!map.has(key)) map.set(key, { hit: h, hits: [] });
      map.get(key)!.hits.push(h);
    }
    return [...map.values()];
  }, [hits]);

  const openHit = (h: Hit) => {
    const root = h.root.replace(/\\/g, "/").replace(/\/+$/, "");
    void openFileAtLine(h.connId, `${root}/${h.path}`, basename(h.path), h.line);
    onClose();
  };

  const cyclePin = (dir: 1 | -1) => {
    const n = scopeRoots.length + 1; // "All pins" + each pin
    setPinIdx((i) => (i + dir + n) % n);
  };

  // ---- Step 1: scope picker ------------------------------------------------
  if (step === "scope") {
    return (
      <ScopePicker
        title="Search where?"
        onPick={(s) => {
          setScope(s);
          saveScope(s);
          setPinIdx(0);
          setStep("search");
        }}
        onClose={onClose}
      />
    );
  }

  // ---- Step 2: the search --------------------------------------------------
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="search-panel" role="dialog" aria-modal="true">
        <div className="pin-tabs">
          <Tip label="Change scope">
            <button className="pin-tabs__scope" onClick={() => setStep("scope")}>
              ‹ {scope === "all" ? "All hosts" : SCOPES.find((s) => s.id === scope)?.label}
            </button>
          </Tip>
          <button
            className={`pin-tab ${pinIdx === 0 ? "pin-tab--active" : ""}`}
            onClick={() => setPinIdx(0)}
          >
            All pins ({scopeRoots.length})
          </button>
          {scopeRoots.map((r, i) => (
            <Tip key={rootKey(r)} label={r.root}>
              <button
                className={`pin-tab ${pinIdx === i + 1 ? "pin-tab--active" : ""}`}
                onClick={() => setPinIdx(i + 1)}
              >
                {r.tag}
                {scope === "all" ? ` · ${r.kind}` : ""}
              </button>
            </Tip>
          ))}
        </div>
        <div className="search-panel__head">
          <input
            className="search-panel__input"
            autoFocus
            placeholder={
              scopeRoots.length === 0
                ? "No pinned folders in this scope"
                : pinIdx === 0
                  ? "Search in all pins…"
                  : `Search in ${scopeRoots[pinIdx - 1]?.tag}…`
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Tab") {
                e.preventDefault();
                cyclePin(e.shiftKey ? -1 : 1);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
          {query.trim() && !searching && (
            <span className="search-panel__count">
              {hits.length} in {groups.length} file{groups.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
        {statusLine && (
          <div className="search-panel__status">
            {searching && <span className="spinner spinner--sm" />}
            {statusLine}
          </div>
        )}
        <div className="search-panel__results">
          {!query.trim() ? (
            <div className="search-panel__msg">
              Type to search — Tab switches pins, ‹ changes the host.
            </div>
          ) : groups.length === 0 && searching ? (
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
                  <Tip label={f.path}>
                    <div className="search-group__file">
                      <span className="search-group__name">{basename(f.path)}</span>
                      <span className="search-group__dir">
                        {dir ? `${dir} · ` : ""}
                        {f.tag}
                      </span>
                      <span className="search-group__num">{g.hits.length}</span>
                    </div>
                  </Tip>
                  {g.hits.map((h, i) => (
                    <Tip key={i} label="Open at this line">
                      <div className="search-hit" onClick={() => openHit(h)}>
                        <span className="search-hit__line">{h.line}</span>
                        <span className="search-hit__text">{h.text}</span>
                      </div>
                    </Tip>
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
