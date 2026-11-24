/**
 * MP2's leak voxel test (docs/PLAN.md, MP2's checks; G13.9): the printed parts voxelized, each opened by a small ball so
 * every printed edge is rounded as a print rounds it, and the shortest way out of the liquid read by a 0-1 search whose
 * cost is the cells of the funnel flange's contact it crosses. MP3 and MP3b run it again with the lugs and the ears.
 *
 * Cells are a lattice of cubes `h` on a side, packed as bits along z, one run of W words per (x, y) column, x fastest.
 */

export interface VoxelGrid {
  h: number;
  /** The first cell's centre. */
  o: [number, number, number];
  nx: number;
  ny: number;
  nz: number;
  /** Words per column. */
  W: number;
}

export type Bits = Uint32Array;

/** A small offset off the lattice, so no cell centre falls exactly on a face, an edge or P. */
const JITTER: [number, number, number] = [1.37e-4, 2.91e-4, 0.53e-4];

/** The lattice over a box, padded by `pad` cells each side. */
export function voxelGrid(min: readonly number[], max: readonly number[], h: number, pad = 3): VoxelGrid {
  const n = [0, 1, 2].map((a) => Math.ceil((max[a] - min[a]) / h) + 2 * pad);
  const o = [0, 1, 2].map((a) => min[a] - pad * h + h / 2 + JITTER[a]) as [number, number, number];
  return { h, o, nx: n[0], ny: n[1], nz: n[2], W: Math.ceil(n[2] / 32) };
}

export function emptyBits(g: VoxelGrid): Bits {
  return new Uint32Array(g.nx * g.ny * g.W);
}

export function getBit(g: VoxelGrid, bits: Bits, c: number, k: number): boolean {
  return (bits[c * g.W + (k >>> 5)] & (1 << (k & 31))) !== 0;
}

function setRun(g: VoxelGrid, bits: Bits, c: number, k0: number, k1: number): void {
  for (let k = Math.max(0, k0); k < Math.min(g.nz, k1); k++) bits[c * g.W + (k >>> 5)] |= 1 << (k & 31);
}

/** Growing arrays of a column's crossings: its index, the z, and +1 entering or -1 leaving. */
class Crossings {
  col = new Int32Array(1 << 16);
  z = new Float64Array(1 << 16);
  s = new Int8Array(1 << 16);
  n = 0;
  push(col: number, z: number, s: number): void {
    if (this.n === this.col.length) {
      const grow = <T extends Int32Array | Float64Array | Int8Array>(a: T): T => {
        const b = new (a.constructor as new (n: number) => T)(a.length * 2);
        b.set(a);
        return b;
      };
      this.col = grow(this.col);
      this.z = grow(this.z);
      this.s = grow(this.s);
    }
    this.col[this.n] = col;
    this.z[this.n] = z;
    this.s[this.n++] = s;
  }
}

/**
 * A closed oriented mesh's cells: a ray up each column, its crossings counted by the faces' winding, so a cell is in where
 * the winding past its centre is positive.
 */
export function voxelize(g: VoxelGrid, mesh: { vertProperties: Float32Array; triVerts: Uint32Array; numProp?: number }): Bits {
  const { vertProperties: P, triVerts: T } = mesh;
  const stride = mesh.numProp ?? 3;
  const { h, o, nx, ny } = g;
  const out = new Crossings();
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t] * stride, b = T[t + 1] * stride, c = T[t + 2] * stride;
    const ax = P[a], ay = P[a + 1], bx = P[b], by = P[b + 1], cx = P[c], cy = P[c + 1];
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-14) continue;
    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - o[0]) / h)), i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - o[0]) / h));
    const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - o[1]) / h)), j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - o[1]) / h));
    // Faces turning their outside down are entered going up.
    const s = area > 0 ? -1 : 1;
    for (let j = j0; j <= j1; j++) {
      const y = o[1] + j * h;
      for (let i = i0; i <= i1; i++) {
        const x = o[0] + i * h;
        const w0 = (bx - x) * (cy - y) - (by - y) * (cx - x);
        const w1 = (cx - x) * (ay - y) - (cy - y) * (ax - x);
        const w2 = (ax - x) * (by - y) - (ay - y) * (bx - x);
        if (!((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0))) continue;
        out.push(i + j * nx, (w0 * P[a + 2] + w1 * P[b + 2] + w2 * P[c + 2]) / area, s);
      }
    }
  }
  // By column, then each column's crossings by z.
  const columns = nx * ny;
  const start = new Int32Array(columns + 1);
  for (let k = 0; k < out.n; k++) start[out.col[k] + 1]++;
  for (let c = 0; c < columns; c++) start[c + 1] += start[c];
  const fill = start.slice(0, columns);
  const order = new Int32Array(out.n);
  for (let k = 0; k < out.n; k++) order[fill[out.col[k]]++] = k;
  const bits = emptyBits(g);
  const zs: number[] = [], ss: number[] = [];
  for (let c = 0; c < columns; c++) {
    const n = start[c + 1] - start[c];
    if (n === 0) continue;
    zs.length = ss.length = 0;
    for (let k = start[c]; k < start[c + 1]; k++) {
      zs.push(out.z[order[k]]);
      ss.push(out.s[order[k]]);
    }
    const idx = zs.map((_, k) => k).sort((p, q) => zs[p] - zs[q]);
    let wind = 0;
    for (let k = 0; k < n; k++) {
      const was = wind;
      wind += ss[idx[k]];
      if (was > 0 && k > 0) setRun(g, bits, c, Math.ceil((zs[idx[k - 1]] - o[2]) / h), Math.ceil((zs[idx[k]] - o[2]) / h));
    }
  }
  return bits;
}

export function or(...all: Bits[]): Bits {
  const out = all[0].slice();
  for (const b of all.slice(1)) for (let w = 0; w < out.length; w++) out[w] |= b[w];
  return out;
}

export function and(a: Bits, b: Bits): Bits {
  const out = a.slice();
  for (let w = 0; w < out.length; w++) out[w] &= b[w];
  return out;
}

export function andNot(a: Bits, b: Bits): Bits {
  const out = a.slice();
  for (let w = 0; w < out.length; w++) out[w] &= ~b[w];
  return out;
}

export function count(bits: Bits): number {
  let n = 0;
  for (let w = 0; w < bits.length; w++) {
    let v = bits[w];
    v = v - ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    n += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return n;
}

/** Bits past nz in each column's last word, kept 0. */
function lastMask(g: VoxelGrid): number {
  const r = g.nz & 31;
  return r === 0 ? 0xffffffff : (1 << r) - 1;
}

/**
 * One step of erosion (`erode`) or dilation along an axis: a cell and its two neighbours, ANDed or ORed. Past the lattice's
 * top a cell counts as filled for erosion, so a part cut off by the lattice's top (the funnel) keeps its cut face.
 */
function step(g: VoxelGrid, a: Bits, axis: 0 | 1 | 2, erode: boolean): Bits {
  const { nx, ny, W } = g;
  const out = new Uint32Array(a.length);
  const mask = lastMask(g);
  if (axis === 2) {
    const topBit = 1 << ((g.nz - 1) & 31);
    for (let c = 0; c < nx * ny; c++) {
      const base = c * W;
      for (let w = 0; w < W; w++) {
        const v = a[base + w];
        const up = (v >>> 1) | (w + 1 < W ? a[base + w + 1] << 31 : erode ? topBit : 0);
        const down = (v << 1) | (w > 0 ? a[base + w - 1] >>> 31 : 0);
        out[base + w] = erode ? v & up & down : v | up | down;
      }
      out[base + W - 1] &= mask;
    }
    return out;
  }
  const stride = axis === 0 ? W : nx * W;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const base = (i + j * nx) * W;
      const lo = axis === 0 ? i > 0 : j > 0, hi = axis === 0 ? i < nx - 1 : j < ny - 1;
      for (let w = 0; w < W; w++) {
        const v = a[base + w];
        const p = lo ? a[base + w - stride] : 0, q = hi ? a[base + w + stride] : 0;
        out[base + w] = erode ? v & p & q : v | p | q;
      }
    }
  }
  return out;
}

/**
 * Erosion or dilation by about a ball of 2 cells: the cross of 6 neighbours on the 18-neighbour cube less its corners, each a
 * union of axis steps (cross = x | y | z, the 18 = xy | yz | xz). Its widest reach is sqrt(5) cells, its narrowest 2.
 */
function ball(g: VoxelGrid, a: Bits, erode: boolean): Bits {
  const join = erode ? and : or;
  const z = step(g, a, 2, erode);
  const sq = join(join(step(g, step(g, a, 1, erode), 0, erode), step(g, z, 1, erode)), step(g, z, 0, erode));
  return join(join(step(g, sq, 0, erode), step(g, sq, 1, erode)), step(g, sq, 2, erode));
}

/** The cells next to a set, across a face: what a contact between two parts is read from. */
export function grow6(g: VoxelGrid, a: Bits): Bits {
  return or(step(g, a, 0, false), step(g, a, 1, false), step(g, a, 2, false));
}

/** A part's printed edges rounded: its opening by the ball, which keeps every flat face and rounds every convex edge. */
export function opened(g: VoxelGrid, a: Bits): Bits {
  return ball(g, ball(g, a, true), false);
}

/** Cells whose centre lies within the flange's footprint about the pour's axis and within `layer` of the top face. */
export function flangeZone(g: VoxelGrid, x: number, y: number, radius: number, Zt: number, layer: number): Bits {
  const bits = emptyBits(g);
  const { h, o, nx, ny, nz } = g;
  const k0 = Math.max(0, Math.ceil((Zt - layer - o[2]) / h)), k1 = Math.min(nz, Math.floor((Zt + layer - o[2]) / h) + 1);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (Math.hypot(o[0] + i * h - x, o[1] + j * h - y) > radius) continue;
      setRun(g, bits, i + j * nx, k0, k1);
    }
  }
  return bits;
}

/** Cells whose centre lies within `radius` of the vertical line through (x, y), from z0 to the lattice's top. */
export function columnZone(g: VoxelGrid, x: number, y: number, radius: number, z0: number): Bits {
  const bits = emptyBits(g);
  const { h, o, nx, ny, nz } = g;
  const k0 = Math.max(0, Math.ceil((z0 - o[2]) / h));
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (Math.hypot(o[0] + i * h - x, o[1] + j * h - y) > radius) continue;
      setRun(g, bits, i + j * nx, k0, nz);
    }
  }
  return bits;
}

/** Cells whose centre lies in the box from `min` to `max`. */
export function boxZone(g: VoxelGrid, min: readonly number[], max: readonly number[]): Bits {
  const bits = emptyBits(g);
  const { h, o, nx, ny, nz } = g;
  const range = (a: number, n: number): [number, number] => [Math.max(0, Math.ceil((min[a] - o[a]) / h)), Math.min(n, Math.floor((max[a] - o[a]) / h) + 1)];
  const [i0, i1] = range(0, nx), [j0, j1] = range(1, ny), [k0, k1] = range(2, nz);
  for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) setRun(g, bits, i + j * nx, k0, k1);
  return bits;
}

/** A growing queue of cell ids. */
class Queue {
  a = new Int32Array(1 << 16);
  n = 0;
  push(v: number): void {
    if (this.n === this.a.length) {
      const b = new Int32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
}

/** Visits the 6 neighbours of cell (c, k), c = i + j nx. */
function neighbours(g: VoxelGrid, id: number, visit: (c: number, k: number) => void): void {
  const { nx, ny, nz } = g;
  const c = Math.floor(id / nz), k = id - c * nz;
  const i = c % nx, j = (c - i) / nx;
  if (k > 0) visit(c, k - 1);
  if (k < nz - 1) visit(c, k + 1);
  if (i > 0) visit(c - 1, k);
  if (i < nx - 1) visit(c + 1, k);
  if (j > 0) visit(c - nx, k);
  if (j < ny - 1) visit(c + nx, k);
}

export interface LeakInput {
  /** Every part's cells, after opening. */
  occupied: Bits;
  /** The liquid: the cavity, the openings' cutters and the funnel's inside, less the parts. */
  liquid: Bits;
  /** K4 and K5: cells in the base groove's or the seam groove's cutter and in no part. */
  barrier: Bits;
  /** The flange's contact zone: crossing one of its cells costs one. */
  flange: Bits;
  /** Part cells a path may run through: every contact between two parts, the film a crack holds. */
  contact: Bits;
}

function mark(g: VoxelGrid, bits: Bits, c: number, k: number): void {
  bits[c * g.W + (k >>> 5)] |= 1 << (k & 31);
}

/**
 * The outside: empty cells reached from the lattice's faces, through empty cells that are not liquid, a barrier or in
 * the flange's zone. With `outFrom`, each cell's predecessor on the way in, for a trace.
 */
export function outsideOf(g: VoxelGrid, input: Pick<LeakInput, 'occupied' | 'liquid' | 'barrier' | 'flange'>, outFrom: Int32Array | null = null): Bits {
  const { nx, ny, nz } = g;
  const { occupied, liquid, barrier, flange } = input;
  const at = (bits: Bits, c: number, k: number): boolean => getBit(g, bits, c, k);
  const outside = emptyBits(g);
  const free = (c: number, k: number): boolean => !at(occupied, c, k) && !at(liquid, c, k) && !at(barrier, c, k) && !at(flange, c, k);
  const queue = new Queue();
  let from = -1;
  const seed = (c: number, k: number): void => {
    if (!at(outside, c, k) && free(c, k)) {
      mark(g, outside, c, k);
      if (outFrom) outFrom[c * nz + k] = from;
      queue.push(c * nz + k);
    }
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = i + j * nx;
      if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) {
        for (let k = 0; k < nz; k++) seed(c, k);
      } else {
        seed(c, 0);
        seed(c, nz - 1);
      }
    }
  }
  for (let q = 0; q < queue.n; q++) {
    from = queue.a[q];
    neighbours(g, queue.a[q], seed);
  }
  return outside;
}

/** A cell's centre. */
function centre(g: VoxelGrid, id: number): [number, number, number] {
  const { nx, nz } = g;
  const c = Math.floor(id / nz), k = id - c * nz, i = c % nx, j = (c - i) / nx;
  return [g.o[0] + i * g.h, g.o[1] + j * g.h, g.o[2] + k * g.h];
}

/** The first cell of a set, by column then z, as its centre, or null when the set is empty. */
export function firstCell(g: VoxelGrid, bits: Bits): [number, number, number] | null {
  for (let w = 0; w < bits.length; w++) {
    if (bits[w] === 0) continue;
    const c = Math.floor(w / g.W), k = (w - c * g.W) * 32 + 31 - Math.clz32(bits[w] & -bits[w]);
    return centre(g, c * g.nz + k);
  }
  return null;
}

/**
 * The cells of `barrier` next to `outside` (the outsideOf cells, or the open air among them), less those in `allowed`:
 * where a groove's void would reach the outside but through its exits, so a crack could run round it through the void's
 * own Vaseline.
 */
export function barrierExits(g: VoxelGrid, barrier: Bits, outside: Bits, allowed: Bits): Bits {
  return andNot(and(barrier, grow6(g, outside)), allowed);
}

/**
 * The least number of flange cells any path from the liquid to the outside crosses, through empty cells and the
 * contacts between parts, never a barrier: Infinity where none gets out.
 */
export function leastFlangeCrossing(g: VoxelGrid, input: LeakInput, trace?: (path: [number, number, number][]) => void): number {
  const { nx, ny, nz } = g;
  const { occupied, liquid, barrier, flange, contact } = input;
  const at = (bits: Bits, c: number, k: number): boolean => getBit(g, bits, c, k);
  const outFrom = trace ? new Int32Array(nx * ny * nz).fill(-1) : null;
  const outside = outsideOf(g, input, outFrom);
  const where = (id: number): [number, number, number] => centre(g, id);

  // 0-1 search from the liquid: a step into a flange cell costs one, any other step nothing.
  const settled = emptyBits(g);
  const parent = trace ? new Int32Array(nx * ny * nz).fill(-1) : null;
  let now = new Queue(), next = new Queue();
  for (let c = 0; c < nx * ny; c++) {
    for (let k = 0; k < nz; k++) {
      if (!at(liquid, c, k)) continue;
      mark(g, settled, c, k);
      now.push(c * nz + k);
    }
  }
  const passable = (c: number, k: number): boolean => !at(barrier, c, k) && (!at(occupied, c, k) || at(contact, c, k));
  for (let cost = 0; now.n > 0 || next.n > 0; cost++) {
    let found = false;
    for (let q = 0; q < now.n && !found; q++) {
      const id = now.a[q];
      neighbours(g, id, (c, k) => {
        if (found || at(settled, c, k)) return;
        if (at(outside, c, k)) {
          found = true;
          if (parent && outFrom && trace) {
            // The way out, from the outside's face to the liquid.
            const path: [number, number, number][] = [];
            const outer: number[] = [];
            for (let at2 = c * nz + k; at2 >= 0; at2 = outFrom[at2]) outer.push(at2);
            for (const cell of outer.reverse()) path.push(where(cell));
            for (let at2 = id; at2 >= 0; at2 = parent[at2]) path.push(where(at2));
            trace(path);
          }
          return;
        }
        if (!passable(c, k)) return;
        if (parent) parent[c * nz + k] = id;
        if (at(flange, c, k)) {
          next.push(c * nz + k);
        } else {
          mark(g, settled, c, k);
          now.push(c * nz + k);
        }
      });
    }
    if (found) return cost;
    // The next level's cells, less those reached on this one, each once.
    const level = new Queue();
    for (let q = 0; q < next.n; q++) {
      const id = next.a[q];
      const c = Math.floor(id / nz), k = id - c * nz;
      if (at(settled, c, k)) continue;
      mark(g, settled, c, k);
      level.push(id);
    }
    now = level;
    next = new Queue();
  }
  return Infinity;
}
