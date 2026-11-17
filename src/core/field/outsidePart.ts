import { transformPositions, type RigidTransform } from '../base/orient';
import { clipBelow } from '../mesh/clip';
import { meshBounds, type Bounds, type WeldedMesh } from '../mesh/weld';

/**
 * RM, decision D: the parts of the maker's file a rebuilt copy left out (O_far), which a glue-mode mold must hold
 * too, as the maker prints the file itself. The field, the box and the export's measure take them as the model
 * stands: turned by the plan's transform and cut at the base plane, as model_oriented.stl cuts the file there, so
 * nothing of them below the plane widens the box. Pure, for both workers and main.
 */

/** O_far as the model stands, cut at z = 0 triangle by triangle (clipBelow), or null where none of it is left above. */
export function orientedOutside(far: WeldedMesh, transform: RigidTransform): WeldedMesh | null {
  const clipped = clipBelow({ positions: transformPositions(far.positions, transform), indices: far.indices });
  return clipped.indices.length > 0 ? clipped : null;
}

/** The model's mesh with the left-out parts appended, as one mesh for the raster and the box. */
export function withOutside(mesh: WeldedMesh, outside: WeldedMesh | null): WeldedMesh {
  if (!outside) return mesh;
  const V = mesh.positions.length / 3;
  const positions = new Float32Array(mesh.positions.length + outside.positions.length);
  positions.set(mesh.positions);
  positions.set(outside.positions, mesh.positions.length);
  const indices = new Uint32Array(mesh.indices.length + outside.indices.length);
  indices.set(mesh.indices);
  for (let k = 0; k < outside.indices.length; k++) indices[mesh.indices.length + k] = outside.indices[k] + V;
  return { positions, indices };
}

/** The box round both. */
export function unionBounds(a: Bounds, b: Bounds | null): Bounds {
  if (!b) return a;
  return { min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])], max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])] };
}

/** The bounds of the left-out parts as the model stands, or null. */
export const outsideBounds = (outside: WeldedMesh | null): Bounds | null => (outside ? meshBounds(outside.positions) : null);
