import { windingNumber } from '../src/core/mesh/shells';
import type { WeldedMesh } from '../src/core/mesh/weld';
import { orientedExample } from '../test/fixtures/fieldRuns';

type Point = [number, number, number];

/** G2.6's level of Benchy's lettering, in mm over its base plane. */
const LETTERING = 0.3;
/** How far a letter's walls may lie from a point in it, in mm: wider than a stroke, far narrower than the hull. */
const STROKE = 4;

/** The distance along a ray to the nearest face of the mesh, or Infinity: Moller and Trumbore's test. */
function hitDistance(mesh: WeldedMesh, from: Point, dir: Point): number {
  const { positions: p, indices } = mesh;
  let nearest = Infinity;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const q = [dir[1] * e2[2] - dir[2] * e2[1], dir[2] * e2[0] - dir[0] * e2[2], dir[0] * e2[1] - dir[1] * e2[0]];
    const det = e1[0] * q[0] + e1[1] * q[1] + e1[2] * q[2];
    if (Math.abs(det) < 1e-12) continue;
    const s = [from[0] - p[a], from[1] - p[a + 1], from[2] - p[a + 2]];
    const u = (s[0] * q[0] + s[1] * q[1] + s[2] * q[2]) / det;
    if (u < 0 || u > 1) continue;
    const r = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const v = (dir[0] * r[0] + dir[1] * r[1] + dir[2] * r[2]) / det;
    if (v < 0 || u + v > 1) continue;
    const along = (e2[0] * r[0] + e2[1] * r[1] + e2[2] * r[2]) / det;
    if (along > 0 && along < nearest) nearest = along;
  }
  return nearest;
}

/**
 * In Node, from Benchy's own faces and none of the code under test: a point 0.15 mm up in one of its
 * sealed letters, under the largest face of the lettering's ceiling that has room round it, and a point on the same cut and height outside the hull, 1.5 mm past where its
 * model ends, where silicone reaches the plate. The letter's point lies under a face of the model at
 * G2.6's 0.30 mm level that faces down, has 0.25 mm of air round it in the cut, and has the model on all
 * four sides within a stroke's width, so it is in a letter and not out under the open sky of the hull.
 */
export function benchyLetterSpots(): { air: Point; open: Point } {
  const { mesh } = orientedExample('benchy');
  const { positions: p, indices } = mesh;
  const model = { numProp: 3, vertProperties: p, triVerts: indices } as never;
  const inModel = (at: Point): boolean => windingNumber(model, ...at) > 0.5;
  // The letters' ceilings: faces on the level, facing down, largest first.
  const ceilings: { area: number; at: [number, number] }[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    if (![a, b, c].every((v) => Math.abs(p[v + 2] - LETTERING) < 0.01)) continue;
    const nz = (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a]);
    if (nz >= 0) continue;
    ceilings.push({ area: -nz / 2, at: [(p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3] });
  }
  ceilings.sort((m, n) => n.area - m.area);
  const z = LETTERING / 2;
  for (const { at: [x, y] } of ceilings) {
    const around: Point[] = [[x, y, z], [x, y - 0.25, z], [x, y + 0.25, z], [x, y, z - 0.1], [x, y, z + 0.1]];
    if (around.some(inModel)) continue;
    // Straight up, the ceiling; sideways, the letter's walls.
    if (Math.abs(hitDistance(mesh, [x, y, z], [0, 0, 1]) - (LETTERING - z)) > 0.01) continue;
    const walls: Point[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
    if (!walls.every((dir) => hitDistance(mesh, [x, y, z], dir) < STROKE)) continue;
    // Outward from the hull's middle line, until the model ends, then 1.5 mm on.
    const way = y >= 0 ? 1 : -1;
    let edge = y;
    while (inModel([x, edge, z]) || hitDistance(mesh, [x, edge, z], [0, 0, 1]) < 1) edge += way * 0.1;
    return { air: [x, y, z], open: [x, edge + way * 1.5, z] };
  }
  throw new Error('No point under Benchy\'s lettering has air round it and walls on all sides.');
}
