import type { OpenLoop } from '../mesh/audit';
import type { Bounds, WeldedMesh } from '../mesh/weld';

export type Vec3 = [number, number, number];

export interface BaseOptions {
  /** Corners this close to a plane belong to it, in mm. */
  planeTol: number;
  /** For the footprint only: smaller components are dropped from it, in mm2. Detection ignores this. */
  minIsland: number;
}

/** What only soup mode knows. Passing it also says the mesh's winding cannot be trusted. */
export interface SoupContext {
  openLoops: OpenLoop[];
}

/** A flat level near the support plane, at `offset` mm into the model. Offset 0 is the support. */
export interface PlaneLevel {
  offset: number;
  area: number;
  /** Surface lying past this plane, in mm2: what a trim to this level would remove. */
  beyond: number;
  /** Area of the whole face. Above `area` when the face is rougher than the tolerance band. */
  faceArea: number;
}

export interface BaseCandidate {
  /** Unit outward normal: it points away from the model, towards the base. */
  normal: Vec3;
  /** Largest dot(normal, vertex): the plane touching the model's extreme vertex. */
  support: number;
  /** How far the chosen plane sits into the model from the support plane. */
  offset: number;
  /** Area projected onto the plane, of the triangles with every corner on it, plus `holes`. */
  area: number;
  /** Those triangles, by index, for highlighting and for the footprint. */
  members: Uint32Array;
  /** Flat levels within reach of the tolerance slider, nearest first. Includes the chosen one. */
  levels: PlaneLevel[];
  /** A histogram plane is on or within slider reach of the support. A picked one can be any ledge. */
  source: 'histogram' | 'pick' | 'hole';
  /** Holes in an open mesh on this plane, largest first: faces the file lacks, counted in `area`. */
  holes: OpenLoop[];
  /** See PlaneLevel.faceArea. */
  faceArea: number;
}

const DEGREE = Math.PI / 180;
const BIN = 1.5 * DEGREE;
const CANDIDATE_LIMIT = 8;
// Each examined bin costs a pass over the mesh, and a real face this far down the list is unusual.
const EXAMINED_BIN_LIMIT = 128;
/** Reach of the tolerance slider (1 mm). Beyond this a flat face is a ledge, not a second level. */
export const NEAR_SUPPORT_RANGE = 1;
const COS_FLAT = Math.cos(BIN);
// Normals agreeing to 0.02 degrees count as one exactly flat face.
const FINE_CELLS = 1 / (0.02 * DEGREE);
// Within about 0.011 degrees of an axis counts as that axis, so an axis-aligned model is only
// translated and picks up no rotation noise at all.
const AXIS_SNAP = 2e-8;
/**
 * Below this a flat patch is not a face to stand on, in mm2. It is fixed rather than the user's
 * minIsland, so a small base can still be chosen and raising the footprint filter cannot hide a level.
 */
export const LEVEL_FLOOR = 2;
// A rough face's normals scatter further than one bin, so its mean is taken over this cone.
const ROUGH_POOL_COS = Math.cos(8 * DEGREE);
const ROUGH_BIN_COS = Math.cos(9.5 * DEGREE);
// Bins whose cones centre this close would settle on one face, so only the first is worked through.
const ROUGH_SAME_COS = Math.cos(3 * DEGREE);
/**
 * What lies past a plane is stray rather than a real step when its surface is under this share of
 * the plane's area. Real steps on the examples start at 14%, and a thin 3 mm spike is under 1%.
 */
const STRAY_SHARE = 0.02;
/** A shallow level with nothing flat below it may stand in when its trim removes up to this share. */
const SHALLOW_TRIM_SHARE = 0.25;
// How much a face may grow when the depth doubles (or quadruples, for a rough one) and still have
// ended. A dome grows by 2 and 4 at any depth, because its area is proportional to the depth.
const FACE_END_GROWTH = 1.25;
// Depth steps tol * 2^k. A rough face is looked for up to k=3, and its growth is read 2 steps on.
const PROFILE_STEPS = 6;

/** Plane tolerance scales with model size, because noise in the file does too. */
export function autoPlaneTol(bounds: Bounds): number {
  const diagonal = Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);
  return Math.min(0.2, Math.max(0.05, diagonal * 0.0005));
}

interface Faces {
  normals: Float64Array;
  areas: Float64Array;
}

function faces(mesh: WeldedMesh): Faces {
  const { positions: p, indices } = mesh;
  const count = indices.length / 3;
  const normals = new Float64Array(count * 3);
  const areas = new Float64Array(count);
  for (let t = 0; t < count; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    areas[t] = length / 2;
    // Collinear triangles are kept in the mesh, and they have no normal and no area.
    if (length === 0) continue;
    normals[t * 3] = nx / length;
    normals[t * 3 + 1] = ny / length;
    normals[t * 3 + 2] = nz / length;
  }
  return { normals, areas };
}

/**
 * Polar rings at 1.5 degree spacing, split so every bin is about 1.5 degrees wide. Rings and
 * sectors are centred on the axes: a flat face aligned to an axis, the common case, has normals
 * that jitter around that axis and would otherwise straddle up to four bins.
 */
const RINGS = Math.round(Math.PI / BIN);
const ringStart = new Int32Array(RINGS + 2);
const ringSectors = new Int32Array(RINGS + 1);
for (let ring = 0; ring <= RINGS; ring++) {
  const sectors = ring === 0 || ring === RINGS ? 1 : Math.max(1, Math.round((2 * Math.PI * Math.sin(ring * BIN)) / BIN));
  ringSectors[ring] = sectors;
  ringStart[ring + 1] = ringStart[ring] + sectors;
}

function binOf(nx: number, ny: number, nz: number): number {
  const ring = Math.round(Math.acos(Math.max(-1, Math.min(1, nz))) / BIN);
  const sectors = ringSectors[ring];
  if (sectors === 1) return ringStart[ring];
  let phi = Math.atan2(ny, nx);
  if (phi < 0) phi += 2 * Math.PI;
  return ringStart[ring] + (Math.round((phi / (2 * Math.PI)) * sectors) % sectors);
}

function snapToAxis(n: Vec3): Vec3 {
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(n[axis]) >= 1 - AXIS_SNAP) {
      const out: Vec3 = [0, 0, 0];
      out[axis] = Math.sign(n[axis]);
      return out;
    }
  }
  return n;
}

function normalised(x: number, y: number, z: number): Vec3 {
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}

function negated(n: Vec3): Vec3 {
  return [-n[0] || 0, -n[1] || 0, -n[2] || 0];
}

/**
 * A flat face gives many triangles with one exact normal, while a mean also averages in nearby
 * sloped triangles and tilts the plane off the face. Returns that normal if it holds most of the
 * area, and otherwise null, because the triangles are a rough surface.
 */
function exactNormal(triangles: ArrayLike<number>, from: number, to: number, shape: Faces): Vec3 | null {
  const { normals, areas } = shape;
  const cells = new Map<string, { area: number; x: number; y: number; z: number }>();
  let total = 0;
  for (let i = from; i < to; i++) {
    const t = triangles[i];
    const area = areas[t];
    const nx = normals[t * 3], ny = normals[t * 3 + 1], nz = normals[t * 3 + 2];
    total += area;
    const key = `${Math.round(nx * FINE_CELLS)},${Math.round(ny * FINE_CELLS)},${Math.round(nz * FINE_CELLS)}`;
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = { area: 0, x: 0, y: 0, z: 0 }));
    cell.area += area;
    cell.x += nx * area;
    cell.y += ny * area;
    cell.z += nz * area;
  }
  let best = { area: 0, x: 0, y: 0, z: 0 };
  for (const cell of cells.values()) if (cell.area > best.area) best = cell;
  return best.area * 2 < total || best.area === 0 ? null : normalised(best.x, best.y, best.z);
}

/** Corners of these triangles, fitted with a least-squares plane close to `n`. */
function fitPlane(mesh: WeldedMesh, shape: Faces, triangles: number[], n: Vec3): Vec3 {
  const { positions: p, indices } = mesh;
  // Any two directions across the plane will do.
  const axis: Vec3 = Math.abs(n[0]) < 0.6 ? [1, 0, 0] : [0, 1, 0];
  const u = normalised(n[1] * axis[2] - n[2] * axis[1], n[2] * axis[0] - n[0] * axis[2], n[0] * axis[1] - n[1] * axis[0]);
  const v: Vec3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  let weight = 0, mx = 0, my = 0, mz = 0, xx = 0, xy = 0, yy = 0, xz = 0, yz = 0;
  for (const t of triangles) {
    for (let c = 0; c < 3; c++) {
      const i = indices[t * 3 + c] * 3;
      const x = u[0] * p[i] + u[1] * p[i + 1] + u[2] * p[i + 2];
      const y = v[0] * p[i] + v[1] * p[i + 1] + v[2] * p[i + 2];
      const z = n[0] * p[i] + n[1] * p[i + 1] + n[2] * p[i + 2];
      const w = shape.areas[t];
      weight += w;
      mx += w * x;
      my += w * y;
      mz += w * z;
      xx += w * x * x;
      xy += w * x * y;
      yy += w * y * y;
      xz += w * x * z;
      yz += w * y * z;
    }
  }
  if (weight === 0) return n;
  xx -= (mx * mx) / weight;
  xy -= (mx * my) / weight;
  yy -= (my * my) / weight;
  xz -= (mx * mz) / weight;
  yz -= (my * mz) / weight;
  const det = xx * yy - xy * xy;
  // Triangles along one line fix no plane.
  if (det <= 1e-9 * (xx * yy || 1)) return n;
  const a = (xz * yy - yz * xy) / det, b = (yz * xx - xz * xy) / det;
  return normalised(n[0] - a * u[0] - b * v[0], n[1] - a * u[1] - b * v[1], n[2] - a * u[2] - b * v[2]);
}

/** The normal histogram: which triangles fall in each bin, and each bin's area-weighted normal sum. */
interface Histogram {
  /** Bins with any area, largest first. */
  bins: number[];
  /** Triangles of bin b are byBin[start[b]] up to byBin[start[b + 1]]. */
  start: Int32Array;
  byBin: Uint32Array;
  /** Area-weighted normal sum, three per bin. */
  sums: Float64Array;
  /** That sum as a unit vector, three per bin. */
  means: Float64Array;
}

function buildHistogram(shape: Faces): Histogram {
  const count = shape.areas.length;
  const binCount = ringStart[RINGS + 1];
  const areas = new Float64Array(binCount);
  const sums = new Float64Array(binCount * 3);
  const binOfTriangle = new Int32Array(count);
  const start = new Int32Array(binCount + 1);
  for (let t = 0; t < count; t++) {
    const bin = binOf(shape.normals[t * 3], shape.normals[t * 3 + 1], shape.normals[t * 3 + 2]);
    binOfTriangle[t] = bin;
    areas[bin] += shape.areas[t];
    for (let axis = 0; axis < 3; axis++) sums[bin * 3 + axis] += shape.normals[t * 3 + axis] * shape.areas[t];
    start[bin + 1]++;
  }
  for (let b = 0; b < binCount; b++) start[b + 1] += start[b];
  const fill = start.slice();
  const byBin = new Uint32Array(count);
  for (let t = 0; t < count; t++) byBin[fill[binOfTriangle[t]]++] = t;
  const bins = Array.from(areas.keys())
    .filter((b) => areas[b] > 0)
    .sort((a, b) => areas[b] - areas[a]);
  const means = new Float64Array(binCount * 3);
  for (const b of bins) {
    const length = Math.hypot(sums[b * 3], sums[b * 3 + 1], sums[b * 3 + 2]) || 1;
    for (let axis = 0; axis < 3; axis++) means[b * 3 + axis] = sums[b * 3 + axis] / length;
  }
  return { bins, start, byBin, sums, means };
}

/** The mean normal over the whole cone around a direction, recentred a few times. */
function coneMean(histogram: Histogram, start: Vec3): Vec3 {
  const { bins, sums, means } = histogram;
  let n = start;
  for (let pass = 0; pass < 3; pass++) {
    let x = 0, y = 0, z = 0;
    for (const b of bins) {
      if (n[0] * means[b * 3] + n[1] * means[b * 3 + 1] + n[2] * means[b * 3 + 2] < ROUGH_POOL_COS) continue;
      x += sums[b * 3];
      y += sums[b * 3 + 1];
      z += sums[b * 3 + 2];
    }
    if (x === 0 && y === 0 && z === 0) return start;
    n = normalised(x, y, z);
  }
  return n;
}

/**
 * One bin's mean is biased when a rough face straddles several bins, and a tilt of half a degree
 * pivots the plane on one corner of the face. So after coneMean has removed most of that, a plane
 * is fitted to the triangles at the most common depth, which leaves out parallel faces further along.
 */
function roughFaceNormal(mesh: WeldedMesh, shape: Faces, histogram: Histogram, pooled: Vec3, tol: number): Vec3 {
  const { normals, areas } = shape;
  const { positions: p, indices } = mesh;
  const { bins, means, byBin } = histogram;
  let n = pooled;
  let kept: number[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const pool: { t: number; depth: number }[] = [];
    let total = 0;
    for (const b of bins) {
      // A bin is 1.5 degrees across, so its mean can sit just outside a cone that holds some of it.
      if (n[0] * means[b * 3] + n[1] * means[b * 3 + 1] + n[2] * means[b * 3 + 2] < ROUGH_BIN_COS) continue;
      for (let i = histogram.start[b]; i < histogram.start[b + 1]; i++) {
        const t = byBin[i];
        if (n[0] * normals[t * 3] + n[1] * normals[t * 3 + 1] + n[2] * normals[t * 3 + 2] < ROUGH_POOL_COS) continue;
        const a0 = indices[t * 3] * 3, a1 = indices[t * 3 + 1] * 3, a2 = indices[t * 3 + 2] * 3;
        const depth = (n[0] * (p[a0] + p[a1] + p[a2]) + n[1] * (p[a0 + 1] + p[a1 + 1] + p[a2 + 1]) + n[2] * (p[a0 + 2] + p[a1 + 2] + p[a2 + 2])) / 3;
        pool.push({ t, depth });
        total += areas[t];
      }
    }
    if (pool.length === 0) return n;
    pool.sort((x, y) => x.depth - y.depth);
    // Area-weighted quartiles: the middle half of the area says where the face is and how rough.
    const quantile = (share: number): number => {
      let sum = 0;
      for (const item of pool) {
        sum += areas[item.t];
        if (sum >= share * total) return item.depth;
      }
      return pool[pool.length - 1].depth;
    };
    const low = quantile(0.25), middle = quantile(0.5), high = quantile(0.75);
    const band = Math.max(tol, 2 * (high - low));
    kept = pool.filter((item) => Math.abs(item.depth - middle) <= band).map((item) => item.t);
    n = fitPlane(mesh, shape, kept, n);
  }
  return exactNormal(kept, 0, kept.length, shape) ?? n;
}

function vertexDots(mesh: WeldedMesh, n: Vec3): Float64Array {
  const p = mesh.positions;
  const dots = new Float64Array(p.length / 3);
  for (let v = 0; v < dots.length; v++) dots[v] = n[0] * p[v * 3] + n[1] * p[v * 3 + 1] + n[2] * p[v * 3 + 2];
  return dots;
}

function facingOf(shape: Faces, n: Vec3, t: number): number {
  return n[0] * shape.normals[t * 3] + n[1] * shape.normals[t * 3 + 1] + n[2] * shape.normals[t * 3 + 2];
}

/**
 * Membership goes by corner distance, not normal, so tiny tilted facets on the face still count.
 * The triangles with a corner past the plane are what a trim would cut, which `beyond` adds up.
 */
function membersOf(mesh: WeldedMesh, shape: Faces, dots: Float64Array, n: Vec3, planeDot: number, tol: number): { members: Uint32Array; area: number; beyond: number } {
  const { indices } = mesh;
  const count = indices.length / 3;
  const found = new Uint32Array(count);
  let used = 0, area = 0, beyond = 0;
  for (let t = 0; t < count; t++) {
    const a = dots[indices[t * 3]] - planeDot, b = dots[indices[t * 3 + 1]] - planeDot, c = dots[indices[t * 3 + 2]] - planeDot;
    if (a > tol || b > tol || c > tol) {
      beyond += shape.areas[t];
      continue;
    }
    if (a < -tol || b < -tol || c < -tol) continue;
    found[used++] = t;
    area += shape.areas[t] * Math.abs(facingOf(shape, n, t));
  }
  return { members: found.slice(0, used), area, beyond };
}

/**
 * Area by depth from the support plane decides what is flat. A real face ends at its outline, so
 * past its depth the area stops growing, while a dome's cap keeps growing with depth for as far
 * as you look. Rough faces have no sharp start, so their area levels off a few tolerances down.
 */
function supportFaceArea(mesh: WeldedMesh, shape: Faces, dots: Float64Array, n: Vec3, support: number, tol: number, anySide: boolean): number | null {
  const { indices } = mesh;
  const count = indices.length / 3;
  const areas = new Float64Array(PROFILE_STEPS);
  const sums = new Float64Array(PROFILE_STEPS * 3);
  const deepest = tol * 2 ** (PROFILE_STEPS - 1);
  let flatArea = 0;
  for (let t = 0; t < count; t++) {
    const depth = support - Math.min(dots[indices[t * 3]], dots[indices[t * 3 + 1]], dots[indices[t * 3 + 2]]);
    if (depth > deepest) continue;
    const facing = facingOf(shape, n, t);
    // On a closed solid, triangles facing away are the back of a thin part, not this surface.
    if (!anySide && facing <= 0) continue;
    const projected = shape.areas[t] * Math.abs(facing);
    let step = 0;
    while (depth > tol * 2 ** step) step++;
    areas[step] += projected;
    if (step === 0 && Math.abs(facing) >= COS_FLAT) flatArea += projected;
    const signed = shape.areas[t] * Math.sign(facing);
    for (let axis = 0; axis < 3; axis++) sums[step * 3 + axis] += shape.normals[t * 3 + axis] * signed;
  }
  for (let k = 1; k < PROFILE_STEPS; k++) {
    areas[k] += areas[k - 1];
    for (let axis = 0; axis < 3; axis++) sums[k * 3 + axis] += sums[(k - 1) * 3 + axis];
  }

  if (areas[0] > 0 && flatArea * 2 >= areas[0] && areas[1] <= FACE_END_GROWTH * areas[0]) return areas[0];
  for (let k = 0; k + 2 < PROFILE_STEPS; k++) {
    if (areas[k] === 0 || areas[k + 2] > FACE_END_GROWTH * areas[k]) continue;
    // A rough face averages out to this plane. A flat face tilted away from it, which merely
    // touches the plane at one edge, does not, and the barrier's sloped flanks are that case.
    const x = sums[k * 3], y = sums[k * 3 + 1], z = sums[k * 3 + 2];
    return n[0] * x + n[1] * y + n[2] * z >= COS_FLAT * Math.hypot(x, y, z) ? areas[k] : null;
  }
  return null;
}

/**
 * Finds the flat levels a direction offers. On the support plane, flatness decides. Deeper in, a
 * run of triangles facing the normal must stay flat within the tolerance band, because a shallow
 * slope chains together into a wide run. Levels within slider reach are all kept. A deeper one only
 * counts when what lies past it is stray, since otherwise it is a ledge the model cannot stand on.
 */
function findLevels(mesh: WeldedMesh, shape: Faces, dots: Float64Array, n: Vec3, support: number, tol: number, anySide: boolean): PlaneLevel[] {
  const { indices } = mesh;
  const count = indices.length / 3;
  const levels: PlaneLevel[] = [];
  const faceArea = supportFaceArea(mesh, shape, dots, n, support, tol, anySide);
  if (faceArea !== null) {
    const { area, beyond } = membersOf(mesh, shape, dots, n, support, tol);
    if (area >= LEVEL_FLOOR) levels.push({ offset: 0, area, beyond, faceArea: Math.max(area, faceArea) });
  }

  const flat: { depth: number; area: number }[] = [];
  for (let t = 0; t < count; t++) {
    const facing = facingOf(shape, n, t);
    if (facing < COS_FLAT) continue;
    const a = support - dots[indices[t * 3]];
    const b = support - dots[indices[t * 3 + 1]];
    const c = support - dots[indices[t * 3 + 2]];
    flat.push({ depth: (a + b + c) / 3, area: shape.areas[t] * facing });
  }
  flat.sort((x, y) => x.depth - y.depth);

  const levelAt = (offset: number): PlaneLevel => {
    const { area, beyond } = membersOf(mesh, shape, dots, n, support - offset, tol);
    return { offset, area, beyond, faceArea: area };
  };
  let ledge: { offset: number; area: number } | null = null;
  for (let i = 0; i < flat.length; ) {
    const start = flat[i].depth;
    let end = start, area = 0, weighted = 0;
    let j = i;
    while (j < flat.length && flat[j].depth - end <= tol) {
      end = flat[j].depth;
      area += flat[j].area;
      weighted += flat[j].depth * flat[j].area;
      j++;
    }
    i = j;
    if (start <= tol || end - start > 2 * tol) continue;
    const offset = weighted / area;
    if (offset <= NEAR_SUPPORT_RANGE) {
      const level = levelAt(offset);
      if (level.area >= LEVEL_FLOOR) levels.push(level);
    } else if (!ledge || area > ledge.area) {
      ledge = { offset, area };
    }
  }
  if (ledge && ledge.area >= LEVEL_FLOOR) {
    const level = levelAt(ledge.offset);
    if (level.area >= LEVEL_FLOOR && level.beyond <= STRAY_SHARE * level.area) levels.push(level);
  }
  return levels.sort((a, b) => a.offset - b.offset);
}

/**
 * The plane a direction offers by default: its largest level with only stray geometry past it,
 * which is normally the support plane itself. A big face just above a tiny stray bit wins over the
 * bit, which then gets the below-plane warning and the trim. With nothing flat on the support
 * plane, a shallow level may stand in. Otherwise the direction has no plane to offer.
 */
function chooseLevel(levels: PlaneLevel[]): PlaneLevel | null {
  let best: PlaneLevel | null = null;
  for (const level of levels) {
    if (level.beyond <= STRAY_SHARE * level.area && (!best || level.area > best.area)) best = level;
  }
  return best ?? levels.find((level) => level.offset <= NEAR_SUPPORT_RANGE && level.beyond <= SHALLOW_TRIM_SHARE * level.area) ?? null;
}

function candidateAt(mesh: WeldedMesh, shape: Faces, dots: Float64Array, n: Vec3, support: number, offset: number, levels: PlaneLevel[], tol: number, source: BaseCandidate['source']): BaseCandidate {
  const { members, area } = membersOf(mesh, shape, dots, n, support - offset, tol);
  const level = levels.find((l) => Math.abs(l.offset - offset) <= tol);
  return { normal: n, support, offset, area, members, levels, source, holes: [], faceArea: Math.max(area, level?.faceArea ?? 0) };
}

function maxOf(values: Float64Array): number {
  let best = -Infinity;
  for (let i = 0; i < values.length; i++) if (values[i] > best) best = values[i];
  return best;
}

function minOf(values: Float64Array): number {
  let best = Infinity;
  for (let i = 0; i < values.length; i++) if (values[i] < best) best = values[i];
  return best;
}

/**
 * A hole with a flat rim can be the model's base, as on a shell with an open underside. The cap
 * normal comes from the winding, so which way it faces is decided by where the model lies, and a
 * hole with model on both sides of its plane is no base. Holes on a plane already offered join it,
 * and the largest go first: a missing face with a recess in it leaves a big outer rim plus inner
 * rims with their caps the other way, whose area comes back off.
 */
function addHoleCandidates(mesh: WeldedMesh, shape: Faces, openLoops: readonly OpenLoop[], tol: number, candidates: BaseCandidate[]): void {
  for (const hole of [...openLoops].sort((a, b) => b.area - a.area)) {
    if (hole.area === 0) continue;
    const capNormal = snapToAxis(hole.capNormal);
    const dots = vertexDots(mesh, capNormal);
    const rim = Array.from(hole.vertices, (v) => dots[v]);
    const planeDot = rim.reduce((sum, value) => sum + value, 0) / rim.length;
    if (rim.some((value) => Math.abs(value - planeDot) > tol)) continue;

    const top = maxOf(dots), bottom = minOf(dots);
    const facesAway = top - planeDot <= tol;
    if (!facesAway && planeDot - bottom > tol) continue;
    const n = facesAway ? capNormal : negated(capNormal);
    const support = facesAway ? top : -bottom;

    const same = candidates.find((c) => c.normal[0] * n[0] + c.normal[1] * n[1] + c.normal[2] * n[2] > COS_FLAT && Math.abs(c.support - c.offset - support) <= tol);
    if (same) {
      const area = facesAway ? hole.area : -hole.area;
      same.holes.push(hole);
      same.area += area;
      same.faceArea += area;
      continue;
    }
    if (hole.area < LEVEL_FLOOR) continue;
    const planeSide = facesAway ? dots : vertexDots(mesh, n);
    const { members, area } = membersOf(mesh, shape, planeSide, n, support, tol);
    const total = area + hole.area;
    candidates.push({ normal: n, support, offset: 0, area: total, members, levels: [{ offset: 0, area: total, beyond: 0, faceArea: total }], source: 'hole', holes: [hole], faceArea: total });
  }
}

/**
 * G2: ranked base planes. The histogram proposes directions. A direction only becomes a candidate
 * if a flat face lies on its support plane, on a level within slider reach of it, or above nothing
 * but stray geometry; a flat face deeper in is a ledge that the model cannot stand on, and is
 * rejected. The ranking is advice: a big flat top is a support plane too, which is why the user
 * always confirms. In soup mode a face may be wound the wrong way, so a bin only says which line
 * a face's normal lies on, and both directions along it are tried.
 */
export function findBaseCandidates(mesh: WeldedMesh, options: BaseOptions, soup?: SoupContext): BaseCandidate[] {
  const { planeTol } = options;
  const shape = faces(mesh);
  const histogram = buildHistogram(shape);
  const { start, byBin, sums } = histogram;

  const accepted: BaseCandidate[] = [];
  const known = (n: Vec3): boolean => accepted.some((c) => c.normal[0] * n[0] + c.normal[1] * n[1] + c.normal[2] * n[2] > COS_FLAT);
  const roughTried: Vec3[] = [];
  for (const bin of histogram.bins.slice(0, EXAMINED_BIN_LIMIT)) {
    if (accepted.length === CANDIDATE_LIMIT) break;
    let direction = exactNormal(byBin, start[bin], start[bin + 1], shape);
    if (!direction) {
      const pooled = coneMean(histogram, normalised(sums[bin * 3], sums[bin * 3 + 1], sums[bin * 3 + 2]));
      if (roughTried.some((v) => v[0] * pooled[0] + v[1] * pooled[1] + v[2] * pooled[2] > ROUGH_SAME_COS)) continue;
      roughTried.push(pooled);
      direction = roughFaceNormal(mesh, shape, histogram, pooled, planeTol);
    }
    const found = snapToAxis(direction);
    for (const n of soup ? [found, negated(found)] : [found]) {
      if (accepted.length === CANDIDATE_LIMIT || known(n)) continue;
      const dots = vertexDots(mesh, n);
      const support = maxOf(dots);
      const levels = findLevels(mesh, shape, dots, n, support, planeTol, soup !== undefined);
      const chosen = chooseLevel(levels);
      if (chosen) accepted.push(candidateAt(mesh, shape, dots, n, support, chosen.offset, levels, planeTol, 'histogram'));
    }
  }
  if (soup) addHoleCandidates(mesh, shape, soup.openLoops, planeTol, accepted);
  // A rough base ranks by its whole face, since raising the tolerance would seat all of it. A plane
  // that needs a trim is a worse base than a whole one of about the same size, such as a plate's
  // top with a small knob on it against the plate's underside. Soup mode cannot trim at all.
  const score = (c: BaseCandidate): number => (c.offset <= planeTol ? c.faceArea : soup ? 0 : c.faceArea / 2);
  return accepted.sort((a, b) => score(b) - score(a)).slice(0, CANDIDATE_LIMIT);
}

function isMember(candidate: BaseCandidate, triangle: number): boolean {
  // Members are collected in triangle order, so they are sorted.
  const { members } = candidate;
  let low = 0, high = members.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (members[middle] === triangle) return true;
    if (members[middle] < triangle) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

/**
 * The plane through a clicked triangle. It may be a ledge, and orient reports what lies below it.
 * A click inside a ranked candidate means that whole plane, because a tilted sliver inside its
 * tolerance band has a plane of its own that would otherwise jump somewhere unrelated.
 */
export function candidateFromPick(mesh: WeldedMesh, triangle: number, options: BaseOptions, ranked: readonly BaseCandidate[] = []): BaseCandidate {
  const { planeTol } = options;
  const known = ranked.find((c) => isMember(c, triangle));
  if (known) return { ...known, source: 'pick' };

  const shape = faces(mesh);
  if (!(shape.areas[triangle] > 0)) throw new Error('A collinear triangle has no plane to pick.');
  const picked: Vec3 = [shape.normals[triangle * 3], shape.normals[triangle * 3 + 1], shape.normals[triangle * 3 + 2]];

  // Average over the face around the click: one small triangle's normal is noisy. Neighbours wound
  // the other way lie on the same face, so they count with their sign turned.
  const first = vertexDots(mesh, picked);
  const { indices } = mesh;
  const pickedDot = (first[indices[triangle * 3]] + first[indices[triangle * 3 + 1]] + first[indices[triangle * 3 + 2]]) / 3;
  let x = 0, y = 0, z = 0;
  const near = membersOf(mesh, shape, first, picked, pickedDot, planeTol);
  for (const t of near.members) {
    const facing = facingOf(shape, picked, t);
    if (Math.abs(facing) < COS_FLAT) continue;
    const weight = shape.areas[t] * Math.sign(facing);
    x += shape.normals[t * 3] * weight;
    y += shape.normals[t * 3 + 1] * weight;
    z += shape.normals[t * 3 + 2] * weight;
  }
  let n = snapToAxis(normalised(x, y, z));
  let dots = vertexDots(mesh, n);
  let support = maxOf(dots);
  let planeDot = (dots[indices[triangle * 3]] + dots[indices[triangle * 3 + 1]] + dots[indices[triangle * 3 + 2]]) / 3;
  // With the whole model in front of the face, the face is wound the wrong way round.
  const reversed = planeDot - minOf(dots) <= planeTol && support - planeDot > planeTol;
  if (reversed) {
    n = negated(n);
    dots = vertexDots(mesh, n);
    support = maxOf(dots);
    planeDot = -planeDot;
  }
  const levels = findLevels(mesh, shape, dots, n, support, planeTol, reversed);
  return candidateAt(mesh, shape, dots, n, support, Math.max(0, support - planeDot), levels, planeTol, 'pick');
}

/** The same direction with the plane moved to another level: this is "Use upper level". */
export function candidateAtLevel(mesh: WeldedMesh, candidate: BaseCandidate, offset: number, options: BaseOptions): BaseCandidate {
  const shape = faces(mesh);
  const dots = vertexDots(mesh, candidate.normal);
  return candidateAt(mesh, shape, dots, candidate.normal, candidate.support, offset, candidate.levels, options.planeTol, candidate.source);
}

/** The largest level above the chosen plane, if any. Whether it matters is for classifyLevels. */
export function upperLevel(candidate: BaseCandidate, planeTol: number): PlaneLevel | null {
  let best: PlaneLevel | null = null;
  for (const level of candidate.levels) {
    if (level.offset > candidate.offset + planeTol && (!best || level.area > best.area)) best = level;
  }
  return best;
}
