import type { Manifold } from 'manifold-3d';
import type { Arena } from '../solid/arena';
import type { Rim } from './rim';

export const OPENING_SEGMENTS = 48;
/** How far a cutter runs into the cavity below it, so it shares no surface with the ceiling. */
export const BELOW_CEILING = 0.5;
/** How far a cutter runs past the flat top. */
const ABOVE_TOP = 1;
export const VENT_CHAMFER = 0.3;

function cone(arena: Arena, x: number, y: number, zLow: number, zHigh: number, rLow: number, rHigh: number): Manifold {
  const { track } = arena;
  return track(track(arena.api.Manifold.cylinder(zHigh - zLow, rLow, rHigh, OPENING_SEGMENTS)).translate([x, y, zLow]));
}

export interface PourOpening {
  x: number;
  y: number;
  /** The lowest cavity ceiling over the opening's disc. */
  zb: number;
  diameter: number;
  /** 0 with the seat turned off, which leaves a plain bore. */
  seatDepth: number;
  seatHalfAngleDeg: number;
}

/** Radius of a pour's seat at the flat top, which is the widest it gets. */
export function seatTopRadius(opening: Pick<PourOpening, 'diameter' | 'seatDepth' | 'seatHalfAngleDeg'>): number {
  return opening.diameter / 2 + opening.seatDepth * Math.tan((opening.seatHalfAngleDeg * Math.PI) / 180);
}

/** Radius of a vent's mouth at the flat top. */
export function ventTopRadius(diameter: number): number {
  return diameter / 2 + VENT_CHAMFER;
}

/**
 * G11: the bore, and the seat cone above it, widening towards the flat top. Never a counterbore,
 * which would need supports and form a locking head. The bore starts above the cavity ceiling's
 * lowest point, so it only removes plastic.
 */
export function pourCutters(arena: Arena, rim: Pick<Rim, 'Zt'>, opening: PourOpening): Manifold[] {
  const { x, y, zb, diameter, seatDepth, seatHalfAngleDeg } = opening;
  const r = diameter / 2;
  const bottom = zb - BELOW_CEILING;
  const seatTop = rim.Zt + ABOVE_TOP;
  if (seatDepth <= 0) return [cone(arena, x, y, bottom, seatTop, r, r)];
  const seatFloor = rim.Zt - seatDepth;
  const rTop = r + (seatTop - seatFloor) * Math.tan((seatHalfAngleDeg * Math.PI) / 180);
  const seat = cone(arena, x, y, seatFloor, seatTop, r, rTop);
  // A seat past the rule on its depth has its floor below the ceiling. That is an inline error, and
  // a bore of negative length would turn it into a failed boolean as well.
  return seatFloor + 0.01 > bottom ? [cone(arena, x, y, bottom, seatFloor + 0.01, r, r), seat] : [seat];
}

export interface VentOpening {
  x: number;
  y: number;
  zb: number;
  diameter: number;
}

/** G11: a straight hole with a small mouth chamfer, so the first layer does not close it. */
export function ventCutters(arena: Arena, rim: Pick<Rim, 'Zt'>, opening: VentOpening): Manifold[] {
  const { x, y, zb, diameter } = opening;
  const r = diameter / 2;
  const mouth = rim.Zt - VENT_CHAMFER;
  return [cone(arena, x, y, zb - BELOW_CEILING, mouth + 0.01, r, r), cone(arena, x, y, mouth, rim.Zt + ABOVE_TOP, r, r + VENT_CHAMFER + ABOVE_TOP)];
}

export type CutOpening = ({ kind: 'pour' } & PourOpening) | ({ kind: 'vent' } & VentOpening);

export function openingCutters(arena: Arena, rim: Pick<Rim, 'Zt'>, opening: CutOpening): Manifold[] {
  return opening.kind === 'pour' ? pourCutters(arena, rim, opening) : ventCutters(arena, rim, opening);
}
