import type { MeshPiece } from './shells';
import type { WeldedMesh } from './weld';

/**
 * Parts of a file closer than this, in mm, touch, and with them one body. A model split for multi-colour
 * printing often has its parts share a face, which rounding to float32 can leave a few microns apart; parts
 * this close print as one, while x8's barriers stand millimetres apart. It is the least plane tolerance the auto
 * rule picks.
 */
export const TOUCH_MM = 0.05;

/** Grid cells per triangle, at most, so a large box of small triangles stays cheap. */
const CELLS_PER_TRIANGLE = 4;
/** The most cells one piece's grid may have, 8 MB of counts, so a piece of millions of triangles stays bounded. */
const MAX_CELLS = 1 << 21;

type Vec = [number, number, number];

const corner = (p: Float32Array, v: number): Vec => [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const det3 = (a: Vec, b: Vec, c: Vec): number => a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
const dist2 = (a: Vec, b: Vec): number => {
  const d = sub(a, b);
  return dot(d, d);
};

/** Squared distance from p to triangle abc, by the regions of the triangle's closest point. */
function pointTriangle2(p: Vec, a: Vec, b: Vec, c: Vec): number {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return dist2(p, a);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return dist2(p, b);
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return dist2(p, c);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const s = d1 / (d1 - d3);
    return dist2(p, [a[0] + ab[0] * s, a[1] + ab[1] * s, a[2] + ab[2] * s]);
  }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const s = d2 / (d2 - d6);
    return dist2(p, [a[0] + ac[0] * s, a[1] + ac[1] * s, a[2] + ac[2] * s]);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const s = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return dist2(p, [b[0] + (c[0] - b[0]) * s, b[1] + (c[1] - b[1]) * s, b[2] + (c[2] - b[2]) * s]);
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return dist2(p, [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]);
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Squared distance between segments p1q1 and p2q2, either of which may have no length. */
function segmentSegment2(p1: Vec, q1: Vec, p2: Vec, q2: Vec): number {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s: number, t: number;
  if (a <= 1e-30 && e <= 1e-30) return dot(r, r);
  if (a <= 1e-30) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = dot(d1, r);
    if (e <= 1e-30) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = dot(d1, d2), denom = a * e - b * b;
      s = denom > 0 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  return dist2([p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s], [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t]);
}

/**
 * Whether segment pq passes through the inside of triangle abc, by the signs of four volumes. A touch at
 * its rim or an end on the face is left to the distances, which read it as 0.
 */
function pierces(p: Vec, q: Vec, a: Vec, b: Vec, c: Vec): boolean {
  const pa = sub(a, p), pb = sub(b, p), pc = sub(c, p), pq = sub(q, p);
  const sp = det3(pa, pb, pc), sq = det3(sub(a, q), sub(b, q), sub(c, q));
  if ((sp > 0 && sq > 0) || (sp < 0 && sq < 0) || sp === 0 || sq === 0) return false;
  const u = det3(pq, pb, pc), v = det3(pq, pc, pa), w = det3(pq, pa, pb);
  return (u > 0 && v > 0 && w > 0) || (u < 0 && v < 0 && w < 0);
}

/**
 * Whether two triangles come within `tol2`, squared. Apart, the nearest points lie on an edge of each or
 * on a corner of one and the face of the other; crossing, an edge of one passes through the other.
 */
function trianglesNear(s: Vec[], t: Vec[], tol2: number): boolean {
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    if (pierces(s[i], s[j], t[0], t[1], t[2]) || pierces(t[i], t[j], s[0], s[1], s[2])) return true;
  }
  for (let i = 0; i < 3; i++) {
    if (pointTriangle2(s[i], t[0], t[1], t[2]) <= tol2 || pointTriangle2(t[i], s[0], s[1], s[2]) <= tol2) return true;
  }
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) if (segmentSegment2(s[i], s[(i + 1) % 3], t[j], t[(j + 1) % 3]) <= tol2) return true;
  }
  return false;
}

/** Triangle t's box into `out` at `at`: low then high, per axis, as x0, x1, y0, y1, z0, z1. */
function triangleBox(mesh: WeldedMesh, t: number, out: Float64Array, at = 0): void {
  const { positions: p, indices } = mesh;
  const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
  for (let axis = 0; axis < 3; axis++) {
    const u = p[a + axis], v = p[b + axis], w = p[c + axis];
    out[at + axis * 2] = u < v ? (u < w ? u : w) : v < w ? v : w;
    out[at + axis * 2 + 1] = u > v ? (u > w ? u : w) : v > w ? v : w;
  }
}

/**
 * Cells of a uniform grid over lo..hi for `count` boxes whose mean side is `side`: about a box's size, grown
 * until the grid holds no more than a few cells per box, and never past MAX_CELLS.
 */
function gridOver(lo: Vec, hi: Vec, count: number, side: number): { size: number; n: Vec } {
  let size = Math.max(side, 1e-3);
  const counts = (): Vec => [0, 1, 2].map((k) => Math.max(1, Math.ceil((hi[k] - lo[k]) / size))) as Vec;
  let n = counts();
  const limit = Math.min(CELLS_PER_TRIANGLE * count + 64, MAX_CELLS);
  while (n[0] * n[1] * n[2] > limit) {
    size *= 1.25;
    n = counts();
  }
  return { size, n };
}

/** Boxes, 6 numbers each, filed in the cells of a uniform grid that each reaches. */
class BoxGrid {
  private readonly lo: Vec;
  private readonly size: number;
  private readonly n: Vec;
  private readonly start: Int32Array;
  private readonly members: Int32Array;
  private readonly range = new Int32Array(6);

  /** `box(k, out)` writes box k; `grow` widens each as it is filed, so a box that near counts as reaching. */
  constructor(lo: Vec, hi: Vec, count: number, side: number, box: (k: number, out: Float64Array) => void, grow = 0) {
    this.lo = lo;
    ({ size: this.size, n: this.n } = gridOver(lo, hi, count, side));
    const cells = this.n[0] * this.n[1] * this.n[2];
    const scratch = new Float64Array(6);
    this.start = new Int32Array(cells + 1);
    for (let k = 0; k < count; k++) {
      box(k, scratch);
      this.each(this.rangeOf(scratch, grow), (cell) => void this.start[cell + 1]++);
    }
    for (let c = 0; c < cells; c++) this.start[c + 1] += this.start[c];
    const fill = this.start.slice(0, -1);
    this.members = new Int32Array(this.start[cells]);
    for (let k = 0; k < count; k++) {
      box(k, scratch);
      this.each(this.rangeOf(scratch, grow), (cell) => void (this.members[fill[cell]++] = k));
    }
  }

  private cellOf(v: number, axis: number): number {
    return Math.min(this.n[axis] - 1, Math.max(0, Math.floor((v - this.lo[axis]) / this.size)));
  }

  /** The cells a box reaches, as x, y and z ranges. */
  private rangeOf(box: ArrayLike<number>, grow: number, at = 0): Int32Array {
    for (let axis = 0; axis < 3; axis++) {
      this.range[axis * 2] = this.cellOf(box[at + axis * 2] - grow, axis);
      this.range[axis * 2 + 1] = this.cellOf(box[at + axis * 2 + 1] + grow, axis);
    }
    return this.range;
  }

  private each(r: Int32Array, visit: (cell: number) => void): void {
    const [nx, ny] = this.n;
    for (let z = r[4]; z <= r[5]; z++) for (let y = r[2]; y <= r[3]; y++) for (let x = r[0]; x <= r[1]; x++) visit(x + nx * (y + ny * z));
  }

  /** Every box filed in a cell the box at `at` of `boxes` reaches; one may come more than once. */
  candidates(boxes: ArrayLike<number>, at: number, visit: (k: number) => boolean | void): boolean {
    let stop = false;
    this.each(this.rangeOf(boxes, 0, at), (cell) => {
      for (let m = this.start[cell]; m < this.start[cell + 1] && !stop; m++) if (visit(this.members[m]) === true) stop = true;
    });
    return stop;
  }
}

/**
 * A closed surface's winding number reads 1 or 0 at a point off it. An open mesh's reads in between near a
 * hole, such as 0.52 for each letter recessed 0.3 mm into Benchy's underside once that underside is taken
 * away, so only a clear reading, with a hole filling under a quarter of the view, counts as inside.
 */
const INSIDE_WINDING = 0.75;

/**
 * One piece's surface for the tests: its own triangles and those of the voids it holds, as a hollow's wall
 * is the piece's material as much as its outside is. Its grid is built once, the first time a small region
 * of it is asked for, however many pairs it is in.
 */
class Surface {
  readonly triangles: Int32Array;
  readonly min: Vec;
  readonly max: Vec;
  private grid: BoxGrid | null = null;
  private seen: Int32Array | null = null;
  private visit = 0;

  constructor(
    private readonly mesh: WeldedMesh,
    readonly piece: MeshPiece,
    voids: readonly MeshPiece[],
  ) {
    const count = piece.triangles.length + voids.reduce((sum, hollow) => sum + hollow.triangles.length, 0);
    this.triangles = new Int32Array(count);
    let k = 0;
    for (const list of [piece.triangles, ...voids.map((hollow) => hollow.triangles)]) for (const t of list) this.triangles[k++] = t;
    this.min = [...piece.min];
    this.max = [...piece.max];
  }

  /** Its triangles whose box reaches into lo..hi, as mesh triangles with their boxes, 6 numbers each. */
  within(lo: Vec, hi: Vec): { ids: Int32Array; boxes: Float64Array } {
    const found = new Found();
    const box = new Float64Array(6);
    const keep = (t: number): void => {
      triangleBox(this.mesh, t, box);
      for (let axis = 0; axis < 3; axis++) if (box[axis * 2 + 1] < lo[axis] || box[axis * 2] > hi[axis]) return;
      found.add(t, box);
    };
    // Over much of the piece, one pass over its triangles costs less than visiting the grid's cells.
    let share = 1;
    for (let axis = 0; axis < 3; axis++) {
      const extent = this.max[axis] - this.min[axis];
      if (extent > 0) share *= Math.max(0, Math.min(hi[axis], this.max[axis]) - Math.max(lo[axis], this.min[axis])) / extent;
    }
    if (share > 0.25 || this.triangles.length < 256) {
      for (const t of this.triangles) keep(t);
      return found.result();
    }
    const grid = (this.grid ??= this.buildGrid());
    const seen = (this.seen ??= new Int32Array(this.triangles.length));
    const visit = ++this.visit;
    grid.candidates(Float64Array.of(lo[0], hi[0], lo[1], hi[1], lo[2], hi[2]), 0, (j) => {
      if (seen[j] === visit) return;
      seen[j] = visit;
      keep(this.triangles[j]);
    });
    return found.result();
  }

  private buildGrid(): BoxGrid {
    const box = new Float64Array(6);
    let side = 0;
    for (const t of this.triangles) {
      triangleBox(this.mesh, t, box);
      side += box[1] - box[0] + box[3] - box[2] + box[5] - box[4];
    }
    return new BoxGrid(this.min, this.max, this.triangles.length, side / (3 * this.triangles.length), (j, out) => triangleBox(this.mesh, this.triangles[j], out));
  }

  /**
   * Whether point `at` lies in this piece's solid. A closed surface is read along the vertical line through
   * the point, by the faces it crosses above and below, which must agree; otherwise, and on an open mesh,
   * by the generalised winding number of every triangle.
   */
  encloses(at: Vec, closed: boolean): boolean {
    if (closed) {
      const column = this.within([at[0], at[1], -Infinity], [at[0], at[1], Infinity]).ids;
      const count = lineCrossings(this.mesh, column, at);
      if (count !== null) return count > INSIDE_WINDING;
    }
    return windingAt(this.mesh, this.triangles, at) > INSIDE_WINDING;
  }
}

/** Triangles and their boxes as they are found, in typed arrays that grow as needed. */
class Found {
  private ids = new Int32Array(64);
  private boxes = new Float64Array(64 * 6);
  private count = 0;

  add(t: number, box: Float64Array): void {
    if (this.count === this.ids.length) {
      const ids = new Int32Array(2 * this.ids.length);
      ids.set(this.ids);
      this.ids = ids;
      const boxes = new Float64Array(2 * this.boxes.length);
      boxes.set(this.boxes);
      this.boxes = boxes;
    }
    this.ids[this.count] = t;
    this.boxes.set(box, this.count * 6);
    this.count++;
  }

  result(): { ids: Int32Array; boxes: Float64Array } {
    return { ids: this.ids.subarray(0, this.count), boxes: this.boxes.subarray(0, this.count * 6) };
  }
}

/** Generalised winding number of a set of triangles at a point: 1 inside a closed positive surface, 0 outside. */
function windingAt(mesh: WeldedMesh, triangles: ArrayLike<number>, at: Vec): number {
  const { positions: p, indices } = mesh;
  let sum = 0;
  for (let k = 0; k < triangles.length; k++) {
    const t = triangles[k];
    const a = sub(corner(p, indices[t * 3]), at), b = sub(corner(p, indices[t * 3 + 1]), at), c = sub(corner(p, indices[t * 3 + 2]), at);
    const la = Math.hypot(...a), lb = Math.hypot(...b), lc = Math.hypot(...c);
    sum += 2 * Math.atan2(det3(a, b, c), la * lb * lc + dot(a, b) * lc + dot(b, c) * la + dot(c, a) * lb);
  }
  return sum / (4 * Math.PI);
}

/**
 * The winding number at `at` of a closed surface, from the triangles the vertical line through it crosses:
 * each face crossed above the point counts +1 facing up and -1 facing down, and below it the other way. On
 * a closed surface both halves give the winding number; null when they differ, as near a hole, or when the
 * line passes too near an edge or the point too near a face to tell.
 */
function lineCrossings(mesh: WeldedMesh, triangles: ArrayLike<number>, at: Vec): number | null {
  const { positions: p, indices } = mesh;
  const [x, y, z] = at;
  let up = 0, down = 0;
  for (let k = 0; k < triangles.length; k++) {
    const t = triangles[k];
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ax = p[a], ay = p[a + 1], bx = p[b], by = p[b + 1], cx = p[c], cy = p[c + 1];
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    // Edge functions: each is the doubled area the point makes with one edge, opposite one corner.
    const wa = (cx - bx) * (y - by) - (cy - by) * (x - bx);
    const wb = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
    const wc = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    const s = area > 0 ? 1 : -1;
    // Rounding in the products, far below any real distance between the point and an edge.
    const eps = 1e-9 * (Math.abs(bx - ax) + Math.abs(cx - bx) + Math.abs(ax - cx) + Math.abs(by - ay) + Math.abs(cy - by) + Math.abs(ay - cy)) ** 2;
    if (wa * s < -eps || wb * s < -eps || wc * s < -eps) continue;
    // On an edge or a corner, or a face standing on edge over the point: no clean crossing to count.
    if (Math.abs(area) <= eps || Math.abs(wa) <= eps || Math.abs(wb) <= eps || Math.abs(wc) <= eps) return null;
    const height = (wa * p[a + 2] + wb * p[b + 2] + wc * p[c + 2]) / area;
    if (Math.abs(height - z) <= 1e-9) return null;
    if (height > z) up += s;
    else down -= s;
  }
  return up === down ? up : null;
}

/** A point on a piece's surface, at its first triangle's centre: off its edges, so a line through it crosses others cleanly. */
function pointOn(mesh: WeldedMesh, piece: MeshPiece): Vec {
  const { positions: p, indices } = mesh;
  const t = piece.triangles[0];
  const [a, b, c] = [0, 1, 2].map((k) => corner(p, indices[t * 3 + k]));
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
}

/**
 * Whether the surfaces of two pieces come within `tol` anywhere, which crossing surfaces do at 0. Only the
 * triangles in the boxes' common part, grown by `tol`, can, so the smaller set of those goes in a grid and
 * the larger is looked up in it, and the first pair near enough ends the search.
 */
function surfacesNear(mesh: WeldedMesh, a: Surface, b: Surface, tol: number): boolean {
  const lo: Vec = [0, 1, 2].map((k) => Math.max(a.min[k], b.min[k]) - tol) as Vec;
  const hi: Vec = [0, 1, 2].map((k) => Math.min(a.max[k], b.max[k]) + tol) as Vec;
  const inA = a.within(lo, hi);
  if (inA.ids.length === 0) return false;
  const inB = b.within(lo, hi);
  if (inB.ids.length === 0) return false;
  const [small, large] = inA.ids.length <= inB.ids.length ? [inA, inB] : [inB, inA];

  let side = tol;
  for (let k = 0; k < small.ids.length; k++) {
    for (let axis = 0; axis < 3; axis++) side += (small.boxes[k * 6 + axis * 2 + 1] - small.boxes[k * 6 + axis * 2]) / (3 * small.ids.length);
  }
  // The smaller set, each box grown by tol, so a lookup by the other's own box finds every pair that near.
  const grid = new BoxGrid(lo, hi, small.ids.length, side, (k, out) => out.set(small.boxes.subarray(k * 6, k * 6 + 6)), tol);

  const { positions: p, indices } = mesh;
  const corners = (t: number): Vec[] => [corner(p, indices[t * 3]), corner(p, indices[t * 3 + 1]), corner(p, indices[t * 3 + 2])];
  const tol2 = tol * tol;
  const seen = new Int32Array(small.ids.length).fill(-1);
  for (let k = 0; k < large.ids.length; k++) {
    let mine: Vec[] | null = null;
    const found = grid.candidates(large.boxes, k * 6, (other) => {
      if (seen[other] === k) return false;
      seen[other] = k;
      // Boxes further apart than tol on any axis cannot hold points that close.
      for (let axis = 0; axis < 3; axis++) {
        if (small.boxes[other * 6 + axis * 2] - tol > large.boxes[k * 6 + axis * 2 + 1] || large.boxes[k * 6 + axis * 2] - tol > small.boxes[other * 6 + axis * 2 + 1]) return false;
      }
      mine ??= corners(large.ids[k]);
      return trianglesNear(mine, corners(small.ids[other]), tol2);
    });
    if (found) return true;
  }
  return false;
}

/**
 * Whether piece `inner` lies in the solid of `outer`. Only asked once their surfaces, `outer`'s hollows'
 * walls included, are known to stay further apart than the tolerance, so the whole piece is in or out
 * alike and one point of it tells. A piece in a sealed hollow of the other is not in its solid.
 */
function insideOf(mesh: WeldedMesh, inner: MeshPiece, outer: Surface, tol: number, closed: boolean): boolean {
  // All of a piece in the other's solid lies in that solid's box.
  for (let axis = 0; axis < 3; axis++) if (inner.min[axis] < outer.min[axis] - tol || inner.max[axis] > outer.max[axis] + tol) return false;
  return outer.encloses(pointOn(mesh, inner), closed);
}

/**
 * The piece whose solid holds each void, by index: of those whose box holds the void's and whose own surface
 * encloses it, the one with the smallest box, so a hollow in a part that sits in another's hollow is its own.
 */
function voidOwners(mesh: WeldedMesh, pieces: readonly MeshPiece[], solids: readonly number[], closed: boolean): Map<number, MeshPiece[]> {
  const held = new Map<number, MeshPiece[]>();
  const size = (piece: MeshPiece): number => (piece.max[0] - piece.min[0]) * (piece.max[1] - piece.min[1]) * (piece.max[2] - piece.min[2]);
  for (const hollow of pieces) {
    if (hollow.kind !== 'void') continue;
    const at = pointOn(mesh, hollow);
    let owner = -1;
    for (const index of solids) {
      const piece = pieces[index];
      if (![0, 1, 2].every((axis) => piece.min[axis] <= hollow.min[axis] && piece.max[axis] >= hollow.max[axis])) continue;
      if (owner >= 0 && size(piece) >= size(pieces[owner])) continue;
      const own = closed ? lineCrossings(mesh, piece.triangles, at) : null;
      if ((own ?? windingAt(mesh, piece.triangles, at)) > INSIDE_WINDING) owner = index;
    }
    if (owner >= 0) held.set(owner, [...(held.get(owner) ?? []), hollow]);
  }
  return held;
}

export interface TouchOptions {
  /** In mm: surfaces this close touch. */
  tol?: number;
  /**
   * The mesh is closed, as one Manifold has taken, so whether a piece lies in another can be read along one
   * line through it. An open mesh's pieces are read by the winding number, whose reading near a hole is the rule.
   */
  closed?: boolean;
}

/**
 * The bodies of a mesh as groups of its connected pieces, by index into `pieces`: pieces whose solids
 * overlap, or whose surfaces come within `tol` of each other, are one body, as a slicer prints them, and
 * so are all pieces joined to each other that way. A void's surface counts as that of the piece whose solid
 * holds it, so a part resting on a hollow's floor, or passing through its wall, joins that piece. Voids
 * belong to no group. Groups keep the order of their first piece, and one piece is a group of its own with
 * no test at all. Needs no Manifold, so soup mode and field.worker can use it, and works on the surfaces
 * themselves, with no cell.
 */
export function touchingGroups(mesh: WeldedMesh, pieces: readonly MeshPiece[], options: TouchOptions = {}): number[][] {
  const tol = options.tol ?? TOUCH_MM, closed = options.closed ?? false;
  const solids = pieces.flatMap((piece, index) => (piece.kind === 'void' ? [] : [index]));
  if (solids.length < 2) return solids.map((index) => [index]);
  const held = voidOwners(mesh, pieces, solids, closed);
  const surfaces = new Map<number, Surface>();
  const surface = (index: number): Surface => {
    let found = surfaces.get(index);
    if (!found) surfaces.set(index, (found = new Surface(mesh, pieces[index], held.get(index) ?? [])));
    return found;
  };
  const parent = pieces.map((_, index) => index);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (let x = 0; x < solids.length; x++) {
    for (let y = x + 1; y < solids.length; y++) {
      const i = solids[x], j = solids[y];
      if (find(i) === find(j)) continue;
      const a = pieces[i], b = pieces[j];
      if ([0, 1, 2].some((axis) => a.min[axis] - tol > b.max[axis] || b.min[axis] - tol > a.max[axis])) continue;
      const sa = surface(i), sb = surface(j);
      if (surfacesNear(mesh, sa, sb, tol) || insideOf(mesh, a, sb, tol, closed) || insideOf(mesh, b, sa, tol, closed)) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, number[]>();
  for (const index of solids) {
    const root = find(index);
    const group = groups.get(root);
    if (group) group.push(index);
    else groups.set(root, [index]);
  }
  return [...groups.values()];
}
