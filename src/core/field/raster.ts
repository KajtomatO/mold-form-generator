import type { WeldedMesh } from '../mesh/weld';
import { emptyField, type Field, type Grid } from './grid';

/** Marks a cell no triangle touches. Height 0 is a real source: model standing on the plane. */
export const NO_SOURCE = -1;

// A triangle clipped by 4 axis-aligned planes has at most 7 corners: 3 values each.
const CLIP_CORNERS = 7;

/**
 * Sutherland-Hodgman against one axis-aligned plane, with `axis` 0, 1 or 2 for u, v or z. It works
 * in 3D and keeps touching corners, so a vertical triangle needs no special case and still reports
 * the height it reaches inside the cell. Returns how many corners went to `out`.
 */
export function clipToPlane(input: Float64Array, count: number, axis: 0 | 1 | 2, bound: number, keepAbove: boolean, out: Float64Array): number {
  let kept = 0;
  let previous = (count - 1) * 3;
  let sidePrevious = keepAbove ? input[previous + axis] - bound : bound - input[previous + axis];
  for (let corner = 0; corner < count; corner++) {
    const at = corner * 3;
    const side = keepAbove ? input[at + axis] - bound : bound - input[at + axis];
    if ((side > 0 && sidePrevious < 0) || (side < 0 && sidePrevious > 0)) {
      const s = sidePrevious / (sidePrevious - side);
      out[kept * 3] = input[previous] + s * (input[at] - input[previous]);
      out[kept * 3 + 1] = input[previous + 1] + s * (input[at + 1] - input[previous + 1]);
      out[kept * 3 + 2] = input[previous + 2] + s * (input[at + 2] - input[previous + 2]);
      kept++;
    }
    if (side >= 0) {
      out[kept * 3] = input[at];
      out[kept * 3 + 1] = input[at + 1];
      out[kept * 3 + 2] = input[at + 2];
      kept++;
    }
    previous = at;
    sidePrevious = side;
  }
  return kept;
}

/**
 * G3: for each cell, the highest point of the model inside it, clipped to z >= 0. Each triangle is
 * clipped to each cell it touches. That is exact, so it is tighter than the plan's corner formula
 * on steep facets and never below the model, and the G4 proof needs only that bound. Being a bound
 * on what lies inside the cell is also what catches a needle far thinner than a cell. Works from
 * triangles alone, so an open mesh in soup mode rasters like any other.
 */
export function rasterize(mesh: WeldedMesh, grid: Grid): Field {
  const field = emptyField(grid, NO_SOURCE);
  const { values, nx, ny } = field;
  const { positions: p, indices } = mesh;
  const scale = 1 / grid.cell;
  // In these units cell i spans [i, i + 1), so node i at (x0 + i * cell) is its centre.
  const ou = 0.5 - grid.x0 * scale;
  const ov = 0.5 - grid.y0 * scale;

  const triangle = new Float64Array(9);
  const band = new Float64Array(CLIP_CORNERS * 3);
  const scratch = new Float64Array(CLIP_CORNERS * 3);
  const piece = new Float64Array(CLIP_CORNERS * 3);

  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const az = p[a + 2], bz = p[b + 2], cz = p[c + 2];
    const top = Math.max(az, bz, cz);
    if (top < 0) continue;
    const au = p[a] * scale + ou, av = p[a + 1] * scale + ov;
    const bu = p[b] * scale + ou, bv = p[b + 1] * scale + ov;
    const cu = p[c] * scale + ou, cv = p[c + 1] * scale + ov;
    const iMin = Math.floor(Math.min(au, bu, cu)), iMax = Math.floor(Math.max(au, bu, cu));
    const jMin = Math.floor(Math.min(av, bv, cv)), jMax = Math.floor(Math.max(av, bv, cv));
    if (iMin < 0 || jMin < 0 || iMax >= nx || jMax >= ny) throw new Error('A triangle lies outside the field domain.');

    // Most triangles of a detailed mesh fit in one cell, where the answer needs no clipping.
    if (iMin === iMax && jMin === jMax) {
      const n = iMin + jMin * nx;
      if (top > values[n]) values[n] = top;
      continue;
    }

    triangle[0] = au, triangle[1] = av, triangle[2] = az;
    triangle[3] = bu, triangle[4] = bv, triangle[5] = bz;
    triangle[6] = cu, triangle[7] = cv, triangle[8] = cz;

    for (let j = jMin; j <= jMax; j++) {
      let count = clipToPlane(triangle, 3, 1, j, true, scratch);
      count = clipToPlane(scratch, count, 1, j + 1, false, band);
      if (count === 0) continue;
      let uLow = Infinity, uHigh = -Infinity;
      for (let k = 0; k < count; k++) {
        const u = band[k * 3];
        if (u < uLow) uLow = u;
        if (u > uHigh) uHigh = u;
      }
      const row = j * nx;
      const iHigh = Math.floor(uHigh);
      for (let i = Math.floor(uLow); i <= iHigh; i++) {
        const n = i + row;
        // Nothing in this triangle can beat what the cell already has.
        if (top <= values[n]) continue;
        let corners = clipToPlane(band, count, 0, i, true, scratch);
        corners = clipToPlane(scratch, corners, 0, i + 1, false, piece);
        let height = NO_SOURCE;
        for (let k = 0; k < corners; k++) {
          const z = piece[k * 3 + 2];
          if (z > height) height = z;
        }
        // Below the plane it clips away. A part of the cell above the plane keeps its true height.
        if (height >= 0 && height > values[n]) values[n] = height;
      }
    }
  }
  return field;
}
