import { BOUND_SLACK_MM, DEVIATION_CELL_MM, PIECE_BUDGET, SurfaceIndex, type SurfaceMesh } from './deviation';
import { meshBounds, type WeldedMesh } from './weld';

/**
 * RM, decision D: what the silicone's guarantee needs of a rebuilt copy R and the maker's file O. The file is
 * printed in glue mode, so every point of it must be at least the measured clearance from the cover. A point of O
 * within e of R's surface is (the margin is widened by e); a point of O inside R is, as the cover is outside R; any
 * other point is left out of R (a fin, a wall thinner than the cell, a fold), and those triangles are held in the
 * field and measured on their own (farPrisms). compareToRepaired sorts O's triangles so, with every figure proved.
 */

/** A surface whose triangles were cut from another's: float64 positions, and each piece's triangle there. */
export interface SplitSurface {
  mesh: SurfaceMesh;
  parent: Int32Array;
}

/** Growing typed arrays for pieces. */
class Pieces {
  pos = new Float64Array(3 * 4096);
  idx = new Uint32Array(3 * 4096);
  par = new Int32Array(4096);
  nv = 0;
  nt = 0;
  vert(x: number, y: number, z: number): number {
    if (this.nv * 3 + 3 > this.pos.length) {
      const grown = new Float64Array(this.pos.length * 2);
      grown.set(this.pos);
      this.pos = grown;
    }
    this.pos[this.nv * 3] = x;
    this.pos[this.nv * 3 + 1] = y;
    this.pos[this.nv * 3 + 2] = z;
    return this.nv++;
  }
  tri(a: number, b: number, c: number, parent: number): void {
    if (this.nt * 3 + 3 > this.idx.length) {
      const grown = new Uint32Array(this.idx.length * 2);
      grown.set(this.idx);
      this.idx = grown;
      const parents = new Int32Array(this.par.length * 2);
      parents.set(this.par);
      this.par = parents;
    }
    this.idx[this.nt * 3] = a;
    this.idx[this.nt * 3 + 1] = b;
    this.idx[this.nt * 3 + 2] = c;
    this.par[this.nt++] = parent;
  }
  done(): SplitSurface {
    return { mesh: { positions: this.pos.slice(0, this.nv * 3), indices: this.idx.slice(0, this.nt * 3) }, parent: this.par.slice(0, this.nt) };
  }
}

/**
 * The listed triangles of `mesh` (all of them where `triangles` is null), each cut until no edge is longer than
 * `longest`, each piece keeping its triangle's index. SurfaceIndex.bound gives a triangle 256 pieces: against a
 * surface of small triangles that is not enough for a large one (a 30 x 20 mm face of a box was bounded at 13.8 mm
 * from a rebuild it lies 0.217 mm from, at a 0.5 mm cell; cut to 4 cells first, 0.2171). A needle, whose shortest
 * edge is at most a quarter of `longest`, is cut across into strips of at most three quarters of it along its long
 * sides, so every edge, diagonals too, keeps within `longest`; any other triangle is bisected across its longest
 * edge. Bisection alone cut each 70 mm needle of the 3 million triangle block's bottom fan into about 800 pieces,
 * strips into about 120. Cut points are float64, so the pieces cover the triangle exactly; they are not shared
 * between neighbours, which the bound does not need. Only the vertices the listed triangles use are kept. `remap`,
 * if given, is a scratch of one int a vertex of `mesh`, all -1, which it leaves so.
 */
export function splitLong(mesh: WeldedMesh, longest: number, triangles: ArrayLike<number> | null = null, remap = new Int32Array(mesh.positions.length / 3).fill(-1)): SplitSurface {
  const P = mesh.positions, I = mesh.indices;
  const out = new Pieces();
  const used: number[] = [];
  const L2 = longest * longest;
  const stack: number[] = [];
  const at = (v: number): number => {
    let id = remap[v];
    if (id < 0) {
      id = remap[v] = out.vert(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      used.push(v);
    }
    return id;
  };
  const d2 = (a: number, b: number): number => {
    const Q = out.pos;
    const dx = Q[a * 3] - Q[b * 3], dy = Q[a * 3 + 1] - Q[b * 3 + 1], dz = Q[a * 3 + 2] - Q[b * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
  };
  /** The point `f` of the way from vertex a to vertex b, as a new vertex. */
  const along = (a: number, b: number, f: number): number => {
    const Q = out.pos;
    return out.vert(Q[a * 3] + (Q[b * 3] - Q[a * 3]) * f, Q[a * 3 + 1] + (Q[b * 3 + 1] - Q[a * 3 + 1]) * f, Q[a * 3 + 2] + (Q[b * 3 + 2] - Q[a * 3 + 2]) * f);
  };
  const count = triangles ? triangles.length : I.length / 3;
  for (let k = 0; k < count; k++) {
    const t = triangles ? triangles[k] : k;
    stack.push(at(I[t * 3]), at(I[t * 3 + 1]), at(I[t * 3 + 2]));
    while (stack.length > 0) {
      const c = stack.pop()!, b = stack.pop()!, a = stack.pop()!;
      const ab = d2(a, b), bc = d2(b, c), ca = d2(c, a);
      const most = Math.max(ab, bc, ca);
      if (!(most > L2)) {
        out.tri(a, b, c, t);
        continue;
      }
      const least = Math.min(ab, bc, ca);
      if (least * 16 <= L2) {
        // A needle: apex r opposite its shortest edge (p, q), in the triangle's own order, cut into strips.
        const [r, p, q] = least === bc ? [a, b, c] : least === ca ? [b, c, a] : [c, a, b];
        const strips = Math.ceil(Math.sqrt(most) / (0.75 * longest));
        let lp = r, lq = r;
        for (let i = 1; i <= strips; i++) {
          const np = i === strips ? p : along(r, p, i / strips), nq = i === strips ? q : along(r, q, i / strips);
          if (i === 1) stack.push(r, np, nq);
          else stack.push(lp, np, nq, lp, nq, lq);
          lp = np;
          lq = nq;
        }
        continue;
      }
      // The longest edge (p, q), r opposite, kept in the triangle's own order.
      const [p, q, r] = most === ab ? [a, b, c] : most === bc ? [b, c, a] : [c, a, b];
      const m = along(p, q, 0.5);
      stack.push(p, m, r, m, q, r);
    }
  }
  for (const v of used) remap[v] = -1;
  return out.done();
}

/**
 * Whether points lie inside a closed mesh wound outwards: the winding of the mesh's crossings above the point, by
 * forEachCrossing's own test for a column through it (the top-left rule, so a column through a shared edge or vertex
 * meets it once), over the mesh's triangles in the point's bucket of a 2D grid. A crossing at the point's own height
 * proves nothing, and then the answer is null.
 */
export class SolidPoints {
  private readonly starts: Int32Array;
  private readonly list: Int32Array;
  private readonly x0: number;
  private readonly y0: number;
  private readonly cell: number;
  private readonly nx: number;
  private readonly ny: number;

  constructor(private readonly mesh: WeldedMesh) {
    const P = mesh.positions, I = mesh.indices, T = I.length / 3;
    const { min, max } = meshBounds(P);
    const dx = Math.max(max[0] - min[0], 1e-6), dy = Math.max(max[1] - min[1], 1e-6);
    // About one bucket a triangle, and at most 4096 a side.
    this.cell = Math.max(Math.sqrt((dx * dy) / Math.max(1, T)), Math.max(dx, dy) / 4096);
    this.x0 = min[0];
    this.y0 = min[1];
    this.nx = Math.floor(dx / this.cell) + 1;
    this.ny = Math.floor(dy / this.cell) + 1;
    const cols = this.nx * this.ny;
    const starts = new Int32Array(cols + 1);
    const range = new Int32Array(4);
    const box = (t: number): void => {
      const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
      range[0] = Math.max(0, Math.floor((Math.min(P[a], P[b], P[c]) - this.x0) / this.cell));
      range[1] = Math.min(this.nx - 1, Math.floor((Math.max(P[a], P[b], P[c]) - this.x0) / this.cell));
      range[2] = Math.max(0, Math.floor((Math.min(P[a + 1], P[b + 1], P[c + 1]) - this.y0) / this.cell));
      range[3] = Math.min(this.ny - 1, Math.floor((Math.max(P[a + 1], P[b + 1], P[c + 1]) - this.y0) / this.cell));
    };
    for (let t = 0; t < T; t++) {
      box(t);
      for (let j = range[2]; j <= range[3]; j++) for (let i = range[0]; i <= range[1]; i++) starts[i + j * this.nx + 1]++;
    }
    for (let c = 0; c < cols; c++) starts[c + 1] += starts[c];
    const list = new Int32Array(starts[cols]);
    const fill = starts.slice(0, cols);
    for (let t = 0; t < T; t++) {
      box(t);
      for (let j = range[2]; j <= range[3]; j++) for (let i = range[0]; i <= range[1]; i++) list[fill[i + j * this.nx]++] = t;
    }
    this.starts = starts;
    this.list = list;
  }

  /** Its own arrays, for the memory meter. */
  held(): unknown[] {
    return [this.starts, this.list];
  }

  /** True inside, false outside, null where a crossing lies at the point's own height. */
  inside(x: number, y: number, z: number): boolean | null {
    const i = Math.floor((x - this.x0) / this.cell), j = Math.floor((y - this.y0) / this.cell);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return false;
    const p = this.mesh.positions, indices = this.mesh.indices;
    const s = i + j * this.nx;
    let sum = 0;
    for (let e = this.starts[s]; e < this.starts[s + 1]; e++) {
      const t = this.list[e] * 3;
      // forEachCrossing's arithmetic, for the one column at (x, y).
      const a = indices[t] * 3;
      let b = indices[t + 1] * 3, c = indices[t + 2] * 3;
      const doubled = (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a]);
      if (doubled === 0) continue;
      const sign = doubled > 0 ? -1 : 1;
      if (doubled < 0) [b, c] = [c, b];
      const ax = p[a], ay = p[a + 1], az = p[a + 2];
      const bx = p[b], by = p[b + 1], bz = p[b + 2];
      const cx = p[c], cy = p[c + 1], cz = p[c + 2];
      if (x < Math.min(ax, bx, cx) || x > Math.max(ax, bx, cx) || y < Math.min(ay, by, cy) || y > Math.max(ay, by, cy)) continue;
      const topLeftAB = by < ay || (by === ay && bx < ax);
      const topLeftBC = cy < by || (cy === by && cx < bx);
      const topLeftCA = ay < cy || (ay === cy && ax < cx);
      const w0 = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      const w1 = (cx - bx) * (y - by) - (cy - by) * (x - bx);
      const w2 = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
      if (w0 < 0 || (w0 === 0 && !topLeftAB)) continue;
      if (w1 < 0 || (w1 === 0 && !topLeftBC)) continue;
      if (w2 < 0 || (w2 === 0 && !topLeftCA)) continue;
      const zt = (w1 * az + w2 * bz + w0 * cz) / Math.abs(doubled);
      if (zt === z) return null;
      if (zt > z) sum += sign;
    }
    // Rising from inside, the column leaves the solid once more than it enters it.
    return sum < 0;
  }
}

/** The finest the inside test cuts a piece it cannot prove whole: into 4 a level, 64 at the third. */
const INSIDE_LEVELS = 3;
/** O's triangles are cut to edges of at most this many cells before the bound (see splitLong). */
export const SPLIT_CELLS = 4;
/** Triangles of O measured a pass at a time, so the pieces of a 3 million triangle file are never held at once. */
const CHUNK = 65_536;

export interface Comparison {
  /**
   * e_near, in mm: how far the points of O, but those inside R and those of the far triangles, lie from R's surface
   * at most, proved (SurfaceIndex.bound). At most the cell.
   */
  nearMm: number;
  /** O's triangles left out: neither within the cell of R's surface nor inside R, proved; sorted, by index into O. */
  far: Int32Array;
  /** For the record: O's triangles with a vertex past the cell, pieces bounded, past pieces the inside test took, pieces it handed back. */
  suspect: number;
  pieces: number;
  insideProved: number;
  leftover: number;
}

/**
 * Sorts the points of O by how they lie against R, a closed mesh wound outwards, with cell `h` (the rebuild's).
 * O's triangles are cut to SPLIT_CELLS cells, then bounded against R with a limit of h, a point past it kept from
 * raising the figure of the rest (bound's `isolate`). A past piece is inside R if its centroid is and no triangle of R
 * lies within its radius (the ball round the centroid holds the piece and does not reach R's surface), else it is
 * cut into four by its edges' midpoints and each tried, down INSIDE_LEVELS levels; the pieces still unproved are
 * bounded again, and a triangle with a piece past that is far. The far triangles are found first among those with a
 * vertex past the cell (a fin's tip, a fold, an inner wall), so their points near R, such as a fin's foot, do not
 * raise the goal of the main pass, whose figure is then e_near: a fin standing on a box measured 0.47 mm at a 0.5 mm
 * cell in one pass, against the box's own 0.36. `hold` is given the arrays held, for the memory meter.
 */
export function compareToRepaired(O: WeldedMesh, R: WeldedMesh, h: number, hold?: (arrays: unknown[]) => void): Comparison {
  const T = O.indices.length / 3;
  const index = new SurfaceIndex(R, h, Math.max(DEVIATION_CELL_MM, h));
  const solid = new SolidPoints(R);
  const far = new Uint8Array(T);
  let pieces = 0, insideProved = 0, leftovers = 0;
  const one = new Float32Array(3);
  /**
   * A lower bound on the distance from (x, y, z) to R's surface: exact but for the rounding of the point to float32,
   * which is taken off, within h; past h, h less that rounding, with `beyond` set.
   */
  let beyond = false;
  const distance = (x: number, y: number, z: number): number => {
    one[0] = x;
    one[1] = y;
    one[2] = z;
    const slip = Math.sqrt((one[0] - x) ** 2 + (one[1] - y) ** 2 + (one[2] - z) ** 2);
    const check = index.check(one, h);
    beyond = check.beyond > 0;
    return (beyond ? h : check.max) - slip;
  };
  /** Tries one piece, corners in `q` (9 numbers), at `level`: proved inside, its parent marked far, or handed to `left`. */
  const classify = (q: Float64Array, parent: number, level: number, left: Pieces): void => {
    if (far[parent]) return;
    const cx = (q[0] + q[3] + q[6]) / 3, cy = (q[1] + q[4] + q[7]) / 3, cz = (q[2] + q[5] + q[8]) / 3;
    let rho = 0;
    for (let k = 0; k < 3; k++) rho = Math.max(rho, Math.sqrt((q[k * 3] - cx) ** 2 + (q[k * 3 + 1] - cy) ** 2 + (q[k * 3 + 2] - cz) ** 2));
    if (rho <= h) {
      const d = distance(cx, cy, cz);
      if (d >= rho) {
        const inside = solid.inside(cx, cy, cz);
        if (inside === true) {
          insideProved++;
          return;
        }
        // Outside R, and its centroid farther than the cell from it: left out of the copy.
        if (inside === false && (beyond || d > h)) {
          far[parent] = 1;
          return;
        }
      }
    }
    if (level >= INSIDE_LEVELS) {
      left.tri(left.vert(q[0], q[1], q[2]), left.vert(q[3], q[4], q[5]), left.vert(q[6], q[7], q[8]), parent);
      return;
    }
    const m = new Float64Array(9);
    for (let d = 0; d < 3; d++) {
      m[d] = (q[d] + q[3 + d]) / 2;
      m[3 + d] = (q[3 + d] + q[6 + d]) / 2;
      m[6 + d] = (q[6 + d] + q[d]) / 2;
    }
    const sub = (a: Float64Array, ao: number, b: Float64Array, bo: number, c: Float64Array, co: number): Float64Array => Float64Array.of(a[ao], a[ao + 1], a[ao + 2], b[bo], b[bo + 1], b[bo + 2], c[co], c[co + 1], c[co + 2]);
    classify(sub(q, 0, m, 0, m, 6), parent, level + 1, left);
    classify(sub(m, 0, q, 3, m, 3), parent, level + 1, left);
    classify(sub(m, 6, m, 3, q, 6), parent, level + 1, left);
    classify(sub(m, 0, m, 3, m, 6), parent, level + 1, left);
  };
  /**
   * One pass over the listed triangles: bounded a chunk at a time, past pieces tried by the inside test, the pieces
   * it hands back bounded again, any past then marking its triangle far. The figure over what was proved within h.
   */
  const remap = new Int32Array(O.positions.length / 3).fill(-1);
  const pass = (triangles: Int32Array): number => {
    const left = new Pieces();
    const corner = new Float64Array(9);
    let figure = 0;
    for (let from = 0; from < triangles.length; from += CHUNK) {
      const split = splitLong(O, SPLIT_CELLS * h, triangles.subarray(from, Math.min(triangles.length, from + CHUNK)), remap);
      pieces += split.parent.length;
      const at = new Float64Array(split.mesh.positions.length / 3);
      hold?.([index.held(), solid.held(), far, remap, left.pos, left.idx, left.par, split, at]);
      const found = index.bound(split.mesh, h, BOUND_SLACK_MM, at, PIECE_BUDGET, true);
      figure = Math.max(figure, found.bound);
      const Q = split.mesh.positions, J = split.mesh.indices;
      for (const k of found.past) {
        for (let c = 0; c < 3; c++) for (let d = 0; d < 3; d++) corner[c * 3 + d] = Q[J[k * 3 + c] * 3 + d];
        classify(corner, split.parent[k], 0, left);
      }
    }
    const leftover = left.done();
    leftovers += leftover.parent.length;
    if (leftover.parent.length > 0) {
      hold?.([index.held(), solid.held(), far, leftover]);
      const found = index.bound(leftover.mesh, h, BOUND_SLACK_MM, undefined, PIECE_BUDGET, true);
      figure = Math.max(figure, found.bound);
      for (const k of found.past) far[leftover.parent[k]] = 1;
    }
    return figure;
  };
  // Suspects: the triangles with a vertex past the cell from R's surface.
  const vertexPast = index.check(O.positions, h).past;
  const pastVertex = new Uint8Array(O.positions.length / 3);
  for (const v of vertexPast) pastVertex[v] = 1;
  const suspects: number[] = [];
  for (let t = 0; t < T; t++) if (pastVertex[O.indices[t * 3]] || pastVertex[O.indices[t * 3 + 1]] || pastVertex[O.indices[t * 3 + 2]]) suspects.push(t);
  // First the suspects alone, to find the far triangles, whose figure is not kept.
  if (suspects.length > 0) pass(Int32Array.from(suspects));
  // Then every triangle not found far, whose figure is e_near.
  const rest: number[] = [];
  for (let t = 0; t < T; t++) if (!far[t]) rest.push(t);
  const nearMm = rest.length > 0 ? pass(Int32Array.from(rest)) : 0;
  let count = 0;
  for (let t = 0; t < T; t++) count += far[t];
  const list = new Int32Array(count);
  for (let t = 0, w = 0; t < T; t++) if (far[t]) list[w++] = t;
  return { nearMm, far: list, suspect: suspects.length, pieces, insideProved, leftover: leftovers };
}

/** The listed triangles of a mesh as a mesh of their own, its vertices compacted in order of first use. */
export function subMesh(mesh: WeldedMesh, triangles: ArrayLike<number>): WeldedMesh {
  const remap = new Int32Array(mesh.positions.length / 3).fill(-1);
  const positions = new Float32Array(triangles.length * 9);
  const indices = new Uint32Array(triangles.length * 3);
  let n = 0;
  for (let k = 0; k < triangles.length; k++) {
    for (let c = 0; c < 3; c++) {
      const v = mesh.indices[triangles[k] * 3 + c];
      if (remap[v] < 0) {
        remap[v] = n;
        positions.set(mesh.positions.subarray(v * 3, v * 3 + 3), n * 3);
        n++;
      }
      indices[k * 3 + c] = remap[v];
    }
  }
  return { positions: positions.slice(0, n * 3), indices };
}

/** A sorted list of indices as [first, count] runs. */
export function runsOf(sorted: ArrayLike<number>): [number, number][] {
  const runs: [number, number][] = [];
  for (let k = 0; k < sorted.length; ) {
    let j = k + 1;
    while (j < sorted.length && sorted[j] === sorted[j - 1] + 1) j++;
    runs.push([sorted[k], j - k]);
    k = j;
  }
  return runs;
}

/** The indices a list of [first, count] runs covers, in order. */
export function fromRuns(runs: readonly (readonly [number, number])[]): Int32Array {
  const out = new Int32Array(runs.reduce((sum, [, count]) => sum + count, 0));
  let w = 0;
  for (const [first, count] of runs) for (let k = 0; k < count; k++) out[w++] = first + k;
  return out;
}

export interface FarFigures {
  /** How far the far part lies from R's surface at most, proved, in mm. */
  farthestMm: number;
  /** The point of the far part found farthest from R's surface. */
  at: [number, number, number];
  /** Where Show marks the far part: `at`, then a far vertex of each other connected piece of it, farthest first; at most `marks`. */
  marks: [number, number, number][];
  /** The far part's summed area, in mm2. */
  area: number;
}

/**
 * The triangles of `target` whose box comes within `reach` of the box of `surface`: every triangle within the reach
 * of a point of the surface is among them, so an index of them alone answers as one of the whole target does, for
 * that surface and reach. Null where that is most of the target, whose own index is then as cheap.
 */
function nearTriangles(target: WeldedMesh, surface: SurfaceMesh, reach: number): Int32Array | null {
  const { min, max } = meshBounds(surface.positions);
  const Q = target.positions, J = target.indices, T = J.length / 3;
  const near: number[] = [];
  for (let t = 0; t < T; t++) {
    let apart = false;
    for (let d = 0; d < 3 && !apart; d++) {
      const a = Q[J[t * 3] * 3 + d], b = Q[J[t * 3 + 1] * 3 + d], c = Q[J[t * 3 + 2] * 3 + d];
      apart = Math.min(a, b, c) > max[d] + reach || Math.max(a, b, c) < min[d] - reach;
    }
    if (!apart) near.push(t);
  }
  return near.length > 0.8 * T ? null : Int32Array.from(near);
}

/** A SurfaceIndex of `target` for `surface` at `reach`: of the triangles near the surface alone where they are few. */
function indexFor(target: WeldedMesh, surface: SurfaceMesh, reach: number): SurfaceIndex {
  const near = nearTriangles(target, surface, reach);
  return new SurfaceIndex(near ? subMesh(target, near) : target, reach, Math.max(DEVIATION_CELL_MM, reach));
}

/**
 * How far `surface` lies from `target` at most, proved (SurfaceIndex.bound with no limit), and the vertex of it found
 * farthest. Its vertices' distances come first, with a reach that doubles from `start` until none is past it; the
 * bound then runs with that reach, or the farthest vertex's distance and `pad` more (about half a piece of the
 * surface) where that is more, and only if a point passes it again with the reach doubled. A bound whose reach a point passes spends each piece's budget for
 * nothing, and doubling from the cell did that at every reach on the way (431 ms for a fin of 2 triangles). Each index
 * holds only the target's triangles near the surface's box where they are few (nearTriangles), as for a fin. `first`
 * hears the first index, at the reach `start`; `hold` what is held as each index is made, for the memory meter.
 */
export function provedDistance(target: WeldedMesh, surface: SurfaceMesh, start: number, pad: number, first?: (index: SurfaceIndex) => void, hold?: (arrays: unknown[]) => void): { mm: number; at: [number, number, number] } {
  const points = surface.positions instanceof Float32Array ? surface.positions : Float32Array.from(surface.positions);
  const at = new Float64Array(surface.positions.length / 3);
  let reach = start, top = 0;
  const indexAt = (r: number): SurfaceIndex => {
    const index = indexFor(target, surface, r);
    hold?.([surface, points, at, index.held()]);
    return index;
  };
  let index = indexAt(reach);
  first?.(index);
  for (;;) {
    const check = index.check(points, reach);
    if (check.beyond === 0) {
      top = check.max;
      break;
    }
    reach *= 2;
    index = indexAt(reach);
  }
  if (top + pad > reach) {
    reach = top + pad;
    index = indexAt(reach);
  }
  for (;;) {
    const found = index.bound(surface, null, BOUND_SLACK_MM, at);
    if (!found.beyond) {
      let v = 0;
      for (let k = 1; k < at.length; k++) if (at[k] > at[v]) v = k;
      const P = surface.positions;
      return { mm: found.bound, at: [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]] };
    }
    reach *= 2;
    index = indexAt(reach);
  }
}

/**
 * How far the far part of O lies from R: a proved bound over its points (its triangles cut to SPLIT_CELLS cells,
 * provedDistance), and its vertices' own distances, for marking each connected piece of it at its farthest vertex.
 */
export function farFigures(far: WeldedMesh, R: WeldedMesh, h: number, marks = 20, hold?: (arrays: unknown[]) => void): FarFigures {
  const V = far.positions.length / 3;
  // Each vertex's distance within the first reach, and past it the reach, for the marks: a piece is marked at a vertex
  // as far as any of its own, and where several pass the reach, at the first of them.
  const dist = new Float64Array(V);
  // Its vertices are past the cell from R, most of them: so from four cells, which on the 3 million triangle test block
  // saved an index of the whole copy at twice the cell, the costliest to make.
  const reach = SPLIT_CELLS * h;
  const proved = provedDistance(
    R,
    splitLong(far, SPLIT_CELLS * h).mesh,
    reach,
    (SPLIT_CELLS * h) / 2,
    (index) => {
      const one = new Float32Array(3);
      for (let v = 0; v < V; v++) {
        one.set(far.positions.subarray(v * 3, v * 3 + 3));
        dist[v] = index.check(one, reach).max;
      }
    },
    (arrays) => hold?.([dist, arrays]),
  );
  // Connected pieces by shared vertices, each marked at its farthest vertex.
  const parent = new Int32Array(V);
  for (let v = 0; v < V; v++) parent[v] = v;
  const find = (v: number): number => {
    while (parent[v] !== v) v = parent[v] = parent[parent[v]];
    return v;
  };
  const I = far.indices;
  for (let t = 0; t < I.length; t += 3) {
    const r = find(I[t]);
    parent[find(I[t + 1])] = r;
    parent[find(I[t + 2])] = r;
  }
  const best = new Map<number, number>();
  for (let t = 0; t < I.length; t++) {
    const v = I[t], r = find(v);
    const b = best.get(r);
    if (b === undefined || dist[v] > dist[b]) best.set(r, v);
  }
  const point = (v: number): [number, number, number] => [far.positions[v * 3], far.positions[v * 3 + 1], far.positions[v * 3 + 2]];
  // RM's review: the farthest point proved comes first, then the other pieces, farthest first (in order of first
  // triangle where their vertices' distances tie, as past the first reach they do), so the 20 marks Show gives hold
  // the part the note names, not the first 20 pieces of the file.
  let nearest = -1, gap = Infinity;
  for (let v = 0; v < V; v++) {
    const dx = far.positions[v * 3] - proved.at[0], dy = far.positions[v * 3 + 1] - proved.at[1], dz = far.positions[v * 3 + 2] - proved.at[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < gap) {
      gap = d;
      nearest = v;
    }
  }
  const own = nearest < 0 ? -1 : find(nearest);
  const others = [...best.entries()].filter(([r]) => r !== own).map(([, v]) => v);
  others.sort((a, b) => dist[b] - dist[a]);
  const marked: [number, number, number][] = [[proved.at[0], proved.at[1], proved.at[2]], ...others.slice(0, Math.max(0, marks - 1)).map(point)];
  let area = 0;
  const P = far.positions;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    const x = uy * wz - uz * wy, y = uz * wx - ux * wz, z = ux * wy - uy * wx;
    area += Math.sqrt(x * x + y * y + z * z) / 2;
  }
  return { farthestMm: proved.mm, at: proved.at, marks: marks > 0 ? marked.slice(0, marks) : [], area };
}

/**
 * Each triangle as a closed prism `eps` either side of it along its normal, its corners also pushed `eps` away from
 * the triangle's centroid so the triangle lies inside the prism, not on its sides; a triangle with no normal as a
 * box `eps` round its own box. All in one mesh of separate closed pieces, which Manifold takes, so the least gap
 * from the far part to the cover is one minGap (the design's probe: 1.09 s for 100,000 triangles, where one hull a
 * triangle took 13.3 s for 10,000). The prism's figure is under the triangle's own by at most about 1.5 eps.
 */
export function farPrisms(mesh: WeldedMesh, eps = 0.01): WeldedMesh {
  const T = mesh.indices.length / 3, P = mesh.positions;
  const pos: number[] = [], idx: number[] = [];
  for (let t = 0; t < T; t++) {
    const a = mesh.indices[t * 3] * 3, b = mesh.indices[t * 3 + 1] * 3, c = mesh.indices[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const n = Math.sqrt(nx * nx + ny * ny + nz * nz);
    const base = pos.length / 3;
    if (n > 1e-9) {
      nx = (nx / n) * eps;
      ny = (ny / n) * eps;
      nz = (nz / n) * eps;
      const cx = (P[a] + P[b] + P[c]) / 3, cy = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, cz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
      for (const s of [-1, 1]) {
        for (const k of [a, b, c]) {
          const rx = P[k] - cx, ry = P[k + 1] - cy, rz = P[k + 2] - cz;
          const r = Math.sqrt(rx * rx + ry * ry + rz * rz);
          const out = r > 0 ? eps / r : 0;
          pos.push(P[k] + rx * out + s * nx, P[k + 1] + ry * out + s * ny, P[k + 2] + rz * out + s * nz);
        }
      }
      // Top (+n) wound with the triangle, bottom against it, and each side as two triangles, facing out.
      idx.push(base + 3, base + 4, base + 5, base, base + 2, base + 1);
      for (let e = 0; e < 3; e++) {
        const i = e, j = (e + 1) % 3;
        idx.push(base + i, base + j, base + 3 + j, base + i, base + 3 + j, base + 3 + i);
      }
    } else {
      const xs = [P[a], P[b], P[c]], ys = [P[a + 1], P[b + 1], P[c + 1]], zs = [P[a + 2], P[b + 2], P[c + 2]];
      const x0 = Math.min(...xs) - eps, x1 = Math.max(...xs) + eps, y0 = Math.min(...ys) - eps, y1 = Math.max(...ys) + eps, z0 = Math.min(...zs) - eps, z1 = Math.max(...zs) + eps;
      pos.push(x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1);
      for (const [p, q, r] of [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7]]) idx.push(base + p, base + q, base + r);
    }
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}
