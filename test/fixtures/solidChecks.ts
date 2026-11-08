import type { CrossSection, Manifold, Mesh, SimplePolygon } from 'manifold-3d';
import { orientSolid, type RigidTransform } from '../../src/core/base/orient';
import { auditEdges, type MeshAudit } from '../../src/core/mesh/audit';
import { importSolid, windingNumber } from '../../src/core/mesh/shells';
import { weld, type WeldedMesh } from '../../src/core/mesh/weld';
import { inversePose } from '../../src/core/parts/poses';
import type { Arena } from '../../src/core/solid/arena';
import { parseStl } from '../../src/core/stl/parse';
import { writeBinaryStl } from '../../src/core/stl/write';
import type { Rect } from '../../src/core/solid/rect';

export interface ParsedPart {
  mesh: WeldedMesh;
  audit: MeshAudit;
}

/** The bytes of an exported STL, read back the way the app reads any file. */
export function readPart(bytes: Uint8Array): ParsedPart {
  const mesh = weld(parseStl(bytes).positions);
  return { mesh, audit: auditEdges(mesh) };
}

/**
 * G9 reassembly: an exported part, re-parsed and taken back from its print pose to where it sits in
 * the mold. Everything after the bytes runs on what a user would really print.
 */
export function unpose(arena: Arena, bytes: Uint8Array, pose: RigidTransform): Manifold {
  const { mesh, audit } = readPart(bytes);
  const { solid } = importSolid(arena, mesh, audit);
  if (!solid) throw new Error(`An exported part did not read back as a solid: ${audit.openEdges} open, ${audit.nonManifoldEdges} non-manifold edges.`);
  return orientSolid(arena, solid, inversePose(pose));
}

/**
 * The wrong export the print pose is there to prevent: by default a plain z flip, written as a slicer
 * would see it, with the winding reversed so that it still reads as a closed solid. `alongX` reflects
 * the cavity in x once it is back in place, rather than in y as the z flip does.
 */
export function mirroredCoverStl(cover: Manifold, Zt: number, alongX = false): Uint8Array {
  const mesh = cover.getMesh();
  const positions = mesh.vertProperties.slice();
  for (let i = 0; i < positions.length; i += 3) {
    positions[i + 2] = Zt - positions[i + 2];
    if (alongX) {
      positions[i] = -positions[i];
      positions[i + 1] = -positions[i + 1];
    }
  }
  const indices = mesh.triVerts.slice();
  for (let t = 0; t < indices.length; t += 3) [indices[t + 1], indices[t + 2]] = [indices[t + 2], indices[t + 1]];
  return writeBinaryStl(positions, indices);
}

export interface VoidShell {
  /** Positive, in mm3. */
  volume: number;
  mesh: Mesh;
}

/** Solids and voids of a union: Manifold gives a void as a separate shell of negative volume. */
export function splitShells(arena: Arena, solid: Manifold): { bodies: Manifold[]; voids: VoidShell[] } {
  const parts = arena.trackAll(solid.decompose());
  return {
    bodies: parts.filter((part) => part.volume() > 0),
    voids: parts.filter((part) => part.volume() < 0).map((part) => ({ volume: -part.volume(), mesh: part.getMesh() })),
  };
}

export interface ExpectedVoid {
  name: string;
  volume: number;
  /** Allowed error as a share of `volume`. */
  fraction: number;
  /** A point the shell must enclose. */
  probe: [number, number, number];
}

/** Voids smaller than this come from the float rounding of near-coplanar faces, not from the design. */
export const CRUMB_MM3 = 1e-3;

/**
 * The closed-volume list: each expected void must be found by its probe point, at its volume, and
 * nothing else may be left over. Returns what is wrong, as sentences, so that a failure says which
 * void, and a negative control can say what it expects to break.
 */
export function compareVoids(voids: VoidShell[], expected: ExpectedVoid[]): string[] {
  const problems: string[] = [];
  const unused = new Set(voids.filter((shell) => shell.volume >= CRUMB_MM3));
  for (const want of expected) {
    const [x, y, z] = want.probe;
    const found = [...unused].find((shell) => Math.abs(windingNumber(shell.mesh, x, y, z)) > 0.5);
    if (!found) {
      problems.push(`${want.name}: no void encloses (${want.probe.map((v) => v.toFixed(2)).join(', ')})`);
      continue;
    }
    unused.delete(found);
    if (Math.abs(found.volume - want.volume) > want.volume * want.fraction) {
      problems.push(`${want.name}: volume ${found.volume.toFixed(2)} is not within ${want.fraction * 100}% of ${want.volume.toFixed(2)}`);
    }
  }
  for (const shell of unused) problems.push(`an unexpected void of ${shell.volume.toFixed(3)} mm3`);
  return problems;
}

/** The empty part of the cover at height z, inside a rectangle that holds the cavity and not the groove. */
export function cavitySection(arena: Arena, cover: Manifold, inner: Rect, z: number): CrossSection {
  const { track } = arena;
  const { x0, y0, x1, y1 } = inner;
  const rect: SimplePolygon = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  return track(arena.crossSection([rect]).subtract(track(cover.slice(z))));
}

/** Area of a closed contour, whichever way it runs. */
export function contourArea(contour: SimplePolygon): number {
  let doubled = 0;
  for (let i = 0, j = contour.length - 1; i < contour.length; j = i++) {
    const [ax, ay] = contour[j] as [number, number], [bx, by] = contour[i] as [number, number];
    doubled += ax * by - bx * ay;
  }
  return Math.abs(doubled) / 2;
}

function pointToContour(x: number, y: number, contour: SimplePolygon): number {
  let best = Infinity;
  for (let i = 0, j = contour.length - 1; i < contour.length; j = i++) {
    const [ax, ay] = contour[j] as [number, number], [bx, by] = contour[i] as [number, number];
    const dx = bx - ax, dy = by - ay;
    const along = dx === 0 && dy === 0 ? 0 : Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(x - ax - along * dx, y - ay - along * dy));
  }
  return best;
}

/** True distance between two contours that do not cross: it is reached at a corner of one or the other. */
export function contourDistance(a: SimplePolygon, b: SimplePolygon): number {
  let best = Infinity;
  for (const p of a) best = Math.min(best, pointToContour((p as [number, number])[0], (p as [number, number])[1], b));
  for (const p of b) best = Math.min(best, pointToContour((p as [number, number])[0], (p as [number, number])[1], a));
  return best;
}

/** Boxes in tests: min corner and max corner, through Manifold, tracked. */
export function boxSolid(arena: Arena, min: [number, number, number], max: [number, number, number]): Manifold {
  const { track } = arena;
  return track(track(arena.api.Manifold.cube([max[0] - min[0], max[1] - min[1], max[2] - min[2]])).translate(min));
}

/** Area of a hole as the cutters make it: a 48-gon on the circle of radius r. */
export const polygonArea = (r: number): number => 24 * r * r * Math.sin((2 * Math.PI) / 48);

/** Ray parity: whether a point lies inside a closed outline. */
export function insideOutline(x: number, y: number, outline: readonly (readonly number[])[]): boolean {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [xi, yi] = outline[i], [xj, yj] = outline[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function outlineArea(outline: readonly (readonly number[])[]): number {
  return contourArea(outline as SimplePolygon);
}

/** A convex outline cut to a rectangle, side by side (Sutherland and Hodgman), so a slot's channel ends at the wall it opens through. */
export function clipToBox(outline: readonly (readonly number[])[], box: Rect): [number, number][] {
  let points = outline.map(([x, y]) => [x, y] as [number, number]);
  const edges: [(p: [number, number]) => number][] = [[(p) => p[0] - box.x0], [(p) => box.x1 - p[0]], [(p) => p[1] - box.y0], [(p) => box.y1 - p[1]]];
  for (const [side] of edges) {
    const next: [number, number][] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      const da = side(a), db = side(b);
      if (da >= 0) next.push(a);
      if (da >= 0 !== db >= 0) {
        const f = da / (da - db);
        next.push([a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])]);
      }
    }
    points = next;
  }
  return points;
}

/**
 * The holes of a solid's section at height z, near the given axes: for each axis, the centroid of the
 * contour round it, which must be a 48-gon of radius r within 1% by area. Null where none is found.
 */
export function holeCentres(arena: Arena, solid: Manifold, z: number, axes: readonly { x: number; y: number }[], r: number): ([number, number] | null)[] {
  const contours = arena.polygons(arena.track(solid.slice(z)));
  return axes.map(({ x, y }) => {
    for (const contour of contours) {
      const points = contour as [number, number][];
      if (!insideOutline(x, y, points)) continue;
      const area = contourArea(contour);
      if (Math.abs(area - polygonArea(r)) > polygonArea(r) * 0.01) continue;
      // The centroid of the contour's own polygon, by the shoelace formula.
      let cx = 0, cy = 0, doubled = 0;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const cross = points[j][0] * points[i][1] - points[i][0] * points[j][1];
        doubled += cross;
        cx += (points[j][0] + points[i][0]) * cross;
        cy += (points[j][1] + points[i][1]) * cross;
      }
      return [cx / (3 * doubled), cy / (3 * doubled)];
    }
    return null;
  });
}
