/** Multi-lane layout for the commit graph (gitk-style lane assignment).
 *
 *  Commits arrive newest-first with children before parents (`--topo-order` /
 *  jj's default). Each lane "waits" for a commit id; when that commit's row is
 *  reached, the lane ends in its dot and the dot opens lanes for its parents.
 *  Merges fan out to extra lanes; two branches waiting for the same parent
 *  collapse into one lane to keep the graph narrow. */
import type { VcsCommit } from "./ipc";

export interface GraphRow {
  /** Column of this commit's dot. */
  lane: number;
  /** Columns whose line from the row above ends at this dot. */
  incoming: number[];
  /** Columns this dot connects down to (its parents' lanes). */
  outgoing: number[];
  /** Columns whose line passes straight through this row untouched. */
  through: number[];
}

export interface CommitGraph {
  rows: GraphRow[];
  /** Highest number of concurrent lanes (for sizing the rail). */
  width: number;
}

export function computeGraph(commits: VcsCommit[]): CommitGraph {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let width = 1;

  const firstFree = (): number => {
    const i = lanes.indexOf(null);
    if (i >= 0) return i;
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const c of commits) {
    const before = lanes.slice();

    const incoming: number[] = [];
    for (let i = 0; i < lanes.length; i += 1) {
      if (lanes[i] === c.id) incoming.push(i);
    }
    const lane = incoming.length > 0 ? Math.min(...incoming) : firstFree();
    for (const i of incoming) lanes[i] = null;

    const outgoing: number[] = [];
    const parents = c.parents.filter((p) => p.length > 0);
    parents.forEach((p, idx) => {
      // If a lane is already waiting for this parent, merge into it.
      const existing = lanes.findIndex((l) => l === p);
      if (existing >= 0) {
        outgoing.push(existing);
      } else if (idx === 0 && lanes[lane] === null) {
        lanes[lane] = p; // first parent continues in our own column
        outgoing.push(lane);
      } else {
        const k = firstFree();
        lanes[k] = p;
        outgoing.push(k);
      }
    });

    // A column passes through when it waits for the same commit above and
    // below this row (lanes we merged an edge into also keep their line).
    const through: number[] = [];
    const span = Math.max(before.length, lanes.length);
    for (let i = 0; i < span; i += 1) {
      if (before[i] != null && before[i] === lanes[i] && !incoming.includes(i)) {
        through.push(i);
      }
    }

    rows.push({ lane, incoming, outgoing, through });
    const involved = [lane, ...incoming, ...outgoing, ...through];
    width = Math.max(width, Math.max(...involved) + 1);

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
  }

  return { rows, width };
}
