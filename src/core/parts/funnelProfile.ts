import type { Params } from '../params/schema';
import { seatTopRadius } from './openings';

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
  /** FL: the flange's outer radius, the seat's radius at the top plus the flange width, or 0 with no flange. */
  rFlange: number;
  /** Top of the flange's vertical edge, where its 45 degree chamfer starts, or 0. */
  zFlange: number;
  /** Where the chamfer reaches the neck's outer radius, or 0. */
  zChamfer: number;
  /** How far under the flange the spigot runs straight up: 2 layers, more on a shallow seat, less on one too short to spare them, or 0 with no flange. */
  relief: number;
  /** The spigot's outer radius over the relief: rNeck less the cone's widening over it. */
  rRelief: number;
}

/** FL: the relief is at least this many layers. The cover prints top down, so the seat's mouth is in its first layers, squashed a little narrower. */
const RELIEF_LAYERS = 2;
/**
 * FL: how far a first layer may squash into the seat's mouth (elephant foot), in mm: the relief also runs
 * high enough for the gap across the mouth, at the foot of the cover's first layer, to be at least this.
 * At a 30 degree seat 2 layers do that already; a shallower seat, or thinner layers, needs more.
 */
const MOUTH_SQUASH = 0.2;
/** A shorter spigot cone than this cannot hold a funnel upright in its seat, in mm. */
export const MIN_SPIGOT = 0.5;

export function funnelProfile(params: Params): FunnelProfile {
  const r = params.pour.diameter / 2;
  const { depth, halfAngleDeg } = params.seat;
  const { topDiameter, height, neckHeight, wall, tipWall, seatClearance, flangeWidth, flangeThickness } = params.funnel;
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

  const flange = flangeWidth > 0;
  // A layer height of 0, or none, as a user part way through typing gives, leaves no relief rather than a broken profile.
  const layer = params.print.layerHeight;
  let relief = 0;
  if (flange && layer > 0) {
    // The gap across is seatClearance / cos all down the cone, and grows by tan per mm of relief above its foot.
    const wanted = Math.max(RELIEF_LAYERS * layer, layer + (MOUTH_SQUASH - seatClearance / Math.cos(half)) / Math.tan(half));
    // No more than the spigot can spare, so a shallow seat still has MIN_SPIGOT of cone to centre the funnel.
    relief = Math.max(0, Math.min(wanted, -zTip - MIN_SPIGOT));
  }
  const rRelief = rNeck - relief * Math.tan(half);
  const rFlange = flange ? seatTopRadius({ diameter: params.pour.diameter, seatDepth: depth, seatHalfAngleDeg: halfAngleDeg }) + flangeWidth : 0;
  // Within 45 degrees of vertical even where the wall is thicker at the tip than at the neck. With the
  // relief the outside stops widening for its last layers, so the bore widens slower, to leave the wall at
  // the relief's top no thinner than the thinnest the funnel has anyway.
  const span = rNeckInner - rThroat;
  // With no room for that wall at all the bore never reaches the neck, which the funnel-wall rule refuses.
  const room = rRelief - Math.min(tipWall, wall) - rThroat;
  const zNeckInner = flange && span > 0
    ? zTip + Math.max(-zTip, span, room > 0 ? (span * -zTip) / room : Infinity)
    : zTip + Math.max(-zTip, rNeckInner - rThroat);
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
    rFlange,
    zFlange: flange ? flangeThickness : 0,
    zChamfer: flange ? flangeThickness + (rFlange - rNeck) : 0,
    relief,
    rRelief,
  };
}
