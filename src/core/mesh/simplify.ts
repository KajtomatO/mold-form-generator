import type { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import type { Diagnostic } from '../report/diagnostics';
import type { WeldedMesh } from './weld';

/** meshoptimizer is WASM that needs an async start, so it is passed in, like Manifold. */
export type MeshSimplifier = Pick<typeof MeshoptSimplifier, 'simplify' | 'simplifySloppy' | 'getScale'>;

/** Above this the Manifold path uses a simplified copy, and Mode B warns with the error. */
export const MANIFOLD_TRIANGLE_LIMIT = 2_000_000;
/** Above this the viewport draws a sloppy proxy. */
export const DISPLAY_TRIANGLE_LIMIT = 300_000;

// Fraction of the model size. The target count is what matters here; this only stops a
// pathological mesh from collapsing further to reach it.
const MAX_RELATIVE_ERROR = 0.02;

export interface SimplifiedMesh {
  mesh: WeldedMesh;
  /** Geometric error reported by meshoptimizer, in mm. */
  errorMm: number;
  /** The warning G1.8 asks for, to be shown in Mode B. */
  diagnostics: Diagnostic[];
}

function compacted(positions: Float32Array, indices: Uint32Array): WeldedMesh {
  const remap = new Int32Array(positions.length / 3).fill(-1);
  const out = new Float32Array(positions.length);
  const outIndices = new Uint32Array(indices.length);
  let count = 0;
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    if (remap[v] < 0) {
      remap[v] = count;
      out[count * 3] = positions[v * 3];
      out[count * 3 + 1] = positions[v * 3 + 1];
      out[count * 3 + 2] = positions[v * 3 + 2];
      count++;
    }
    outIndices[i] = remap[v];
  }
  return { positions: out.slice(0, count * 3), indices: outIndices };
}

/**
 * Topology-preserving simplification for the Manifold path only. Run this after importSolid, so
 * shells are classified from the real mesh, and never for model_oriented.stl, which always comes
 * from the original soup. Returns null when the mesh is already within the limit.
 */
export function simplifyForManifold(mesh: WeldedMesh, simplifier: MeshSimplifier, limit = MANIFOLD_TRIANGLE_LIMIT): SimplifiedMesh | null {
  if (mesh.indices.length / 3 <= limit) return null;
  const [indices, error] = simplifier.simplify(mesh.indices, mesh.positions, 3, limit * 3, MAX_RELATIVE_ERROR);
  const errorMm = error * simplifier.getScale(mesh.positions, 3);
  const diagnostics: Diagnostic[] = [
    {
      code: 'mode-b-simplified',
      severity: 'warning',
      message: `This model is too heavy for merged mode as it is, so merged mode uses a copy simplified with up to ${errorMm.toFixed(3)} mm of error.`,
    },
  ];
  return { mesh: compacted(mesh.positions, indices), errorMm, diagnostics };
}

/** Fast, topology-breaking copy for the viewport only. Returns null within the limit. */
export function displayProxy(mesh: WeldedMesh, simplifier: MeshSimplifier, limit = DISPLAY_TRIANGLE_LIMIT): WeldedMesh | null {
  if (mesh.indices.length / 3 <= limit) return null;
  const [indices] = simplifier.simplifySloppy(mesh.indices, mesh.positions, 3, null, limit * 3, 1);
  return compacted(mesh.positions, indices);
}
