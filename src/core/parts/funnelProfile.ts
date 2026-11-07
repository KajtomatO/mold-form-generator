import type { Params } from '../params/schema';

const DEGREE = Math.PI / 180;

/**
 * G12, the sizes of the revolved profile, as they follow from the seat and the pour. Heights are from
 * the cover's flat top, so z < 0 is inside the seat. Only arithmetic, so the rules can read it too.
 */
export interface FunnelProfile {
  /** How far the seated spigot stands off the seat's floor: the seat's own cone, moved up until its faces lie seatClearance apart. */
  standoff: number;
  /** Lowest point of the funnel, at the spigot's tip. */
  zTip: number;
  /** Outer radius at the tip. It is the bore's, since the spigot is the seat moved along the axis. */
  rTip: number;
  /** Inner radius at the tip: pour diameter / 2 - tipWall. */
  rThroat: number;
  /** Outer radius of the spigot's wide end, which is also the neck's. */
  rNeck: number;
  /** Inner radius of the neck. */
  rNeckInner: number;
  /** Where the bore through the spigot reaches the neck's inner radius. */
  zNeckInner: number;
  /** Where the neck's inner wall reaches the inner cone. */
  zConeInner: number;
  zNeck: number;
  zRim: number;
  rRim: number;
  rRimInner: number;
  /** From vertical, in degrees. The steepest wall in the print pose, inside and out. */
  coneDeg: number;
  /** The same for the inner wall of the spigot. */
  throatDeg: number;
}

export function funnelProfile(params: Params): FunnelProfile {
  const r = params.pour.diameter / 2;
  const { depth, halfAngleDeg } = params.seat;
  const { topDiameter, height, neckHeight, wall, tipWall, seatClearance } = params.funnel;
  const half = halfAngleDeg * DEGREE;
  const standoff = seatClearance / Math.sin(half);
  const zTip = standoff - depth;
  const rNeck = r + (depth - standoff) * Math.tan(half);
  const rRim = topDiameter / 2;
  const rThroat = r - tipWall;
  const rNeckInner = Math.max(rNeck - wall, rThroat);

  const coneRise = height - neckHeight;
  const cone = Math.atan2(rRim - rNeck, coneRise);
  const across = wall / Math.cos(cone);
  // The inner cone is the outer one moved in by the wall, measured square to the wall. A straight funnel has none.
  const zConeInner = cone > 0 ? neckHeight + (rNeckInner - (rNeck - across)) / Math.tan(cone) : neckHeight;
  // Within 45 degrees of vertical even where the wall is thicker at the tip than at the neck.
  const zNeckInner = zTip + Math.max(-zTip, rNeckInner - rThroat);
  const throat = Math.atan2(rNeckInner - rThroat, zNeckInner - zTip);
  return {
    standoff,
    zTip,
    rTip: r,
    rThroat,
    rNeck,
    rNeckInner,
    zNeckInner,
    zConeInner,
    zNeck: neckHeight,
    zRim: height,
    rRim,
    rRimInner: rRim - across,
    coneDeg: cone / DEGREE,
    throatDeg: throat / DEGREE,
  };
}
