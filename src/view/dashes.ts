/**
 * OL: the dashed circle a funnel's flange will rest on, as flat triangles in z = 0. No three here, so the
 * unit tests can read it in Node.
 */

/** Across the line, in mm: two thirds of an opening ring's 0.6, so it reads as the lesser mark. */
export const OUTLINE_WIDTH = 0.4;
/**
 * Across the light band under each dash, in mm: 0.2 mm each side of the dark line, and as far past each end.
 * Seen straight down the backdrop is the pale top, where the dark line reads; seen at an angle in the dark
 * theme it is the dark scene through the see-through cover, where only a light edge does.
 */
export const CASING_WIDTH = 0.8;
/** One dash and the gap after it, along the circle, in mm, and the dash's share of that. */
export const DASH_PERIOD = 2.8;
export const DASH_SHARE = 0.6;
/** Straight pieces per dash. */
const SEGMENTS = 4;

/** How many dashes go round a circle of `radius`: about one per DASH_PERIOD, and never under 12. */
export function dashCount(radius: number): number {
  return Math.max(12, Math.round((2 * Math.PI * radius) / DASH_PERIOD));
}

/**
 * The dashes round a circle of `radius`, `width` across, centred on the origin in z = 0. Dash k is
 * centred on the angle 2πk/n, so dash 0 is centred on +x and the gap after it on π/n. `run` lengthens each
 * dash by that much along the circle at both ends, as the light band under the dark line does, though
 * never by more than a quarter of the gap, so the gaps stay open.
 */
export function dashedRing(radius: number, width: number = OUTLINE_WIDTH, run = 0): { positions: Float32Array; indices: Uint32Array } {
  const n = dashCount(radius);
  const inner = Math.max(0, radius - width / 2), outer = radius + width / 2;
  const step = (2 * Math.PI) / n;
  const half = (step * DASH_SHARE) / 2 + Math.min(run / radius, (step * (1 - DASH_SHARE)) / 4);
  const positions = new Float32Array(n * (SEGMENTS + 1) * 2 * 3);
  const indices = new Uint32Array(n * SEGMENTS * 6);
  let v = 0, t = 0;
  for (let k = 0; k < n; k++) {
    const first = v / 3 / 2;
    for (let s = 0; s <= SEGMENTS; s++) {
      const angle = k * step - half + (2 * half * s) / SEGMENTS;
      const c = Math.cos(angle), sn = Math.sin(angle);
      positions.set([inner * c, inner * sn, 0, outer * c, outer * sn, 0], v);
      v += 6;
    }
    for (let s = 0; s < SEGMENTS; s++) {
      const a = (first + s) * 2;
      // Inner and outer at this stop, then at the next, as two triangles facing +z.
      indices.set([a, a + 1, a + 3, a, a + 3, a + 2], t);
      t += 6;
    }
  }
  return { positions, indices };
}

/** The light band under the dashes of a circle of `radius`: CASING_WIDTH across, and as far past each end. */
export function dashCasing(radius: number): { positions: Float32Array; indices: Uint32Array } {
  return dashedRing(radius, CASING_WIDTH, (CASING_WIDTH - OUTLINE_WIDTH) / 2);
}
