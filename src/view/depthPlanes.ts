/**
 * U2: the perspective camera's near and far planes, fitted to what is drawn on every frame. No three
 * here, so the unit tests can read it in Node.
 *
 * A depth buffer of `bits` bits resolves, at a distance d, steps of about 2^-bits d² (f - n) / (f n) in
 * world terms: with 0.1.0's fixed n = 0.1 and f = 5000 that is d² x 6e-7 mm, 0.06 mm at the framed view
 * of a 60 mm model and 0.44 mm at a 200 mm one, more than the gaps the joint leaves between parts (0.05
 * to 0.3 mm), so those fought in the depth buffer as the view turned. With the planes at the mold's own
 * nearest and farthest depths the step falls to about 2e-5 and 5e-5 mm.
 */

export type Vec3 = readonly [number, number, number] | readonly number[];

/** The near plane never comes nearer than 0.1.0's fixed one. */
export const MIN_NEAR = 0.1;
/** 0.1.0's far plane, kept while nothing is drawn yet. */
export const DEFAULT_FAR = 5000;
/** The planes stand this share inside the nearest, and outside the farthest, corner of what is drawn. */
export const NEAR_SHARE = 0.9;
export const FAR_SHARE = 1.1;
/** With the camera inside the box, or beside it, the near plane stands at this share of the distance to the target. */
export const INSIDE_NEAR = 1 / 100;

/**
 * Near and far for a camera at `eye` looking along the unit vector `forward`, `toTarget` from what it
 * orbits, so that every corner of what is drawn lies between them. Eye depth is linear, so over a box
 * its least and greatest values are at corners. With nothing drawn, 0.1.0's fixed planes.
 */
export function depthPlanes(corners: readonly Vec3[] | null, eye: Vec3, forward: Vec3, toTarget: number): { near: number; far: number } {
  if (!corners || corners.length === 0) return { near: MIN_NEAR, far: DEFAULT_FAR };
  let nearest = Infinity, farthest = -Infinity;
  for (const corner of corners) {
    const depth = (corner[0] - eye[0]) * forward[0] + (corner[1] - eye[1]) * forward[1] + (corner[2] - eye[2]) * forward[2];
    if (depth < nearest) nearest = depth;
    if (depth > farthest) farthest = depth;
  }
  // In front of the box nothing drawn lies nearer than its nearest corner; inside it, things may lie
  // right beside the camera, and a share of the orbit's distance keeps what it looks at.
  const near = nearest > 0 ? Math.max(MIN_NEAR, NEAR_SHARE * nearest) : Math.max(MIN_NEAR, INSIDE_NEAR * toTarget);
  return { near, far: Math.max(FAR_SHARE * farthest, 2 * near) };
}

/** How far the orthographic camera sees in front of what it orbits and behind it, in mm, as 0.1.0 saw from the camera. */
export const ORTHO_DEPTH = 5000;

/**
 * The orthographic camera's planes for a camera `toTarget` from what it orbits: linear, so the step is
 * 2 x ORTHO_DEPTH / 2^24, 0.0006 mm, at any distance, and centred on the target rather than on the camera,
 * which stands wherever the perspective view left it. Fixed at -5000 and 5000 from the camera, as in
 * 0.1.0, they lost the mold once the perspective view, whose far plane now follows the mold, was zoomed
 * out past 5 m and switched to orthographic.
 */
export function orthoPlanes(toTarget: number): { near: number; far: number } {
  return { near: toTarget - ORTHO_DEPTH, far: toTarget + ORTHO_DEPTH };
}

/** The 8 corners of a box. */
export function boxCorners(min: Vec3, max: Vec3): [number, number, number][] {
  const corners: [number, number, number][] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) corners.push([x, y, z]);
  return corners;
}

/** The smallest depth difference a buffer of `bits` bits tells apart at `depth` from the eye, in world units. */
export function depthStep(near: number, far: number, depth: number, bits = 24): number {
  return (2 ** -bits * depth * depth * (far - near)) / (far * near);
}
