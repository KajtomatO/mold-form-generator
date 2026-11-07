import { NO_OWNER } from './composite';
import type { Field } from './grid';

export interface CavityCount {
  count: number;
  /** In mm2, largest first. */
  areas: number[];
}

interface CavityRuns {
  /** Nodes in each run. */
  length: number[];
  /** The root run of the cavity a run belongs to. */
  find: (run: number) => number;
}

/**
 * Connected parts of {H > 0}, by runs per row so no field-sized label array is needed. Neighbours
 * connect by a shared edge only: silicone cannot flow through two cells that touch at a corner.
 * `labels`, if given, receives the run of each node in a cavity.
 */
function cavityRuns(field: Field, labels: Int32Array | null): CavityRuns {
  const { nx, ny, values } = field;
  const parent: number[] = [];
  const length: number[] = [];
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };

  // Runs of the previous row, as start, end and id.
  let above: number[] = [];
  for (let y = 0; y < ny; y++) {
    const row = y * nx;
    const current: number[] = [];
    let cursor = 0;
    for (let x = 0; x < nx; x++) {
      if (values[row + x] <= 0) continue;
      const begin = x;
      while (x + 1 < nx && values[row + x + 1] > 0) x++;
      const id = parent.length;
      parent.push(id);
      length.push(x - begin + 1);
      if (labels) labels.fill(id, row + begin, row + x + 1);
      while (cursor < above.length && above[cursor + 1] < begin) cursor += 3;
      for (let k = cursor; k < above.length && above[k] <= x; k += 3) parent[find(above[k + 2])] = find(id);
      current.push(begin, x, id);
    }
    above = current;
  }
  return { length, find };
}

export function countCavities(field: Field): CavityCount {
  const { length, find } = cavityRuns(field, null);
  const area = new Map<number, number>();
  for (let id = 0; id < length.length; id++) {
    const root = find(id);
    area.set(root, (area.get(root) ?? 0) + length[id] * field.cell * field.cell);
  }
  const areas = [...area.values()].sort((a, b) => b - a);
  return { count: areas.length, areas };
}

export interface TileWalls {
  /** Thinnest plastic that keeps the cavities of two tiles apart, in mm, or null if none does. */
  minWall: number | null;
  /** A cavity spans two tiles or more, so no wall stands between them there. */
  merged: boolean;
}

/**
 * G6: what separates the tiles on the conditioned composite. Only plastic down to z = 0 can keep two
 * cavities apart, so a wall is a gap on a line between nodes of different cavities and different
 * tiles. A fin with the same cavity on both sides is not a wall: closing leaves one at its element's
 * width wherever it filled the wall, which says nothing about the wall that was there. Nor is a
 * model's own fin, which is there at any spacing and which spacing could not fix.
 *
 * Width is from first to last plastic node, which is the wall the interpolated surface leaves at its
 * thin end. Rows and columns alone would pass a slanted wall at up to sqrt 2 times its width, so the
 * diagonals are read too. Parallel faces 22.5 degrees from all four lines still read about 8% wide,
 * and rounded corners up to about 16%, so a wall from about 1.85 mm can pass the 2 mm limit. A
 * diagonal's longer step can read up to a cell too thin, which is the safe way round.
 */
export function tileWalls(field: Field, owners: Uint16Array): TileWalls {
  const { nx, ny, cell, values } = field;
  const labels = new Int32Array(values.length).fill(-1);
  const { length, find } = cavityRuns(field, labels);

  const tileOfCavity = new Int32Array(length.length).fill(-1);
  let merged = false;
  for (let n = 0; n < labels.length; n++) {
    if (labels[n] < 0) continue;
    const root = find(labels[n]);
    labels[n] = root;
    const owner = owners[n];
    if (owner === NO_OWNER) continue;
    if (tileOfCavity[root] < 0) tileOfCavity[root] = owner;
    else if (tileOfCavity[root] !== owner) merged = true;
  }

  // The tile next to a wall. Nodes raised by conditioning have none, so it looks further out, as far
  // as the same cavity goes.
  const ownerFrom = (start: number, step: number, remaining: number): number => {
    let at = start;
    for (let k = 0; k < remaining; k++, at += step) {
      if (values[at] <= 0) return NO_OWNER;
      if (owners[at] !== NO_OWNER) return owners[at];
    }
    return NO_OWNER;
  };

  let best = Infinity;
  const scanLine = (line: number, stride: number, total: number, spacing: number): void => {
    let previous = -1;
    for (let k = 0; k < total; k++) {
      const at = line + k * stride;
      if (values[at] <= 0) continue;
      if (previous >= 0) {
        const before = line + previous * stride;
        const width = Math.max(0, k - previous - 2) * spacing;
        if (width < best && labels[at] !== labels[before]) {
          const left = ownerFrom(before, -stride, previous + 1);
          const right = ownerFrom(at, stride, total - k);
          if (left !== NO_OWNER && right !== NO_OWNER && left !== right) best = width;
        }
      }
      previous = k;
    }
  };

  for (let y = 0; y < ny; y++) scanLine(y * nx, 1, nx, cell);
  for (let x = 0; x < nx; x++) scanLine(x, nx, ny, cell);
  const diagonal = cell * Math.SQRT2;
  for (let x = 0; x < nx; x++) {
    scanLine(x, nx + 1, Math.min(nx - x, ny), diagonal);
    scanLine(x, nx - 1, Math.min(x + 1, ny), diagonal);
  }
  for (let y = 1; y < ny; y++) {
    scanLine(y * nx, nx + 1, Math.min(nx, ny - y), diagonal);
    scanLine(nx - 1 + y * nx, nx - 1, Math.min(nx, ny - y), diagonal);
  }
  return { minWall: best === Infinity ? null : best, merged };
}
