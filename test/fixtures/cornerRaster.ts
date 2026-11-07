import type { Field, Grid } from '../../src/core/field/grid';
import { emptyField } from '../../src/core/field/grid';
import { NO_SOURCE } from '../../src/core/field/raster';
import type { WeldedMesh } from '../../src/core/mesh/weld';

/**
 * G3's formula as the plan writes it, kept to compare the clipped raster against: per cell,
 * min(triMaxZ, max(plane z at the 4 corners)), clipped to z >= 0, with triMaxZ for a vertical
 * triangle. Covers the same cells, found here the plain way: the triangle's clipped x-span per row.
 */
export function cornerRaster(mesh: WeldedMesh, grid: Grid): Field {
  const field = emptyField(grid, NO_SOURCE);
  const { values, nx } = field;
  const { positions: p, indices } = mesh;
  const scale = 1 / grid.cell;
  const ou = 0.5 - grid.x0 * scale;
  const ov = 0.5 - grid.y0 * scale;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const corners = [
      [p[a] * scale + ou, p[a + 1] * scale + ov, p[a + 2]],
      [p[b] * scale + ou, p[b + 1] * scale + ov, p[b + 2]],
      [p[c] * scale + ou, p[c + 1] * scale + ov, p[c + 2]],
    ];
    const top = Math.max(corners[0][2], corners[1][2], corners[2][2]);
    if (top < 0) continue;
    const [A, B, C] = corners;
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
    const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
    const det = ux * vy - uy * vx;
    const slopeU = det === 0 ? 0 : (uz * vy - uy * vz) / det;
    const slopeV = det === 0 ? 0 : (ux * vz - uz * vx) / det;
    const jMin = Math.floor(Math.min(A[1], B[1], C[1])), jMax = Math.floor(Math.max(A[1], B[1], C[1]));
    for (let j = jMin; j <= jMax; j++) {
      let low = Infinity, high = -Infinity;
      for (const [P, Q] of [[A, B], [B, C], [C, A]]) {
        const [L, H] = P[1] <= Q[1] ? [P, Q] : [Q, P];
        if (L[1] > j + 1 || H[1] < j) continue;
        const rise = H[1] - L[1];
        const s0 = rise === 0 ? 0 : Math.max(0, (j - L[1]) / rise);
        const s1 = rise === 0 ? 1 : Math.min(1, (j + 1 - L[1]) / rise);
        for (const s of [s0, s1]) {
          const u = L[0] + s * (H[0] - L[0]);
          if (u < low) low = u;
          if (u > high) high = u;
        }
      }
      for (let i = Math.floor(low); i <= Math.floor(high); i++) {
        const planeTop = A[2] + slopeU * (i + 0.5 - A[0]) + slopeV * (j + 0.5 - A[1]) + (Math.abs(slopeU) + Math.abs(slopeV)) / 2;
        const height = det === 0 ? top : Math.min(top, planeTop);
        const n = i + j * nx;
        if (height >= 0 && height > values[n]) values[n] = height;
      }
    }
  }
  return field;
}
