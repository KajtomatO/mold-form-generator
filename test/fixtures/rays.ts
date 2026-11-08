import type { WeldedMesh } from '../../src/core/mesh/weld';

/**
 * Whether a point is inside a closed mesh, by the parity of the faces a ray straight up from it crosses.
 * The ray is moved a hair off the point, so it never runs through an edge or a corner of the mesh.
 */
export function insideMesh(mesh: WeldedMesh, point: readonly number[]): boolean {
  const x = point[0] + 1.234e-4, y = point[1] + 2.345e-4, z = point[2];
  const { positions: p, indices } = mesh;
  let crossings = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const d = (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a]);
    if (d === 0) continue;
    const u = ((p[b] - x) * (p[c + 1] - y) - (p[b + 1] - y) * (p[c] - x)) / d;
    const v = ((p[c] - x) * (p[a + 1] - y) - (p[c + 1] - y) * (p[a] - x)) / d;
    const w = 1 - u - v;
    if (u < 0 || v < 0 || w < 0) continue;
    if (u * p[a + 2] + v * p[b + 2] + w * p[c + 2] > z) crossings++;
  }
  return crossings % 2 === 1;
}
