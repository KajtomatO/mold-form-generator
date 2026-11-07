import type { Field } from '../../src/core/field/grid';

/**
 * The reference for dilate.ts: every source writes its whole kernel, as G3's formula reads. Float64,
 * so the rounding of the Float32 field is not in the reference too.
 */
export function bruteDilate(raster: Field, radius: number): Float64Array {
  const { nx, ny, cell, values } = raster;
  const out = new Float64Array(nx * ny);
  const reach = Math.ceil(radius / cell);
  const r2 = radius * radius;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const h = values[x + y * nx];
      if (h < 0) continue;
      for (let dy = -reach; dy <= reach; dy++) {
        const Y = y + dy;
        if (Y < 0 || Y >= ny) continue;
        for (let dx = -reach; dx <= reach; dx++) {
          const X = x + dx;
          if (X < 0 || X >= nx) continue;
          const d2 = (dx * dx + dy * dy) * cell * cell;
          if (d2 > r2) continue;
          const v = h + Math.sqrt(r2 - d2);
          if (v > out[X + Y * nx]) out[X + Y * nx] = v;
        }
      }
    }
  }
  return out;
}
