import type { ErrorStatus, Manifold, Mesh } from 'manifold-3d';
import type { Diagnostic } from '../report/diagnostics';
import type { Arena } from '../solid/arena';
import { MISSING_SURFACE_MM2, type MeshAudit, type OpenLoop } from './audit';
import { touchingGroups } from './touching';
import { meshBounds, type WeldedMesh } from './weld';

/** Where the repair ladder stopped: plain weld, weld plus Mesh.merge, or no solid at all. */
export type ImportRoute = 'manifold' | 'merged' | 'soup';

/**
 * solid: an outer surface. void: a negative shell inside a solid, such as the barrel's sealed
 * hollow. inverted: a negative shell inside nothing, so it is really a solid wound backwards.
 * unverified: a connected piece of an open mesh, which may not enclose anything. An open mesh can
 * have a void too, told by its winding and position alone.
 */
export type ShellKind = 'solid' | 'void' | 'inverted' | 'unverified';

export interface ShellInfo {
  kind: ShellKind;
  /**
   * Negative for a void. An inverted shell reports its volume after being flipped. In soup mode
   * this is only an estimate, since an open surface has no true volume.
   */
  volume: number;
  triangleCount: number;
  /** 0 in soup mode, where it means nothing. */
  genus: number;
  min: [number, number, number];
  max: [number, number, number];
}

export interface SolidReport {
  route: ImportRoute;
  /** Status from the first failed construction, or null if the weld alone was enough. */
  failure: ErrorStatus | null;
  /** The whole mesh was inside out and has been flipped. */
  flipped: boolean;
  shells: ShellInfo[];
  /**
   * Separate objects, each needing its own pour: the solid, inverted and unverified shells, not voids,
   * with those that overlap or touch counted as one, as a model split for multi-colour printing is.
   */
  bodies: number;
  solidVolume: number;
  voidVolume: number;
  /** Sum of the solid shells minus their union. */
  overlapVolume: number;
  /** Mode B needs a real solid, so soup mode disables it. */
  modeBAvailable: boolean;
  /** Soup mode has no solid for minGap to measure, so its cavity clearance stays nominal. */
  clearanceVerified: boolean;
  diagnostics: Diagnostic[];
}

export interface ImportedSolid {
  /** Owned by the caller's arena. Null in soup mode. */
  solid: Manifold | null;
  /** The input mesh, with its winding corrected if a flip was needed. */
  mesh: WeldedMesh;
  /** The audit's holes, turned to match `mesh`. For findBaseCandidates and orientToBase in soup mode. */
  openLoops: OpenLoop[];
  report: SolidReport;
  /**
   * The union of the model's parts, in `mesh`'s coordinates, where parts that overlap or touch were joined:
   * the section's cut is counted from it, as the parts' own walls inside the model show in a cut as a seam.
   * Null for a model of one part or of parts apart, and past JOINED_MESH_LIMIT.
   */
  joined: WeldedMesh | null;
}

/**
 * The display proxy's limit (G1.8, 300k triangles): past it the union of joined parts is not kept for the
 * section, as a second whole mesh on main costs memory a heavy model does not have to spare.
 */
const JOINED_MESH_LIMIT = 300_000;

// Numerical noise on x8 is 2e-7 of its volume, so this only catches real overlap.
const OVERLAP_FRACTION = 1e-4;
/**
 * How far Mesh.merge may pull open vertices together, in mm. The library's own default is about a
 * float step, so a file rounded to 3 decimals stays open: its seams reach 0.0017 mm across a
 * diagonal. This is still far below the smallest plane tolerance and cell, at 0.05 mm.
 */
const MERGE_TOLERANCE = 0.002;

function isManifoldError(error: unknown): error is { code: ErrorStatus } {
  return error instanceof Error && error.name === 'ManifoldError';
}

/** The same triangles wound the other way round. */
export function reversed(indices: Uint32Array): Uint32Array {
  const out = indices.slice();
  for (let i = 0; i < out.length; i += 3) {
    out[i + 1] = indices[i + 2];
    out[i + 2] = indices[i + 1];
  }
  return out;
}

/** Generalised winding number: 1 inside a closed positive surface, 0 outside, robust at edges. */
export function windingNumber(mesh: Mesh, x: number, y: number, z: number): number {
  const p = mesh.vertProperties;
  const stride = mesh.numProp;
  const tv = mesh.triVerts;
  let sum = 0;
  for (let t = 0; t < tv.length; t += 3) {
    const a = tv[t] * stride, b = tv[t + 1] * stride, c = tv[t + 2] * stride;
    const ax = p[a] - x, ay = p[a + 1] - y, az = p[a + 2] - z;
    const bx = p[b] - x, by = p[b + 1] - y, bz = p[b + 2] - z;
    const cx = p[c] - x, cy = p[c + 1] - y, cz = p[c + 2] - z;
    const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz), lc = Math.hypot(cx, cy, cz);
    const det = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    const ab = ax * bx + ay * by + az * bz, bc = bx * cx + by * cy + bz * cz, ca = cx * ax + cy * ay + cz * az;
    sum += 2 * Math.atan2(det, la * lb * lc + ab * lc + bc * la + ca * lb);
  }
  return sum / (4 * Math.PI);
}

/** Inside if most sampled corners are, so one corner touching the outer wall cannot decide it. */
function isInside(inner: Mesh, outer: Mesh): boolean {
  const samples = 8;
  const vertexCount = inner.vertProperties.length / inner.numProp;
  const step = Math.max(1, Math.floor(vertexCount / samples));
  let total = 0, inside = 0;
  for (let v = 0; v < vertexCount; v += step) {
    const i = v * inner.numProp;
    total++;
    if (windingNumber(outer, inner.vertProperties[i], inner.vertProperties[i + 1], inner.vertProperties[i + 2]) > 0.5) inside++;
  }
  return inside * 2 > total;
}

function toMesh(arena: Arena, welded: WeldedMesh, tolerance = 0): Mesh {
  return new arena.api.Mesh({ numProp: 3, vertProperties: welded.positions, triVerts: welded.indices, tolerance });
}

/** Only a ManifoldError means the mesh is bad. Anything else is a WASM fault and must propagate. */
function tryManifold(arena: Arena, mesh: Mesh): Manifold | ErrorStatus {
  try {
    return arena.manifold(mesh);
  } catch (error) {
    if (isManifoldError(error)) return error.code;
    throw error;
  }
}

/** Signed volume, summed about one point. An open surface's result depends on that point. */
function signedVolumeAbout(mesh: WeldedMesh, triangles: ArrayLike<number> | null, cx: number, cy: number, cz: number): number {
  const { positions: p, indices } = mesh;
  const count = triangles ? triangles.length : indices.length / 3;
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const t = triangles ? triangles[i] : i;
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ax = p[a] - cx, ay = p[a + 1] - cy, az = p[a + 2] - cz;
    const bx = p[b] - cx, by = p[b + 1] - cy, bz = p[b + 2] - cz;
    const ex = p[c] - cx, ey = p[c + 1] - cy, ez = p[c + 2] - cz;
    sum += ax * (by * ez - bz * ey) - ay * (bx * ez - bz * ex) + az * (bx * ey - by * ex);
  }
  return sum / 6;
}

/** A connected piece of a mesh, with the triangles that make it up. */
export interface MeshPiece extends ShellInfo {
  triangles: number[];
}

/**
 * Connected pieces of a mesh, joined through shared vertices. M4 places one pour per body, which
 * soup mode needs too, so each piece reports its bounds and an estimate of its volume. Needs no
 * Manifold, so the field worker can use it as well.
 */
export function connectedPieces(mesh: WeldedMesh): MeshPiece[] {
  const { positions: p, indices } = mesh;
  const parent = new Int32Array(p.length / 3);
  for (let v = 0; v < parent.length; v++) parent[v] = v;
  const find = (v: number): number => {
    while (parent[v] !== v) {
      parent[v] = parent[parent[v]];
      v = parent[v];
    }
    return v;
  };
  for (let i = 0; i < indices.length; i += 3) {
    const root = find(indices[i]);
    parent[find(indices[i + 1])] = root;
    parent[find(indices[i + 2])] = root;
  }
  const byRoot = new Map<number, { triangles: number[]; min: ShellInfo['min']; max: ShellInfo['max'] }>();
  for (let t = 0; t < indices.length / 3; t++) {
    const root = find(indices[t * 3]);
    let piece = byRoot.get(root);
    if (!piece) byRoot.set(root, (piece = { triangles: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
    piece.triangles.push(t);
    for (let c = 0; c < 3; c++) {
      for (let axis = 0; axis < 3; axis++) {
        const value = p[indices[t * 3 + c] * 3 + axis];
        if (value < piece.min[axis]) piece.min[axis] = value;
        if (value > piece.max[axis]) piece.max[axis] = value;
      }
    }
  }
  const pieces = Array.from(byRoot.values());
  return pieces.map(({ triangles, min, max }): MeshPiece => {
    const volume = signedVolumeAbout(mesh, triangles, (min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    // Wound inside out and lying within another piece: a void such as the barrel's, not a body.
    const nested = pieces.some((other) => [0, 1, 2].every((axis) => other.min[axis] < min[axis] && other.max[axis] > max[axis]));
    return { kind: volume < 0 && nested ? 'void' : 'unverified', volume: nested ? volume : Math.abs(volume), triangleCount: triangles.length, genus: 0, min, max, triangles };
  });
}

function soupResult(welded: WeldedMesh, audit: MeshAudit, failure: ErrorStatus | null): ImportedSolid {
  const defects = `${audit.openEdges} open, ${audit.nonManifoldEdges} non-manifold and ${audit.misorientedEdges} misoriented edges`;
  const diagnostics: Diagnostic[] = [
    {
      code: 'soup-mode',
      severity: 'warning',
      // Said whatever the mode is set to, as one set before this model, or by a project file, stays set.
      message: `The mesh is not a closed solid (${defects}), so merged mode cannot be used with it, and the cover and the glue-mode base are built from its surface as it is. Without a closed model the silicone thickness cannot be measured: it stays as planned, and no export can check it. To use merged mode and a measured thickness, repair the mesh, for example with your slicer's repair, and open it again.`,
    },
  ];
  if (audit.openArea >= MISSING_SURFACE_MM2) {
    // Which way is up depends on the base plane, so orientToBase is what warns about the cavity.
    diagnostics.push({
      code: 'missing-surface',
      severity: 'info',
      message: `${audit.openLoops.length === 1 ? `The surface has 1 hole of ${audit.openArea.toFixed(1)} mm2` : `The surface has ${audit.openLoops.length} holes totalling ${audit.openArea.toFixed(1)} mm2`}. Close ${audit.openLoops.length === 1 ? 'it' : 'them'} in the program that made the model, or with a mesh repair, and open the file again.`,
    });
  }

  // An open mesh wound inside out would have every normal pointing into the model. Measured about
  // the mesh's own centre, a hole costs little of the total, so the sign still holds.
  const { min, max } = meshBounds(welded.positions);
  const flipped = signedVolumeAbout(welded, null, (min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2) < 0;
  if (flipped) diagnostics.push({ code: 'mesh-flipped', severity: 'warning', message: 'The mesh was inside out, so its faces were flipped.' });
  const mesh = flipped ? { positions: welded.positions, indices: reversed(welded.indices) } : welded;
  const openLoops = flipped ? audit.openLoops.map((loop): OpenLoop => ({ ...loop, capNormal: [-loop.capNormal[0] || 0, -loop.capNormal[1] || 0, -loop.capNormal[2] || 0] })) : audit.openLoops;

  const pieces = connectedPieces(mesh);
  const shells = pieces.map(({ triangles: _, ...shell }): ShellInfo => shell);
  const bodies = touchingGroups(mesh, pieces).length;
  // An open surface has no volume to give, so the note says only how many parts make how many models.
  const note = partsNote(pieces.filter((piece) => piece.kind !== 'void').length, bodies, null, null);
  if (note) diagnostics.push(note);
  return {
    solid: null,
    mesh,
    openLoops,
    joined: null,
    report: {
      route: 'soup',
      failure,
      flipped,
      shells,
      bodies,
      solidVolume: 0,
      voidVolume: 0,
      overlapVolume: 0,
      modeBAvailable: false,
      clearanceVerified: false,
      diagnostics,
    },
  };
}

interface LadderResult {
  solid: Manifold;
  route: ImportRoute;
  failure: ErrorStatus | null;
  /** Carries the merge vectors of the second rung, which a flip must keep. */
  mesh: Mesh;
}

/** Returns the failure status when even the last rung leaves no usable solid. */
function climbLadder(arena: Arena, welded: WeldedMesh, diagnostics: Diagnostic[]): LadderResult | { failure: ErrorStatus | null } {
  const mesh = toMesh(arena, welded);
  const first = tryManifold(arena, mesh);
  if (typeof first !== 'string') return { solid: first, route: 'manifold', failure: null, mesh };

  // Only this rung carries the tolerance, because a Manifold also collapses edges shorter than it.
  // merge() returns false when it found nothing to merge, and the retry would fail the same way.
  const merged = toMesh(arena, welded, MERGE_TOLERANCE);
  if (!merged.merge()) return { failure: first };
  const second = tryManifold(arena, merged);
  if (typeof second === 'string') return { failure: first };
  diagnostics.push({ code: 'mesh-merged', severity: 'info', message: 'Nearly touching vertices along open edges were merged to close the surface.' });
  return { solid: second, route: 'merged', failure: first, mesh: merged };
}

/**
 * Each body without the voids inside it, ready to union. A body sitting in another's sealed void
 * touches nothing, but with the void filled in it would look swallowed by the outer body. A void's
 * inside-out surface is no valid operand for a boolean, so it is turned the right way first.
 */
function hollowed(arena: Arena, bodies: Manifold[], voidParts: Manifold[]): Manifold[] {
  if (voidParts.length === 0) return bodies;
  const voids = voidParts.map((part) => {
    const shell = part.getMesh();
    return { shell, solid: arena.manifold(new arena.api.Mesh({ numProp: shell.numProp, vertProperties: shell.vertProperties, triVerts: reversed(shell.triVerts) })) };
  });
  return bodies.map((body) => {
    const outer = body.getMesh();
    const inside = voids.filter(({ shell }) => isInside(shell, outer)).map(({ solid }) => solid);
    return inside.length === 0 ? body : arena.track(body.subtract(arena.track(arena.api.Manifold.union(inside))));
  });
}

/**
 * What solid shells share, in mm3: their sum, each less the voids inside it, minus their union, or 0 under
 * the noise of a mesh whose shells only meet.
 */
function overlapOf(arena: Arena, solids: Manifold[], voids: Manifold[]): { overlap: number; union: Manifold | null } {
  if (solids.length < 2) return { overlap: 0, union: null };
  const hollow = hollowed(arena, solids, voids);
  const union = arena.track(arena.api.Manifold.union(hollow));
  const excess = hollow.reduce((total, part) => total + part.volume(), 0) - union.volume();
  const scale = solids.reduce((total, part) => total + part.volume(), 0);
  return { overlap: excess > OVERLAP_FRACTION * scale ? excess : 0, union };
}

/**
 * What the parts of a solid share, as the import measures it. A trim at the base plane takes away what they
 * share below it and keeps them apart above it, so a trimmed model's own figure is this one, not the
 * import's: its volume less this is the union of its parts above the plane.
 */
export function sharedVolume(arena: Arena, solid: Manifold): number {
  const parts = arena.trackAll(solid.decompose());
  return overlapOf(arena, parts.filter((part) => part.volume() > 0), parts.filter((part) => part.volume() < 0)).overlap;
}

/**
 * G1, steps 5 to 7: the repair ladder, then shell analysis. Exact weld is the ladder's first step
 * and has already happened. Shells are classified here from the real mesh, before any simplify.
 */
export function importSolid(arena: Arena, welded: WeldedMesh, audit: MeshAudit): ImportedSolid {
  const diagnostics: Diagnostic[] = [];
  const climbed = climbLadder(arena, welded, diagnostics);
  if (!('solid' in climbed)) return soupResult(welded, audit, climbed.failure);
  const { route, failure, mesh } = climbed;
  let solid = climbed.solid;

  // A closed mesh can still enclose nothing, such as a tetrahedron flattened into one plane.
  if (solid.isEmpty() || solid.volume() === 0) return soupResult(welded, audit, failure);

  let result = welded;
  const flipped = solid.volume() < 0;
  if (flipped) {
    // Reversing the winding is not a transform, so no reflection enters the pipeline.
    result = { positions: welded.positions, indices: reversed(welded.indices) };
    solid = arena.manifold(new arena.api.Mesh({ numProp: 3, vertProperties: mesh.vertProperties, triVerts: reversed(mesh.triVerts), mergeFromVert: mesh.mergeFromVert, mergeToVert: mesh.mergeToVert, tolerance: mesh.tolerance }));
    diagnostics.push({ code: 'mesh-flipped', severity: 'warning', message: 'The mesh was inside out, so its faces were flipped.' });
  }

  const parts = arena.trackAll(solid.decompose());
  const positives = parts.filter((part) => part.volume() > 0);
  const negatives = parts.filter((part) => part.volume() < 0);
  const shells: ShellInfo[] = [];
  const describe = (part: Manifold, kind: ShellKind): void => {
    const { min, max } = part.boundingBox();
    shells.push({ kind, volume: part.volume(), triangleCount: part.numTri(), genus: part.genus(), min: [...min], max: [...max] });
  };
  positives.forEach((part) => describe(part, 'solid'));

  const positiveMeshes = negatives.length > 0 ? positives.map((part) => part.getMesh()) : [];
  const voidParts: Manifold[] = [];
  const flippedParts: Manifold[] = [];
  for (const part of negatives) {
    const shellMesh = part.getMesh();
    if (positiveMeshes.some((outer) => isInside(shellMesh, outer))) {
      voidParts.push(part);
      describe(part, 'void');
      diagnostics.push({ code: 'shell-void', severity: 'info', message: `A sealed internal void of ${(-part.volume()).toFixed(0)} mm3 was found; silicone cannot reach it and it is not counted as silicone.` });
      continue;
    }
    const fixed = arena.manifold(new arena.api.Mesh({ numProp: shellMesh.numProp, vertProperties: shellMesh.vertProperties, triVerts: reversed(shellMesh.triVerts) }));
    flippedParts.push(fixed);
    describe(fixed, 'inverted');
    diagnostics.push({ code: 'shell-inverted', severity: 'warning', message: `A separate body of ${fixed.volume().toFixed(0)} mm3 was inside out, so its faces were flipped.` });
  }
  if (flippedParts.length > 0) {
    // compose drops negative shells, so voids stay out of this solid. Nothing needs them in it:
    // voidVolume reports them, silicone works from the exterior, and Mode B fills them anyway.
    solid = arena.track(arena.api.Manifold.compose([...positives, ...flippedParts]));
    const composed = solid.getMesh();
    result = { positions: composed.vertProperties, indices: composed.triVerts };
  }

  const solids = [...positives, ...flippedParts];
  const solidVolume = solids.reduce((sum, part) => sum + part.volume(), 0);
  const voidVolume = voidParts.reduce((sum, part) => sum - part.volume(), 0);
  let overlapVolume = 0;
  let bodies = solids.length;
  let joined: WeldedMesh | null = null;
  if (solids.length > 1) {
    const shared = overlapOf(arena, solids, voidParts);
    overlapVolume = shared.overlap;
    // The same rule as findBodies, on the mesh, so the count is the bodies that get their own pours.
    bodies = touchingGroups(result, connectedPieces(result), { closed: true }).length;
    const note = partsNote(solids.length, bodies, overlapVolume, solidVolume - voidVolume - overlapVolume);
    if (note) diagnostics.push(note);
    if (bodies < solids.length && result.indices.length / 3 <= JOINED_MESH_LIMIT) {
      const union = shared.union!.getMesh();
      if (union.numProp === 3) joined = { positions: union.vertProperties, indices: union.triVerts };
    }
  }

  return {
    solid,
    mesh: result,
    openLoops: [],
    report: { route, failure, flipped, shells, bodies, solidVolume, voidVolume, overlapVolume, modeBAvailable: true, clearanceVerified: true, diagnostics },
    joined,
  };
}

/**
 * What a maker reads about a file made of parts that overlap or touch, as models split for multi-colour
 * printing often are: no fault of the file, so a note, with the model's volume as the union of its parts.
 * Null when every part stands apart, as x8's barriers do. An open mesh has neither figure (null), as only a
 * closed solid's union can be measured, and its note says only that its parts overlap or touch.
 */
export function partsNote(parts: number, bodies: number, overlap: number | null, volume: number | null): Diagnostic | null {
  if (bodies === parts) return null;
  const how = overlap === null ? 'overlap or touch' : overlap > 0 ? `overlap by ${overlap.toFixed(1)} mm3` : 'touch';
  const one = bodies === 1;
  const message = one
    ? `The file is made of ${parts} parts that ${how}, as models split for multi-colour printing often are. The mold treats them as one model${volume === null ? '' : `, of ${volume.toFixed(0)} mm3`}.`
    : `The file is made of ${parts} parts, some of which ${how}, as models split for multi-colour printing often are. The mold treats parts that overlap or touch as one model, so it makes ${bodies} models of them${volume === null ? '' : `, ${volume.toFixed(0)} mm3 in all`}.`;
  return { code: overlap !== null && overlap > 0 ? 'shell-overlap' : 'shell-touch', severity: 'info', message };
}
