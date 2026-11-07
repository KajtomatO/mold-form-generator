import type { Manifold, Vec3 } from 'manifold-3d';
import type { Arena } from '../solid/arena';
import { outset, type Rect } from '../solid/rect';
import type { Rim } from './rim';

/**
 * Same on every ring, so a ring and its offset share their corner angles. The gap between them is
 * then cT * cos(half a segment) at worst, which at 16 is 0.1% under cT rather than a 10% dip.
 */
const CORNER_SEGMENTS = 16;
/** How far a frustum subtracted from another runs past it, so they share no end plane. */
const OVERSHOOT = 0.1;

/** Counter-clockwise points of a rounded rectangle at height z. A radius of 0 gives its 4 corners. */
export function ringPoints(rect: Rect, radius: number, z: number): Vec3[] {
  const { x0, y0, x1, y1 } = rect;
  const r = Math.max(0, Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2));
  if (r === 0) return [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]];
  const corners: [number, number, number][] = [[x1 - r, y0 + r, -90], [x1 - r, y1 - r, 0], [x0 + r, y1 - r, 90], [x0 + r, y0 + r, 180]];
  const points: Vec3[] = [];
  for (const [cx, cy, start] of corners) {
    for (let k = 0; k <= CORNER_SEGMENTS; k++) {
      const a = ((start + (90 * k) / CORNER_SEGMENTS) * Math.PI) / 180;
      points.push([cx + r * Math.cos(a), cy + r * Math.sin(a), z]);
    }
  }
  return points;
}

/** Area of ringPoints: its corners are polygons, so a closed form for the circle would read high. */
export function ringArea(rect: Rect, radius: number): number {
  const w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  const polygon = (CORNER_SEGMENTS * r * r * Math.sin(Math.PI / 2 / CORNER_SEGMENTS)) / 2;
  return w * h - 4 * (r * r - polygon);
}

/** Convex hull of rings: the shape of the block, rebate, plate and each joint frustum. */
export function ringHull(arena: Arena, rings: { rect: Rect; radius: number; z: number }[]): Manifold {
  const points = rings.flatMap(({ rect, radius, z }) => ringPoints(rect, radius, z));
  return arena.track(arena.api.Manifold.hull(points));
}

/**
 * Radius of the ring at offset `e` from D, at z = 0. Ring by ring outward the corners follow the
 * plate's, so a wall stays one land away from it, and any ring with no room for that is sharp. This
 * is the plan's rule that ring radii are clamped to be non-negative. deriveRim keeps the plate's radius
 * within the room from D to B, so no ring's corner comes nearer D's corner than its own offset.
 */
function ringRadius(rim: Rim, e: number): number {
  const ring = outset(rim.D, e);
  const land = Math.min(ring.x0 - rim.B.x0, ring.y0 - rim.B.y0, rim.B.x1 - ring.x1, rim.B.y1 - ring.y1);
  return Math.max(0, rim.cornerRadius - land);
}

/**
 * A joint wall at offset `e` from D at z = 0, moving by `slope` per mm of height. The corner moves
 * with it, as a true offset does, or a corner's slant would be steeper than the sides and its gap
 * narrower.
 */
export function wallRing(rim: Rim, e: number, slope: number, z: number): { rect: Rect; radius: number; z: number } {
  const moved = z * slope;
  const r0 = ringRadius(rim, e);
  return { rect: outset(rim.D, e + moved), radius: r0 > 0 ? Math.max(0, r0 + moved) : 0, z };
}

/** Between walls at `eInner` and `eOuter`, narrowing upward at the ridge draft, from zBottom to zTop. */
function draftedRing(arena: Arena, rim: Rim, eInner: number, eOuter: number, zBottom: number, zTop: number): Manifold {
  const outer = ringHull(arena, [wallRing(rim, eOuter, -rim.tanRidge, zBottom), wallRing(rim, eOuter, -rim.tanRidge, zTop)]);
  const inner = ringHull(arena, [wallRing(rim, eInner, rim.tanRidge, zBottom - OVERSHOOT), wallRing(rim, eInner, rim.tanRidge, zTop + OVERSHOOT)]);
  return arena.track(outer.subtract(inner));
}

const JOINT_BOTTOM = -0.5;

/** G9: cut into the cover. It runs below the shelf so the mouth has no plane in common with it. */
export function grooveSolid(arena: Arena, rim: Rim): Manifold {
  return draftedRing(arena, rim, rim.e1, rim.e4, JOINT_BOTTOM, rim.ridgeHeight + rim.grooveExtra);
}

/** G10: stands on the base. It starts inside the plate so the two fuse. */
export function ridgeSolid(arena: Arena, rim: Rim): Manifold {
  return draftedRing(arena, rim, rim.e2, rim.e3, JOINT_BOTTOM, rim.ridgeHeight);
}

/** Composite Simpson. Each ring's area is quadratic in z, apart from where a clamped radius reaches 0. */
function integrate(f: (z: number) => number, a: number, b: number): number {
  const steps = 16;
  const h = (b - a) / steps;
  let sum = f(a) + f(b);
  for (let k = 1; k < steps; k++) sum += f(a + k * h) * (k % 2 === 1 ? 4 : 2);
  return (sum * h) / 3;
}

/**
 * Air left around the ridge above a plate whose top is at zPlate. It is what the closed-volume check
 * must find as a negative shell, worked out from the rim alone, with no solid involved.
 */
export function grooveResidualVolume(rim: Rim, zPlate: number): number {
  const area = (eInner: number, eOuter: number, z: number): number => {
    const outer = wallRing(rim, eOuter, -rim.tanRidge, z), inner = wallRing(rim, eInner, rim.tanRidge, z);
    return ringArea(outer.rect, outer.radius) - ringArea(inner.rect, inner.radius);
  };
  const groove = integrate((z) => area(rim.e1, rim.e4, z), zPlate, rim.ridgeHeight + rim.grooveExtra);
  const ridge = integrate((z) => area(rim.e2, rim.e3, z), zPlate, rim.ridgeHeight);
  return groove - ridge;
}
