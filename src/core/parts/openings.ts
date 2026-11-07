import type { Manifold } from 'manifold-3d';
import type { Arena } from '../solid/arena';
import type { Rim } from './rim';

const SEGMENTS = 48;
/** How far a cutter runs into the cavity below it, so it shares no surface with the ceiling. */
const BELOW_CEILING = 0.5;
/** How far a cutter runs past the flat top. */
const ABOVE_TOP = 1;
const VENT_CHAMFER = 0.3;

function cone(arena: Arena, x: number, y: number, zLow: number, zHigh: number, rLow: number, rHigh: number): Manifold {
  const { track } = arena;
  return track(track(arena.api.Manifold.cylinder(zHigh - zLow, rLow, rHigh, SEGMENTS)).translate([x, y, zLow]));
}

export interface PourOpening {
  x: number;
  y: number;
  /** The lowest cavity ceiling over the opening's disc. */
  zb: number;
  diameter: number;
  seatDepth: number;
  seatHalfAngleDeg: number;
}

/**
 * G11: the bore, and the seat cone above it, widening towards the flat top. Never a counterbore,
 * which would need supports and form a locking head. The bore starts above the cavity ceiling's
 * lowest point, so it only removes plastic.
 */
export function pourCutters(arena: Arena, rim: Rim, opening: PourOpening): Manifold[] {
  const { x, y, zb, diameter, seatDepth, seatHalfAngleDeg } = opening;
  const r = diameter / 2;
  const seatFloor = rim.Zt - seatDepth;
  const seatTop = rim.Zt + ABOVE_TOP;
  const rTop = r + (seatTop - seatFloor) * Math.tan((seatHalfAngleDeg * Math.PI) / 180);
  return [cone(arena, x, y, zb - BELOW_CEILING, seatFloor + 0.01, r, r), cone(arena, x, y, seatFloor, seatTop, r, rTop)];
}

export interface VentOpening {
  x: number;
  y: number;
  zb: number;
  diameter: number;
}

/** G11: a straight hole with a small mouth chamfer, so the first layer does not close it. */
export function ventCutters(arena: Arena, rim: Rim, opening: VentOpening): Manifold[] {
  const { x, y, zb, diameter } = opening;
  const r = diameter / 2;
  const mouth = rim.Zt - VENT_CHAMFER;
  return [cone(arena, x, y, zb - BELOW_CEILING, mouth + 0.01, r, r), cone(arena, x, y, mouth, rim.Zt + ABOVE_TOP, r, r + VENT_CHAMFER + ABOVE_TOP)];
}
