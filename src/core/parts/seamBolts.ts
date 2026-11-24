import type { Params } from '../params/schema';
import { SEAL_SPACING_MM } from '../report/clamp';
import type { Diagnostic } from '../report/diagnostics';
import { BOLT_HOLD_N, BRIDGE_LIMIT, FASTENERS, longestLength, OVER_SINK_LAYERS, OVER_SINK_MM, standardLength, threadPast, type BoltSize, type Fastener } from './fasteners';
import type { ClamRim, SeamAxis } from './rim';

/**
 * G13.10: the two-part cover's seam bolts. M3 countersunk screws (ISO 10642 or DIN 7991) run along a through a pair of
 * printed lugs on each end face, one lug on each half, into an ISO 4032 hex nut held in a slot of the + half's lug:
 * heads always in the - half, nuts always in the + half. This file sizes them from M10's hardware and places them up
 * the end faces; the solids and their cuts are MP3's.
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
