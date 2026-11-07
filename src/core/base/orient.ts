import type { Mat4, Manifold } from 'manifold-3d';
import { MISSING_SURFACE_MM2, type OpenLoop } from '../mesh/audit';
import type { WeldedMesh } from '../mesh/weld';
import type { Diagnostic } from '../report/diagnostics';
import type { Arena } from '../solid/arena';
import type { BaseCandidate, Vec3 } from './candidates';

/** Rotation (row-major 3x3) then translation. The only kind of transform this app applies. */
export interface RigidTransform {
  rotation: readonly [number, number, number, number, number, number, number, number, number];
  translation: Vec3;
}

export function determinant(t: RigidTransform): number {
  const [a, b, c, d, e, f, g, h, i] = t.rotation;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

/**
 * Refuses reflections. A mirrored model passes every other check and only fails on the printer,
 * so every transform in the pipeline comes through here.
 */
export function assertRigid(t: RigidTransform): void {
  const [a, b, c, d, e, f, g, h, i] = t.rotation;
  const off = 1e-9;
  const orthonormal =
    Math.abs(a * a + b * b + c * c - 1) < off &&
    Math.abs(d * d + e * e + f * f - 1) < off &&
    Math.abs(g * g + h * h + i * i - 1) < off &&
    Math.abs(a * d + b * e + c * f) < off &&
    Math.abs(a * g + b * h + c * i) < off &&
    Math.abs(d * g + e * h + f * i) < off;
  if (!orthonormal || Math.abs(determinant(t) - 1) >= off) {
    throw new Error(`Refusing a transform that is not a pure rotation (determinant ${determinant(t)}).`);
  }
}

/** Rotation taking the unit normal to -z, the shortest way round. */
function rotationToMinusZ(n: Vec3): RigidTransform['rotation'] {
  const [x, y, z] = n;
  // Exact cases first: the general formula divides by 1 + cos, and axis-aligned models should
  // not pick up any rounding at all.
  if (x === 0 && y === 0 && z === -1) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (x === 0 && y === 0 && z === 1) return [1, 0, 0, 0, -1, 0, 0, 0, -1];
  // Rodrigues with axis n x (0,0,-1) = (-y, x, 0) and cos = -z, so the factor is 1 / (1 - z).
  // Near +z that subtraction loses all its digits, so use the equal form that does not subtract.
  const k = z > 0 ? (1 + z) / (x * x + y * y) : 1 / (1 - z);
  return [
    1 - x * x * k, -x * y * k, x,
    -x * y * k, 1 - y * y * k, y,
    -x, -y, -z,
  ];
}

/** Puts the plane dot(normal, p) = planeDot at z = 0 with the model above it. */
export function planeTransform(normal: Vec3, planeDot: number): RigidTransform {
  const transform: RigidTransform = { rotation: rotationToMinusZ(normal), translation: [0, 0, planeDot] };
  assertRigid(transform);
  return transform;
}

export function transformPositions(positions: Float32Array, t: RigidTransform): Float32Array {
  assertRigid(t);
  const [a, b, c, d, e, f, g, h, i] = t.rotation;
  const [tx, ty, tz] = t.translation;
  const out = new Float32Array(positions.length);
  for (let p = 0; p < positions.length; p += 3) {
    const x = positions[p], y = positions[p + 1], z = positions[p + 2];
    out[p] = a * x + b * y + c * z + tx;
    out[p + 1] = d * x + e * y + f * z + ty;
    out[p + 2] = g * x + h * y + i * z + tz;
  }
  return out;
}

/** Column-major, as Manifold wants it. */
export function toMat4(t: RigidTransform): Mat4 {
  const [a, b, c, d, e, f, g, h, i] = t.rotation;
  const [x, y, z] = t.translation;
  return [a, d, g, 0, b, e, h, 0, c, f, i, 0, x, y, z, 1];
}

export interface BelowPlane {
  /** Vertices below the plane by more than the tolerance. */
  vertexCount: number;
  /** How far the lowest one is below the plane, in mm. */
  depth: number;
}

export interface OrientedModel {
  /** Same vertex order and indices as the input, so candidate.members stay valid. */
  mesh: WeldedMesh;
  transform: RigidTransform;
  below: BelowPlane;
  /** Mode B and model_oriented.stl must trimByPlane, because model lies below the plane. */
  needsTrim: boolean;
  /** In soup mode there is no solid to trim, so a plane with model below it cannot be used. */
  usable: boolean;
  diagnostics: Diagnostic[];
}

/** With less than this share of a face on the plane, the face is rougher than the tolerance band. */
const ROUGH_SHARE = 0.75;

/**
 * G2, step 7: move the model onto the chosen plane and say what that plane implies. The levels of
 * step 6 need the footprint, so classifyLevels reports those. `openLoops` is only there in soup
 * mode, where "up" is first known here and a hole facing up leaves the cavity too low.
 */
export function orientToBase(mesh: WeldedMesh, candidate: BaseCandidate, options: { planeTol: number; soup: boolean; openLoops?: readonly OpenLoop[] }): OrientedModel {
  const { planeTol, soup, openLoops = [] } = options;
  const transform = planeTransform(candidate.normal, candidate.support - candidate.offset);
  const positions = transformPositions(mesh.positions, transform);

  let vertexCount = 0, depth = 0;
  for (let p = 2; p < positions.length; p += 3) {
    if (positions[p] < -planeTol) vertexCount++;
    if (-positions[p] > depth) depth = -positions[p];
  }
  const needsTrim = vertexCount > 0;
  const diagnostics: Diagnostic[] = [];
  if (needsTrim && soup) {
    diagnostics.push({
      code: 'below-plane-soup',
      severity: 'error',
      message: `${vertexCount} vertices lie up to ${depth.toFixed(2)} mm below this plane, and an open mesh cannot be trimmed, so please choose another plane.`,
    });
  } else if (needsTrim) {
    diagnostics.push({
      code: 'below-plane',
      severity: 'warning',
      message: `${vertexCount} vertices lie up to ${depth.toFixed(2)} mm below this plane and will be trimmed off the printed model.`,
    });
  }
  if (candidate.area < ROUGH_SHARE * candidate.faceArea) {
    diagnostics.push({
      code: 'plane-rough',
      severity: 'warning',
      message: `Only ${candidate.area.toFixed(0)} of this face's ${candidate.faceArea.toFixed(0)} mm2 lies within the ${planeTol.toFixed(2)} mm plane tolerance, so the surface looks rough; raise the tolerance to seat more of it.`,
    });
  }
  if (candidate.holes.length > 0) {
    const area = candidate.holes.reduce((sum, hole) => sum + hole.area, 0);
    diagnostics.push({
      code: 'base-from-hole',
      severity: 'info',
      message: `This plane closes ${candidate.holes.length} holes totalling ${area.toFixed(1)} mm2, so the file has no face there and the rim stands in for it.`,
    });
  }
  // The rims of a recess in a missing base face up, but the base plate closes those.
  const [, , , , , , g, h, i] = transform.rotation;
  const upward = openLoops.filter((loop) => !candidate.holes.includes(loop)).reduce((sum, { area, capNormal: [x, y, z] }) => sum + area * Math.max(0, g * x + h * y + i * z), 0);
  if (upward >= MISSING_SURFACE_MM2) {
    diagnostics.push({
      code: 'missing-top-surface',
      severity: 'warning',
      message: `On this plane ${upward.toFixed(1)} mm2 of holes face upward, and the cavity will be too low where a top surface is missing.`,
    });
  }
  return { mesh: { positions, indices: mesh.indices }, transform, below: { vertexCount, depth }, needsTrim, usable: !(needsTrim && soup), diagnostics };
}

export function orientSolid(arena: Arena, solid: Manifold, transform: RigidTransform): Manifold {
  assertRigid(transform);
  return arena.track(solid.transform(toMat4(transform)));
}

/** Removes everything below the base plane of an oriented solid. */
export function trimToBase(arena: Arena, oriented: Manifold): Manifold {
  return arena.track(oriented.trimByPlane([0, 0, 1], 0));
}
