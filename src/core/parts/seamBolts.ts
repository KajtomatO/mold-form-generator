import type { Manifold, Vec2 } from 'manifold-3d';
import { orientSolid } from '../base/orient';
import { frameInverse, halfFrame } from '../field/frames';
import type { Params } from '../params/schema';
import { SEAL_SPACING_MM } from '../report/clamp';
import type { Diagnostic } from '../report/diagnostics';
import type { Arena } from '../solid/arena';
import { column, OVERLAP, PAST, slotOutline } from './bolts';
import { BOLT_HOLD_N, BRIDGE_LIMIT, FASTENERS, longestLength, OVER_SINK_LAYERS, OVER_SINK_MM, standardLength, threadPast, type BoltSize, type Fastener } from './fasteners';
import type { ClamRim, SeamAxis } from './rim';

/**
 * G13.10: the two-part cover's seam bolts. M3 countersunk screws (ISO 10642 or DIN 7991) run along a through a pair of
 * printed lugs on each end face, one lug on each half, into an ISO 4032 hex nut held in a slot of the + half's lug:
 * heads always in the - half, nuts always in the + half. This file sizes them from M10's hardware, places them up the
 * end faces (MP1), and builds the lugs, their relief and their cuts (MP3).
 */

/** G13.10.2: the lug's height along z, at least, so about 73 mm2 of interlayer section stays across the slot's level at M3. */
export const LUG_HEIGHT = 14;
/** G13.10.6: between the top lug and the pry chamfers' foot, in mm. */
export const LUG_GAP = 1;
/** G13.10.6: room over a lug's slot to drop a nut in (6.35 mm across corners at M3), so the lug above never blocks it. */
export const LUG_CLEAR = 8;
/** G13.7 step 5: how far down from Zt the pry chamfers run on the end faces. */
export const PRY_RUN = 12;
/** G13.10.3: how far a lug's base overlaps into the wall, in mm. */
export const LUG_OVERLAP = 1;
/** G13.10.7: what the bottom pair is counted at against the taper wedge, two bolts at BOLT_HOLD_N. */
export const BOTTOM_HOLD_N = 2 * BOLT_HOLD_N;

/** G13.10.2's hex keys for the sizes' countersunk heads (ISO 10642, and ISO 14581's M2.5 head taken with a 1.5 mm key). */
const HEX_KEY: Record<BoltSize, number> = { 'M2.5': 1.5, M3: 2, M4: 2.5 };

/** G13.10.2, from M10's `boltNeeds` and `FASTENERS` with the same names. Lengths in mm along a, z or w as each says. */
export interface SeamBoltNeeds {
  size: BoltSize;
  fastener: Fastener;
  minWall: number;
  layer: number;
  /** r: each lug's seam face lies one layer back from P, so a pair keeps a 2r gap (G13.10.1). */
  relief: number;
  holeClearance: number;
  nutClearance: number;
  /** rh, rk: the hole's radius, and the countersink's and access bore's. */
  holeRadius: number;
  sinkRadius: number;
  /** rk - rh, at 45 degrees. */
  sinkDepth: number;
  /** s: the slot's width, the bridge its ceiling spans in the pose. */
  slotWidth: number;
  /** s / sqrt 3: how far the hex pocket reaches past the axis. */
  apex: number;
  slotHeight: number;
  /** e: from the axis to the lug's sides in w; p = 2e, the lug's projection past O; c = e, the axis from the end face. */
  e: number;
  p: number;
  c: number;
  /** hL: the lug's height along z. */
  height: number;
  /** f_min: from P to the slot's seam-side face, at least: one minWall of top skin over the bridge's sag, one of plate. */
  fMin: number;
  /** Tn,min: from P to the head's face, at least, so the plate over the countersink holds. */
  tnMin: number;
  /** The shortest standard length that is safe wherever f lands within its layer. */
  autoLength: number;
  /** The length in use: the user's bolts.length, shared with the corner bolts, or the auto one. */
  length: number;
  /** The 2 mm key for M3. */
  hexKey: number;
}

/**
 * G13.10.2's sizes. With the relief, Tn,min counts one layer from P, and the auto length is the shortest standard one
 * that passes the nut by 2 threads with the slot's face a layer past f_min: M2.5 10, M3 10, M4 12.
 */
export function seamBoltNeeds(params: Params): SeamBoltNeeds {
  const b = params.bolts;
  const fastener = FASTENERS[b.size];
  const layer = params.print.layerHeight;
  const relief = layer;
  const holeRadius = fastener.d / 2 + b.holeClearance;
  const sinkRadius = fastener.headDiameter / 2 + b.holeClearance;
  const slotWidth = fastener.nutFlats + 2 * b.nutClearance;
  const apex = slotWidth / Math.sqrt(3);
  const slotHeight = fastener.nutHeight + 2 * b.nutClearance + layer;
  const e = Math.max(sinkRadius, apex) + b.minWall;
  const fMin = relief + 2 * b.minWall;
  const sinkDepth = sinkRadius - holeRadius;
  const tnMin = relief + sinkDepth + Math.max(OVER_SINK_MM, OVER_SINK_LAYERS * layer);
  const autoLength = standardLength(tnMin + fMin + layer + fastener.nutHeight + threadPast(fastener)) ?? 40;
  return {
    size: b.size,
    fastener,
    minWall: b.minWall,
    layer,
    relief,
    holeClearance: b.holeClearance,
    nutClearance: b.nutClearance,
    holeRadius,
    sinkRadius,
    sinkDepth,
    slotWidth,
    apex,
    slotHeight,
    e,
    p: 2 * e,
    c: e,
    height: Math.max(2 * e, LUG_HEIGHT),
    fMin,
    tnMin,
    autoLength,
    length: b.length ?? autoLength,
    hexKey: HEX_KEY[b.size],
  };
}

/** G13.3 and G13.10.8: the lugs widen each half's pose by 2p across b, 19.0 mm at M3. */
export function lugBedGrowth(needs: Pick<SeamBoltNeeds, 'p'>): number {
  return 2 * needs.p;
}

/**
 * G13.10.4 step 1, `placeBolts`' rule: the slot's face is a whole number of layers from the + half's back face, which
 * lies at H+ from P in its pose, so f lands in [f_min, f_min + layer).
 */
export function slotFace(depth: number, needs: Pick<SeamBoltNeeds, 'fMin' | 'layer'>): number {
  return depth - needs.layer * Math.floor((depth - needs.fMin) / needs.layer + 1e-9);
}

/** G13.10.5: the - lug's flat thickness Tn = L - f - nutHeight - threadPast, so a flush head passes the nut by exactly 2 threads. */
export function headThickness(length: number, f: number, fastener: Fastener): number {
  return length - f - fastener.nutHeight - threadPast(fastener);
}

/** One lug pair: on which end face, its height, and its axis in the mold, running along a. */
export interface SeamBoltSpot {
  /** b0 or b1: the end face at O.b0 or O.b1. */
  end: 'b0' | 'b1';
  /** z_k, the pair's centre. */
  z: number;
  /** The axis's b, c outside the end face. */
  b: number;
}

/** Where the seam bolts go, and what their lugs and cuts are built from. Plain data, as it travels with the rim. */
export interface SeamBoltLayout extends SeamBoltNeeds {
  axis: SeamAxis;
  xs: number;
  /** H- and H+: each half's depth from P to its back face. */
  depths: [number, number];
  /** The slot's face from P in the + lug, and the flat thicknesses of the - and + lugs. */
  f: number;
  tn: number;
  tp: number;
  /** z_bot and z_top: the lowest and highest centres the room allows. */
  zBottom: number;
  zTop: number;
  /** Lug pairs on each end face, and in all (2 per end face's count). */
  perEnd: number;
  count: number;
  zs: number[];
  spots: SeamBoltSpot[];
  /** Along a, where the base tape's strips along b must not go: from P, Tn + p in front and Tp + p behind. */
  lugZone: [number, number];
  /** The length in use passes the nut and stops a minWall short of the - half's back face. */
  lengthFits: boolean;
  /** The shortest and longest standard lengths that fit here. */
  shortest: number | null;
  longest: number | null;
  /** The force guard's count was held back by the room between lugs. */
  heldBack: boolean;
  diagnostics: Diagnostic[];
}

const mm = (v: number): string => v.toFixed(1);

/**
 * G13.10.5 and G13.10.6: the lugs' heights, both end faces alike, and the screw's length checks. The lowest lug's
 * bottom is flush with the cover's bottom edge, over the rebate wall, where it takes the taper wedge; the highest
 * keeps clear of the pry chamfers. Past the room for one, `seam-bolt-no-room`; under the room for two with a nut's
 * clearance between them, one with `seam-bolt-single`; otherwise one every SEAL_SPACING_MM at most, at least two, and
 * more while 2n BOLT_HOLD_N is short of `holdN`.
 */
export function placeSeamBolts(needs: SeamBoltNeeds, rim: Pick<ClamRim, 'O' | 'Zt' | 'Tb' | 'proud'>, axis: SeamAxis, xs: number, holdN = 0): SeamBoltLayout {
  const { O, Zt, Tb, proud } = rim;
  const [a0, a1, b0, b1] = axis === 'x' ? [O.x0, O.x1, O.y0, O.y1] : [O.y0, O.y1, O.x0, O.x1];
  const depths: [number, number] = [xs - a0, a1 - xs];
  const { fastener, height: hL, minWall, length } = needs;
  const f = slotFace(depths[1], needs);
  const tn = headThickness(length, f, fastener);
  const tp = f + needs.slotHeight + minWall;
  const zBottom = -Tb + proud + hL / 2;
  const zTop = Zt - PRY_RUN - LUG_GAP - hL / 2;
  const diagnostics: Diagnostic[] = [];
  const span = zTop - zBottom;
  let perEnd = 0, heldBack = false;
  if (span < -1e-9) {
    // Both heights as printed, from the cover's bottom edge: the halves', and the least a lug fits under the chamfers in.
    const tall = Zt + Tb - proud, needed = hL + PRY_RUN + LUG_GAP;
    diagnostics.push({ code: 'seam-bolt-no-room', severity: 'error', also: ['clamshell.fastener', 'cover.topCap'], message: `The halves are ${mm(tall)} mm tall, too low for a seam bolt's ${hL} mm lug under the pry chamfers, which needs them at least ${mm(needed)} mm tall: set Seam fasteners to None, or raise Top cap by at least ${mm(needed - tall)} mm.` });
  } else if (span < hL + LUG_CLEAR - 1e-9) {
    perEnd = 1;
    diagnostics.push({ code: 'seam-bolt-single', severity: 'info', message: `The halves are low, so each end face takes one seam bolt, at the bottom edge, where the taper pushes the seam open.` });
    heldBack = 2 * BOLT_HOLD_N < holdN - 1e-9;
  } else {
    perEnd = Math.max(2, Math.ceil(span / SEAL_SPACING_MM - 1e-9) + 1);
    // The force guard, held back where the gaps would leave no room to drop a nut in.
    const most = Math.floor(span / (hL + LUG_CLEAR) + 1e-9) + 1;
    while (2 * perEnd * BOLT_HOLD_N < holdN && perEnd < most) perEnd++;
    heldBack = 2 * perEnd * BOLT_HOLD_N < holdN - 1e-9;
  }
  if (heldBack) {
    diagnostics.push({ code: 'seam-bolt-held-back', severity: 'warning', also: ['clamshell.fastener', 'bolts.size'], message: `The seam needs holding with ${holdN.toFixed(0)} N, and the ${2 * perEnd} seam bolts that fit up the end faces are counted at ${2 * perEnd * BOLT_HOLD_N} N: set Seam fasteners to None and hold the seam with clamps and tape belts, or use a larger bolt size.` });
  }
  const zs = perEnd === 1 ? [zBottom] : Array.from({ length: perEnd }, (_, k) => zBottom + (k * span) / (perEnd - 1));
  const spots: SeamBoltSpot[] = [];
  for (const end of ['b0', 'b1'] as const) for (const z of zs) spots.push({ end, z, b: end === 'b0' ? b0 - needs.c : b1 + needs.c });

  const pastNut = f + fastener.nutHeight + threadPast(fastener);
  const shortest = standardLength(needs.tnMin + pastNut);
  const longest = longestLength(depths[0] - minWall + pastNut);
  const short = tn < needs.tnMin - 1e-9, long = tn > depths[0] - minWall + 1e-9;
  const name = `${needs.size} x ${length}`;
  if (perEnd > 0 && short) {
    diagnostics.push({ code: 'seam-bolt-short', severity: 'warning', also: ['bolts.length'], message: `An ${name} mm screw leaves the head side's lug ${tn.toFixed(2)} mm thick, under the ${needs.tnMin.toFixed(2)} mm that keeps plastic over its countersink while it passes the nut by 2 threads: ${shortest !== null ? `use ${shortest} mm or longer` : 'no standard length is long enough'}.` });
  }
  if (perEnd > 0 && long) {
    diagnostics.push({ code: 'seam-bolt-long', severity: 'warning', also: ['bolts.length'], message: `An ${name} mm screw needs the head side's lug ${tn.toFixed(2)} mm thick, more than the ${mm(depths[0])} mm half less a ${minWall} mm wall holds: ${longest !== null && longest >= needs.tnMin + pastNut - 1e-9 ? `use ${longest} mm or shorter` : 'use a shorter screw'}.` });
  }
  if (perEnd > 0 && needs.slotWidth > BRIDGE_LIMIT + 1e-9) {
    diagnostics.push({ code: 'bolt-bridge', severity: 'warning', also: ['bolts.size'], message: `Each seam bolt's nut slot bridges ${needs.slotWidth.toFixed(1)} mm in print pose, past the ${BRIDGE_LIMIT} mm that prints flat without supports on most printers: use a smaller nut clearance or bolt size.` });
  }
  return {
    ...needs,
    axis,
    xs,
    depths,
    f,
    tn,
    tp,
    zBottom,
    zTop,
    perEnd,
    count: 2 * perEnd,
    zs,
    spots,
    lugZone: [tn + needs.p, tp + needs.p],
    lengthFits: !short && !long,
    shortest,
    longest,
    heldBack,
    diagnostics,
  };
}

// ----- MP3: the lugs, their relief and their cuts (G13.10.3, G13.10.4) -----

/** A spot's end face, as the b of O's face there and the sign of w, outward from it along b. */
function endFace(layout: Pick<SeamBoltLayout, 'c'>, spot: SeamBoltSpot): { b: number; out: 1 | -1 } {
  return spot.end === 'b0' ? { b: spot.b + layout.c, out: -1 } : { b: spot.b - layout.c, out: 1 };
}

/** A prism over z0 to z1 of a polygon given in (a, w) at an end face, in mold coordinates. */
function prismAW(arena: Arena, axis: SeamAxis, face: { b: number; out: 1 | -1 }, points: [number, number][], z0: number, z1: number): Manifold {
  const plan = points.map(([a, w]) => {
    const b = face.b + face.out * w;
    return (axis === 'x' ? [a, b] : [b, a]) as [number, number];
  });
  // NonZero, so the winding a mirrored end face gives is filled all the same.
  return arena.track(arena.extrude(arena.crossSection([plan], 'NonZero'), z1 - z0).translate([0, 0, z0]));
}

/** Tests only: negative controls of the audit and of the gap a pair keeps. */
export interface LugOptions {
  /** A lug with no gussets, square under its flat thicknesses. */
  flat?: boolean;
  /** False: no relief, so the lug faces of a pair touch in P. */
  relief?: boolean;
}

/**
 * G13.10.3: per lug pair, in mold coordinates, the prism over z_k -+ hL/2 of the trapezoid in (a, w) with corners
 * (xs - Tn - p - LUG_OVERLAP, -LUG_OVERLAP), (xs - Tn, p), (xs + Tp, p), (xs + Tp + p + LUG_OVERLAP, -LUG_OVERLAP): both
 * lugs of a pair as one solid, which the trim at P parts. Its slanted sides, the gussets, are at exactly 45 degrees, so
 * each half's prints with no supports on its back. The shared block takes these before the trim, cut to O's slab along a.
 */
export function lugSolid(arena: Arena, layout: SeamBoltLayout, options: LugOptions = {}): Manifold[] {
  const { xs, tn, tp, p, height: hL } = layout;
  const e = LUG_OVERLAP;
  const points: [number, number][] = options.flat
    ? [[xs - tn, -e], [xs - tn, p], [xs + tp, p], [xs + tp, -e]]
    : [[xs - tn - p - e, -e], [xs - tn, p], [xs + tp, p], [xs + tp + p + e, -e]];
  return layout.spots.map((spot) => prismAW(arena, layout.axis, endFace(layout, spot), points, spot.z - hL / 2, spot.z + hL / 2));
}

/**
 * G13.10.1: on each end face, the slab |a - xs| < r outside O (w > 0) over the lugs' heights, cut from both halves, so
 * each lug's seam face lies one layer back from P and a pair keeps a 2r gap. Each half's own seam face, inside O, is
 * untouched, so the screw's preload reaches the seal through the lugs' roots.
 */
export function lugRelief(arena: Arena, layout: SeamBoltLayout): Manifold[] {
  const { xs, relief: r, p } = layout;
  return reliefEnds(layout).map(({ face, z0, z1 }) => prismAW(arena, layout.axis, face, [[xs - r, 0], [xs + r, 0], [xs + r, p + PAST], [xs - r, p + PAST]], z0, z1));
}

/** lugRelief's slabs: one per end face with lugs, out p + PAST from it, over one z span from the lowest lug to the highest. */
function reliefEnds(layout: SeamBoltLayout): { face: { b: number; out: 1 | -1 }; z0: number; z1: number }[] {
  if (layout.spots.length === 0) return [];
  const hL = layout.height;
  const z0 = Math.min(...layout.zs) - hL / 2 - PAST, z1 = Math.max(...layout.zs) + hL / 2 + PAST;
  const ends = (['b0', 'b1'] as const).flatMap((end) => layout.spots.filter((spot) => spot.end === end).slice(0, 1));
  return ends.map((spot) => ({ face: endFace(layout, spot), z0, z1 }));
}

/**
 * lugRelief's slabs on P, in (b, z), which hold the lugs too: G13.5's room rule keeps the openings' bands out of them.
 */
export function lugReliefBoxes(layout: SeamBoltLayout): { b0: number; b1: number; z0: number; z1: number }[] {
  return reliefEnds(layout).map(({ face, z0, z1 }) => {
    const far = face.b + face.out * (layout.p + PAST);
    return { b0: Math.min(face.b, far), b1: Math.max(face.b, far), z0, z1 };
  });
}

/** A spot's axis in a half's pull frame (u, v), v = z_k. */
export function lugAxis(layout: Pick<SeamBoltLayout, 'axis' | 'xs'>, spot: SeamBoltSpot, sign: 1 | -1): [number, number] {
  const { rotation: R, translation: t } = halfFrame(layout.axis, layout.xs, sign);
  const [x, y, z] = layout.axis === 'x' ? [layout.xs, spot.b, spot.z] : [spot.b, layout.xs, spot.z];
  return [R[0] * x + R[1] * y + R[2] * z + t[0], R[3] * x + R[4] * y + R[5] * z + t[1]];
}

/** Tests only: each a negative control of the cuts' reading, or of the audit. */
export interface SeamBoltCutOptions {
  /** False: the pos hole runs on into the slot, with no membrane. */
  membrane?: boolean;
  /** The slot stops this far short of the lug's top face. */
  slotShort?: number;
  /** The access bore ends this far past Tn, short of the gusset. */
  boreTo?: number;
  /** A counterbore of rk in place of the countersink's cone. */
  counterbore?: boolean;
  /** The slot leaving along -h: built from f toward P, so its ceiling is not the bridge listed. */
  slotTowardSeam?: boolean;
}

/**
 * G13.10.4: one half's cuts per lug, built in the half's pull frame (halfFrame) with h as Manifold's z, where M10's
 * `column` applies, and turned back. neg (-1), the head side: the hole from the relieved face to the countersink, its
 * 45 degree cone opening toward the back face, and the access bore on through the gusset, so a short 2 mm key reaches
 * the head along -a. pos (+1), the nut side: the hole to a one-layer membrane under the slot's face at f, the slot over
 * it leaving through the lug's top face (+z), and the hole on past the back face, so the screw never bottoms out.
 */
export function seamBoltCuts(arena: Arena, layout: SeamBoltLayout, sign: 1 | -1, options: SeamBoltCutOptions = {}): Manifold[] {
  const back = frameInverse(halfFrame(layout.axis, layout.xs, sign));
  const { relief: r, holeRadius: rh, sinkRadius: rk, sinkDepth, tn, f, layer, slotHeight, height: hL } = layout;
  const depth = layout.depths[sign > 0 ? 1 : 0];
  const cuts: Manifold[] = [];
  // A column held to h in [r - PAST, depth + PAST], its radius taken along with it, and none where nothing is left: a
  // length off its range (seam-bolt-short or seam-bolt-long) moves Tn past either end, and the halves still build.
  const lo = r - PAST, hi = depth + PAST;
  const add = (u: number, v: number, z0: number, z1: number, r0: number, r1: number): void => {
    const at = (z: number): number => r0 + ((r1 - r0) * (z - z0)) / (z1 - z0);
    const c0 = Math.max(z0, lo), c1 = Math.min(z1, hi);
    if (c1 > c0 + OVERLAP) cuts.push(column(arena, u, v, c0, c1, at(c0), at(c1)));
  };
  for (const spot of layout.spots) {
    const [u, v] = lugAxis(layout, spot, sign);
    if (sign < 0) {
      add(u, v, lo, tn - sinkDepth, rh, rh);
      add(u, v, tn - sinkDepth, tn, options.counterbore ? rk : rh, rk);
      add(u, v, tn, options.boreTo !== undefined ? tn + options.boreTo : hi, rk, rk);
    } else {
      add(u, v, lo, options.membrane === false ? f + OVERLAP : f - layer, rh, rh);
      const slotRun = hL / 2 + PAST - (options.slotShort !== undefined ? options.slotShort + PAST : 0);
      const outline = arena.crossSection([slotOutline(layout, { x: u, y: v, sx: 1, sy: 1, exit: 'y1', slotRun })]);
      const from = options.slotTowardSeam ? f - slotHeight : f;
      cuts.push(arena.track(arena.extrude(outline, slotHeight).translate([0, 0, from])));
      add(u, v, f + slotHeight - OVERLAP, hi, rh, rh);
    }
  }
  return cuts.map((cut) => orientSolid(arena, cut, back));
}

/** A nut slot's face toward P in the pos half, a bridge in its pose: at a = xs + f, its outline in (b, z). */
export interface SeamBoltBridge {
  a: number;
  outline: Vec2[];
  span: number;
}

/** G13.10.10: the bridges the audit lists in pos's pose, one per lug pair: each slot's face toward P. There are none in neg. */
export function seamBoltBridges(layout: SeamBoltLayout): SeamBoltBridge[] {
  return layout.spots.map((spot) => {
    const [u, v] = lugAxis(layout, spot, 1);
    const outline = slotOutline(layout, { x: u, y: v, sx: 1, sy: 1, exit: 'y1', slotRun: layout.height / 2 + PAST });
    // Pos's frame has u = b with an x seam and -b with a y seam.
    return { a: layout.xs + layout.f, outline: outline.map(([pu, pv]) => [layout.axis === 'x' ? pu : -pu, pv] as Vec2), span: layout.slotWidth };
  });
}

/** Whether a point in mold coordinates lies on one of these bridges: within `tol` of its plane and inside its outline. */
export function onSeamBoltBridge(bridges: readonly SeamBoltBridge[], axis: SeamAxis, x: number, y: number, z: number, tol = 1e-3): boolean {
  const [a, b] = axis === 'x' ? [x, y] : [y, x];
  return bridges.some((bridge) => Math.abs(a - bridge.a) <= tol && inside(b, z, bridge.outline));
}

function inside(px: number, py: number, polygon: readonly Vec2[]): boolean {
  let hit = false;
  for (let k = 0, j = polygon.length - 1; k < polygon.length; j = k++) {
    const [xk, yk] = polygon[k], [xj, yj] = polygon[j];
    if (yk > py !== yj > py && px < ((xj - xk) * (py - yk)) / (yj - yk) + xk) hit = !hit;
  }
  return hit;
}

/**
 * The seam bolts' lines for the build: placeSeamBolts' own (G13.10.13's rules on the count, the length and the bridge).
 * Every wall the cuts leave is minWall or more by e's rule (G13.10.2), whatever the size or the clearances, so none is
 * checked here; test/regression/seamBolts.test.ts reads them off the cutters.
 */
export function seamBoltDiagnostics(layout: SeamBoltLayout): Diagnostic[] {
  return layout.diagnostics;
}
