import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { FLANGE_GAP, flangeReach, openingSizes } from '../analysis/validate';
import { defaultParams } from '../params/defaults';
import type { Params } from '../params/schema';
import { EOL, wrap } from '../report/text';
import { checked, withArena, type Arena } from '../solid/arena';
import { TOOL_BOTTOM } from '../solid/tool';
import { buildBaseBody } from './base';
import { baseBoltCutters, boltNeeds, coverBoltCutters, type BoltLayout } from './bolts';
import type { ClamshellBuildOptions } from './clamshell';
import { buildCoverBody, trimHalf } from './cover';
import { standardLength, threadPast } from './fasteners';
import { pourCutters, VENT_CHAMFER, ventCutters } from './openings';
import { basePose, coverPose, halfPose, poseToStl } from './poses';
import { deriveRim, type Rim } from './rim';
import type { Rect } from '../solid/rect';
import { headThickness, LUG_OVERLAP, lugRelief, lugSolid, seamBoltCuts, seamBoltNeeds, slotFace, type SeamBoltLayout } from './seamBolts';
import { clipNeeds, earSolids, keyHead, keySolid, PLATE_GAP, socketCutters, type ClipLayout, type ClipSpot, type EarOptions } from './clips';

const TOOL_SIDE = 20;
const TOOL_HEIGHT = 6;
/** The bound of G8 around the box tool, from which the rim is derived as for a model. */
const BOUND_SLACK = 0.5;

const NOTCH_WIDTH = 1;
const NOTCH_DEPTH = 0.8;
const NOTCH_PITCH = 2.5;

export interface FitVariant {
  id: string;
  /** Taper clearance per side. */
  cT: number;
  /** Groove clearance per side. */
  cG: number;
  /** Edge notches on the variant's side, which is how to tell the printed pieces apart. */
  notches: number;
  /** +x for the taper series, +y for the groove series. */
  series: 'taper' | 'groove';
}

/**
 * The plan's lower limit on the groove clearance: under it the ridge could touch before the taper,
 * and the piece would read the ridge rather than the groove's clearance.
 */
const GROOVE_OVER_TAPER = 0.15;

/**
 * D4 and G12: first cT with the groove generous enough never to touch, then cG, in steps of 0.1 mm.
 * The taper fits first, so a groove pair only seats on a printer that seats its cT. So the groove series
 * is built at the cT in params, and a user whose best taper is not the default regenerates it at theirs.
 */
export function fitVariants(params: Params = defaultParams()): FitVariant[] {
  const generousGroove = 0.55;
  const defaults = defaultParams().joint;
  const cT = params.joint.taperClearance;
  const firstGroove = Math.max(defaults.grooveClearance, cT + GROOVE_OVER_TAPER);
  const variants: FitVariant[] = [];
  for (let k = 0; k < 4; k++) {
    const step = round(defaults.taperClearance + 0.1 * k);
    variants.push({ id: `taper-${step.toFixed(2)}`, cT: step, cG: generousGroove, notches: k + 1, series: 'taper' });
  }
  for (let k = 0; k < 4; k++) {
    const cG = round(firstGroove + 0.1 * k);
    variants.push({ id: `groove-${cG.toFixed(2)}-taper-${cT.toFixed(2)}`, cT, cG, notches: k + 1, series: 'groove' });
  }
  return variants;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The rim of one variant: the real derivation, around a cavity bound that is just the box tool. The joint
 * pieces never carry bolts, which the bolt coupon tests on its own, so they stay small and the same.
 */
export function fitRim(params: Params, variant: FitVariant): Rim {
  const half = TOOL_SIDE / 2;
  const model = { x0: -half, y0: -half, x1: half, y1: half };
  const D = { x0: -half - BOUND_SLACK, y0: -half - BOUND_SLACK, x1: half + BOUND_SLACK, y1: half + BOUND_SLACK };
  const joint = { ...params.joint, taperClearance: variant.cT, grooveClearance: variant.cG };
  return deriveRim({ D, model, hMax: TOOL_HEIGHT, offsets: [[0, 0]] }, { ...params, joint, grid: { ...params.grid, edge: null }, bolts: { ...params.bolts, enabled: false } });
}

/** The bolt coupon's two pieces, centred on one bolt, with its own flat top: the bolt's cuts as the mold has them. */
export interface BoltCoupon {
  bolts: BoltLayout;
  base: Manifold;
  cover: Manifold;
  /** The cover piece's flat top, which is on the bed in its print pose. */
  top: number;
}

/**
 * M10's fit test of the bolts: a square of base with one countersunk hole, and a square of cover with one
 * nut slot opening at +x, its membrane, and the hole for the screw's end, at the clearances set. The same
 * cutters as the mold, with the slot's floor at the lowest the mold's takes, as the fit test is built
 * without a model (the mold's is up to a layer higher), and a whole number of layers under the piece's top.
 */
export function buildBoltCoupon(arena: Arena, params: Params): BoltCoupon {
  const needs = boltNeeds(params);
  const { minWall, layer } = needs;
  const half = Math.ceil(Math.max(needs.sinkRadius, needs.slotWidth / Math.sqrt(3), needs.slotWidth / 2) + minWall + 1);
  const Tb = params.base.thickness;
  const slotFloor = needs.slotFloorMin;
  const slotTop = slotFloor + needs.slotHeight;
  const top = slotFloor + layer * Math.ceil((Math.max(needs.wantedTop, slotTop) + minWall - slotFloor) / layer - 1e-9);
  const bolts: BoltLayout = {
    ...needs,
    bed: -Tb,
    slotFloor,
    slotTop,
    holeTop: Math.min(needs.wantedTop, top - minWall),
    reach: Tb + slotFloor + needs.fastener.nutHeight + threadPast(needs.fastener),
    longest: null,
    jointLand: 0,
    spots: [{ x: 0, y: 0, sx: 1, sy: 1, exit: 'x1', slotRun: half + 1 }],
  };
  const { Manifold } = arena.api;
  const base = checked(arena.track(Manifold.difference([boxAt(arena, -half, -half, -Tb, half, half, 0), ...baseBoltCutters(arena, bolts)])), 'The bolt coupon base');
  const cover = checked(arena.track(Manifold.difference([boxAt(arena, -half, -half, 0, half, half, top), ...coverBoltCutters(arena, bolts)])), 'The bolt coupon cover');
  return { bolts, base, cover, top };
}

/** G13.10.12's coupon of the seam bolts: a stub of each half's end wall with one lug pair, cut as the halves' are. */
export interface SeamBoltCoupon {
  /** One pair on the end face at b = 0 of an x seam at xs = 0, its centre at z = 0. */
  bolts: SeamBoltLayout;
  /** The stub's box, which stands for the halves' O: the wall on y in [-wall, 0], each half as deep as its lug needs. */
  O: Rect;
  /** neg (the head side) first. */
  halves: [Manifold, Manifold];
}

/**
 * G13.10.12: with Seam fasteners Bolts, the fit test's two seam bolt coupons, from the same functions as the halves: a
 * wall stub (w in [-wall, 0], z within hL/2 + 2 of the lug's centre, each half Hc deep) with the lug pair, less the relief
 * and each half's cuts. Hc = T + p + LUG_OVERLAP rounded up to whole layers, T the half's flat thickness, so the gussets
 * end on the back face; as each half's back face is a whole number of layers from P, so is the slot's face, as in the
 * mold. `options` are the tests' negative controls.
 */
export function buildSeamBoltCoupon(arena: Arena, params: Params, options: Pick<ClamshellBuildOptions, 'lugs' | 'cuts'> = {}): SeamBoltCoupon {
  const needs = seamBoltNeeds(params);
  const { layer, p, height: hL, slotHeight, minWall, fastener } = needs;
  const whole = (v: number): number => layer * Math.ceil(v / layer - 1e-9);
  const f = slotFace(whole(needs.fMin), needs);
  const tn = headThickness(needs.length, f, fastener);
  const tp = f + slotHeight + minWall;
  const depths: [number, number] = [whole(tn + p + LUG_OVERLAP), whole(tp + p + LUG_OVERLAP)];
  const bolts: SeamBoltLayout = {
    ...needs,
    axis: 'x',
    xs: 0,
    depths,
    f,
    tn,
    tp,
    zBottom: 0,
    zTop: 0,
    perEnd: 1,
    count: 2,
    zs: [0],
    spots: [{ end: 'b1', z: 0, b: needs.c }],
    lugZone: [tn + p, tp + p],
    lengthFits: tn >= needs.tnMin - 1e-9 && tn <= depths[0] - minWall + 1e-9,
    shortest: null,
    longest: null,
    heldBack: false,
    diagnostics: [],
  };
  const O: Rect = { x0: -depths[0], y0: -params.cover.wall, x1: depths[1], y1: 0 };
  const { Manifold } = arena.api;
  const stub = boxAt(arena, O.x0, O.y0, -(hL / 2 + 2), O.x1, O.y1, hL / 2 + 2);
  const block = arena.track(Manifold.union([stub, ...lugSolid(arena, bolts, options.lugs)]));
  const relief = options.lugs?.relief === false ? [] : lugRelief(arena, bolts);
  const half = (sign: 1 | -1): Manifold => checked(arena.track(Manifold.difference([trimHalf(arena, block, 'x', 0, sign), ...relief, ...seamBoltCuts(arena, bolts, sign, options.cuts)])), sign > 0 ? 'The seam bolt coupon\'s nut side' : 'The seam bolt coupon\'s head side');
  return { bolts, O, halves: [half(-1), half(1)] };
}

/** G13.10.19: the clip coupon's block stands for a corner of a half, its end wall this thick along b, in mm. */
export const CLIP_BLOCK_WALL = 8;
/** G13.10.19: the block's height over the ear's, in mm, half of it above and half below. */
export const CLIP_BLOCK_OVER = 4;
/** G13.10.19: the trio's keys stand this far apart in Clip clearance, in mm, within the setting's range. */
export const CLIP_TRIO_STEP = 0.1;

/** G13.10.19's clip coupon: a corner of each half with one ear and its socket, and the trio of keys. */
export interface ClipCoupon {
  /** One ear pair on the end face at b = 0 of an x seam at xs = 0, centred in the block's height. */
  clips: ClipLayout;
  spot: ClipSpot;
  /** The block's box for the + half, which stands for O: a in [0, earDepth], the wall on y in [-wall, 0]. */
  O: Rect;
  /** The + half's block, the one printed twice, and the - half's, built by the same functions, which it equals turned over. */
  block: Manifold;
  negBlock: Manifold;
  /** The trio's clearances, 1, 2 and 3 notches on the head, and the keys standing on their heads in a row PLATE_GAP apart. */
  trio: [number, number, number];
  keys: Manifold;
}

/** G13.10.19: clips.clearance - 0.1, the set value and + 0.1, held inside the setting's range of 0 to 0.5. */
export function clipTrio(clearance: number): [number, number, number] {
  const mid = Math.min(0.5 - CLIP_TRIO_STEP, Math.max(CLIP_TRIO_STEP, clearance));
  const round = (v: number): number => Math.round(v * 100) / 100;
  return [round(mid - CLIP_TRIO_STEP), round(mid), round(mid + CLIP_TRIO_STEP)];
}

/**
 * G13.10.19: the fit test's clip coupon, from the halves' own functions. The block: b in [-CLIP_BLOCK_WALL, 0], a in
 * [0, the ear's depth], z in [0, h_e + CLIP_BLOCK_OVER], with one ear and its socket centred in z on its end face; as the
 * ear's depth is its corbel's foot, the corbel lands on the bed in the halves' pose. The ear and socket are symmetric
 * about the ear's middle in z, so the block turned over about b is the - half's, and one file printed twice is the pair.
 * The keys: keySolid at the trio's clearances, with 1, 2 and 3 notches. `ears` are the tests' negative controls.
 */
export function buildClipCoupon(arena: Arena, params: Params, ears: EarOptions = {}): ClipCoupon {
  const needs = clipNeeds(params);
  const depth = needs.earDepth;
  const top = needs.height + CLIP_BLOCK_OVER;
  const spot: ClipSpot = { end: 'b1', z: top / 2 };
  const clips: ClipLayout = {
    ...needs,
    axis: 'x',
    xs: 0,
    depths: [depth, depth],
    ends: [-CLIP_BLOCK_WALL, 0],
    zLow: 0,
    zHigh: top,
    most: 1,
    placed: [{ kind: 'bottom', z: spot.z }],
    zs: [spot.z],
    count: 2,
    clipsHoldN: 0,
    holdN: 0,
    heldBack: false,
    lowered: false,
    diagnostics: [],
  };
  const O: Rect = { x0: -depth, y0: -CLIP_BLOCK_WALL, x1: depth, y1: 0 };
  const { Manifold } = arena.api;
  const half = (sign: 1 | -1): Manifold => {
    const stub = sign > 0 ? boxAt(arena, 0, O.y0, 0, depth, 0, top) : boxAt(arena, -depth, O.y0, 0, 0, 0, top);
    const eared = arena.track(Manifold.union([stub, ...earSolids(arena, clips, sign, ears, [spot])]));
    return checked(arena.track(Manifold.difference([eared, ...socketCutters(arena, clips, sign, ears, [spot])])), sign > 0 ? 'The clip coupon\'s block' : 'The clip coupon\'s other block');
  };
  const trio = clipTrio(needs.clearance);
  const head = keyHead(needs);
  const keys = trio.map((clearance, k) => arena.track(keySolid(arena, needs, { clearance, notches: k + 1 }).translate([(k - 1) * (2 * head.x + PLATE_GAP), 0, 0])));
  return { clips, spot, O, block: half(1), negBlock: half(-1), trio, keys: arena.track(Manifold.union(keys)) };
}

function boxAt(arena: Arena, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Manifold {
  const { track } = arena;
  return track(track(arena.api.Manifold.cube([x1 - x0, y1 - y0, z1 - z0])).translate([x0, y0, z0]));
}

/** Upright notches on the outside, a side per series, cut the same on both parts. The piece is square, so one distance serves both sides. */
function edgeMarks(arena: Arena, variant: FitVariant, outer: number, inner: number, zLow: number, zHigh: number): Manifold[] {
  const marks: Manifold[] = [];
  const start = -((variant.notches - 1) * NOTCH_PITCH) / 2;
  for (let k = 0; k < variant.notches; k++) {
    const along = start + k * NOTCH_PITCH;
    const a = along - NOTCH_WIDTH / 2, b = along + NOTCH_WIDTH / 2;
    marks.push(variant.series === 'taper' ? boxAt(arena, inner, a, zLow, outer, b, zHigh) : boxAt(arena, a, inner, zLow, b, outer, zHigh));
  }
  return marks;
}

export interface FitPiece {
  rim: Rim;
  cover: Manifold;
  base: Manifold;
}

/** Where the fit test's pour goes, a third of the way from the box tool's middle to its -x side. */
export function fitPour(): { x: number; y: number } {
  return { x: -(TOOL_SIDE / 2) / 3, y: 0 };
}

/**
 * Where the fit test's vent goes: towards the box tool's +x, +y corner, as M3 put it, unless the funnel's
 * flange would rest on it there. Then it moves out along the line from the pour by as little as clears the
 * flange as the mold's vents do (FL), but never so far that its bore stops opening into the box tool, and
 * never back in towards the pour, as a wide vent already past that edge at M3's spot would. VN: by the gap
 * the seat clearance and nozzle need, through flangeReach; a default flange of 2 mm leaves M3's spot clear.
 */
export function fitVent(params: Params): { x: number; y: number } {
  const half = TOOL_SIDE / 2;
  const at = { x: half * 0.72, y: half * 0.72 };
  const pour = fitPour();
  const reach = flangeReach(openingSizes(params));
  const dx = at.x - pour.x, dy = at.y - pour.y;
  const apart = Math.hypot(dx, dy);
  if (reach <= apart) return at;
  const room = half - params.vents.diameter / 2;
  const along = Math.max(apart, Math.min(reach, (room - pour.x) / (dx / apart), (room - pour.y) / (dy / apart)));
  if (along === apart) return at;
  return { x: pour.x + (dx / apart) * along, y: pour.y + (dy / apart) * along };
}

/** G12: the real builders with a 20 x 20 x 6 box for a tool, and a pour bore, seat and vent, so it also holds water for a leak test. */
export function buildFitPiece(arena: Arena, params: Params, variant: FitVariant): FitPiece {
  const { track } = arena;
  const { Manifold } = arena.api;
  const rim = fitRim(params, variant);
  const half = TOOL_SIDE / 2;
  const tool = boxAt(arena, -half, -half, TOOL_BOTTOM, half, half, TOOL_HEIGHT);
  const body = buildCoverBody(arena, rim, tool);

  const { pour, seat, vents } = params;
  const openings = [
    ...pourCutters(arena, rim, { ...fitPour(), zb: TOOL_HEIGHT, diameter: pour.diameter, seatDepth: seat.depth, seatHalfAngleDeg: seat.halfAngleDeg }),
    ...ventCutters(arena, rim, { ...fitVent(params), zb: TOOL_HEIGHT, diameter: vents.diameter }),
  ];
  const coverMarks = edgeMarks(arena, variant, rim.O.x1 + 1, rim.O.x1 - NOTCH_DEPTH, -rim.Tb - 1, rim.Zt + 1);
  const cover = checked(track(Manifold.difference([body, ...openings, ...coverMarks])), 'The fit-test cover');

  const baseMarks = edgeMarks(arena, variant, rim.B.x1 + rim.Tb + 1, rim.B.x1 - NOTCH_DEPTH, -rim.Tb - 1, 1);
  const base = checked(track(Manifold.difference([buildBaseBody(arena, rim), ...baseMarks])), 'The fit-test base');
  return { rim, cover, base };
}

/** fit_test/README.txt as lines, wrapped and in plain ASCII like the export's README.txt. */
function readmeLines(variants: FitVariant[], params: Params): string[] {
  const out: string[] = [];
  const para = (text: string): void => {
    out.push(...wrap(text), '');
  };
  const step = (n: number, text: string): void => {
    out.push(...wrap(text, `${n}. `, '   '));
  };
  const item = (text: string): void => {
    out.push(...wrap(text, '- ', '  '));
  };
  para('Fit-test pieces for the base and cover joint.');
  para('Each pair is a small mold with the real taper, ridge and groove, a pour bore, a funnel seat and a vent. Use it to find the clearances that suit your printer, and as a leak test.');
  para('The file names give each pair\'s clearances. Printed pieces are told apart by the notches on one edge: on the +x side for the taper series and on the +y side for the groove series, one notch for the first in the series, two for the second, and so on.');
  out.push('How to read the result:');
  step(1, 'Print the taper series, one pair at a time, in the material and settings of the real mold, in the poses of these files. The groove is generous here, so only the taper decides the fit.');
  step(2, `The best fit is the tightest pair whose base seats fully on the cover's shelf by hand. The base then stands proud of the cover by ${params.joint.baseProud} mm. If it rocks or stands higher, go one step looser. Set Taper clearance per side to that pair's value.`);
  step(3, `Print the groove series. This ZIP builds it at a taper clearance of ${params.joint.taperClearance.toFixed(2)} mm, and a base that is too tight in the taper stops short whatever the groove does. So if step 2 gave you another value, set Taper clearance per side to it under Cover & joint in the app, and save the fit test again with the Fit test button under Export (diag.html offers the same under Printer check). Choose the tightest pair that still seats fully, and set Groove clearance per side to that pair's value.`);
  step(4, 'For a leak test, seat the chosen pair, tape it as for a real pour, and fill it with water through the pour opening until water shows at the vent. The joint should stay dry for several minutes. A little Vaseline in the groove helps.');
  // FL: the seat here is the mold's, so a printed funnel shows whether its flange will rest flat on the real top.
  if (params.funnel.generate && params.seat.enabled && params.funnel.flangeWidth > 0) {
    // VN: past where FLANGE_GAP covers the funnel's play and half a line (flangeGap), the vents keep further off
    // the flange; a cover printed before still keeps each bore clear until they reach its mouth's chamfer too.
    const cos = Math.cos((params.seat.halfAngleDeg * Math.PI) / 180);
    const past = Math.max(0, (FLANGE_GAP - params.print.nozzle / 2) * cos);
    const bore = Math.max(0, (FLANGE_GAP + VENT_CHAMFER - params.print.nozzle / 2) * cos);
    step(5, `To check the funnel, print one (the Funnel button under Export, or funnel.stl in the mold's ZIP) and press it into the seat of the pour opening: its flange should sit flat on the top all round, and the funnel should stand without rocking. If it stands on its spigot with a gap under the flange, raise Seat clearance under Advanced, Funnel, by 0.05 mm. Past about ${past.toFixed(2)} mm of Seat clearance the funnel has enough play in its seat that the app keeps each vent a little further from the flange: a cover printed before still takes the funnel up to about ${bore.toFixed(2)} mm, its flange then at most over a vent's chamfer and not its bore, and the next export keeps each vent's mouth clear.`);
  }
  out.push('', 'If no pair seats:');
  item('In the taper series, even the loosest: your printer is printing well over size. Check its flow and first-layer squish, then print the series again.');
  item('In the groove series, when it was built at a taper clearance that seats: clean any stringing from the ridge and groove and try again. If it still stops short, set Groove clearance per side one step past the loosest pair.');
  out.push('', 'Variants:');
  for (const v of variants) item(`${v.id}: taper clearance ${v.cT.toFixed(2)} mm, groove clearance ${v.cG.toFixed(2)} mm, ${v.notches} notch${v.notches > 1 ? 'es' : ''} on the ${v.series === 'taper' ? '+x' : '+y'} side`);
  return out;
}

function boltLines(coupon: BoltCoupon, params: Params): string[] {
  const { bolts } = coupon;
  const b = params.bolts;
  const out: string[] = ['', 'Bolt coupon:'];
  const step = (n: number, text: string): void => {
    out.push(...wrap(text, `${n}. `, '   '));
  };
  out.push(...wrap(`bolt_coupon_base.stl and bolt_coupon_cover.stl are a corner of the base and of the cover with one bolt, cut as the real mold's are: an ${bolts.size} countersink at a hole clearance of ${b.holeClearance} mm per side, and a nut slot at a nut clearance of ${b.nutClearance} mm per side, with its membrane. Print them as they are saved, in the material and settings of the real mold. Then, with an ${bolts.size} x ${bolts.length} mm countersunk screw and an ${bolts.size} hex nut:`));
  step(1, 'Push the nut into the slot from the +x side, corner first, with two of its flats against the sides of the slot: it should slide in by hand until its leading corner stops at the end of the slot, and stay in. If it will not go, raise Nut clearance per side under Cover & joint, Bolts, by 0.05 mm; if it falls out, lower it.');
  step(2, "Put the screw up through the base piece from its underside, into the cover piece, and push it through the membrane, the thin layer of plastic between the hole and the nut slot, under the nut, which is meant to be pierced. It should pass the hole without binding; if it binds, raise Hole clearance per side.");
  step(3, "Turn the screw into the nut until snug. Its head should sit flush with the base piece's underside or a little below it, and the pieces should close without a gap.");
  out.push(...wrap(`The coupon's slot sits at the lowest height the mold's can. The mold's is up to one layer higher, so that its bridge starts on a layer under its flat top, so in the mold the same screw passes its nut by up to ${bolts.layer} mm less than here.`));
  return out;
}

function seamBoltLines(coupon: SeamBoltCoupon, params: Params): string[] {
  const { bolts } = coupon;
  const b = params.bolts;
  const out: string[] = ['', 'Seam bolt coupon:'];
  const step = (n: number, text: string): void => {
    out.push(...wrap(text, `${n}. `, '   '));
  };
  out.push(...wrap(`seam_bolt_coupon_neg.stl and seam_bolt_coupon_pos.stl are a stub of each half's end wall with one pair of seam bolt lugs, cut as the real halves' are: the head side (neg) with an ${bolts.size} countersink and hole at a hole clearance of ${b.holeClearance} mm per side, and the nut side (pos) with a nut slot at a nut clearance of ${b.nutClearance} mm per side and its membrane. Print them as they are saved, on their backs, in the material and settings of the real mold. Then, with an ${bolts.size} x ${bolts.length} mm countersunk screw, an ${bolts.size} hex nut and a ${bolts.hexKey} mm hex key:`));
  // MP5 draws the Seam bolts rows under Two-part cover; these steps name them there.
  const rows = 'under Two-part cover, Seam bolts';
  step(1, `Stand both coupons on their bottom ends, the nut side's slot opening at the top, as the halves stand in the mold. Drop the nut into the slot on the top of the nut side's lug, flats against the slot's sides: it should drop in by hand and seat at the bottom of the slot. If it will not go, raise Nut clearance per side ${rows}, by 0.05 mm.`);
  step(2, `Assemble the two coupons on a flat table, seam faces together. Put the screw through the head side's lug from its outer side, through the hole and the membrane, the thin layer of plastic between the hole and the nut slot, which is meant to be pierced, and turn it into the nut with the key. It should pass the holes without binding; if it binds, raise Hole clearance per side ${rows}.`);
  step(3, 'Stop at snug, when the stub faces close, then give it a quarter turn more. The lug faces must keep a visible gap while the stub faces close, and no lug may crack. If the lug faces touch, back the screw off to snug; if they still touch, your printer is printing over size: check its flow and first-layer squish. If the stub faces stay open, check that the table is flat and the screw straight. If a lug cracks, check in the slicer\'s preview that the mold\'s lugs print solid, and in the mold stop at snug.');
  if (bolts.tn < bolts.tnMin - 1e-9) {
    const shortest = standardLength(bolts.tnMin + bolts.f + bolts.fastener.nutHeight + threadPast(bolts.fastener));
    out.push(...wrap(`An ${bolts.size} x ${bolts.length} mm screw leaves the head side's lug ${bolts.tn.toFixed(2)} mm thick, under the ${bolts.tnMin.toFixed(2)} mm that keeps plastic over its countersink: ${shortest !== null ? `use ${shortest} mm or longer` : 'no standard length is long enough'}, and save the fit test again.`));
  }
  out.push(...wrap(`The coupon's nut slot sits a whole number of layers from the seam face. The mold's is up to one layer nearer to it or further from it, as each half's back face is a whole number of layers from the seam, and the mold's head side's lug is that much thinner or thicker, so in the mold the same screw passes its nut by the same 2 threads.`));
  return out;
}

function clipLines(coupon: ClipCoupon): string[] {
  const out: string[] = ['', 'Clip coupon:'];
  const step = (n: number, text: string): void => {
    out.push(...wrap(text, `${n}. `, '   '));
  };
  const item = (text: string): void => {
    out.push(...wrap(text, '- ', '  '));
  };
  const mm = (v: number): string => v.toFixed(2);
  const [low, mid, high] = coupon.trio;
  // MP5 draws the Seam clips rows under Two-part cover; these steps name the row there.
  const row = 'Clip clearance under Two-part cover, Seam clips';
  out.push(...wrap(`clip_coupon_block.stl is a corner of a half with one clip ear and its socket, cut as the real halves' are, and clip_coupon_keys.stl holds three clips, the printed keys that slide into the sockets, at a Clip clearance of ${mm(low)}, ${mm(mid)} and ${mm(high)} mm per side, told apart by 1, 2 and 3 notches on the head. Each clip has a double line across its sides, with single marks 1 mm apart on either side of it; the double line shows how far the clip went in. Print the block twice, like the halves, at 5 percent infill or less with at least 3 walls, and the clips at 100 percent infill, standing on their heads as the file lays them out, in PLA or PETG. Then:`));
  step(1, 'Stand the two blocks on a flat table, seam faces together, one of them turned upside down, so their ears meet side by side and their sockets make one.');
  step(2, 'Push the clip with 2 notches into the socket, narrow end first, head out, by hand until it stops, then give its head two light taps with a screwdriver handle. Its double line should end level with the tip of the ears, within one mark, and the seam faces should be closed.');
  step(3, `Set ${row} to ${mm(mid)} mm, the value of the clip with 2 notches, plus 0.05 mm for each mark its double line stops outside the tip of the ears, or minus 0.05 mm for each mark it goes in past it. If the clip goes in to its head with the seam still open, try the clip with 1 notch and set Clip clearance to its value. If even the clip with 3 notches stops more than 2 marks out, set Clip clearance to its value plus 0.1 mm; if that would be over 0.5 mm, your printer is printing well over size: check its flow and first-layer squish, then print the coupon again. Clip clearance never goes below 0 or above 0.5 mm.`);
  step(4, 'Try to pull the blocks apart by hand, with well over the 40 N each clip is counted at: they should not move. Then lever the clip out whole with a flat screwdriver between its head and the ears.');
  out.push('', 'Clips:');
  coupon.trio.forEach((value, k) => item(`${k + 1} notch${k > 0 ? 'es' : ''} on the head: Clip clearance ${mm(value)} mm`));
  return out;
}

/** Everything in the fit-test ZIP, by path, in print pose. The caller zips it, so core needs no zip library. */
export function fitTestFiles(api: ManifoldToplevel, params: Params = defaultParams()): Record<string, Uint8Array> {
  const variants = fitVariants(params);
  const files: Record<string, Uint8Array> = {};
  for (const variant of variants) {
    withArena(api, (arena) => {
      const { rim, cover, base } = buildFitPiece(arena, params, variant);
      files[`fit_test/${variant.id}_cover.stl`] = poseToStl(api, cover, coverPose(rim));
      files[`fit_test/${variant.id}_base.stl`] = poseToStl(api, base, basePose(rim));
    });
  }
  const readme = readmeLines(variants, params);
  // G13.10.12: the two-part cover holds its seam with its own bolts, so M10's coupon is not this type's.
  const clamshell = params.mold.type === 'clamshell';
  if (params.bolts.enabled && !clamshell) {
    withArena(api, (arena) => {
      const coupon = buildBoltCoupon(arena, params);
      files['fit_test/bolt_coupon_cover.stl'] = poseToStl(api, coupon.cover, coverPose({ Zt: coupon.top }));
      files['fit_test/bolt_coupon_base.stl'] = poseToStl(api, coupon.base, basePose({ Tb: params.base.thickness }));
      readme.push(...boltLines(coupon, params));
    });
  }
  if (clamshell && params.clamshell.fastener === 'bolts') {
    withArena(api, (arena) => {
      const coupon = buildSeamBoltCoupon(arena, params);
      files['fit_test/seam_bolt_coupon_neg.stl'] = poseToStl(api, coupon.halves[0], halfPose(coupon, 'x', -1));
      files['fit_test/seam_bolt_coupon_pos.stl'] = poseToStl(api, coupon.halves[1], halfPose(coupon, 'x', 1));
      readme.push(...seamBoltLines(coupon, params));
    });
  }
  // G13.10.19: the clip coupon with Seam fasteners Clips only, the block in the halves' pose and the keys as they stand.
  if (clamshell && params.clamshell.fastener === 'clips') {
    withArena(api, (arena) => {
      const coupon = buildClipCoupon(arena, params);
      files['fit_test/clip_coupon_block.stl'] = poseToStl(api, coupon.block, halfPose(coupon, 'x', 1));
      files['fit_test/clip_coupon_keys.stl'] = poseToStl(api, coupon.keys, { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] });
      readme.push(...clipLines(coupon));
    });
  }
  // Plain ASCII in CRLF lines for Notepad, and core has no TextEncoder without the DOM types.
  files['fit_test/README.txt'] = Uint8Array.from(readme.join(EOL) + EOL, (c) => c.charCodeAt(0));
  return files;
}
