import type { SeamAxis } from '../parts/rim';
import { forEachCrossing } from '../mesh/crossings';
import type { WeldedMesh } from '../mesh/weld';

/**
 * MP4: G13.5's seam section S and its merge tree. S is the set of rows (b, z), z >= 0, whose cavity is non-empty on
 * either side of P (seamMask in field/side.ts, on the fine fields' lattice). Air that reaches P rises in z within S, so
 * it stops at the top of a run of S: a leaf of S, or a hidden leaf under more of S in its own column.
 */

/** S on the lattice, as seamMask gives it: column k at b = b0 + k cell, row j at z = j cell. */
export interface SeamCells {
  mask: Uint8Array;
  nb: number;
  nz: number;
  b0: number;
  cell: number;
}

/** A top of a run of S, where air on P collects under a rising level. */
export interface SeamLeaf {
  /** Its top cell: column and row, the first cell of its basin in the sweep. */
  k: number;
  j: number;
  /** The middle of its flat top: the columns from k at row j with no S right above them. */
  b: number;
  /** The flat top's first and last column. */
  k0: number;
  k1: number;
  /** z of its top row. */
  height: number;
  /** Where its basin first joins a higher one; 0 for the highest of a component of S, its floor. */
  saddle: number;
  /** height - saddle, in whole cells. */
  persistence: number;
  /** The leaf it merges into, or -1 for the highest of a component of S. */
  parent: number;
  /** More of S lies above every column of its flat top, so no opening at the top reaches its air (G13.5's hidden leaf). */
  hidden: boolean;
}

export interface SeamTree {
  cells: SeamCells;
  /** Highest first, then by b; leaves[0] is the highest point of S. Births at a flat level are not here. */
  leaves: SeamLeaf[];
  /** Per cell: the basin it joined on the way down, or -1 outside S. */
  basins: Int32Array;
  /** Per basin: the basin it merged into, or -1. */
  basinParents: Int32Array;
  /** Per basin: the height at which it merged into its parent, or 0. */
  basinSaddles: Float32Array;
  /** Per basin: its index in `leaves`, or -1 for a birth with no persistence, which folds into its parent. */
  basinLeaves: Int32Array;
}

/**
 * G13.5's merge tree on S: a union-find over the cells of S, swept in descending z, and by b within a row, with
 * 4-neighbours in (b, z), as peaks.ts sweeps a top-down field. The basin born first is the higher, so it lives where two
 * meet, and the other dies there, at that row; only a basin that rose above where it died is a leaf.
 */
export function seamTree(cells: SeamCells): SeamTree {
  const { mask, nb, nz, b0, cell } = cells;
  const basins = new Int32Array(mask.length).fill(-1);
  const parent: number[] = [];
  const peak: number[] = [];
  /** Row at which each basin died, or -1 while it lives. */
  const died: number[] = [];
  const mergedInto: number[] = [];
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  for (let j = nz - 1; j >= 0; j--) {
    for (let k = 0; k < nb; k++) {
      const n = k + j * nb;
      if (!mask[n]) continue;
      let basin = -1;
      for (const other of [k > 0 ? n - 1 : -1, j + 1 < nz ? n + nb : -1]) {
        if (other < 0 || basins[other] < 0) continue;
        const root = find(basins[other]);
        if (basin < 0) basin = root;
        else if (root !== basin) {
          // Born earlier is higher, or as high and further along -b.
          const [winner, loser] = basin < root ? [basin, root] : [root, basin];
          parent[loser] = winner;
          mergedInto[loser] = winner;
          died[loser] = j;
          basin = winner;
        }
      }
      if (basin < 0) {
        basin = parent.length;
        parent.push(basin);
        peak.push(n);
        died.push(-1);
        mergedInto.push(-1);
      }
      basins[n] = basin;
    }
  }
  const rowOf = (n: number): number => Math.floor(n / nb);
  const kept: number[] = [];
  for (let b = 0; b < parent.length; b++) if (died[b] < 0 || rowOf(peak[b]) > died[b]) kept.push(b);
  const basinLeaves = new Int32Array(parent.length).fill(-1);
  kept.forEach((b, index) => (basinLeaves[b] = index));
  const leafAbove = (b: number): number => {
    let at = mergedInto[b];
    while (at >= 0 && basinLeaves[at] < 0) at = mergedInto[at];
    return at < 0 ? -1 : basinLeaves[at];
  };
  const leaves = kept.map((b): SeamLeaf => {
    const n = peak[b];
    const j = rowOf(n), k = n - j * nb;
    let k1 = k;
    while (k1 + 1 < nb && mask[k1 + 1 + j * nb] && !(j + 1 < nz && mask[k1 + 1 + (j + 1) * nb])) k1++;
    // Hidden only where every column of the flat top has more of S above it: one open column lets its air out at the top.
    let hidden = true;
    for (let kk = k; kk <= k1 && hidden; kk++) {
      let above = false;
      for (let jj = j + 1; jj < nz && !above; jj++) if (mask[kk + jj * nb]) above = true;
      hidden = above;
    }
    const deathRow = Math.max(died[b], 0);
    return {
      k,
      j,
      b: b0 + ((k + k1) / 2) * cell,
      k0: k,
      k1,
      height: j * cell,
      saddle: deathRow * cell,
      persistence: (j - deathRow) * cell,
      parent: died[b] < 0 ? -1 : leafAbove(b),
      hidden,
    };
  });
  const basinSaddles = Float32Array.from(died, (row) => Math.max(row, 0) * cell);
  return { cells, leaves, basins, basinParents: Int32Array.from(mergedInto), basinSaddles, basinLeaves };
}

/** The leaves that matter: those past the persistence limit, plus the top of each component of S, which always does. */
export function significantSeamLeaves(tree: SeamTree, minPersistence: number): SeamLeaf[] {
  // Persistence is in whole cells, so a hair of slack only absorbs float noise in the limit.
  return tree.leaves.filter((leaf) => leaf.parent < 0 || leaf.persistence >= minPersistence - 1e-6);
}

/**
 * peaks.ts's leavesCovered on S: a leaf is covered when a bore on P, |b - b0| <= radius from `zFrom` up, meets its
 * basin within `drop` of its height, and the way up the basins from there never dips further than that under it. The
 * bore's own cells are those of S under its b span at or over zFrom less a cell, where it opens into the run below.
 * Returns the indexes in tree.leaves.
 */
export function seamLeavesCovered(tree: SeamTree, b: number, radius: number, zFrom: number, drop: number): Set<number> {
  const { mask, nb, nz, b0, cell } = tree.cells;
  const highest = new Map<number, number>();
  const kLow = Math.max(0, Math.ceil((b - radius - b0) / cell - 1e-9)), kHigh = Math.min(nb - 1, Math.floor((b + radius - b0) / cell + 1e-9));
  const jLow = Math.max(0, Math.ceil((zFrom - cell) / cell - 1e-9));
  for (let k = kLow; k <= kHigh; k++) {
    for (let j = jLow; j < nz; j++) {
      const n = k + j * nb;
      if (!mask[n]) continue;
      const basin = tree.basins[n];
      const z = j * cell;
      const known = highest.get(basin);
      if (known === undefined || z > known) highest.set(basin, z);
    }
  }
  const covered = new Set<number>();
  for (const [start, height] of highest) {
    let reach = height;
    for (let basin = start; basin >= 0; basin = tree.basinParents[basin]) {
      const index = tree.basinLeaves[basin];
      if (index >= 0) {
        const leaf = tree.leaves[index];
        if (reach < leaf.height - drop - 1e-9) break;
        covered.add(index);
      }
      reach = Math.min(reach, tree.basinSaddles[basin]);
    }
  }
  return covered;
}

/**
 * The columns of the leaf's own basin within `drop` of its height: its top run, inside which a hidden leaf's vent is
 * looked for. Ascending.
 */
export function topRunColumns(tree: SeamTree, leafIndex: number, drop: number): number[] {
  const { mask, nb, nz, cell } = tree.cells;
  const leaf = tree.leaves[leafIndex];
  const own = new Set<number>();
  tree.basinLeaves.forEach((index, basin) => {
    if (index === leafIndex) own.add(basin);
  });
  // Births folded into this leaf's basin are its run too.
  tree.basinLeaves.forEach((index, basin) => {
    if (index >= 0) return;
    let at = basin;
    while (at >= 0 && tree.basinLeaves[at] < 0) at = tree.basinParents[at];
    if (at >= 0 && tree.basinLeaves[at] === leafIndex) own.add(basin);
  });
  const columns: number[] = [];
  const jLow = Math.max(0, Math.ceil((leaf.height - drop) / cell - 1e-9));
  for (let k = 0; k < nb; k++) {
    for (let j = Math.min(nz - 1, leaf.j); j >= jLow; j--) {
      const basin = tree.basins[k + j * nb];
      if (mask[k + j * nb] && own.has(basin)) {
        columns.push(k);
        break;
      }
    }
  }
  return columns;
}

/**
 * S8's column read of the model, along a strip about P: each column at `cell` holds the model's crossings sorted by
 * height with their winding, as analyseIntervals reads them, so a straight vent on P can be held clear of the model
 * (G13.5's hidden leaf). Only the strip |a - xs| <= half is read.
 */
export interface ModelStrip {
  /** Whether no column within `radius` of (xs, b) holds the model between z0 and z1. */
  clear(b: number, radius: number, z0: number, z1: number): boolean;
}

export function modelStrip(mesh: WeldedMesh, axis: SeamAxis, xs: number, half: number, cell: number): ModelStrip {
  const { positions } = mesh;
  const bi = axis === 'x' ? 1 : 0;
  let bLow = Infinity, bHigh = -Infinity;
  for (let k = bi; k < positions.length; k += 3) {
    if (positions[k] < bLow) bLow = positions[k];
    if (positions[k] > bHigh) bHigh = positions[k];
  }
  if (!(bHigh >= bLow)) return { clear: () => true };
  const na = Math.ceil((2 * half) / cell) + 3, nbCols = Math.ceil((bHigh - bLow) / cell) + 3;
  const a0 = xs - half - cell, b0 = bLow - cell;
  const [nx, ny, x0, y0] = axis === 'x' ? [na, nbCols, a0, b0] : [nbCols, na, b0, a0];
  const lists = new Map<number, number[]>();
  forEachCrossing(mesh, nx, ny, cell, x0, y0, (column, z, sign) => {
    let list = lists.get(column);
    if (!list) lists.set(column, (list = []));
    list.push(z, sign);
  });
  // Per column, the solid stretches as [z0, z1] pairs, where the winding is positive.
  const solid = new Map<number, number[]>();
  for (const [column, list] of lists) {
    const order = Array.from({ length: list.length / 2 }, (_, k) => k).sort((p, q) => list[2 * p] - list[2 * q]);
    const stretches: number[] = [];
    let winding = 0, from = 0;
    for (const k of order) {
      const was = winding;
      winding += list[2 * k + 1];
      if (was <= 0 && winding > 0) from = list[2 * k];
      else if (was > 0 && winding <= 0) stretches.push(from, list[2 * k]);
    }
    if (stretches.length > 0) solid.set(column, stretches);
  }
  return {
    clear(b, radius, z0, z1) {
      const reach = radius + cell * Math.SQRT2;
      const [cx, cy] = axis === 'x' ? [xs, b] : [b, xs];
      const iLow = Math.max(0, Math.floor((cx - reach - x0) / cell)), iHigh = Math.min(nx - 1, Math.ceil((cx + reach - x0) / cell));
      const jLow = Math.max(0, Math.floor((cy - reach - y0) / cell)), jHigh = Math.min(ny - 1, Math.ceil((cy + reach - y0) / cell));
      for (let i = iLow; i <= iHigh; i++) {
        for (let j = jLow; j <= jHigh; j++) {
          const x = x0 + i * cell, y = y0 + j * cell;
          const [a, bb] = axis === 'x' ? [x, y] : [y, x];
          if (Math.hypot(a - xs, bb - b) > reach) continue;
          const stretches = solid.get(i + j * nx);
          if (!stretches) continue;
          for (let s = 0; s < stretches.length; s += 2) if (stretches[s] < z1 && stretches[s + 1] > z0) return false;
        }
      }
      return true;
    },
  };
}
