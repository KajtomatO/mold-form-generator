import type { Manifold } from 'manifold-3d';
import type { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import type { Diagnostic } from '../report/diagnostics';
import type { Arena } from '../solid/arena';
import { BOUND_SLACK_MM, DEVIATION_CELL_MM, SurfaceIndex, type DeviationBound } from './deviation';
import { reversed, type ImportedSolid, type SolidReport } from './shells';
import type { WeldedMesh } from './weld';

/** meshoptimizer is WASM that needs an async start, so it is passed in, like Manifold. */
export type MeshSimplifier = Pick<typeof MeshoptSimplifier, 'simplify' | 'simplifySloppy' | 'getScale' | 'simplifyWithAttributes'>;

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

export function compacted(positions: Float32Array, indices: Uint32Array): WeldedMesh {
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
  return { solid, mesh, openLoops: [], report: known, joined: null, simplified: copy.diagnostics, errorMm: copy.errorMm };
}

/**
 * MM2: at most this many rounds of the lock loop. The 3 million triangle test block, whose ripple cannot keep to
 * 0.05 mm under about three quarters of a million triangles, needs 10 at 300,000.
 */
export const MAX_ROUNDS = 12;

/** MM2: a model's simplified copy, and how far its surface lies from the model's, proved. */
export interface ModelSimplified {
  /** Compacted, its vertices a subset of the model's, unmoved. */
  mesh: WeldedMesh;
  /**
   * How far the model's surface lies from the copy's at most, in mm: a bound over every point of it, proved
   * (SurfaceIndex.bound), within BOUND_SLACK_MM of the largest distance found. At most the bound asked for, unless
   * the loop could not reach it, and then the figure proved.
   */
  errorMm: number;
  /** 'error' when the copy kept more triangles than asked for, to keep within the bound. */
  stoppedBy: 'target' | 'error';
  rounds: number;
  /** meshoptimizer's own error figure for the last round, in mm, which is not a bound (for the record and tests). */
  reportedMm: number;
}

/**
 * MM2: the copy of a large model the mold is made from (R42, D24), held to `maxErrorMm` by proof, as
 * meshoptimizer's figure is not a bound: on the examples the surface moved 3 to 9 times what it reported. Each
 * round simplifies the model from scratch towards the count, with meshoptimizer's own limit at the bound, then
 * proves of each of the model's triangles that it lies within the bound of the copy everywhere
 * (SurfaceIndex.bound); the corners of every triangle it cannot are locked, which the next round keeps. The next
 * round's count is raised by a few triangles for each vertex newly locked, about what keeping it costs, so the
 * round need not take as much off elsewhere: two each, doubled after any round that did not halve the triangles
 * past the bound, as on the 3 million triangle test block the rounds then go on breaking it elsewhere. It ends when
 * every triangle is proved within the bound, or a round locks nothing new, or after MAX_ROUNDS; where the bound is
 * not kept, the figure proved, with a reach that grows until it holds. LockBorder keeps an open mesh's holes where
 * they are; Prune is not used, as it can delete a small body, which is a pour of its own. The same mesh, target
 * and bound give the same copy every time. `hold` is given the arrays each round holds, for the memory meter.
 */
export function simplifyModel(mesh: WeldedMesh, simplifier: MeshSimplifier, target: number, maxErrorMm: number, onRound: (round: number, step: 'simplify' | 'check') => void = () => {}, hold: (arrays: unknown[]) => void = () => {}): ModelSimplified {
  const P = mesh.positions, I = mesh.indices, V = P.length / 3, T = I.length / 3;
  const asked = Math.max(1, Math.min(target, T));
  let wanted = asked;
  const lock = new Uint8Array(V);
  // The bound's scratch, one distance per vertex of the model, made once.
  const at = new Float64Array(V);
  let result: WeldedMesh = mesh, reportedMm = 0, rounds = 0, perLock = 2, lastPast = Infinity;
  let proved: DeviationBound | null = null;
  while (rounds < MAX_ROUNDS) {
    rounds++;
    hold([lock, at, result]);
    onRound(rounds, 'simplify');
    const [indices, error] = simplifier.simplifyWithAttributes(I, P, 3, new Float32Array(0), 0, [], lock, wanted * 3, maxErrorMm, ['ErrorAbsolute', 'LockBorder']);
    reportedMm = error;
    result = compacted(P, indices);
    const index = new SurfaceIndex(result, maxErrorMm);
    hold([lock, at, result, index.held()]);
    onRound(rounds, 'check');
    proved = index.bound(mesh, maxErrorMm, BOUND_SLACK_MM, at);
    hold([lock, at, result, index.held(), proved.past]);
    const past = proved.past.length;
    if (past === 0) break;
    let locked = 0;
    for (const t of proved.past) {
      for (let c = 0; c < 3; c++) {
        const v = I[t * 3 + c];
        if (lock[v]) continue;
        lock[v] = 1;
        locked++;
      }
    }
    if (locked === 0) break;
    if (past > lastPast / 2) perLock *= 2;
    lastPast = past;
    wanted = Math.min(T, Math.max(wanted, result.indices.length / 3 + perLock * locked));
  }
  let errorMm = proved!.bound;
  if (proved!.past.length > 0) {
    // The bound is not kept: the figure proved, with a reach that grows until no point is beyond it.
    for (let reach = 2 * maxErrorMm; ; reach *= 2) {
      const index = new SurfaceIndex(result, reach, Math.max(DEVIATION_CELL_MM, reach));
      hold([lock, at, result, index.held()]);
      const measured = index.bound(mesh, null, BOUND_SLACK_MM, at);
      if (!measured.beyond) {
        errorMm = measured.bound;
        break;
      }
    }
  }
  const triangles = result.indices.length / 3;
  return { mesh: result, errorMm, stoppedBy: triangles > asked ? 'error' : 'target', rounds, reportedMm };
}
