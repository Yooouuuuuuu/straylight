/** Per-host pinned FILES (docs/hot-exit.md § Pinned tabs): a pinned tab means
 *  "this file is part of my workspace on that host", so it reopens pinned on
 *  EVERY connect — app launch, startup reconnect, or a mid-session reconnect
 *  (which used to silently drop pinned tabs with the rest).
 *
 *  Pure localStorage map (`connKey` → paths), written by the pin/unpin action
 *  and read by session restore + the consume-on-connect paths. Closing a
 *  pinned tab does NOT unpin the file — only unpinning does. */

const KEY = "straylight.pinnedTabs";

function load(): Record<string, string[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string[]>;
    }
  } catch {
    /* fall through */
  }
  return {};
}

function save(map: Record<string, string[]>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* storage full — pins still work for this session */
  }
}

/** The files pinned on a host, in pin order. */
export function pinnedTabsFor(connKey: string): string[] {
  return load()[connKey] ?? [];
}

/** Every pinned file across all hosts, for the Settings management list. */
export function allPinnedTabs(): { connKey: string; path: string }[] {
  const map = load();
  return Object.entries(map).flatMap(([connKey, paths]) =>
    paths.map((path) => ({ connKey, path })),
  );
}

/** Record a pin/unpin for a host's file. */
export function setTabPinned(connKey: string, path: string, on: boolean): void {
  const map = load();
  const list = map[connKey] ?? [];
  const has = list.includes(path);
  if (on && !has) map[connKey] = [...list, path];
  else if (!on && has) {
    const next = list.filter((p) => p !== path);
    if (next.length) map[connKey] = next;
    else delete map[connKey];
  } else {
    return; // no change
  }
  save(map);
}
