import type { Field } from '../field/grid';
import { distanceToOutside } from './distance';
import { HEIGHT_STEP } from './peaks';

/** How far under the peak a flat top still counts as the peak, in mm. Measured in whole height steps, like the peaks. */
export const PLATEAU_DROP = 0.2;
/** A surface under this slope lets the level rise evenly, so no one spot of it is the highest. */
export const PLATEAU_SLOPE_DEG = 2;
export const PLATEAU_MIN_AREA = 50;

/**
 * Whether a height is within PLATEAU_DROP of the peak. The difference is counted in the sweep's height
 * steps, so the limit is the same at any height: 0.2 rounded to a step, which lets a drop under 0.205
 * pass. Rounding each height to its step first would move that limit between 0.200 and 0.210 with the
 * peak's height. The barrel's lid is 0.202 under its rim, and it is the plateau the plan flags.
 */
export function withinPlateauDrop(peak: number, height: number): boolean {
  return Math.round((peak - height) / HEIGHT_STEP) <= Math.round(PLATEAU_DROP / HEIGHT_STEP);
}

/** The middle of a flat: its pole of inaccessibility, as far as can be from its edge. */
export interface FlatPole {
  /** Node index in the field. */
  node: number;
  x: number;
  y: number;
  /** How far the pole is from the flat's edge, in mm. */
  clearance: number;
  centroid: [number, number];
}

/**
 * The pole of a set of nodes joined by edges, given as field indexes. Within a node of the deepest
 * counts as a tie, broken towards the centroid, or one stray node on the edge could send an opening to
 * the far end of a long flat top.
 */
export function flatPole(field: Field, nodes: readonly number[]): FlatPole {
  const { nx, cell, x0, y0 } = field;
  let iLow = Infinity, iHigh = -Infinity, jLow = Infinity, jHigh = -Infinity, sumI = 0, sumJ = 0;
  for (const n of nodes) {
    const i = n % nx, j = (n - i) / nx;
    if (i < iLow) iLow = i;
    if (i > iHigh) iHigh = i;
    if (j < jLow) jLow = j;
    if (j > jHigh) jHigh = j;
    sumI += i;
    sumJ += j;
  }
  // One free ring all round, so the distance below sees the outside on every side.
  const w = iHigh - iLow + 3, h = jHigh - jLow + 3;
  const at = (n: number): number => (n % nx) - iLow + 1 + ((n - (n % nx)) / nx - jLow + 1) * w;
  const mask = new Uint8Array(w * h);
  for (const n of nodes) mask[at(n)] = 1;
  const distance = distanceToOutside(mask, w, h);
  let deepest = 0;
  for (const n of nodes) if (distance[at(n)] > deepest) deepest = distance[at(n)];
  const ci = sumI / nodes.length, cj = sumJ / nodes.length;
  let pole = nodes[0], nearest = Infinity;
  for (const n of nodes) {
    if (distance[at(n)] < deepest - 1) continue;
    const i = n % nx, j = (n - i) / nx;
    const d = (i - ci) ** 2 + (j - cj) ** 2;
    if (d < nearest) {
      nearest = d;
      pole = n;
    }
  }
  const i = pole % nx, j = (pole - i) / nx;
  return { node: pole, x: x0 + i * cell, y: y0 + j * cell, clearance: distance[at(pole)] * cell, centroid: [x0 + ci * cell, y0 + cj * cell] };
}

export interface Plateau {
  /** The pole of inaccessibility: as far as can be from the edge of the flat top. */
  x: number;
  y: number;
  /** How far the pole is from that edge, in mm. */
  clearance: number;
  /** In mm2. */
  area: number;
  /** Highest node on it. */
  height: number;
  centroid: [number, number];
}

/**
 * The plan's plateau rule: nodes within 0.2 mm of the peak with a slope under 2 degrees, joined by
 * edges, and at least 50 mm2. On a flat top the highest node is arbitrary, so the opening belongs at
 * the pole of the highest such part, with ties broken towards its centroid. Null if there is none.
 */
export function findPlateau(field: Field, peak: number): Plateau | null {
  const { nx, ny, cell, values } = field;
  const limit = Math.tan((PLATEAU_SLOPE_DEG * Math.PI) / 180) * 2 * cell;

  let iLow = nx, iHigh = -1, jLow = ny, jHigh = -1;
  const flat: number[] = [];
  // The field's outer ring is always empty, as planning pads it, so a node here has all 4 neighbours.
  for (let j = 1, row = nx; j < ny - 1; j++, row += nx) {
    for (let i = 1, n = row + 1; i < nx - 1; i++, n++) {
      if (values[n] <= 0 || !withinPlateauDrop(peak, values[n])) continue;
      const dx = values[n + 1] - values[n - 1], dy = values[n + nx] - values[n - nx];
      if (dx * dx + dy * dy >= limit * limit) continue;
      flat.push(n);
      if (i < iLow) iLow = i;
      if (i > iHigh) iHigh = i;
      if (j < jLow) jLow = j;
      if (j > jHigh) jHigh = j;
    }
  }
  if (flat.length === 0) return null;

  // Parts are found in a window around the flat nodes, so no array as big as the field is needed.
  const w = iHigh - iLow + 3, h = jHigh - jLow + 3;
  const at = (n: number): number => (n % nx) - iLow + 1 + ((n - (n % nx)) / nx - jLow + 1) * w;
  const toNode = (a: number): number => iLow - 1 + (a % w) + (jLow - 1 + Math.floor(a / w)) * nx;
  const part = new Int32Array(w * h).fill(-1);
  const FLAT = -2;
  for (const n of flat) part[at(n)] = FLAT;

  let best: { nodes: number[]; height: number } | null = null;
  const stack: number[] = [];
  let parts = 0;
  for (const n of flat) {
    const start = at(n);
    if (part[start] !== FLAT) continue;
    const id = parts++;
    const nodes: number[] = [];
    let height = -Infinity;
    part[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const a = stack.pop()!;
      const node = toNode(a);
      nodes.push(node);
      if (values[node] > height) height = values[node];
      for (const b of [a - 1, a + 1, a - w, a + w]) {
        if (part[b] !== FLAT) continue;
        part[b] = id;
        stack.push(b);
      }
    }
    if (nodes.length * cell * cell < PLATEAU_MIN_AREA) continue;
    if (!best || height > best.height) best = { nodes, height };
  }
  if (!best) return null;

  const { x, y, clearance, centroid } = flatPole(field, best.nodes);
  return { x, y, clearance, area: best.nodes.length * cell * cell, height: best.height, centroid };
}
