import type { Field } from './grid';

/**
 * G5: H_d(x) = max over u of (H(u) - |x - u| / tan(alpha)), so the silicone slides out, by a two-pass
 * chamfer in place. Chamfer distance is up to 8% longer than true distance off-axis, so the wall
 * widens up to 8% less there. It can only raise H, so clearance and nesting are kept. Runs before
 * closing, as the other order leaves tall plastic blades.
 */
export function applyDraft(field: Field, degrees: number): void {
  if (degrees <= 0) return;
  const { nx, ny, cell, values } = field;
  const straight = cell / Math.tan((degrees * Math.PI) / 180);
  const diagonal = straight * Math.SQRT2;

  // Planning pads the domain by more than the draft can widen, so the outer ring stays empty and
  // the passes can skip it instead of testing bounds.
  for (let y = 1; y < ny - 1; y++) {
    for (let x = 1, n = 1 + y * nx; x < nx - 1; x++, n++) {
      const v = Math.max(values[n - 1] - straight, values[n - nx] - straight, values[n - nx - 1] - diagonal, values[n - nx + 1] - diagonal);
      if (v > values[n]) values[n] = v;
    }
  }
  for (let y = ny - 2; y >= 1; y--) {
    for (let x = nx - 2, n = nx - 2 + y * nx; x >= 1; x--, n--) {
      const v = Math.max(values[n + 1] - straight, values[n + nx] - straight, values[n + nx + 1] - diagonal, values[n + nx - 1] - diagonal);
      if (v > values[n]) values[n] = v;
    }
  }
}
