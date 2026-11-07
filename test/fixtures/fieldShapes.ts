import { emptyField, type Field } from '../../src/core/field/grid';

/**
 * A field from a formula, for tests that need a ceiling with known peaks. It has one empty ring around
 * it, as a planned field does.
 */
export function fieldOf(width: number, depth: number, cell: number, height: (x: number, y: number) => number): Field {
  const nx = Math.round(width / cell) + 3, ny = Math.round(depth / cell) + 3;
  const field = emptyField({ nx, ny, cell, x0: -cell, y0: -cell });
  for (let j = 1; j < ny - 1; j++) {
    for (let i = 1; i < nx - 1; i++) field.values[i + j * nx] = Math.max(0, height((i - 1) * cell, (j - 1) * cell));
  }
  return field;
}

/** A cone standing at (cx, cy), the shape with the plainest known peak and saddle. */
export function coneAt(cx: number, cy: number, top: number, slope: number): (x: number, y: number) => number {
  return (x, y) => top - slope * Math.hypot(x - cx, y - cy);
}
