import type { Bounds, WeldedMesh } from '../mesh/weld';
import { NEAR_SUPPORT_RANGE, type BaseCandidate, type Vec3 } from './candidates';

/**
 * The base plane as a project file keeps it, beside the choice that found it: a ranked candidate or a
 * picked triangle depends on how one version ranks faces and welds the mesh, and the plane does not.
 * In the STL's own coordinates: `normal` points out of the model towards the base, the model stands
 * where dot(normal, p) = offset, and `upper` is the level choice's offset into the model, or false.
 */
export interface StoredPlane {
  normal: Vec3;
  offset: number;
  upper: number | false;
}

/** A plane by its outward normal and its offset along it. */
export interface Plane {
  normal: Vec3;
  offset: number;
}

/**
 * Saved and found planes this close everywhere over the model's box are one plane. The plane tolerance
 * is 0.05 mm at least, so this is well inside what the app counts as standing on a face.
 */
export const PLANE_MATCH_MM = 0.02;

/** How far a best guess may sit from the stored plane: the reach of the plane tolerance slider, as for levels. */
export const GUESS_RANGE_MM = NEAR_SUPPORT_RANGE;

/** Normals within one histogram bin face the same way, so a plane past this is no guess for another. */
const SAME_WAY_COS = Math.cos((1.5 * Math.PI) / 180);

export type PlaneSource = Pick<BaseCandidate, 'normal' | 'support' | 'offset' | 'levels'>;

/** The plane a candidate stands the model on, as S2 has chosen it, upper level and all. */
export function planeOf(candidate: Pick<BaseCandidate, 'normal' | 'support' | 'offset'>): Plane {
  const [x, y, z] = candidate.normal;
  return { normal: [x, y, z], offset: candidate.support - candidate.offset };
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * How far apart two planes come anywhere in the model's box, in mm, or Infinity if they do not face
 * the same way. The difference of the two signed distances is linear, so its largest size is at a corner.
 */
export function planeGap(a: Plane, b: Plane, bounds: Bounds): number {
  if (dot(a.normal, b.normal) < SAME_WAY_COS) return Infinity;
  let worst = 0;
  for (let k = 0; k < 8; k++) {
    const corner = [k & 1 ? bounds.max[0] : bounds.min[0], k & 2 ? bounds.max[1] : bounds.min[1], k & 4 ? bounds.max[2] : bounds.min[2]];
    worst = Math.max(worst, Math.abs(dot(a.normal, corner) - a.offset - (dot(b.normal, corner) - b.offset)));
  }
  return worst;
}

/**
 * The ranked candidate, on its own plane or on one of its upper levels, nearest the stored plane, with
 * how far off it is. Null when none faces the same way. The caller decides whether that is near enough.
 */
export function nearestCandidate(stored: Plane, candidates: readonly PlaneSource[], planeTol: number, bounds: Bounds): { rank: number; upper: number | false; gap: number } | null {
  let best: { rank: number; upper: number | false; gap: number } | null = null;
  for (let rank = 0; rank < candidates.length; rank++) {
    const candidate = candidates[rank];
    const options: { upper: number | false; plane: Plane }[] = [{ upper: false, plane: planeOf(candidate) }];
    // A level counts only above the candidate's own plane, as levelNear has it.
    for (const level of candidate.levels) {
      if (level.offset > candidate.offset + planeTol) options.push({ upper: level.offset, plane: { normal: candidate.normal, offset: candidate.support - level.offset } });
    }
    for (const option of options) {
      const gap = planeGap(option.plane, stored, bounds);
      if (gap < (best?.gap ?? Infinity)) best = { rank, upper: option.upper, gap };
    }
  }
  return best;
}

/**
 * The largest triangle lying on the stored plane, every corner within `tol` of it, and facing out of
 * the model along its normal, as a face the model stands on does: what a pick of that face would click.
 */
export function triangleOnPlane(mesh: WeldedMesh, stored: Plane, tol: number): number | null {
  const { positions: p, indices } = mesh;
  const [nx, ny, nz] = stored.normal;
  let best: number | null = null, bestArea = 0;
  for (let t = 0; t < indices.length / 3; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    let on = true;
    for (const v of [a, b, c]) if (Math.abs(nx * p[v] + ny * p[v + 1] + nz * p[v + 2] - stored.offset) > tol) on = false;
    if (!on) continue;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const twice = Math.hypot(cx, cy, cz);
    if (twice === 0 || (cx * nx + cy * ny + cz * nz) / twice < SAME_WAY_COS) continue;
    if (twice > bestArea) {
      bestArea = twice;
      best = t;
    }
  }
  return best;
}

/** A choice of base plane as S2 takes it: a ranked candidate, on one of its levels or not, or a picked triangle. */
export type FoundChoice = { rank: number; upper: number | false } | { pick: number; upper: false };

/**
 * Where this version finds a stored plane, in the order a later version that ranks or welds differently
 * needs: the ranked candidate or level that is that plane; else the largest triangle on it facing out
 * along it, as a pick of that face; else the nearest candidate facing within SAME_WAY_COS and within
 * GUESS_RANGE_MM, which is a guess (`exact` false). Null when there is nothing to go on.
 */
export function findStoredPlane(stored: Plane, candidates: readonly PlaneSource[], mesh: WeldedMesh, planeTol: number, bounds: Bounds): { choice: FoundChoice; exact: boolean } | null {
  const nearest = nearestCandidate(stored, candidates, planeTol, bounds);
  if (nearest && nearest.gap <= PLANE_MATCH_MM) return { choice: { rank: nearest.rank, upper: nearest.upper }, exact: true };
  const triangle = triangleOnPlane(mesh, stored, planeTol);
  if (triangle !== null) return { choice: { pick: triangle, upper: false }, exact: true };
  if (nearest && nearest.gap <= GUESS_RANGE_MM) return { choice: { rank: nearest.rank, upper: nearest.upper }, exact: false };
  return null;
}
