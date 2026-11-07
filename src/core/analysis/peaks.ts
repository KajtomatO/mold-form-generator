import type { Field } from '../field/grid';

/** H is compared in steps of this, so float noise on a flat ceiling cannot make peaks of its own. */
export const HEIGHT_STEP = 0.01;

/** A local top of the ceiling, where air collects under a rising level. */
export interface Leaf {
  /** Node index in the field. */
  node: number;
  x: number;
  y: number;
  /** Height of the highest node, as the field has it. */
  height: number;
  /** Where this leaf's basin first joins a higher one. 0 for the highest leaf of a cavity: its floor. */
  saddle: number;
  /** height - saddle, in whole height steps, so a threshold test does not depend on float noise. */
  persistence: number;
  /** Air under the ceiling and above the saddle, over the whole basin, in mm3. */
  airVolume: number;
  /** The leaf it merges into, or -1 for the highest of a cavity. */
  parent: number;
}

export interface MergeTree {
  /** Highest first, so leaves[0] is the highest point of the field. Births at a flat level are not here. */
  leaves: Leaf[];
  /** Per node: the basin it joined on the way down, or -1 outside the cavity. */
  basins: Int32Array;
  /** Per basin: the basin it merged into, or -1. */
  basinParents: Int32Array;
  /** Per basin: the height at which it merged into its parent, or 0. */
  basinSaddles: Float32Array;
  /** Per basin: its index in `leaves`, or -1 for a birth with no persistence, which folds into its parent. */
  basinLeaves: Int32Array;
}

/** Node order for the sweep: highest level first, and by index within a level, so a run is repeatable. */
function sweepOrder(values: Float32Array): { order: Uint32Array; levels: Int32Array } {
  const levels = new Int32Array(values.length);
  let top = 0, inside = 0;
  for (let n = 0; n < values.length; n++) {
    if (values[n] <= 0) {
      levels[n] = -1;
      continue;
    }
    const level = Math.round(values[n] / HEIGHT_STEP);
    levels[n] = level;
    if (level > top) top = level;
    inside++;
  }
  // First position of each level, counted from the top.
  const first = new Uint32Array(top + 2);
  for (let n = 0; n < values.length; n++) if (levels[n] >= 0) first[top - levels[n] + 1]++;
  for (let k = 1; k < first.length; k++) first[k] += first[k - 1];
  const order = new Uint32Array(inside);
  for (let n = 0; n < values.length; n++) if (levels[n] >= 0) order[first[top - levels[n]]++] = n;
  return { order, levels };
}

/**
 * The plan's sweep: H quantised to 0.01 mm, highest node first, with a union-find over basins. The
 * lower peak dies where two basins meet, and the difference is its persistence. A faceted model gives
 * thousands of births from ripple alone, so a caller must always filter on persistence.
 *
 * Neighbours join by a shared edge, like cavities: silicone and air cannot pass where two nodes only
 * touch at a corner. Basins rather than nodes go through the union-find, so the only array this big
 * that it keeps is the node labels.
 */
export function mergeTree(field: Field): MergeTree {
  const { nx, ny, cell, x0, y0, values } = field;
  const { order, levels } = sweepOrder(values);
  const basins = new Int32Array(values.length).fill(-1);

  const parent: number[] = [];
  const peak: number[] = [];
  const sum: number[] = [];
  const count: number[] = [];
  /** Level at which each basin died, or -1 while it lives. */
  const died: number[] = [];
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const higher = (a: number, b: number): boolean => values[peak[a]] > values[peak[b]] || (values[peak[a]] === values[peak[b]] && peak[a] < peak[b]);

  // What a basin looked like when it died: mergedInto stays as it was, while parent gets compressed.
  const mergedInto: number[] = [];
  const airAtDeath: number[] = [];
  const cellArea = cell * cell;

  let basin = -1, level = 0;
  const meet = (other: number): void => {
    if (basins[other] < 0) return;
    const root = find(basins[other]);
    if (basin < 0) {
      basin = root;
    } else if (root !== basin) {
      const [winner, loser] = higher(basin, root) ? [basin, root] : [root, basin];
      parent[loser] = winner;
      mergedInto[loser] = winner;
      died[loser] = level;
      airAtDeath[loser] = (sum[loser] - level * HEIGHT_STEP * count[loser]) * cellArea;
      sum[winner] += sum[loser];
      count[winner] += count[loser];
      basin = winner;
    }
  };

  for (let k = 0; k < order.length; k++) {
    const n = order[k];
    level = levels[n];
    basin = -1;
    const i = n % nx, j = (n - i) / nx;
    if (i > 0) meet(n - 1);
    if (i + 1 < nx) meet(n + 1);
    if (j > 0) meet(n - nx);
    if (j + 1 < ny) meet(n + nx);

    if (basin < 0) {
      basin = parent.length;
      parent.push(basin);
      peak.push(n);
      sum.push(0);
      count.push(0);
      died.push(-1);
      mergedInto.push(-1);
      airAtDeath.push(0);
    } else if (values[n] > values[peak[basin]]) {
      // Within one level the order is by index, so a node can still be a little higher than the peak so far.
      peak[basin] = n;
    }
    basins[n] = basin;
    sum[basin] += values[n];
    count[basin]++;
  }

  // Only a basin that rose above where it died is a leaf. The others fold into their parent.
  const kept: number[] = [];
  for (let b = 0; b < parent.length; b++) {
    if (died[b] < 0 || levels[peak[b]] > died[b]) kept.push(b);
  }
  kept.sort((a, b) => (higher(a, b) ? -1 : 1));
  const basinLeaves = new Int32Array(parent.length).fill(-1);
  kept.forEach((b, index) => (basinLeaves[b] = index));
  const leafAbove = (b: number): number => {
    let at = mergedInto[b];
    while (at >= 0 && basinLeaves[at] < 0) at = mergedInto[at];
    return at < 0 ? -1 : basinLeaves[at];
  };
  const leaves = kept.map((b): Leaf => {
    const node = peak[b];
    const i = node % nx, j = (node - i) / nx;
    const deathLevel = Math.max(died[b], 0);
    return {
      node,
      x: x0 + i * cell,
      y: y0 + j * cell,
      height: values[node],
      saddle: deathLevel * HEIGHT_STEP,
      persistence: (levels[node] - deathLevel) * HEIGHT_STEP,
      airVolume: died[b] < 0 ? sum[b] * cellArea : airAtDeath[b],
      parent: died[b] < 0 ? -1 : leafAbove(b),
    };
  });
  const basinSaddles = Float32Array.from(died, (level) => Math.max(level, 0) * HEIGHT_STEP);
  return { leaves, basins, basinParents: Int32Array.from(mergedInto), basinSaddles, basinLeaves };
}

/** The leaves that matter: those a threshold keeps, plus the top of each cavity, which always does. */
export function significantLeaves(tree: MergeTree, minPersistence: number): Leaf[] {
  // The levels are whole steps, so half a step of slack only absorbs the float noise in the threshold.
  return tree.leaves.filter((leaf) => leaf.parent < 0 || leaf.persistence >= minPersistence - HEIGHT_STEP / 2);
}

/**
 * Plan: a leaf is covered if an opening sits in its basin above the saddle and within `drop` of the
 * peak, as air then has a way out from the top of the basin. Air reaches an opening anywhere under its
 * disc, so the whole disc counts. The way there counts too: if it dips further than `drop` under the
 * peak, the pocket above that dip stays trapped, however high the opening itself stands, and every leaf
 * is in its root's basin. Returns the indexes in tree.leaves. Reads only the nodes under the disc.
 */
export function leavesCovered(tree: MergeTree, field: Field, x: number, y: number, radius: number, drop: number): Set<number> {
  const { nx, ny, cell, x0, y0, values } = field;
  const highest = new Map<number, number>();
  const jLow = Math.max(0, Math.ceil((y - radius - y0) / cell)), jHigh = Math.min(ny - 1, Math.floor((y + radius - y0) / cell));
  for (let j = jLow; j <= jHigh; j++) {
    const dy = y0 + j * cell - y;
    const half = Math.sqrt(Math.max(0, radius * radius - dy * dy));
    const iLow = Math.max(0, Math.ceil((x - half - x0) / cell)), iHigh = Math.min(nx - 1, Math.floor((x + half - x0) / cell));
    for (let i = iLow, n = iLow + j * nx; i <= iHigh; i++, n++) {
      const basin = tree.basins[n];
      if (basin < 0) continue;
      const known = highest.get(basin);
      if (known === undefined || values[n] > known) highest.set(basin, values[n]);
    }
  }
  const covered = new Set<number>();
  for (const [start, height] of highest) {
    let reach = height;
    for (let basin = start; basin >= 0; basin = tree.basinParents[basin]) {
      const index = tree.basinLeaves[basin];
      if (index >= 0) {
        const leaf = tree.leaves[index];
        // Further up the chain the peaks only get higher and the way only lower, so none of them can pass.
        if (reach < leaf.height - drop) break;
        covered.add(index);
      }
      reach = Math.min(reach, tree.basinSaddles[basin]);
    }
  }
  return covered;
}
