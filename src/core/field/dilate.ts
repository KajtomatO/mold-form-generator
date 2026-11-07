import { emptyField, type Field } from './grid';

/**
 * G3: H = max over sources (h + sqrt(r^2 - d^2)) for d <= r, with most of the splat pruned away.
 *
 * Each source's kernel is split into 8 sectors, one around each neighbour, and each sector is kept
 * sorted by distance. Compared with this source:
 *  - The neighbour q ahead, in the sector's direction, is closer to every offset in the sector. How
 *    much q gains over the source grows towards the rim, where the sphere falls steeply. So q wins
 *    on the far part of the sector, or on all of it if q is not lower.
 *  - The neighbour b behind is further from every offset, and it loses more towards the rim. So if
 *    b is higher it wins on the near part of the sector.
 * Only the annulus left between those two is written.
 *
 * Why this is exact: an offset is dropped only for a neighbour that gives a strictly greater value,
 * or an equal value from strictly closer. Following that chain the value never falls and ties
 * always get closer, so it ends at a source that writes the offset. Distance 0 is always written.
 *
 * Cost follows r / cell, so callers set cells in mm. test/fixtures/bruteDilate.ts is the reference.
 */

/** Steps in a height difference lookup, from 0 up to the radius. Fine enough to lose little pruning. */
const BUCKETS = 1024;

// Sector j is centred on this neighbour, at j * 45 degrees.
const NEIGHBOUR_DX = [1, 1, 0, -1, -1, -1, 0, 1];
const NEIGHBOUR_DY = [0, 1, 1, 1, 0, -1, -1, -1];

interface Kernel {
  /** Linear offset of each entry, sectors one after another, each sorted by distance. */
  offsets: Int32Array;
  /** Sphere height at each entry, in mm. */
  heights: Float64Array;
  /** First entry of each sector, plus the end of the last. */
  start: Int32Array;
  /** Per sector and bucket: entries from here on are beaten by the neighbour ahead. */
  ahead: Int32Array;
  /** Per sector and bucket: entries before this are beaten by a higher neighbour behind. */
  behind: Int32Array;
  bucketSize: number;
}

function buildKernel(radiusCells: number, cell: number, nx: number): Kernel {
  const reach = Math.floor(radiusCells);
  const r2 = radiusCells * radiusCells;
  const sphere = (d2: number): number => Math.sqrt(r2 - d2) * cell;

  const sectors: [number, number, number][][] = Array.from({ length: 8 }, () => []);
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const d2 = dx * dx + dy * dy;
      // G3 keeps d = r, where the sphere is at the source's height. So volume on a straight wall is a
      // sawtooth in r / cell: it gains one cell times the wall's area just as the ratio reaches a whole number.
      if (d2 === 0 || d2 > r2) continue;
      // No integer offset lies on a boundary at 22.5 degrees, so each has exactly one sector.
      const sector = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8;
      sectors[sector].push([dx, dy, d2]);
    }
  }

  const total = sectors.reduce((sum, s) => sum + s.length, 0);
  const offsets = new Int32Array(total);
  const heights = new Float64Array(total);
  const start = new Int32Array(9);
  const ahead = new Int32Array(8 * (BUCKETS + 1));
  const behind = new Int32Array(8 * (BUCKETS + 1));
  const bucketSize = (radiusCells * cell) / BUCKETS;

  let write = 0;
  for (let j = 0; j < 8; j++) {
    const entries = sectors[j].sort((a, b) => a[2] - b[2]);
    const count = entries.length;
    start[j] = write;
    const qx = NEIGHBOUR_DX[j], qy = NEIGHBOUR_DY[j];
    const gain = new Float64Array(count);
    const loss = new Float64Array(count);
    entries.forEach(([dx, dy, d2], i) => {
      offsets[write + i] = dx + dy * nx;
      const own = sphere(d2);
      heights[write + i] = own;
      // Every offset in a 45 degree sector is strictly closer to the neighbour ahead, so it reaches.
      gain[i] = sphere((dx - qx) ** 2 + (dy - qy) ** 2) - own;
      const from = (dx + qx) ** 2 + (dy + qy) ** 2;
      loss[i] = from > r2 ? Infinity : own - sphere(from);
    });

    // Gain is not quite monotone: on a lattice the distances to the two sources do not step in
    // lockstep. A threshold must hold for every entry from there on, so keep the lowest gain ahead.
    for (let i = count - 2; i >= 0; i--) if (gain[i + 1] < gain[i]) gain[i] = gain[i + 1];

    const row = j * (BUCKETS + 1);
    for (let b = 0, i = 0; b <= BUCKETS; b++) {
      while (i < count && gain[i] < b * bucketSize) i++;
      ahead[row + b] = i;
    }
    // Stopping at the first entry that costs too much is what makes this one safe as it is.
    for (let b = 0, i = 0; b <= BUCKETS; b++) {
      while (i < count && loss[i] < b * bucketSize) i++;
      behind[row + b] = i;
    }
    write += count;
  }
  start[8] = write;
  return { offsets, heights, start, ahead, behind, bucketSize };
}

export function dilate(raster: Field, radius: number): Field {
  const { nx, ny, cell, values: source } = raster;
  const radiusCells = radius / cell;
  const reach = Math.ceil(radiusCells);
  const out = emptyField(raster);
  const values = out.values;
  const { offsets, heights, start, ahead, behind, bucketSize } = buildKernel(radiusCells, cell, nx);

  const steps = new Int32Array(8);
  for (let j = 0; j < 8; j++) steps[j] = NEIGHBOUR_DX[j] + NEIGHBOUR_DY[j] * nx;

  const perBucket = 1 / bucketSize;
  for (let y = 0; y < ny; y++) {
    const row = y * nx;
    const nearEdgeY = y < reach || y >= ny - reach;
    for (let x = 0; x < nx; x++) {
      const n = x + row;
      const h = source[n];
      if (h < 0) continue;
      // Skipping per-write bounds checks is what keeps this loop fast, so the domain must fit.
      if (nearEdgeY || x < reach || x >= nx - reach) throw new Error('A source lies too close to the edge of the field domain.');

      const self = h + radius;
      if (self > values[n]) values[n] = self;

      for (let j = 0; j < 8; j++) {
        let first = start[j];
        let last = start[j + 1];
        const table = j * (BUCKETS + 1);

        const front = source[n + steps[j]];
        if (front >= 0) {
          const drop = h - front;
          if (drop <= 0) continue;
          const bucket = Math.ceil(drop * perBucket);
          if (bucket <= BUCKETS) last = first + ahead[table + bucket];
        }
        const back = source[n - steps[j]];
        if (back > h) {
          const bucket = Math.floor((back - h) * perBucket);
          first += behind[table + (bucket < BUCKETS ? bucket : BUCKETS)];
        }
        for (let i = first; i < last; i++) {
          const at = n + offsets[i];
          const v = h + heights[i];
          if (v > values[at]) values[at] = v;
        }
      }
    }
  }
  return out;
}
