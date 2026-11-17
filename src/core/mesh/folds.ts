import { forEachCrossing } from './crossings';
import { meshBounds, type WeldedMesh } from './weld';

/**
 * RM: where a closed mesh folds through itself. Rising up a column through a closed surface wound outwards, the
 * winding (+1 entering, -1 leaving, forEachCrossing's signs) counts how many layers of solid the column is in, and
 * never goes below 0. Where a face has been pushed through another, the surface turns inside out over the part
 * pushed through, and there the winding goes below 0. A zero-volume sliver (two faces on each other, wound
 * opposite ways) only touches -1 at one height, so a run counts only when it is longer than `minRun`. A column
 * whose signs do not sum to 0 passes through a crack in the surface and says nothing, so it is left out. Pure TS.
 */

/** The cell of the fold check's columns, in mm, and the shortest run below 0 that counts as a fold. */
export const FOLD_CELL_MM = 0.5;
export const FOLD_MIN_RUN_MM = 0.01;
/** How many places a check marks, for Show. */
export const FOLD_MARKS = 20;

export interface WindingFolds {
  /** Columns with a run of winding below 0 longer than the minimum. */
  columns: number;
  /** Separate places: such columns joined to their eight neighbours. */
  places: number;
  /** One point a place, at most `marks`, in the mesh's coordinates: the middle of the place's longest run. */
  at: [number, number, number][];
  /** The longest run found, in mm, 0 if none. */
  longest: number;
  /** The lowest winding reached anywhere, 0 or below. */
  deepest: number;
}

const NONE: WindingFolds = { columns: 0, places: 0, at: [], longest: 0, deepest: 0 };

/**
 * Runs of winding below 0 in the z columns of `mesh` at `cell`. `where`, if given, hears each run as it is found:
 * its column's x and y, and the heights it runs from and to (the repair's reduction locks the vertices round
 * them). The same mesh gives the same answer everywhere: + - * / and comparisons only.
 */
export function windingFolds(mesh: WeldedMesh, cell = FOLD_CELL_MM, minRun = FOLD_MIN_RUN_MM, marks = FOLD_MARKS, where?: (x: number, y: number, from: number, to: number) => void): WindingFolds {
  if (mesh.indices.length === 0) return { ...NONE, at: [] };
  const { min, max } = meshBounds(mesh.positions);
  const nx = Math.ceil((max[0] - min[0]) / cell) + 2;
  const ny = Math.ceil((max[1] - min[1]) / cell) + 2;
  const x0 = min[0] - cell / 2, y0 = min[1] - cell / 2;
  const cols = nx * ny;
  const starts = new Int32Array(cols + 1);
  forEachCrossing(mesh, nx, ny, cell, x0, y0, (c) => void starts[c + 1]++);
  for (let c = 0; c < cols; c++) starts[c + 1] += starts[c];
  const zs = new Float64Array(starts[cols]);
  const signs = new Int8Array(starts[cols]);
  const fill = starts.slice(0, cols);
  // Each column sorted by height as its crossings come, by insertion: a column holds a few.
  forEachCrossing(mesh, nx, ny, cell, x0, y0, (c, z, sign) => {
    let at = fill[c]++;
    while (at > starts[c] && zs[at - 1] > z) {
      zs[at] = zs[at - 1];
      signs[at] = signs[at - 1];
      at--;
    }
    zs[at] = z;
    signs[at] = sign;
  });
  // Each fold column's longest run, as from and to heights, for the marks.
  const flagged = new Uint8Array(cols);
  const runFrom = new Float64Array(cols), runTo = new Float64Array(cols);
  let columns = 0, deepest = 0, longest = 0;
  for (let c = 0; c < cols; c++) {
    const s = starts[c], e = starts[c + 1];
    let sum = 0;
    for (let i = s; i < e; i++) sum += signs[i];
    if (sum !== 0) continue;
    let w = 0, from = 0, best = 0;
    for (let i = s; i < e; ) {
      const z = zs[i];
      const before = w;
      // Crossings at one height count together, so a sliver's two faces cancel there.
      while (i < e && zs[i] === z) w += signs[i++];
      if (before >= 0 && w < 0) from = z;
      if (w < deepest) deepest = w;
      if (before < 0 && w >= 0) {
        const run = z - from;
        if (run > minRun) {
          where?.(x0 + (c % nx) * cell, y0 + Math.floor(c / nx) * cell, from, z);
          if (run > best) {
            best = run;
            runFrom[c] = from;
            runTo[c] = z;
          }
        }
      }
    }
    if (best > 0) {
      flagged[c] = 1;
      columns++;
      if (best > longest) longest = best;
    }
  }
  if (columns === 0) return { ...NONE, at: [], deepest };
  // Places: flagged columns joined to their eight neighbours, found in column order, so the marks come in a fixed order.
  const at: [number, number, number][] = [];
  const stack: number[] = [];
  let places = 0;
  for (let c = 0; c < cols; c++) {
    if (flagged[c] !== 1) continue;
    places++;
    flagged[c] = 2;
    stack.push(c);
    let pick = c;
    while (stack.length > 0) {
      const q = stack.pop()!;
      if (runTo[q] - runFrom[q] > runTo[pick] - runFrom[pick]) pick = q;
      const qx = q % nx, qy = Math.floor(q / nx);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = qx + dx, y = qy + dy;
          if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
          const n = x + y * nx;
          if (flagged[n] !== 1) continue;
          flagged[n] = 2;
          stack.push(n);
        }
      }
    }
    if (at.length < marks) at.push([x0 + (pick % nx) * cell, y0 + Math.floor(pick / nx) * cell, (runFrom[pick] + runTo[pick]) / 2]);
  }
  return { columns, places, at, longest, deepest };
}
