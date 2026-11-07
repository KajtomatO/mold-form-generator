import type { Manifold, ManifoldToplevel, Mesh } from 'manifold-3d';
import { assertRigid, orientSolid, type OrientedModel, type RigidTransform } from '../base/orient';
import { weld } from '../mesh/weld';
import { writeBinaryStl } from '../stl/write';
import { withArena } from '../solid/arena';
import type { Rim } from './rim';

/**
 * G9: flat top on the bed, by a half turn about x: (x, -y, Zt - z). A plain z -> Zt - z would export a
 * mirrored cavity that passes every other check, and assertRigid refuses that here.
 */
export function coverPose(rim: Pick<Rim, 'Zt'>): RigidTransform {
  const pose: RigidTransform = { rotation: [1, 0, 0, 0, -1, 0, 0, 0, -1], translation: [0, 0, rim.Zt] };
  assertRigid(pose);
  return pose;
}

/** G10: flat underside on the bed. */
export function basePose(rim: Pick<Rim, 'Tb'>): RigidTransform {
  return { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, rim.Tb] };
}

/** Back from a print pose to the assembled position. */
export function inversePose(pose: RigidTransform): RigidTransform {
  assertRigid(pose);
  const [a, b, c, d, e, f, g, h, i] = pose.rotation;
  const [x, y, z] = pose.translation;
  return {
    rotation: [a, d, g, b, e, h, c, f, i],
    translation: [-(a * x + d * y + g * z), -(b * x + e * y + h * z), -(c * x + f * y + i * z)],
  };
}

const step = new Float32Array(1);
const stepBits = new Uint32Array(step.buffer);

/** One float32 step further from 0. */
function nextFloat(value: number): number {
  step[0] = value;
  stepBits[0] += 1;
  return step[0];
}

/** A chain of corners within a float step of each other takes one pass per link, and this is plenty. */
const SEPARATE_PASSES = 8;

/**
 * An STL holds only positions, so a reader welds any two corners that round to one float32 point. On a
 * short edge that is harmless, as the edge just collapses. But where two walls of the solid pass within
 * a float step of each other, as the lobes of a pocket or a model's underside on the plate can, their
 * edges become one edge with 4 faces, which a strict slicer calls non-manifold. This moves the corners
 * of just those edges a float step apart, so the file reads back with the solid's own topology.
 */
export function separateWeldedEdges(mesh: Pick<Mesh, 'vertProperties' | 'triVerts' | 'mergeFromVert' | 'mergeToVert'>): Float32Array {
  const positions = mesh.vertProperties.slice();
  const { triVerts } = mesh;
  // The mesh repeats a vertex along a seam, and those copies must stay together.
  const root = Uint32Array.from({ length: positions.length / 3 }, (_, v) => v);
  mesh.mergeFromVert?.forEach((from, k) => (root[from] = mesh.mergeToVert![k]));

  for (let pass = 0; pass < SEPARATE_PASSES; pass++) {
    const { indices: at, positions: unique } = weld(positions);
    const count = unique.length / 3;
    const uses = new Map<number, number>();
    const use = (a: number, b: number): void => {
      const key = Math.min(a, b) * count + Math.max(a, b);
      uses.set(key, (uses.get(key) ?? 0) + 1);
    };
    for (let t = 0; t < triVerts.length; t += 3) {
      const a = at[triVerts[t]], b = at[triVerts[t + 1]], c = at[triVerts[t + 2]];
      // A reader drops a triangle with two corners on one point, so it uses no edge.
      if (a === b || b === c || c === a) continue;
      use(a, b);
      use(b, c);
      use(c, a);
    }
    const crowded = new Set<number>();
    for (const [key, used] of uses) {
      if (used <= 2) continue;
      crowded.add(Math.floor(key / count));
      crowded.add(key % count);
    }

    const kept = new Map<number, number>();
    let moved = false;
    for (let v = 0; v < at.length; v++) {
      if (!crowded.has(at[v])) continue;
      const first = kept.get(at[v]);
      if (first === undefined) {
        kept.set(at[v], root[v]);
      } else if (first !== root[v]) {
        positions[v * 3] = nextFloat(positions[v * 3]);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return positions;
}

/** A part in its print pose, as the bytes of a binary STL. The posed copy of the solid is freed at once. */
export function poseToStl(api: ManifoldToplevel, solid: Manifold, pose: RigidTransform): Uint8Array {
  const mesh = withArena(api, (arena) => orientSolid(arena, solid, pose).getMesh());
  if (mesh.numProp !== 3) throw new Error(`Expected positions only in a part, got ${mesh.numProp} properties per vertex.`);
  return writeBinaryStl(separateWeldedEdges(mesh), mesh.triVerts);
}

/**
 * G10: the model for Mode A. It stays on the file's own triangles, as nothing here may simplify it,
 * unless the plane cuts through it. Then the only thing to print is the trimmed solid.
 */
export function modelOrientedStl(oriented: OrientedModel, trimmed: Manifold | null): Uint8Array {
  if (!oriented.needsTrim) return writeBinaryStl(oriented.mesh.positions, oriented.mesh.indices);
  if (!trimmed) throw new Error('An open mesh with geometry below the plane cannot be trimmed.');
  const mesh = trimmed.getMesh();
  return writeBinaryStl(separateWeldedEdges(mesh), mesh.triVerts);
}
