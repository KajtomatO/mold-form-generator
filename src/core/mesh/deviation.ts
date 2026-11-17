import type { WeldedMesh } from './weld';

/**
 * MM2: how far one surface lies from another, for the simplified copy of a large model (R42, D24). meshoptimizer's
 * own error figure is not a bound: on the examples the surface moved 3 to 9 times what it reported (docs/PLAN.md,
 * MM2), and the largest distance at a surface's vertices, centroids and edge midpoints is not one either: on
 * Goddess Statue's copy the surface between them lay 0.068 mm off where they gave 0.050 (MM2's review). So
 * `SurfaceIndex.bound` proves a bound over every point of the surface (see there). The mesh measured to goes
 * into a hashed grid of buckets, each triangle into every cell its box, grown by the reach, covers; a point then
 * looks only at its own cell's bucket, so any triangle within the reach of it is there. Pure TS, typed arrays
 * only.
 */

/** The squared distance from point (px, py, pz) to triangle a, b, c of `P` (offsets into it), exactly (Ericson 5.1.5). */
export function pointTriangleDistance2(px: number, py: number, pz: number, P: ArrayLike<number>, a: number, b: number, c: number): number {
  const ax = P[a], ay = P[a + 1], az = P[a + 2];
  const abx = P[b] - ax, aby = P[b + 1] - ay, abz = P[b + 2] - az;
  const acx = P[c] - ax, acy = P[c + 1] - ay, acz = P[c + 2] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = px - P[b], bpy = py - P[b + 1], bpz = pz - P[b + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const x = apx - v * abx, y = apy - v * aby, z = apz - v * abz;
    return x * x + y * y + z * z;
  }
  const cpx = px - P[c], cpy = py - P[c + 1], cpz = pz - P[c + 2];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const x = apx - w * acx, y = apy - w * acy, z = apz - w * acz;
    return x * x + y * y + z * z;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const x = px - (P[b] + w * (P[c] - P[b])), y = py - (P[b + 1] + w * (P[c + 1] - P[b + 1])), z = pz - (P[b + 2] + w * (P[c + 2] - P[b + 2]));
    return x * x + y * y + z * z;
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  const x = apx - abx * v - acx * w, y = apy - aby * v - acy * w, z = apz - abz * v - acz * w;
  return x * x + y * y + z * z;
}

/** The cell of the bucket grid, in mm: small enough that a bucket holds a few triangles, large enough that a triangle spans few cells. */
export const DEVIATION_CELL_MM = 0.5;

interface Buckets {
  /** Where each bucket's triangles start in `list`, and the end as the next bucket's start. */
  starts: Int32Array;
  list: Int32Array;
  mask: number;
}

const hashCell = (i: number, j: number, k: number, mask: number): number => (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791)) & mask;

/** Every triangle into the bucket of each cell its box, grown by `reach`, covers, by a counting sort. */
function bucketsOf(mesh: WeldedMesh, reach: number, cell: number): Buckets {
  const P = mesh.positions, I = mesh.indices, T = I.length / 3;
  const size = 2 ** Math.ceil(Math.log2(Math.max(1024, T * 4)));
  const mask = size - 1;
  const starts = new Int32Array(size + 1);
  const box = new Int32Array(T * 6);
  for (let t = 0; t < T; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    for (let d = 0; d < 3; d++) {
      box[t * 6 + d] = Math.floor((Math.min(P[a + d], P[b + d], P[c + d]) - reach) / cell);
      box[t * 6 + 3 + d] = Math.floor((Math.max(P[a + d], P[b + d], P[c + d]) + reach) / cell);
    }
    for (let i = box[t * 6]; i <= box[t * 6 + 3]; i++) for (let j = box[t * 6 + 1]; j <= box[t * 6 + 4]; j++) for (let k = box[t * 6 + 2]; k <= box[t * 6 + 5]; k++) starts[hashCell(i, j, k, mask) + 1]++;
  }
  for (let s = 0; s < size; s++) starts[s + 1] += starts[s];
  const list = new Int32Array(starts[size]);
  const fill = starts.slice(0, size);
  for (let t = 0; t < T; t++) {
    for (let i = box[t * 6]; i <= box[t * 6 + 3]; i++) for (let j = box[t * 6 + 1]; j <= box[t * 6 + 4]; j++) for (let k = box[t * 6 + 2]; k <= box[t * 6 + 5]; k++) list[fill[hashCell(i, j, k, mask)]++] = t;
  }
  return { starts, list, mask };
}

export interface DeviationCheck {
  /** The largest distance from a sample to the mesh, exact as long as `beyond` is 0; otherwise at least the reach. */
  max: number;
  /** The samples farther than the bound from the mesh, by index. */
  past: Int32Array;
  /** Samples with no triangle within the reach, whose own distance is then known only to pass it. */
  beyond: number;
}

/**
 * The parts of convex polygon `poly` (n corners, 3 numbers each) on each side of the plane s.x = o: where s.x >= o,
 * then where it is <= o. Plain arrays, as millions of small typed arrays cost several times as much to make.
 */
function split(poly: number[], n: number, sx: number, sy: number, sz: number, o: number): [number[], number[]] {
  const over: number[] = [], under: number[] = [];
  for (let k = 0; k < n; k++) {
    const p = k * 3, q = k + 1 < n ? p + 3 : 0;
    const px = poly[p], py = poly[p + 1], pz = poly[p + 2], qx = poly[q], qy = poly[q + 1], qz = poly[q + 2];
    const dp = sx * px + sy * py + sz * pz - o, dq = sx * qx + sy * qy + sz * qz - o;
    if (dp >= 0) over.push(px, py, pz);
    if (dp <= 0) under.push(px, py, pz);
    if ((dp > 0 && dq < 0) || (dp < 0 && dq > 0)) {
      const f = dp / (dp - dq);
      const x = px + (qx - px) * f, y = py + (qy - py) * f, z = pz + (qz - pz) * f;
      over.push(x, y, z);
      under.push(x, y, z);
    }
  }
  return [over, under];
}

/** A convex polygon's area. */
function area(poly: number[]): number {
  const n = poly.length / 3;
  let x = 0, y = 0, z = 0;
  for (let k = 1; k + 1 < n; k++) {
    const ux = poly[k * 3] - poly[0], uy = poly[k * 3 + 1] - poly[1], uz = poly[k * 3 + 2] - poly[2];
    const vx = poly[k * 3 + 3] - poly[0], vy = poly[k * 3 + 4] - poly[1], vz = poly[k * 3 + 5] - poly[2];
    x += uy * vz - uz * vy;
    y += uz * vx - ux * vz;
    z += ux * vy - uy * vx;
  }
  return Math.sqrt(x * x + y * y + z * z) / 2;
}

/**
 * A piece cut by the planes standing on the edges of triangle t, square to it: the part over t and the parts
 * beside each edge, those with area. Null where that cuts off nothing of any size, or t has no area.
 */
function beside(poly: number[], n: number, Q: Float32Array, J: Uint32Array, t: number): number[][] | null {
  const a = J[t * 3] * 3, b = J[t * 3 + 1] * 3, c = J[t * 3 + 2] * 3;
  const abx = Q[b] - Q[a], aby = Q[b + 1] - Q[a + 1], abz = Q[b + 2] - Q[a + 2];
  const acx = Q[c] - Q[a], acy = Q[c + 1] - Q[a + 1], acz = Q[c + 2] - Q[a + 2];
  const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
  if (!(nx * nx + ny * ny + nz * nz > 1e-24)) return null;
  const whole = area(poly);
  if (!(whole > 1e-18)) return null;
  const parts: number[][] = [];
  let over = poly;
  for (let k = 0; k < 3; k++) {
    const p = k === 0 ? a : k === 1 ? b : c, q = k === 0 ? b : k === 1 ? c : a;
    const ex = Q[q] - Q[p], ey = Q[q + 1] - Q[p + 1], ez = Q[q + 2] - Q[p + 2];
    // n x e points into the triangle from the edge.
    const sx = ny * ez - nz * ey, sy = nz * ex - nx * ez, sz = nx * ey - ny * ex;
    const [inside, outside] = split(over, over.length / 3, sx, sy, sz, sx * Q[p] + sy * Q[p + 1] + sz * Q[p + 2]);
    if (outside.length >= 9 && area(outside) > whole * 1e-9) parts.push(outside);
    over = inside;
    if (over.length < 9) break;
  }
  if (over.length >= 9 && area(over) > whole * 1e-9) parts.push(over);
  return parts.length >= 2 ? parts : null;
}

/** A piece halved across its longest extent, through its centroid. */
function halves(poly: number[], n: number, cx: number, cy: number, cz: number): number[][] {
  let bx = 0, by = 0, bz = 0, longest = -1;
  for (let i = 0; i < n; i++) {
    for (let k = i + 1; k < n; k++) {
      const dx = poly[k * 3] - poly[i * 3], dy = poly[k * 3 + 1] - poly[i * 3 + 1], dz = poly[k * 3 + 2] - poly[i * 3 + 2];
      const l = dx * dx + dy * dy + dz * dz;
      if (l > longest) {
        longest = l;
        bx = dx;
        by = dy;
        bz = dz;
      }
    }
  }
  return split(poly, n, bx, by, bz, bx * cx + by * cy + bz * cz).filter((half) => half.length >= 9);
}

/**
 * Each triangle's neighbour across each of its edges, -1 where none: entry t * 3 + k is across the edge from
 * corner k to corner k + 1. An edge more than two triangles share pairs the first two.
 */
function neighboursOf(mesh: WeldedMesh): Int32Array {
  const I = mesh.indices, V = mesh.positions.length / 3, H = I.length;
  const end = (h: number): number => I[h - (h % 3) + ((h % 3) + 1) % 3];
  // Each half-edge under its lower end, by a counting sort.
  const starts = new Int32Array(V + 1);
  for (let h = 0; h < H; h++) starts[Math.min(I[h], end(h)) + 1]++;
  for (let v = 0; v < V; v++) starts[v + 1] += starts[v];
  const fill = starts.slice(0, V), halfs = new Int32Array(H);
  for (let h = 0; h < H; h++) halfs[fill[Math.min(I[h], end(h))]++] = h;
  const across = new Int32Array(H).fill(-1);
  for (let v = 0; v < V; v++) {
    for (let i = starts[v]; i < starts[v + 1]; i++) {
      const g = halfs[i];
      if (across[g] >= 0) continue;
      const other = Math.max(I[g], end(g));
      for (let j = i + 1; j < starts[v + 1]; j++) {
        const h = halfs[j];
        if (across[h] >= 0 || Math.max(I[h], end(h)) !== other || (h - (h % 3)) === (g - (g % 3))) continue;
        across[g] = (h - (h % 3)) / 3;
        across[h] = (g - (g % 3)) / 3;
        break;
      }
    }
  }
  return across;
}

/** What SurfaceIndex.bound proved of one surface against the index's mesh. */
export interface DeviationBound {
  /** At least the distance from every point of the surface to the mesh, in mm: proved, not sampled. */
  bound: number;
  /** The largest distance measured exactly at a point of the surface, which the bound is never under. */
  found: number;
  /** The surface's triangles not proved within the limit, by index: a point of each is farther, or may be. */
  past: Int32Array;
  /** Whether a point had no triangle within the reach: the figures then say only that it is past the reach. */
  beyond: boolean;
}

/** How far over the largest distance found a bound may be left, in mm, where proving it closer costs more. */
export const BOUND_SLACK_MM = 0.0005;
/** The pieces one triangle of the surface may be cut into before what is proved of it stands. */
export const PIECE_BUDGET = 256;
/** How deep a triangle's pieces may be cut, which keeps the recursion's stack small. */
const MAX_CUTS = 48;

/** A mesh's triangles in buckets, once, for any number of checks of points within `reach` of it. */
export class SurfaceIndex {
  private readonly buckets: Buckets;
  /** Each triangle's neighbours across its edges, made the first time a bound needs them. */
  private neighbours: Int32Array | null = null;

  constructor(
    private readonly mesh: WeldedMesh,
    readonly reach: number,
    private readonly cell = DEVIATION_CELL_MM,
  ) {
    this.buckets = bucketsOf(mesh, reach, cell);
  }

  /** The index's own arrays, which the memory meter counts while it lives, its neighbours made now if not yet. */
  held(): unknown[] {
    return [this.buckets.starts, this.buckets.list, (this.neighbours ??= neighboursOf(this.mesh))];
  }

  /**
   * A bound on the distance from every point of `surface` to the mesh, not only at sampled points. The distance
   * to one triangle of the mesh is convex, so over a convex piece of the surface it is largest at a corner: a
   * piece whose corners all lie within the goal of one triangle lies within it everywhere, and so within it of
   * the mesh. Each triangle of the surface is tried whole against the triangle that proved the one before it (a
   * file's triangles mostly follow on from each other) and the triangle nearest its centroid; where none proves
   * it, it is cut by the three planes that stand on the edges of the triangle nearest its centroid, into the part
   * over that triangle and the parts beside it, each tried again, and a part that cutting does not shrink is
   * halved across its longest extent, until every part is proved, PIECE_BUDGET is spent, or a point of it is
   * found past the limit. The goal is the largest distance found so far plus `slack`, at most `limit`: the bound
   * is the most any part was proved within, so it comes within `slack` of the true largest distance where the
   * budget suffices, and is a bound wherever it does not. `limit` (at most the reach) marks the triangles not
   * proved within it as `past`; null measures only, and then a point with nothing within the reach leaves
   * `beyond` set, and the caller asks again with a larger reach. `at`, if given, is the vertices' scratch, one
   * float64 per vertex of `surface`, so a caller can count it.
   */
  bound(surface: WeldedMesh, limit: number | null, slack = BOUND_SLACK_MM, at = new Float64Array(surface.positions.length / 3), budget = PIECE_BUDGET): DeviationBound {
    if (limit !== null && limit > this.reach) throw new Error(`A limit of ${limit} mm needs a reach of at least as much, not ${this.reach} mm.`);
    const Q = this.mesh.positions, J = this.mesh.indices, cell = this.cell;
    const { starts, list, mask } = this.buckets;
    const r2 = this.reach * this.reach, limit2 = limit === null ? Infinity : limit * limit;
    const P = surface.positions, I = surface.indices, T = I.length / 3, V = P.length / 3;
    let found2 = 0, proved2 = 0, beyond = false, hit = -1;
    // The goal, kept as found2 changes: the largest distance found plus the slack, at most the limit.
    let goal2 = Math.min(limit2, slack * slack);
    /** The squared distance to the nearest triangle in the point's bucket, `hit` that triangle; a scan ends at `stop2`. */
    const nearest = (x: number, y: number, z: number, stop2: number): number => {
      const s = hashCell(Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell), mask);
      let best = Infinity;
      hit = -1;
      for (let e = starts[s]; e < starts[s + 1]; e++) {
        const t = list[e];
        const d = pointTriangleDistance2(x, y, z, Q, J[t * 3] * 3, J[t * 3 + 1] * 3, J[t * 3 + 2] * 3);
        if (d < best) {
          best = d;
          hit = t;
          if (best <= stop2) break;
        }
      }
      return best;
    };
    /** A distance measured at a point: past the reach, all that is known is that it passes it. */
    const measured = (d: number): void => {
      if (d > r2) beyond = true;
      const known = Math.min(d, r2);
      if (known > found2) {
        found2 = known;
        goal2 = Math.min(limit2, (Math.sqrt(found2) + slack) ** 2);
      }
    };
    // Each vertex, exactly where it could raise the largest distance or pass the limit; a scan ends otherwise.
    for (let v = 0; v < V; v++) {
      const d = nearest(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], Math.min(found2, limit2));
      at[v] = d;
      measured(d);
    }
    /** The most squared distance from a piece's `n` corners to triangle `t`, ending once past `stop2`. */
    const corners = (poly: number[], n: number, t: number, stop2: number): number => {
      const a = J[t * 3] * 3, b = J[t * 3 + 1] * 3, c = J[t * 3 + 2] * 3;
      let most = 0;
      for (let k = 0; k < n; k++) {
        const d = pointTriangleDistance2(poly[k * 3], poly[k * 3 + 1], poly[k * 3 + 2], Q, a, b, c);
        if (d > most) {
          most = d;
          if (most > stop2) return most;
        }
      }
      return most;
    };
    let spent = 0, failed = false, prover = -1;
    /** A proof of `poly` by triangle `t` within the goal, which then stands for it. */
    const proves = (poly: number[], n: number, t: number): number => {
      const most = corners(poly, n, t, goal2);
      if (most <= goal2) {
        if (most > proved2) proved2 = most;
        prover = t;
        return -1;
      }
      return most;
    };
    const next = this.neighbours ??= neighboursOf(this.mesh);
    /**
     * The nearest triangle to the point in its bucket, `hit` that triangle, unless a triangle within the goal of
     * it proves the piece first: then -1. A scan that ends without a proof has measured the point exactly.
     */
    const nearestOrProof = (poly: number[], n: number, x: number, y: number, z: number, tried: number): number => {
      const s = hashCell(Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell), mask);
      let best = Infinity;
      hit = -1;
      for (let e = starts[s]; e < starts[s + 1]; e++) {
        const t = list[e];
        const d = pointTriangleDistance2(x, y, z, Q, J[t * 3] * 3, J[t * 3 + 1] * 3, J[t * 3 + 2] * 3);
        if (d <= goal2 && t !== tried && proves(poly, n, t) < 0) return -1;
        if (d < best) {
          best = d;
          hit = t;
        }
      }
      return best;
    };
    const piece = (poly: number[], n: number, tried: number, cuts: number): void => {
      if (failed) return;
      let best = Infinity;
      // The triangle that proved the piece before, then the ones across its edges.
      if (tried >= 0) {
        best = proves(poly, n, tried);
        if (best < 0) return;
        for (let k = 0; k < 3; k++) {
          const t = next[tried * 3 + k];
          if (t < 0) continue;
          const most = proves(poly, n, t);
          if (most < 0) return;
          best = Math.min(best, most);
        }
      }
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < n; k++) {
        cx += poly[k * 3];
        cy += poly[k * 3 + 1];
        cz += poly[k * 3 + 2];
      }
      cx /= n;
      cy /= n;
      cz /= n;
      const dc = nearestOrProof(poly, n, cx, cy, cz, tried);
      if (dc < 0) return;
      const near = hit;
      measured(dc);
      if (dc > limit2) {
        failed = true;
        return;
      }
      if (near >= 0) best = Math.min(best, corners(poly, n, near, Infinity));
      if (near < 0 || ++spent > budget || cuts >= MAX_CUTS) {
        // What is proved of it stands: past the limit, it is past.
        if (best > limit2) failed = true;
        else if (best > proved2) proved2 = best;
        return;
      }
      const parts = beside(poly, n, Q, J, near);
      if (parts === null) {
        for (const half of halves(poly, n, cx, cy, cz)) piece(half, half.length / 3, near, cuts + 1);
        return;
      }
      for (const part of parts) piece(part, part.length / 3, near, cuts + 1);
    };
    const past: number[] = [];
    const root = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let t = 0; t < T; t++) {
      let worst = 0;
      for (let c = 0; c < 3; c++) {
        const v = I[t * 3 + c];
        root[c * 3] = P[v * 3];
        root[c * 3 + 1] = P[v * 3 + 1];
        root[c * 3 + 2] = P[v * 3 + 2];
        if (at[v] > worst) worst = at[v];
      }
      // A corner past the limit: past, with nothing to prove.
      if (worst > limit2) {
        past.push(t);
        continue;
      }
      spent = 0;
      failed = false;
      piece(root, 3, prover, 0);
      if (failed) past.push(t);
    }
    return { bound: Math.sqrt(Math.max(found2, proved2)), found: Math.sqrt(found2), past: Int32Array.from(past), beyond };
  }

  /**
   * The largest distance from the points of `samples` (3 floats each) to the mesh, and which lie farther than
   * `bound`, which must not pass the reach. A point's scan stops at the first triangle within both the largest
   * distance found so far and the bound, as such a point can neither raise the maximum nor be past the bound, so
   * most points cost a distance or two; any other point takes its exact nearest.
   */
  check(samples: Float32Array, bound: number): DeviationCheck {
    if (bound > this.reach) throw new Error(`A bound of ${bound} mm needs a reach of at least as much, not ${this.reach} mm.`);
    const P = this.mesh.positions, I = this.mesh.indices, cell = this.cell;
    const { starts, list, mask } = this.buckets;
    const n = samples.length / 3;
    const past: number[] = [];
    const b2 = bound * bound, r2 = this.reach * this.reach;
    let max2 = 0, beyond = 0;
    for (let p = 0; p < n; p++) {
      const x = samples[p * 3], y = samples[p * 3 + 1], z = samples[p * 3 + 2];
      const s = hashCell(Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell), mask);
      const stop = Math.min(max2, b2);
      let best = Infinity;
      for (let e = starts[s]; e < starts[s + 1]; e++) {
        const t = list[e];
        const d = pointTriangleDistance2(x, y, z, P, I[t * 3] * 3, I[t * 3 + 1] * 3, I[t * 3 + 2] * 3);
        if (d < best) {
          best = d;
          if (best <= stop) break;
        }
      }
      // Nothing within the reach: past the bound, which is never beyond it, though how far is unknown here.
      if (best > r2) {
        beyond++;
        past.push(p);
        best = r2;
      } else if (best > b2) past.push(p);
      if (best > max2) max2 = best;
    }
    return { max: Math.sqrt(max2), past: Int32Array.from(past), beyond };
  }
}

/** One check of `samples` against `mesh`: see SurfaceIndex.check. */
export function checkDeviation(mesh: WeldedMesh, samples: Float32Array, bound: number, reach = bound, cell = DEVIATION_CELL_MM): DeviationCheck {
  return new SurfaceIndex(mesh, reach, cell).check(samples, bound);
}

/**
 * The largest distance from `samples` to `mesh`, always exact: a sample with no triangle within the reach
 * doubles the reach and the whole check runs again. At those points only, so never more than what
 * SurfaceIndex.bound proves of the surface they lie on, which the tests check it against.
 */
export function maxDeviation(mesh: WeldedMesh, samples: Float32Array[], reach = 1): number {
  for (;;) {
    const index = new SurfaceIndex(mesh, reach, Math.max(DEVIATION_CELL_MM, reach));
    const found = samples.map((points) => index.check(points, reach));
    if (found.every((f) => f.beyond === 0)) return Math.max(0, ...found.map((f) => f.max));
    reach *= 2;
  }
}

/**
 * Points of a surface besides its vertices: each triangle's centroid and each edge's midpoint, every edge once.
 * MM2 first checked copies at these, which is not enough: on Goddess Statue's copy the surface between them lay
 * 0.068 mm off where they gave 0.050 (MM2's review), so SurfaceIndex.bound proves the whole surface instead; the
 * tests still sample with these.
 */
export function surfaceSamples(mesh: WeldedMesh): { points: Float32Array; centroids: number; edges: Uint32Array } {
  const P = mesh.positions, I = mesh.indices, T = I.length / 3, V = P.length / 3;
  // Each edge once, by its two ends, lower first, as one sortable number (exact in a float64 up to 67M vertices).
  const keys = new Float64Array(I.length);
  for (let t = 0; t < T; t++) {
    for (let c = 0; c < 3; c++) {
      const a = I[t * 3 + c], b = I[t * 3 + ((c + 1) % 3)];
      keys[t * 3 + c] = a < b ? a * V + b : b * V + a;
    }
  }
  keys.sort();
  let unique = 0;
  for (let k = 0; k < keys.length; k++) if (k === 0 || keys[k] !== keys[k - 1]) keys[unique++] = keys[k];
  const edges = new Uint32Array(unique * 2);
  for (let k = 0; k < unique; k++) {
    const low = Math.floor(keys[k] / V);
    edges[k * 2] = low;
    edges[k * 2 + 1] = keys[k] - low * V;
  }
  const points = new Float32Array((T + unique) * 3);
  for (let t = 0; t < T; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    for (let d = 0; d < 3; d++) points[t * 3 + d] = (P[a + d] + P[b + d] + P[c + d]) / 3;
  }
  for (let k = 0; k < unique; k++) {
    const a = edges[k * 2] * 3, b = edges[k * 2 + 1] * 3, o = (T + k) * 3;
    for (let d = 0; d < 3; d++) points[o + d] = (P[a + d] + P[b + d]) / 2;
  }
  return { points, centroids: T, edges };
}
