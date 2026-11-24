import type { CrossSection, Manifold, SimplePolygon } from 'manifold-3d';
import { orientSolid, type RigidTransform } from '../base/orient';
import { frameInverse, seamFrame } from '../field/side';
import type { Params } from '../params/schema';
import type { Diagnostic } from '../report/diagnostics';
import type { Arena } from '../solid/arena';
import { BELOW_CEILING, OPENING_SEGMENTS, seatTopRadius, ventTopRadius, type CutOpening } from './openings';
import { BAND_ROOM, PRY_LEG, type ClamRim, type SeamAxis } from './rim';

/**
 * G13.8: the seam's seal, a tongue loop joined to the base groove. Drawn in P with Manifold's CrossSection, in the seam
 * frame's (u, v) (seamFrame: v = z, u = b with an x seam and -b with a y seam), and extruded along h = a - xs: the
 * groove into the + half (pos), the tongue and the pins on the - half (neg).
 */

/** G13.8 step 1: S is closed by this radius, so the band does not follow every notch of the cavity's outline. */
export const SEAM_CLOSING = 3;
/** G13.8 step 1: S is grown by this, then simplified to it, so the simplified outline still holds S. */
export const SEAM_SIMPLIFY = 0.1;
/** G13.8 step 4: the tongue rises in this many steps, each narrower by its height times tan(ridge draft). */
export const TONGUE_STEPS = 6;
/** G13.8 step 7: the pins, their lead-in, the sockets' clearance and how much deeper the sockets are. */
export const PIN_RADIUS = 2;
export const PIN_HEIGHT = 3;
export const PIN_LEAD = 0.6;
export const SOCKET_CLEARANCE = 0.2;
export const SOCKET_DEEPER = 0.5;
/** Plastic round a socket: to the top face, and past the pry chamfer on the end face. */
export const PIN_WALL = 1.2;
/** How far a cutter or an added solid runs past the face it starts on, so the two share no plane. */
const OVER = 0.3;
/** Segments of a round offset's full circle. */
const ROUND_SEGMENTS = 32;

/** The seam frame's u of a mold b. */
export function uOfB(axis: SeamAxis, b: number): number {
  return axis === 'x' ? b : -b;
}

/** A b range as a u range, lowest first. */
export function uSpan(axis: SeamAxis, b0: number, b1: number): [number, number] {
  const p = uOfB(axis, b0), q = uOfB(axis, b1);
  return [Math.min(p, q), Math.max(p, q)];
}

/** The mold's b range of a rectangle across a seam on `axis`. */
export function bRange(axis: SeamAxis, rect: { x0: number; y0: number; x1: number; y1: number }): [number, number] {
  return axis === 'x' ? [rect.y0, rect.y1] : [rect.x0, rect.x1];
}

export function rectSection(arena: Arena, u0: number, u1: number, v0: number, v1: number): CrossSection {
  return arena.crossSection([[[u0, v0], [u1, v0], [u1, v1], [u0, v1]]]);
}

function round(arena: Arena, section: CrossSection, delta: number): CrossSection {
  return arena.track(section.offset(delta, 'Round', 2, ROUND_SEGMENTS));
}

/** The section's outer outlines only, its holes filled: Clipper gives holes the other way round. */
function filled(arena: Arena, section: CrossSection): CrossSection {
  const outer = arena.polygons(section).filter((polygon) => signedArea(polygon) > 0);
  return arena.crossSection(outer, 'Positive');
}

function signedArea(polygon: SimplePolygon): number {
  let sum = 0;
  for (let k = 0, j = polygon.length - 1; k < polygon.length; j = k++) sum += polygon[j][0] * polygon[k][1] - polygon[k][0] * polygon[j][1];
  return sum / 2;
}

/**
 * G13.8 step 1's S, exactly: both halves' tools, in the mold, turned into the seam frame and sliced at h = 0, P, and the
 * two sections joined. G13.2 step 7 keeps every tool face clear of P. Rows below z = 0, the prism into the rebate, are
 * left to J, which holds them.
 */
export function seamSection(arena: Arena, axis: SeamAxis, xs: number, tools: readonly Manifold[]): CrossSection {
  const frame = seamFrame(axis, xs);
  const both = arena.track(arena.api.CrossSection.union(tools.map((tool) => arena.track(orientSolid(arena, tool, frame).slice(0)))));
  if (both.isEmpty()) return both;
  const b = both.bounds();
  return arena.track(both.intersect(rectSection(arena, b.min[0] - 1, b.max[0] + 1, 0, b.max[1] + 1)));
}

/** The radius of an opening's cutter at the flat top, which its bore strip spans. */
export function openingTopRadius(opening: CutOpening): number {
  if (opening.kind === 'vent') return ventTopRadius(opening.diameter);
  return opening.seatDepth > 0 ? seatTopRadius(opening) : opening.diameter / 2;
}

/** G13.8, everything the seal's solids are cut from, in the seam frame's (u, v). */
export interface SeamSeal {
  axis: SeamAxis;
  xs: number;
  /** The mold to the seam frame. */
  frame: RigidTransform;
  /** rh + gx: the base groove's roof, where the band's legs land. */
  zr: number;
  /** gw = rw + 2 cG, the band's width. */
  gw: number;
  Zt: number;
  /** The cavity on P, R_sil (S closed, with the bore strips), E_in and the band. */
  S: CrossSection;
  Rsil: CrossSection;
  Ein: CrossSection;
  band: CrossSection;
  /**
   * Under the band's legs, the base groove's ring at its full width, [D + e1, D + e4], from below the shelf up to rh + gx:
   * the groove's walls are drafted, so at rh + gx its roof is 2 (rh + gx) tan(ridge draft) narrower than the legs, and
   * without this each leg would overhang a fin of pos's plastic that a print rounds into a duct past both grooves.
   */
  legs: CrossSection;
  /** The band's outside, offset(E_in, gw): what the pins and the rest keep clear of. */
  outer: CrossSection;
  /** The pins' centres in (u, v), none when they were dropped or turned off. */
  pins: [number, number][];
  diagnostics: Diagnostic[];
}

/**
 * G13.8 steps 1 to 3 and 7. R_sil = closing(S) with a bore strip per opening (|b - b0| <= its top radius, from its
 * cutter's bottom to Zt + 1); E_in = offset(R_sil, seamLand) with J = [D.b0 - e1, D.b1 + e1] x [-1, rh + gx], holes
 * filled; the band = offset(E_in, gw) - E_in, clipped to z >= rh + gx and to O across the pull, so at z = rh + gx its legs
 * land on the base groove's ring, [D + e1, D + e4] as gw = e4 - e1, and `legs` under them. Two pins at the top corners, outside the band with
 * BAND_ROOM to spare, clear of the pry chamfers, or none with an info line.
 */
export function seamSeal(arena: Arena, rim: ClamRim, S: CrossSection, openings: readonly CutOpening[], params: Params): SeamSeal {
  const { axis, xs, D, O, Zt, e1 } = rim;
  const j = params.joint;
  const zr = j.ridgeHeight + j.grooveExtraDepth;
  const gw = j.ridgeWidth + 2 * j.grooveClearance;
  const grown = arena.track(round(arena, S, SEAM_SIMPLIFY).simplify(SEAM_SIMPLIFY));
  const closed = round(arena, round(arena, grown, SEAM_CLOSING), -SEAM_CLOSING);
  const strips = openings.map((opening) => {
    const u0 = uOfB(axis, axis === 'x' ? opening.y : opening.x), r = openingTopRadius(opening);
    return rectSection(arena, u0 - r, u0 + r, opening.zb - BELOW_CEILING, Zt + 1);
  });
  const Rsil = strips.length > 0 ? arena.track(arena.api.CrossSection.union([closed, ...strips])) : closed;
  const [db0, db1] = bRange(axis, D);
  const [ju0, ju1] = uSpan(axis, db0 - e1, db1 + e1);
  const J = rectSection(arena, ju0, ju1, -1, zr);
  const Ein = filled(arena, arena.track(round(arena, Rsil, params.clamshell.seamLand).add(J)));
  const outer = round(arena, Ein, gw);
  const [ou0, ou1] = uSpan(axis, ...bRange(axis, O));
  const band = arena.track(arena.track(outer.subtract(Ein)).intersect(rectSection(arena, ou0, ou1, zr, Zt + 2)));
  const legs = arena.track(arena.api.CrossSection.union([rectSection(arena, ...uSpan(axis, db0 - rim.e4, db0 - e1), -1, zr), rectSection(arena, ...uSpan(axis, db1 + e1, db1 + rim.e4), -1, zr)]));

  const diagnostics: Diagnostic[] = [];
  const pins: [number, number][] = [];
  if (params.clamshell.pins) {
    const socket = PIN_RADIUS + SOCKET_CLEARANCE;
    const [b0, b1] = bRange(axis, O);
    const v = Zt - PIN_WALL - socket;
    const spots: [number, number][] = [b0 + PRY_LEG + PIN_WALL + socket, b1 - PRY_LEG - PIN_WALL - socket].map((b) => [uOfB(axis, b), v]);
    const keep = round(arena, outer, BAND_ROOM);
    const fits = spots.every(([u, vv]) => arena.track(keep.intersect(circle(arena, u, vv, socket))).isEmpty());
    if (fits && v - socket > zr) {
      pins.push(...spots);
    } else {
      diagnostics.push({ code: 'seam-pins-dropped', severity: 'info', message: `The registration pins were left out, as the seam's top corners have no room for them clear of its seal, so the tongue alone keeps the halves in line, to within ${j.grooveClearance.toFixed(2)} mm.` });
    }
  }
  return { axis, xs, frame: seamFrame(axis, xs), zr, gw, Zt, S, Rsil, Ein, band, legs, outer, pins, diagnostics };
}

function circle(arena: Arena, u: number, v: number, r: number): CrossSection {
  return arena.track(arena.api.CrossSection.circle(r, OPENING_SEGMENTS).translate([u, v]));
}

/** A solid drawn in the seam frame, back in the mold's. */
function toMold(arena: Arena, seal: SeamSeal, solid: Manifold): Manifold {
  return orientSolid(arena, solid, frameInverse(seal.frame));
}

/** `section` extruded along h from h0 to h1, in the seam frame. */
function prism(arena: Arena, section: CrossSection, h0: number, h1: number): Manifold {
  return arena.track(arena.extrude(section, h1 - h0).translate([0, 0, h0]));
}

/**
 * G13.8 step 4: the groove, cut from pos: the band extruded from P to rh + gx along +a, where it opens into the base
 * groove, and under its legs the base groove's ring at full width over the same depth (SeamSeal's `legs`). The cutter
 * starts a little short of P, on neg's side, where it cuts nothing.
 */
export function seamGroove(arena: Arena, seal: SeamSeal): Manifold {
  const section = arena.track(seal.band.add(seal.legs));
  return toMold(arena, seal, prism(arena, section, -OVER, seal.zr));
}

/**
 * G13.8 step 4: the tongue, added to neg: the band offset inward by cG, rising rh along +a in TONGUE_STEPS steps, each
 * narrower by its height times tan(ridge draft), flush with the top face. It starts cG above the base groove's roof, so it
 * never meets the ridge, and the gap under its tip joins the base groove.
 */
export function seamTongue(arena: Arena, seal: SeamSeal, params: Params): Manifold {
  const j = params.joint;
  const step = j.ridgeHeight / TONGUE_STEPS;
  const tan = Math.tan((j.ridgeDraftDeg * Math.PI) / 180);
  const b = seal.band.bounds();
  const top = rectSection(arena, b.min[0] - 1, b.max[0] + 1, seal.zr, seal.Zt);
  const layers: Manifold[] = [];
  for (let k = 0; k < TONGUE_STEPS; k++) {
    const section = arena.track(round(arena, seal.band, -(j.grooveClearance + k * step * tan)).intersect(top));
    if (section.isEmpty()) continue;
    layers.push(prism(arena, section, k === 0 ? -OVER : k * step, (k + 1) * step));
  }
  return toMold(arena, seal, arena.track(arena.api.Manifold.union(layers)));
}

/** G13.8 step 7: the pins on neg, upright in its print pose with their 45 degree lead-in on top. */
export function seamPins(arena: Arena, seal: SeamSeal): Manifold[] {
  const { Manifold } = arena.api;
  return seal.pins.map(([u, v]) => {
    const body = arena.track(Manifold.cylinder(PIN_HEIGHT - PIN_LEAD + OVER, PIN_RADIUS, PIN_RADIUS, OPENING_SEGMENTS).translate([u, v, -OVER]));
    const lead = arena.track(Manifold.cylinder(PIN_LEAD, PIN_RADIUS, PIN_RADIUS - PIN_LEAD, OPENING_SEGMENTS).translate([u, v, PIN_HEIGHT - PIN_LEAD]));
    return toMold(arena, seal, arena.track(body.add(lead)));
  });
}

/** G13.8 step 7: the sockets in pos, SOCKET_CLEARANCE wider than the pins and SOCKET_DEEPER deeper, so the seam faces touch first. */
export function seamSockets(arena: Arena, seal: SeamSeal): Manifold[] {
  const r = PIN_RADIUS + SOCKET_CLEARANCE;
  return seal.pins.map(([u, v]) => toMold(arena, seal, arena.track(arena.api.Manifold.cylinder(PIN_HEIGHT + SOCKET_DEEPER + OVER, r, r, OPENING_SEGMENTS).translate([u, v, -OVER]))));
}
