import type { Manifold } from 'manifold-3d';
import type { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import type { Diagnostic } from '../report/diagnostics';
import type { Arena } from '../solid/arena';
import { reversed, type ImportedSolid, type SolidReport } from './shells';
import type { WeldedMesh } from './weld';

/** meshoptimizer is WASM that needs an async start, so it is passed in, like Manifold. */
export type MeshSimplifier = Pick<typeof MeshoptSimplifier, 'simplify' | 'simplifySloppy' | 'getScale'>;

/** Above this the Manifold path uses a simplified copy, and the base warns with the error. */
export const MANIFOLD_TRIANGLE_LIMIT = 2_000_000;
/**
 * How many triangles that copy has. Half the limit, as the merged base's union of a 2 million triangle
 * copy took the worker's heap to 2.1 GB, measured on 3 million triangles, and a 1 million one to 1.4 GB.
 */
export const MANIFOLD_TRIANGLE_TARGET = 1_000_000;
/** Above this the viewport draws a sloppy proxy. */
export const DISPLAY_TRIANGLE_LIMIT = 300_000;

/**
 * G1.8's limit and the size of its copy. Passed down to the workers, so a test can reach the heavy path
 * with a few thousand triangles where a real model needs millions.
 */
export interface HeavyLimits {
  limit: number;
  target: number;
}

export const HEAVY_LIMITS: HeavyLimits = { limit: MANIFOLD_TRIANGLE_LIMIT, target: MANIFOLD_TRIANGLE_TARGET };

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
export function simplifyForManifold(mesh: WeldedMesh, simplifier: MeshSimplifier, limit = MANIFOLD_TRIANGLE_LIMIT, target = limit): SimplifiedMesh | null {
  if (mesh.indices.length / 3 <= limit) return null;
  const [indices, error] = simplifier.simplify(mesh.indices, mesh.positions, 3, target * 3, MAX_RELATIVE_ERROR);
  const errorMm = error * simplifier.getScale(mesh.positions, 3);
  const diagnostics: Diagnostic[] = [
    {
      code: 'mode-b-simplified',
      severity: 'warning',
      // meshoptimizer works in float32 on the model scaled to 1, so an error far under a micron on a smooth
      // surface reads as exactly 0: that is said as it is, not as a figure of 0 mm.
      message: `This model has ${(mesh.indices.length / 3).toLocaleString('en-US')} triangles, too many for the geometry engine, so merged mode, and the pocket in glue mode, use a copy simplified to ${(indices.length / 3).toLocaleString('en-US')} triangles, ${errorMm > 0 ? `with up to ${errorMm >= 0.001 ? errorMm.toFixed(3) : errorMm.toPrecision(2)} mm of error` : 'with less error than the simplifier can measure'}. The cover and model_oriented.stl come from the whole mesh.`,
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

export interface ManifoldPath {
  solid: Manifold | null;
  /** The solid is the simplified copy, not the import's own. */
  heavy: boolean;
  diagnostics: Diagnostic[];
  /** How far the copy may lie from the whole mesh, in mm; 0 for the import's own solid. */
  errorMm: number;
}

/**
 * G1.8: the solid every Manifold operation after the import uses. Above MANIFOLD_TRIANGLE_LIMIT it is a copy
 * simplified to MANIFOLD_TRIANGLE_TARGET triangles, made from the mesh, with its error said in a warning:
 * the import has checked the whole mesh by then, and the cover and model_oriented.stl never need a solid.
 * Below the limit, and in soup mode, it is the import's own solid. The copy is owned by `arena`.
 */
export function manifoldPathSolid(arena: Arena, imported: Pick<ImportedSolid, 'solid' | 'mesh'>, simplifier: MeshSimplifier | null, limit = MANIFOLD_TRIANGLE_LIMIT, target = Math.min(limit, MANIFOLD_TRIANGLE_TARGET)): ManifoldPath {
  if (!imported.solid || !simplifier) return { solid: imported.solid, heavy: false, diagnostics: [], errorMm: 0 };
  const simplified = simplifyForManifold(imported.mesh, simplifier, limit, target);
  if (!simplified) return { solid: imported.solid, heavy: false, diagnostics: [], errorMm: 0 };
  try {
    const solid = arena.manifold(new arena.api.Mesh({ numProp: 3, vertProperties: simplified.mesh.positions, triVerts: simplified.mesh.indices }));
    return { solid, heavy: true, diagnostics: simplified.diagnostics, errorMm: simplified.errorMm };
  } catch (error) {
    // A simplified copy can fold onto itself. The whole mesh is slower and heavier, never wrong.
    if (!(error instanceof Error && error.name === 'ManifoldError')) throw error;
    return { solid: imported.solid, heavy: false, diagnostics: [{ code: 'mode-b-unsimplified', severity: 'warning', message: `This model is too heavy for the geometry engine, and its simplified copy is not a closed solid, so the base uses the whole mesh, which may run out of memory.` }], errorMm: 0 };
  }
}

/**
 * M11: a mesh past the limit that an import has already checked whole, as the preview's did, imported again
 * from its simplified copy alone. The copy is all the Manifold path uses past the limit, and the whole
 * solid of 3 million triangles takes a fresh worker's heap to 1.3 GB, which with everything else the page
 * holds passed 3 GB. Null where the copy cannot stand in: under the limit, an open mesh, a mesh the import
 * recomposed, or a copy that is no closed solid; the caller then imports in full.
 */
export function importFromCopy(arena: Arena, welded: WeldedMesh, known: SolidReport, simplifier: MeshSimplifier, limit = MANIFOLD_TRIANGLE_LIMIT, target = Math.min(limit, MANIFOLD_TRIANGLE_TARGET)): (ImportedSolid & { simplified: Diagnostic[]; errorMm: number }) | null {
  if (welded.indices.length / 3 <= limit || known.route === 'soup' || known.diagnostics.some((d) => d.code === 'shell-inverted')) return null;
  const mesh = known.flipped ? { positions: welded.positions, indices: reversed(welded.indices) } : welded;
  const copy = simplifyForManifold(mesh, simplifier, limit, target)!;
  let solid: Manifold;
  try {
    solid = arena.manifold(new arena.api.Mesh({ numProp: 3, vertProperties: copy.mesh.positions, triVerts: copy.mesh.indices }));
  } catch (error) {
    if (error instanceof Error && error.name === 'ManifoldError') return null;
    throw error;
  }
  if (!(solid.volume() > 0)) return null;
  return { solid, mesh, openLoops: [], report: known, simplified: copy.diagnostics, errorMm: copy.errorMm };
}
