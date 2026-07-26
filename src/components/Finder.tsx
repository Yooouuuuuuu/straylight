/** Fuzzy file finder (Ctrl+P), in two steps like search-in-files:
 *  1. Pick the host scope (ScopePicker — digits / arrows / mouse).
 *  2. Fuzzy-find by name across that scope's **pinned folders**; the row above
 *     the input lists the pins ("All pins" + each one) — Tab or mouse switches.
 *  Roots index independently and stream in. Arrows + Enter open; Esc closes. */
import { useEffect, useMemo, useRef, useState } from "react";
import Fuse from "fuse.js";

import { copyPath, downloadToLocal } from "../lib/fileOps";
import { basename } from "../lib/format";
import { fsFind, revealPath } from "../lib/ipc";
import { openFileByPath } from "../lib/openFile";
import {
  collectRoots,
  loadScope,
  rootsForScope,
  saveScope,
  SCOPES,
  type SearchRoot,
  type SearchScope,
} from "../lib/searchScope";
import { useMenuClamp } from "../hooks/useMenuClamp";
import { useAppStore, type TreeNode } from "../store/appStore";
import { ScopePicker } from "./ScopePicker";
import { Tip } from "./Tooltip";

interface Entry extends SearchRoot {
  rel: string;
}

const rootKey = (r: SearchRoot) => `${r.connId}::${r.root}`;

export function Finder() {
  const open = useAppStore((s) => s.finderOpen);
  const setOpen = useAppStore((s) => s.setFinderOpen);
  if (!open) return null;
  return <FinderModal onClose={() => setOpen(false)} />;
}

function FinderModal({ onClose }: { onClose: () => void }) {
  const allRoots = useMemo(() => collectRoots(), []);
  const [step, setStep] = useState<"scope" | "find">("scope");
  const [scope, setScope] = useState<SearchScope>(loadScope);
  const [pinIdx, setPinIdx] = useState(0); // 0 = all pins, 1..n = one pin
  const [indexed, setIndexed] = useState<Record<string, Entry[]>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [menu, setMenu] = useState<{ entry: Entry; x: number; y: number } | null>(
    null,
  );
  const menuClamp = useMenuClamp(menu?.x ?? 0, menu?.y ?? 0, !!menu);
  const listRef = useRef<HTMLDivElement>(null);
  const localConnId = useAppStore((s) => s.localConnId);
  const setClipboard = useAppStore((s) => s.setClipboard);
  const openProperties = useAppStore((s) => s.openProperties);

  const entryPath = (e: Entry) =>
    `${e.root.replace(/\\/g, "/").replace(/\/+$/, "")}/${e.rel}`;
  const entryNode = (e: Entry): TreeNode => ({
    connId: e.connId,
    path: entryPath(e),
    name: basename(e.rel),
    isDir: false,
  });

  const scopeRoots = useMemo(() => rootsForScope(allRoots, scope), [allRoots, scope]);
  const activeRoots = useMemo(
    () =>
      pinIdx > 0 && scopeRoots[pinIdx - 1] ? [scopeRoots[pinIdx - 1]] : scopeRoots,
    [scopeRoots, pinIdx],
  );

  // Index each active root that hasn't been indexed yet (per-root streaming —
  // one slow host doesn't block the others; switching pins reuses the cache).
  useEffect(() => {
    if (step !== "find") return;
    let alive = true;
    for (const r of activeRoots) {
      const key = rootKey(r);
      if (indexed[key] || failed[key]) continue;
      fsFind(r.connId, r.root)
        .then((rels) => {
          if (!alive) return;
          setIndexed((m) => ({ ...m, [key]: rels.map((rel) => ({ ...r, rel })) }));
        })
        .catch(() => {
          if (!alive) return;
          setFailed((m) => ({ ...m, [key]: true }));
        });
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoots, step]);

  const pending = activeRoots.filter(
    (r) => !indexed[rootKey(r)] && !failed[rootKey(r)],
  ).length;

  const entries = useMemo<Entry[]>(
    () => activeRoots.flatMap((r) => indexed[rootKey(r)] ?? []),
    [activeRoots, indexed],
  );

  const fuse = useMemo(
    () => new Fuse(entries, { keys: ["rel"], threshold: 0.4, ignoreLocation: true }),
    [entries],
  );

  const results = useMemo<Entry[]>(() => {
    if (!query.trim()) return entries.slice(0, 200);
    return fuse.search(query).slice(0, 200).map((x) => x.item);
  }, [entries, fuse, query]);

  useEffect(() => setActive(0), [query, pinIdx]);
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

  const cyclePin = (dir: 1 | -1) => {
    const n = scopeRoots.length + 1;
    setPinIdx((i) => (i + dir + n) % n);
  };

  if (step === "scope") {
    return (
      <ScopePicker
        title="Open a file from…"
        onPick={(s) => {
          setScope(s);
          saveScope(s);
          setPinIdx(0);
          setStep("find");
        }}
        onClose={onClose}
      />
    );
  }

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="finder" role="dialog" aria-modal="true">
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
        <input
          className="finder__input"
          autoFocus
          placeholder={
            scopeRoots.length === 0
              ? "No pinned folders in this scope"
              : pinIdx === 0
                ? "Search files by name…"
                : `Search in ${scopeRoots[pinIdx - 1]?.tag}…`
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Tab") {
              e.preventDefault();
              cyclePin(e.shiftKey ? -1 : 1);
            } else if (e.key === "ArrowDown") {
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
          {pending > 0 && (
            <div className="finder__msg">
              <span className="spinner spinner--sm" /> Indexing
              {pending === activeRoots.length
                ? "…"
                : ` (${activeRoots.length - pending}/${activeRoots.length} folders ready)…`}
            </div>
          )}
          {results.length === 0 && pending === 0 ? (
            <div className="finder__msg">
              {activeRoots.length === 0
                ? "Pin a folder in this scope to search it."
                : "No matches."}
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
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    setActive(i);
                    setMenu({ entry: e, x: ev.clientX, y: ev.clientY });
                  }}
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
      {menu && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 1150 }}
            onMouseDown={(ev) => {
              ev.stopPropagation();
              setMenu(null);
            }}
            onContextMenu={(ev) => {
              ev.preventDefault();
              setMenu(null);
            }}
          />
          <div
            ref={menuClamp.ref}
            className="context-menu"
            style={{ left: menuClamp.left, top: menuClamp.top }}
            onContextMenu={(ev) => ev.preventDefault()}
          >
            <button
              className="context-menu__item"
              onClick={() => openEntry(menu.entry)}
            >
              Open
            </button>
            <div className="context-menu__sep" />
            <button
              className="context-menu__item"
              onClick={() => {
                setClipboard("copy", entryNode(menu.entry));
                setMenu(null);
              }}
            >
              Copy
            </button>
            <button
              className="context-menu__item"
              onClick={() => {
                void copyPath(entryPath(menu.entry));
                setMenu(null);
              }}
            >
              Copy Path
            </button>
            {menu.entry.connId === localConnId ? (
              <button
                className="context-menu__item"
                onClick={() => {
                  void revealPath(entryPath(menu.entry));
                  setMenu(null);
                }}
              >
                Reveal in file manager
              </button>
            ) : (
              <Tip label="Downloads to your local machine (Preferences → Download folder)">
                <button
                  className="context-menu__item"
                  onClick={() => {
                    void downloadToLocal(menu.entry.connId, [entryPath(menu.entry)]);
                    setMenu(null);
                  }}
                >
                  Download
                </button>
              </Tip>
            )}
            <div className="context-menu__sep" />
            <button
              className="context-menu__item"
              onClick={() => {
                openProperties([entryNode(menu.entry)]);
                onClose();
              }}
            >
              Properties
            </button>
          </div>
        </>
      )}
    </div>
  );
}
