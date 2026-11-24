import type { RigidTransform } from '../base/orient';
import type { Bounds } from '../mesh/weld';
import type { SeamAxis } from '../parts/rim';

/**
 * G13.1's pulls and their frames, apart from the side fields so that the parts can turn into a pull's frame (the seal,
 * the seam bolts' cuts) with no import of field/side.ts, which reads the parts' sizes for the bed.
 */

/** The four pulls: a half on the + side of P comes off along +a, one on the - side along -a. */
export type Pull = '+x' | '-x' | '+y' | '-y';

export const PULLS: readonly Pull[] = ['+x', '-x', '+y', '-y'];

export const axisOf = (pull: Pull): SeamAxis => (pull[1] as SeamAxis);
export const signOf = (pull: Pull): 1 | -1 => (pull[0] === '+' ? 1 : -1);
export const pullOf = (axis: SeamAxis, sign: 1 | -1): Pull => `${sign > 0 ? '+' : '-'}${axis}` as Pull;

const ROWS: Record<Pull, RigidTransform['rotation']> = {
  '+x': [0, 1, 0, 0, 0, 1, 1, 0, 0],
  '-x': [0, -1, 0, 0, 0, 1, -1, 0, 0],
  '+y': [-1, 0, 0, 0, 0, 1, 0, 1, 0],
  '-y': [1, 0, 0, 0, 0, 1, 0, -1, 0],
};

/**
 * G13.1's frame of a pull, from the model's bounds, so h >= 0 over the whole model: +x (y, z, x - xmin), -x (-y, z,
 * xmax - x), +y (-x, z, y - ymin), -y (x, z, ymax - y). Every one has determinant +1.
 */
export function sideFrame(pull: Pull, bounds: Bounds): RigidTransform {
  const a = axisOf(pull) === 'x' ? 0 : 1;
  const translation: [number, number, number] = [0, 0, signOf(pull) > 0 ? -bounds.min[a] : bounds.max[a]];
  return { rotation: ROWS[pull], translation };
}

/** The frame's inverse: back from (u, v, h) to the mold's (x, y, z). */
export function frameInverse(frame: RigidTransform): RigidTransform {
  const [a, b, c, d, e, f, g, h, i] = frame.rotation;
  const [x, y, z] = frame.translation;
  return {
    rotation: [a, d, g, b, e, h, c, f, i],
    translation: [-(a * x + d * y + g * z), -(b * x + e * y + h * z), -(c * x + f * y + i * z)],
  };
}

/**
 * G13.8's frame of the seam: the + pull's turn, with h = a - xs, so P is h = 0 and (u, v) is the seam face, v = z and
 * u = b with an x seam, -b with a y seam (bOf). The seal's sections are drawn in (u, v) and extruded along h.
 */
export function seamFrame(axis: SeamAxis, xs: number): RigidTransform {
  return { rotation: ROWS[pullOf(axis, 1)], translation: [0, 0, -xs] };
}

/**
 * G13.10.1's pull frame of a half: its pull's turn, translated so that h = 0 on P, h = a - xs for pos (+1) and xs - a for
 * neg (-1), v = z. Pos's is the seam's frame. The seam bolts' cuts are built in it, along h.
 */
export function halfFrame(axis: SeamAxis, xs: number, sign: 1 | -1): RigidTransform {
  return { rotation: ROWS[pullOf(axis, sign)], translation: [0, 0, -sign * xs] };
}
