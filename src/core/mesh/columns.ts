import { forEachCrossing } from './crossings';
import { clampFor, marchSlabs, type Extracted, type Lattice } from './marching';
import { latticeNodes, MAX_NODES, RepairError } from './repair';
import { meshBounds, type WeldedMesh } from './weld';

/**
 * RM, rung B: a volumetric rebuild by a vote of columns along the three axes (Nooruddin and Turk 2003), each column
 * a scan of the surface's crossings with their winding (forEachCrossing, the app's own column scan), and a column
 * that does not come back to winding 0 (one through a hole, as Ju 2004 warns a single bad ray misleads) left out of
 * the vote. A node is inside where its column's winding is above 0, so parts that overlap join and a fold, where the
 * winding goes below 0, is left out. The field the surface is extracted from (marching.ts) is, at each node, the
 * distance to the nearest change of inside along its agreeing columns, clamped to two cells, signed by the vote: on
 * a face square to an axis it is the exact distance, so such a face comes out where it was. Streamed by z slab. Our
 * own code; + - * / and comparisons only, so every engine makes the same mesh.
 */

/** Nodes start 2.37 cells below the mesh's least corner on each axis, and run at least one cell past its greatest. */
export function latticeOf(mesh: WeldedMesh, h: number, origin?: [number, number, number]): Lattice {
  const { min, max } = meshBounds(mesh.positions);
  const o: [number, number, number] = origin ?? [min[0] - 2.37 * h, min[1] - 2.37 * h, min[2] - 2.37 * h];
  if (origin) {
    for (let a = 0; a < 3; a++) if (!(o[a] < min[a] - h)) throw new Error(`A lattice must start more than a cell below the mesh, not at ${o[a]} on axis ${a}.`);
    const n: [number, number, number] = [0, 0, 0];
    for (let a = 0; a < 3; a++) n[a] = Math.floor((max[a] - o[a]) / h) + 3;
    return { h, o, n };
  }
  return { h, o, n: latticeNodes(min, max, h) };
}

/** One axis's columns: each column's changes of inside, sorted, or none where the column is not balanced. */
export interface Columns {
  axis: number;
  /** Columns across the axis's first and second other axes, (axis + 1) % 3 and (axis + 2) % 3. */
  nu: number;
  nv: number;
  /** Where each column's changes start in `heights`, and the end as the next one's start. */
  starts: Int32Array;
  heights: Float64Array;
  /** 1 where a column's winding comes back to 0, so it votes. */
  reliable: Uint8Array;
  crossings: number;
  unbalanced: number;
}

/** How a column's winding says inside: above 0 (the rule used), or odd (a test-only control, which loses overlaps). */
export type InsideRule = 'positive' | 'parity';

/**
 * The columns along `axis`, through the lattice's nodes: forEachCrossing on the positions turned cyclically, (y, z, x)
 * for x columns and (z, x, y) for y columns, which keeps the winding's signs, then each column cut down to the
 * heights where inside changes. `hold` is given the arrays held, for the memory meter.
 */
export function columnsOf(mesh: WeldedMesh, lat: Lattice, axis: number, hold?: (arrays: unknown[]) => void, rule: InsideRule = 'positive'): Columns {
  const u = (axis + 1) % 3, v = (axis + 2) % 3;
  const P = mesh.positions;
  const turned = new Float32Array(P.length);
  for (let i = 0; i < P.length; i += 3) {
    turned[i] = P[i + u];
    turned[i + 1] = P[i + v];
    turned[i + 2] = P[i + axis];
  }
  const along: WeldedMesh = { positions: turned, indices: mesh.indices };
  const nu = lat.n[u], nv = lat.n[v], cols = nu * nv, h = lat.h;
  const starts = new Int32Array(cols + 1);
  forEachCrossing(along, nu, nv, h, lat.o[u], lat.o[v], (c) => void starts[c + 1]++);
  for (let c = 0; c < cols; c++) starts[c + 1] += starts[c];
  const total = starts[cols];
  const zs = new Float64Array(total);
  const signs = new Int8Array(total);
  const fill = starts.slice(0, cols);
  hold?.([turned, starts, zs, signs, fill]);
  forEachCrossing(along, nu, nv, h, lat.o[u], lat.o[v], (c, z, sign) => {
    let at = fill[c]++;
    while (at > starts[c] && zs[at - 1] > z) {
      zs[at] = zs[at - 1];
      signs[at] = signs[at - 1];
      at--;
    }
    zs[at] = z;
    signs[at] = sign;
  });
  // Each column cut down to its changes, in place; one whose signs do not sum to 0 keeps none and does not vote.
  const reliable = new Uint8Array(cols);
  const out = new Int32Array(cols + 1);
  let w = 0, unbalanced = 0;
  for (let c = 0; c < cols; c++) {
    out[c] = w;
    const s = starts[c], e = starts[c + 1];
    let sum = 0;
    for (let i = s; i < e; i++) sum += signs[i];
    if (sum !== 0) {
      unbalanced++;
      continue;
    }
    reliable[c] = 1;
    let wind = 0, count = 0;
    for (let i = s; i < e; ) {
      const z = zs[i];
      const before = rule === 'parity' ? (count & 1) === 1 : wind > 0;
      // Crossings at one height count together.
      while (i < e && zs[i] === z) {
        wind += signs[i++];
        count++;
      }
      if (before !== (rule === 'parity' ? (count & 1) === 1 : wind > 0)) zs[w++] = z;
    }
  }
  out[cols] = w;
  return { axis, nu, nv, starts: out, heights: zs.slice(0, w), reliable, crossings: total, unbalanced };
}

const IN = 0x40, DECIDED = 0x80;

export interface Vote {
  /** One byte a node: bit 2a set where axis a votes, bit 2a + 1 where it votes inside, then IN and DECIDED. */
  bits: Uint8Array;
  /** Nodes whose voting axes split evenly or that had none. */
  ties: number;
  /** Ties no neighbour decided, set outside. */
  tiesLeft: number;
  /** Nodes where the voting axes disagreed, which the majority decided. */
  split: number;
  fillRounds: number;
}

/**
 * Each node inside where most of its voting axes have an odd number of changes below it; a tie takes the majority
 * of its six neighbours already decided, round after round, each round reading the state before it, until nothing
 * changes, and any tie left is outside.
 */
export function vote(lat: Lattice, cols: readonly Columns[], hold?: (arrays: unknown[]) => void): Vote {
  const [nx, ny, nz] = lat.n, h = lat.h;
  const N = nx * ny * nz;
  if (N > MAX_NODES) throw new RepairError('repair-cell', `A ${h.toFixed(2)} mm grid would need ${(N / 1e6).toFixed(0)} million points round this model, past the ${MAX_NODES / 1e6} million this app takes.`);
  const bits = new Uint8Array(N);
  hold?.([bits]);
  const stride = [1, nx, nx * ny];
  for (const col of cols) {
    const a = col.axis, u = (a + 1) % 3, v = (a + 2) % 3;
    const su = stride[u], sv = stride[v], sa = stride[a], na = lat.n[a], oa = lat.o[a];
    const votes = 1 << (2 * a), inside = 1 << (2 * a + 1);
    for (let iv = 0; iv < col.nv; iv++) {
      for (let iu = 0; iu < col.nu; iu++) {
        const c = iu + iv * col.nu;
        if (!col.reliable[c]) continue;
        let p = col.starts[c];
        const s = p, e = col.starts[c + 1];
        let idx = iu * su + iv * sv;
        for (let k = 0; k < na; k++, idx += sa) {
          const z = oa + k * h;
          while (p < e && col.heights[p] < z) p++;
          bits[idx] |= ((p - s) & 1) === 1 ? votes | inside : votes;
        }
      }
    }
  }
  let ties = 0, split = 0;
  const tieList: number[] = [];
  for (let i = 0; i < N; i++) {
    const b = bits[i];
    const voters = (b & 1) + ((b >> 2) & 1) + ((b >> 4) & 1);
    const ins = ((b >> 1) & 1) + ((b >> 3) & 1) + ((b >> 5) & 1);
    if (ins > 0 && ins < voters) split++;
    if (2 * ins > voters) bits[i] = b | IN | DECIDED;
    else if (2 * ins < voters) bits[i] = b | DECIDED;
    else {
      ties++;
      tieList.push(i);
    }
  }
  let list = Int32Array.from(tieList);
  let rounds = 0;
  for (;;) {
    rounds++;
    const next = new Int8Array(list.length);
    let changed = 0;
    for (let q = 0; q < list.length; q++) {
      const i = list[q];
      const x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
      let inn = 0, out = 0;
      const look = (j: number): void => {
        const b = bits[j];
        if (b & DECIDED) {
          if (b & IN) inn++;
          else out++;
        }
      };
      if (x > 0) look(i - 1);
      if (x < nx - 1) look(i + 1);
      if (y > 0) look(i - nx);
      if (y < ny - 1) look(i + nx);
      if (z > 0) look(i - nx * ny);
      if (z < nz - 1) look(i + nx * ny);
      next[q] = inn > out ? 1 : out > inn ? -1 : 0;
      if (next[q] !== 0) changed++;
    }
    if (changed === 0) break;
    const keep: number[] = [];
    for (let q = 0; q < list.length; q++) {
      const i = list[q];
      if (next[q] > 0) bits[i] |= IN | DECIDED;
      else if (next[q] < 0) bits[i] |= DECIDED;
      else keep.push(i);
    }
    list = Int32Array.from(keep);
  }
  for (const i of list) bits[i] |= DECIDED;
  return { bits, ties, tiesLeft: list.length, split, fillRounds: rounds };
}

export interface RebuildStats {
  lattice: Lattice;
  nodes: number;
  crossings: number;
  unbalanced: number;
  columns: number;
  vote: Omit<Vote, 'bits'>;
  insideNodes: number;
  mixedCubes: number;
  ms: Record<string, number>;
}

export interface RebuildOptions {
  /** The lattice's first node, for tests that put faces on node planes; by default 2.37 cells below the mesh. */
  origin?: [number, number, number];
  /** The interpolation clamp, by default clampFor's. */
  clamp?: number;
  rule?: InsideRule;
  now?: () => number;
  /** Given the arrays held as they change, for the memory meter. */
  hold?: (arrays: unknown[]) => void;
  /** Hears each z slab extracted, of how many. */
  progress?: (done: number, total: number) => void;
}

/**
 * Rung B's surface: the vote, then the field slab by slab (f = the sign of the vote times the least distance along
 * an agreeing voting axis to that column's nearest change, clamped to 2h; h / 2 where no voting axis agrees), then
 * marching tetrahedra. Changes only, not every crossing, so the inner walls of parts that overlap do not pull it.
 */
export function rebuildSurface(mesh: WeldedMesh, h: number, options: RebuildOptions = {}): { mesh: WeldedMesh; stats: RebuildStats } {
  const now = options.now ?? (() => 0);
  const ms: Record<string, number> = {};
  let t0 = now();
  const lat = latticeOf(mesh, h, options.origin);
  const [nx, ny, nz] = lat.n;
  const held: unknown[] = [];
  const cols: Columns[] = [];
  for (let a = 0; a < 3; a++) {
    cols.push(columnsOf(mesh, lat, a, (arrays) => options.hold?.([...held, arrays]), options.rule));
    held.push(cols[a]);
    options.hold?.(held);
  }
  ms.columns = now() - t0;
  t0 = now();
  const v = vote(lat, cols, (arrays) => options.hold?.([...held, arrays]));
  held.push(v.bits);
  ms.vote = now() - t0;
  t0 = now();
  const bits = v.bits;
  const [cx, cy, cz] = cols;
  // z columns are x + y * nx; x columns y + z * ny; y columns z + x * nz.
  const zp = new Int32Array(nx * ny);
  for (let c = 0; c < nx * ny; c++) zp[c] = cz.starts[c];
  held.push(zp);
  const two = 2 * h, half = h / 2;
  const slab = (k: number, f: Float64Array): void => {
    const zH = lat.o[2] + k * h;
    const base = k * nx * ny;
    for (let c = 0; c < nx * ny; c++) {
      let p = zp[c];
      const e = cz.starts[c + 1];
      while (p < e && cz.heights[p] < zH) p++;
      zp[c] = p;
    }
    for (let y = 0; y < ny; y++) {
      // The x column through (y, k), walked along x.
      const xc = y + k * ny;
      let px = cx.starts[xc];
      const xs = px, xe = cx.starts[xc + 1];
      const xVotes = cx.reliable[xc];
      for (let x = 0; x < nx; x++) {
        const i = x + y * nx;
        const b = bits[base + i];
        const inside = (b & IN) !== 0;
        let d = Infinity, agree = false;
        if (xVotes) {
          const xH = lat.o[0] + x * h;
          while (px < xe && cx.heights[px] < xH) px++;
          if ((((b >> 1) & 1) === 1) === inside) {
            agree = true;
            if (px > xs) d = Math.min(d, xH - cx.heights[px - 1]);
            if (px < xe) d = Math.min(d, cx.heights[px] - xH);
          }
        }
        if (b & 0x10 && (((b >> 5) & 1) === 1) === inside) {
          agree = true;
          const p = zp[i], s = cz.starts[i], e = cz.starts[i + 1];
          if (p > s) d = Math.min(d, zH - cz.heights[p - 1]);
          if (p < e) d = Math.min(d, cz.heights[p] - zH);
        }
        f[i] = agree ? Math.min(d, two) : half;
        if (!inside) f[i] = -f[i];
      }
    }
    // The y column through (k, x), walked along y, where the y axis agrees.
    for (let x = 0; x < nx; x++) {
      const yc = k + x * nz;
      if (!cy.reliable[yc]) continue;
      let p = cy.starts[yc];
      const s = p, e = cy.starts[yc + 1];
      for (let y = 0; y < ny; y++) {
        const i = x + y * nx;
        const b = bits[base + i];
        const yH = lat.o[1] + y * h;
        while (p < e && cy.heights[p] < yH) p++;
        const inside = (b & IN) !== 0;
        if ((((b >> 3) & 1) === 1) !== inside) continue;
        let d = Infinity;
        if (p > s) d = Math.min(d, yH - cy.heights[p - 1]);
        if (p < e) d = Math.min(d, cy.heights[p] - yH);
        // Whether the node's value came from x or z agreeing, or was h / 2 as none did.
        const xzAgree = ((b & 0x01) !== 0 && (((b >> 1) & 1) === 1) === inside) || ((b & 0x10) !== 0 && (((b >> 5) & 1) === 1) === inside);
        const value = xzAgree ? Math.min(Math.abs(f[i]), d, two) : Math.min(d, two);
        f[i] = inside ? value : -value;
      }
    }
  };
  const extracted: Extracted = marchSlabs(lat, slab, options.clamp ?? clampFor(lat), (arrays) => options.hold?.([...held, arrays]), (done) => options.progress?.(done, nz - 1));
  ms.extract = now() - t0;
  const stats: RebuildStats = {
    lattice: lat,
    nodes: nx * ny * nz,
    crossings: cols.reduce((s, c) => s + c.crossings, 0),
    unbalanced: cols.reduce((s, c) => s + c.unbalanced, 0),
    columns: cols.reduce((s, c) => s + c.nu * c.nv, 0),
    vote: { ties: v.ties, tiesLeft: v.tiesLeft, split: v.split, fillRounds: v.fillRounds },
    insideNodes: extracted.insideNodes,
    mixedCubes: extracted.mixedCubes,
    ms,
  };
  return { mesh: extracted.mesh, stats };
}
