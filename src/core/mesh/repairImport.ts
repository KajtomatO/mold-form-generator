import type { ManifoldToplevel } from 'manifold-3d';
import { withArena } from '../solid/arena';
import { auditEdges, type MeshAudit } from './audit';
import { rebuildSurface, type InsideRule, type RebuildStats } from './columns';
import { DEVIATION_CELL_MM } from './deviation';
import { windingFolds } from './folds';
import { compareToRepaired, farFigures, provedDistance, runsOf, splitLong, subMesh, SPLIT_CELLS } from './outside';
import { reduceRebuilt, REDUCE_ROUNDS, type Reduced } from './reduce';
import { autoRepairCell, cellFacts, fillable, fillHoles, orientPieces, RepairError, repairCellLimit, repairCellProblem, REPAIRED_TRIANGLE_LIMIT, type Filled } from './repair';
import { importSolid, reversed, signedVolumeAbout } from './shells';
import { MANIFOLD_TRIANGLE_LIMIT, type MeshSimplifier } from './simplify';
import { meshBounds, weld, type WeldedMesh } from './weld';

/**
 * RM: the mesh repair the prepare job runs on the maker's file, welded (R43, D26). A mesh that is not a closed solid
 * (holes, edges more than two faces share, faces turned the wrong way, or a surface that folds through itself)
 * becomes one the app can use everywhere. First the orientation fix (repair.ts). Then rung A, where every hole is a
 * simple loop and no edge is shared by more than two faces: each hole closed by its least-area cap, every triangle
 * of the file kept. Otherwise, or where the fill does not give a closed solid that does not fold, rung B: the
 * surface rebuilt on a grid by the columns' vote and marching tetrahedra (columns.ts, marching.ts), reduced by
 * meshoptimizer and put right (reduce.ts). Each result is checked as the app will load it, and for a rebuild the
 * file is measured against it for the silicone's guarantee (outside.ts). Pure TS but for Manifold's check.
 */

export type RepairStep = 'orient' | 'fill' | 'rebuild' | 'reduce' | 'check' | 'compare';

/** The figures a repair gives, which the app's record of a repaired model (RepairRecord) carries with its own. */
export interface RepairFigures {
  method: 'filled' | 'rebuilt';
  /** The rebuild's grid in mm, null for a fill; `cellAsked` null where it was auto. */
  cell: number | null;
  cellAsked: number | null;
  /** The file's open loops, closed (a fill) or closed over (a rebuild), and their flat caps' area in mm2. */
  holes: number;
  holeArea: number;
  /** Triangles the orientation fix turned (a fill), 0 for a rebuild. */
  turned: number;
  /** The repaired copy's triangles. */
  triangles: number;
  /**
   * e_near: how far the file's surface lies from the copy's at most, proved, over the file but its parts inside the
   * copy and those in `outside`, in mm; 0 for a fill, whose copy holds every triangle of the file.
   */
  nearMm: number;
  /** O_far: the file's triangles farther than the cell from the copy and not inside it, null if none. */
  outside: {
    /** By index into the file's triangles as the app welds them, as [first, count]. */
    runs: [number, number][];
    triangles: number;
    area: number;
    /** How far they lie from the copy at most, proved, and the farthest vertex, in file coordinates. */
    farthestMm: number;
    at: [number, number, number];
  } | null;
  /**
   * How far the copy's surface lies from the file's at most, proved: a fill's caps from the faces round its holes, a
   * rebuild's whole surface from the file. Null where the file is too large to index for it (ADDED_INDEX_LIMIT).
   */
  addedMm: number | null;
  addedAt: [number, number, number] | null;
  /** The copy's volume in mm3, less what its parts share, as Manifold measures it (past `manifoldLimit`, by its faces). */
  volume: number;
}

export interface Repaired {
  /** The copy, as loading its binary STL gives it back (welded, collapsed triangles dropped). */
  mesh: WeldedMesh;
  figures: RepairFigures;
  /** O_far as a mesh of its own, in file coordinates, null if none. */
  outside: WeldedMesh | null;
  /** Where to mark the repair, in file coordinates: each closed hole's rim middle, or the far part's farthest point and then each other far piece's farthest vertex, farthest first; at most 20. */
  marks: [number, number, number][];
  /** For the record and the tests: the rebuild's lattice and vote, the reduction's rounds, the comparison's pieces. */
  stats: { rebuild: RebuildStats | null; reduce: Omit<Reduced, 'mesh'> | null; extracted: number; suspect: number; pieces: number; insideProved: number; leftover: number; checkedBy: 'manifold' | 'edges' };
  timings: Record<string, number>;
}

export interface RepairOptions {
  /** The file's name, which the errors' sentences start with. */
  name: string;
  /** The rebuild's grid in mm, null for auto (autoRepairCell). */
  cell: number | null;
  /** The most triangles a rebuilt copy keeps: Q4's 1,000,000, or fewer, such as a simplified copy's count. */
  maxTriangles?: number;
  /** Past this many triangles a filled copy is checked by its edges, folds and volume, not by building a Manifold. */
  manifoldLimit?: number;
  /** Test-only: the vote's rule, to show 'parity' losing overlaps. */
  rule?: InsideRule;
  /** Test-only, and for measuring: 'rebuild' takes rung B whatever the mesh, a closed one too. */
  rung?: 'auto' | 'rebuild';
  now?: () => number;
  progress?: (step: RepairStep, done: number, total: number) => void;
  /**
   * Given what the repair holds as it changes, for the memory meter: its arrays (the file's mesh is the caller's to
   * count), and meshoptimizer's heap in bytes, which it keeps and does not expose, estimated.
   */
  hold?: (arrays: unknown[], meshoptBytes: number) => void;
}

/**
 * meshoptimizer's heap per triangle it simplifies, which grows and never shrinks: the spike measured 119.5 B per
 * extracted triangle (330.6 MB for 2.77 million) by catching its WebAssembly memory, and RM's own measurement
 * agrees (docs/PLAN.md, RM).
 */
export const MESHOPT_BYTES_PER_TRIANGLE = 120;
/** The reduction's error, as a fraction of the cell: h / 4 let jersey's surface move past the bar, h / 8 did not (the spike). */
const REDUCE_ERROR = 1 / 8;
/** The reduction locks extracted vertices this many cells round a bad triangle. */
const LOCK_CELLS = 2;
/** The largest file whose whole surface is indexed for a rebuild's `addedMm`; past it the figure is not worked out. */
export const ADDED_INDEX_LIMIT = 1_000_000;

/**
 * A mesh as its binary STL loads again: corners collapsed onto each other dropped (parseStl), then welded. `hold` is
 * given the soup while it is welded, for the memory meter (RM's review: 108 MB on a filled file of 3 million).
 */
export function asLoaded(mesh: WeldedMesh, hold?: (arrays: unknown[]) => void): WeldedMesh {
  const P = mesh.positions, I = mesh.indices;
  const soup = new Float32Array(I.length * 3);
  hold?.([soup]);
  let w = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ax = P[a], ay = P[a + 1], az = P[a + 2], bx = P[b], by = P[b + 1], bz = P[b + 2], cx = P[c], cy = P[c + 1], cz = P[c + 2];
    if ((ax === bx && ay === by && az === bz) || (ax === cx && ay === cy && az === cz) || (bx === cx && by === cy && bz === cz)) continue;
    soup.set([ax, ay, az, bx, by, bz, cx, cy, cz], w);
    w += 9;
  }
  return weld(soup.subarray(0, w));
}

const closedEdges = (audit: MeshAudit): boolean => audit.openEdges === 0 && audit.nonManifoldEdges === 0 && audit.misorientedEdges === 0;

/** A positive volume, about the origin: exact for a closed mesh, which is all it is used on. */
const volumeOf = (mesh: WeldedMesh): number => signedVolumeAbout(mesh, null, 0, 0, 0);

/**
 * The repair (see the file's head). `welded` is the maker's file as the app welds it and `audit` its auditEdges.
 * Throws RepairError: 'repair-nothing' for a closed mesh that does not fold, which the app never offers it for;
 * 'repair-cell' for a grid the model cannot take; 'repair-empty' where the surface encloses nothing;
 * 'repair-failed' where the rebuilt copy cannot be kept closed.
 */
export function repairMesh(api: ManifoldToplevel, simplifier: MeshSimplifier, welded: WeldedMesh, audit: MeshAudit, options: RepairOptions): Repaired {
  const now = options.now ?? (() => 0);
  const timings: Record<string, number> = {};
  const timed = <T>(step: string, run: () => T): T => {
    const t0 = now();
    const value = run();
    timings[step] = (timings[step] ?? 0) + now() - t0;
    return value;
  };
  const progress = options.progress ?? (() => {});
  let meshopt = 0;
  const hold = (arrays: unknown[]): void => options.hold?.(arrays, meshopt);
  const maxTriangles = options.maxTriangles ?? REPAIRED_TRIANGLE_LIMIT;
  const manifoldLimit = options.manifoldLimit ?? MANIFOLD_TRIANGLE_LIMIT;
  const holes = audit.openLoops.length, holeArea = audit.openArea;

  const { name } = options;
  // A closed mesh, every edge shared by two faces running it opposite ways: Manifold takes it as it is, so only a
  // fold, which it takes without a word, is left to repair, and only rung B mends one. A closed surface of no volume
  // (a flat tetrahedron), which Manifold takes as no solid, goes to rung B too, whose vote then finds nothing inside.
  const closed = closedEdges(audit) || options.rung === 'rebuild';
  if (closedEdges(audit) && options.rung !== 'rebuild') {
    const volume = volumeOf(welded);
    const positive = volume < 0 ? { positions: welded.positions, indices: reversed(welded.indices) } : welded;
    const { min, max } = meshBounds(welded.positions);
    const scale = (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]);
    if (Math.abs(volume) > 1e-9 * scale && timed('folds', () => windingFolds(positive)).places === 0) throw new RepairError('repair-nothing', `${name} is a closed solid already, so there is nothing to repair.`);
  }

  progress('orient', 0, 1);
  const oriented = timed('orient', () => orientPieces(welded, audit.misorientedEdges === 0));
  hold([oriented.mesh.indices]);
  const fixed = oriented.turned > 0 ? timed('audit', () => auditEdges(oriented.mesh)) : audit;

  // Rung A: the holes closed, or, where the fix alone closed it, nothing added.
  if (!closed && (closedEdges(fixed) || fillable(fixed))) {
    if (!closedEdges(fixed)) progress('fill', 0, 1);
    const filled: Filled = closedEdges(fixed) ? { mesh: oriented.mesh, caps: [], area: 0 } : timed('fill', () => fillHoles(oriented.mesh, fixed.openLoops, (arrays) => hold([oriented.mesh.indices, arrays])));
    hold([oriented.mesh.indices, filled.mesh.indices]);
    progress('check', 0, 1);
    const mesh = timed('check', () => asLoaded(filled.mesh, (arrays) => hold([oriented.mesh.indices, filled.mesh.indices, arrays])));
    hold([filled.mesh.indices, mesh]);
    const checked = timed('check', () => checkClosed(api, mesh, manifoldLimit));
    if (checked) {
      const added = timed('added', () => capsAdded(filled, welded));
      return {
        mesh,
        figures: { method: 'filled', cell: null, cellAsked: null, holes, holeArea, turned: oriented.turned, triangles: mesh.indices.length / 3, nearMm: 0, outside: null, addedMm: added.mm, addedAt: added.at, volume: checked.volume },
        outside: null,
        marks: fixed.openLoops.slice(0, 20).map((loop) => rimMiddle(welded, loop.vertices)),
        stats: { rebuild: null, reduce: null, extracted: 0, suspect: 0, pieces: 0, insideProved: 0, leftover: 0, checkedBy: checked.by },
        timings,
      };
    }
  }

  // Rung B: the grid, then the rebuild from the fixed mesh, whose winding the columns read.
  // The automatic grid is checked as a typed one is (RM's review): a model too large for any grid this app takes, or
  // too far from the origin for a fine one, is refused with its own sentence, never left to fail in the lattice.
  const cellAsked = options.cell;
  const facts = cellFacts(welded);
  const h = cellAsked ?? autoRepairCell(facts);
  if (cellAsked !== null) {
    const problem = repairCellProblem(facts, cellAsked);
    if (problem) throw new RepairError('repair-cell', problem);
  } else {
    const limit = repairCellLimit(facts, h);
    if (limit) throw new RepairError('repair-cell', `${name} cannot be rebuilt on any grid this app takes: the coarsest that suits it, ${h.toFixed(2)} mm, ${limit}.`);
  }
  progress('rebuild', 0, 1);
  const rebuilt = timed('rebuild', () => rebuildSurface(oriented.mesh, h, { now, rule: options.rule, hold: (arrays) => hold([oriented.mesh.indices, arrays]), progress: (done, total) => progress('rebuild', done, total) }));
  const extracted = rebuilt.mesh;
  const extractedCount = extracted.indices.length / 3;
  if (extractedCount === 0) throw new RepairError('repair-empty', `${name} could not be repaired: the rebuild could not tell inside from outside, as its surface encloses no space or its holes face each other across it.`);
  hold([extracted]);

  progress('reduce', 0, 1);
  meshopt = MESHOPT_BYTES_PER_TRIANGLE * extractedCount;
  const reduced = timed('reduce', () => reduceRebuilt(extracted, simplifier, h * REDUCE_ERROR, LOCK_CELLS * h, maxTriangles, (round) => progress('reduce', round, REDUCE_ROUNDS), (arrays) => hold([extracted, arrays])));
  let candidate = reduced.mesh;
  if (!reduced.clean) {
    // The extracted surface is closed by construction and does not fold, but is not reduced.
    if (extractedCount > maxTriangles) throw new RepairError('repair-failed', `${name} could not be repaired: its surface rebuilt on a ${h.toFixed(2)} mm grid could not be kept closed as it was reduced. Try a coarser grid.`);
    candidate = extracted;
  }

  progress('check', 0, 1);
  const mesh = timed('check', () => asLoaded(candidate, (arrays) => hold([candidate, arrays])));
  hold([mesh]);
  const checked = timed('check', () => checkClosed(api, mesh, manifoldLimit));
  if (!checked) throw new RepairError('repair-failed', `${name} could not be repaired: its surface rebuilt on a ${h.toFixed(2)} mm grid is not a closed solid the geometry engine takes. Try another grid.`);

  progress('compare', 0, 1);
  const compared = timed('compare', () => compareToRepaired(welded, mesh, h, (arrays) => hold([mesh, arrays])));
  let outside: RepairFigures['outside'] = null;
  let outsideMesh: WeldedMesh | null = null;
  let marks: [number, number, number][] = [];
  if (compared.far.length > 0) {
    outsideMesh = subMesh(welded, compared.far);
    const far = timed('compare', () => farFigures(outsideMesh!, mesh, h, 20, (arrays) => hold([mesh, outsideMesh, arrays])));
    outside = { runs: runsOf(compared.far), triangles: compared.far.length, area: far.area, farthestMm: far.farthestMm, at: far.at };
    marks = far.marks;
  }
  const added = welded.indices.length / 3 <= ADDED_INDEX_LIMIT ? timed('added', () => surfaceAdded(mesh, welded, h, (arrays) => hold([mesh, arrays]))) : { mm: null, at: null };
  return {
    mesh,
    figures: { method: 'rebuilt', cell: h, cellAsked, holes, holeArea, turned: 0, triangles: mesh.indices.length / 3, nearMm: compared.nearMm, outside, addedMm: added.mm, addedAt: added.at, volume: checked.volume },
    outside: outsideMesh,
    marks,
    stats: { rebuild: rebuilt.stats, reduce: { rounds: reduced.rounds, locked: reduced.locked, pairs: reduced.pairs, reportedMm: reduced.reportedMm, clean: reduced.clean, capped: reduced.capped }, extracted: extractedCount, suspect: compared.suspect, pieces: compared.pieces, insideProved: compared.insideProved, leftover: compared.leftover, checkedBy: checked.by },
    timings,
  };
}

/**
 * Whether a repaired mesh is a closed solid the app can use: every edge shared by two faces running it opposite ways,
 * no fold, a positive volume, and, within `manifoldLimit` triangles, Manifold taking it on its first rung without
 * turning it or a part of it. Past the limit no Manifold is built (the spike: 6.3 s and 1.27 GB for a filled file of
 * 3 million triangles), and the volume is the faces' own. Null where it is not.
 */
export function checkClosed(api: ManifoldToplevel, mesh: WeldedMesh, manifoldLimit: number): { volume: number; by: 'manifold' | 'edges' } | null {
  const audit = auditEdges(mesh);
  if (!closedEdges(audit)) return null;
  if (mesh.indices.length / 3 > manifoldLimit) {
    if (windingFolds(mesh).places > 0) return null;
    const volume = volumeOf(mesh);
    return volume > 0 ? { volume, by: 'edges' } : null;
  }
  return withArena(api, (arena) => {
    const imported = importSolid(arena, mesh, audit);
    const report = imported.report;
    if (report.route !== 'manifold' || report.flipped || report.folds > 0 || report.diagnostics.some((d) => d.code === 'shell-inverted')) return null;
    const volume = report.solidVolume - report.voidVolume - report.overlapVolume;
    return volume > 0 ? { volume, by: 'manifold' as const } : null;
  });
}

/** The middle of a hole's rim, as holeMarkers marks it. */
function rimMiddle(mesh: WeldedMesh, vertices: Uint32Array): [number, number, number] {
  const middle = [0, 0, 0];
  for (const v of vertices) for (let k = 0; k < 3; k++) middle[k] += mesh.positions[v * 3 + k] / vertices.length;
  return [middle[0], middle[1], middle[2]];
}

/**
 * How far a fill's caps lie from the file at most, proved: the caps, cut small, against the file's triangles near
 * them (those whose box comes within 4 times the caps' size of the caps' box, which holds every triangle as near as
 * the caps' rim), by provedDistance. 0 with no caps.
 */
function capsAdded(filled: Filled, file: WeldedMesh): { mm: number; at: [number, number, number] | null } {
  if (filled.caps.length === 0) return { mm: 0, at: null };
  const first = filled.caps[0][0];
  const caps: WeldedMesh = subMesh(filled.mesh, Int32Array.from({ length: filled.mesh.indices.length / 3 - first }, (_, k) => first + k));
  const { positions: C } = caps;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < C.length / 3; v++) for (let d = 0; d < 3; d++) {
    lo[d] = Math.min(lo[d], C[v * 3 + d]);
    hi[d] = Math.max(hi[d], C[v * 3 + d]);
  }
  // A cap's points lie within its box's diagonal of its rim, which is the file's: so every triangle of the file as
  // near as that to a point of a cap is within the diagonal of the box.
  const reach = Math.sqrt((hi[0] - lo[0]) ** 2 + (hi[1] - lo[1]) ** 2 + (hi[2] - lo[2]) ** 2);
  const P = file.positions, I = file.indices;
  const near: number[] = [];
  for (let t = 0; t < I.length / 3; t++) {
    let apart = false;
    for (let d = 0; d < 3 && !apart; d++) {
      const a = P[I[t * 3] * 3 + d], b = P[I[t * 3 + 1] * 3 + d], c = P[I[t * 3 + 2] * 3 + d];
      apart = Math.min(a, b, c) > hi[d] + reach || Math.max(a, b, c) < lo[d] - reach;
    }
    if (!apart) near.push(t);
  }
  // Cut to pieces of about a 32nd of the caps' size, at least 0.5 mm: where two faces of the file are as near, the
  // bound cannot come closer than about a piece's size, and a cap's farthest point lies where they are.
  const piece = Math.max(0.5, Math.sqrt(filled.area) / 32);
  return provedDistance(subMesh(file, near), splitLong(caps, piece).mesh, Math.max(DEVIATION_CELL_MM, piece), piece / 2);
}

/** How far a rebuilt copy's surface lies from the file at most, proved: its triangles cut to SPLIT_CELLS cells (provedDistance). */
function surfaceAdded(copy: WeldedMesh, file: WeldedMesh, h: number, hold: (arrays: unknown[]) => void): { mm: number; at: [number, number, number] } {
  const split = splitLong(copy, SPLIT_CELLS * h);
  return provedDistance(file, split.mesh, 2 * h, (SPLIT_CELLS * h) / 2, undefined, (arrays) => hold([split.parent, arrays]));
}
