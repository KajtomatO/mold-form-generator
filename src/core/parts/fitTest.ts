import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { defaultParams } from '../params/defaults';
import type { Params } from '../params/schema';
import { checked, withArena, type Arena } from '../solid/arena';
import { TOOL_BOTTOM } from '../solid/tool';
import { buildBaseBody } from './base';
import { buildCoverBody } from './cover';
import { pourCutters, ventCutters } from './openings';
import { basePose, coverPose, poseToStl } from './poses';
import { deriveRim, type Rim } from './rim';

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

/** The rim of one variant: the real derivation, around a cavity bound that is just the box tool. */
export function fitRim(params: Params, variant: FitVariant): Rim {
  const half = TOOL_SIDE / 2;
  const model = { x0: -half, y0: -half, x1: half, y1: half };
  const D = { x0: -half - BOUND_SLACK, y0: -half - BOUND_SLACK, x1: half + BOUND_SLACK, y1: half + BOUND_SLACK };
  const joint = { ...params.joint, taperClearance: variant.cT, grooveClearance: variant.cG };
  return deriveRim({ D, model, hMax: TOOL_HEIGHT, offsets: [[0, 0]] }, { ...params, joint, grid: { ...params.grid, edge: null } });
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
    ...pourCutters(arena, rim, { x: -half / 3, y: 0, zb: TOOL_HEIGHT, diameter: pour.diameter, seatDepth: seat.depth, seatHalfAngleDeg: seat.halfAngleDeg }),
    ...ventCutters(arena, rim, { x: half * 0.72, y: half * 0.72, zb: TOOL_HEIGHT, diameter: vents.diameter }),
  ];
  const coverMarks = edgeMarks(arena, variant, rim.O.x1 + 1, rim.O.x1 - NOTCH_DEPTH, -rim.Tb - 1, rim.Zt + 1);
  const cover = checked(track(Manifold.difference([body, ...openings, ...coverMarks])), 'The fit-test cover');

  const baseMarks = edgeMarks(arena, variant, rim.B.x1 + rim.Tb + 1, rim.B.x1 - NOTCH_DEPTH, -rim.Tb - 1, 1);
  const base = checked(track(Manifold.difference([buildBaseBody(arena, rim), ...baseMarks])), 'The fit-test base');
  return { rim, cover, base };
}

const README = (variants: FitVariant[], params: Params): string => `Fit-test pieces for the base and cover joint.

Each pair is a small mold with the real taper, ridge and groove, a pour bore, a funnel seat and a vent. Use it to find the clearances that suit your printer, and as a leak test.

The file names give each pair's clearances. Printed pieces are told apart by the notches on one edge: on the +x side for the taper series and on the +y side for the groove series, one notch for the first in the series, two for the second, and so on.

How to read the result:
1. Print the taper series, one pair at a time, in the material and settings of the real mold, in the poses of these files. The groove is generous here, so only the taper decides the fit.
2. The best fit is the tightest pair whose base seats fully on the cover's shelf by hand. The base then stands proud of the cover by ${params.joint.baseProud} mm. If it rocks or stands higher, go one step looser. Set Taper clearance per side to that pair's value.
3. Print the groove series. This ZIP builds it at a taper clearance of ${params.joint.taperClearance.toFixed(2)} mm, and a base that is too tight in the taper stops short whatever the groove does. So if step 2 gave you another value, enter it under Printer check on diag.html and download again first. Choose the tightest pair that still seats fully, and set Groove clearance per side to that pair's value.
4. For a leak test, seat the chosen pair, tape it as for a real pour, and fill it with water through the pour opening until water shows at the vent. The joint should stay dry for several minutes. A little Vaseline in the groove helps.

If no pair seats:
- In the taper series, even the loosest: your printer is printing well over size. Check its flow and first-layer squish, then print the series again.
- In the groove series, when it was built at a taper clearance that seats: clean any stringing from the ridge and groove and try again. If it still stops short, set Groove clearance per side one step past the loosest pair.

Variants:
${variants.map((v) => `${v.id}: taper clearance ${v.cT.toFixed(2)} mm, groove clearance ${v.cG.toFixed(2)} mm, ${v.notches} notch${v.notches > 1 ? 'es' : ''} on the ${v.series === 'taper' ? '+x' : '+y'} side`).join('\n')}
`;

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
  // Plain ASCII, and core has no TextEncoder without the DOM types.
  files['fit_test/README.txt'] = Uint8Array.from(README(variants, params), (c) => c.charCodeAt(0));
  return files;
}
