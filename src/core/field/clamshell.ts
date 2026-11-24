import { clipBelow } from '../mesh/clip';
import { meshBounds, type Bounds, type WeldedMesh } from '../mesh/weld';
import { resolveAuto } from '../params/defaults';
import type { Params } from '../params/schema';
import { clamVertices, deriveClamRim, moldBounds, seamJointTop, sideBounds, type ClamRim, type ClamVertices, type MoldBounds } from '../parts/rim';
import { clipNeeds, placeClips, SPARES, type ClipLayout } from '../parts/clips';
import { placeSeamBolts, seamBoltNeeds, type SeamBoltLayout } from '../parts/seamBolts';
import { clipAdvice, fillLevel, filmPush, halfForces, halvesTape, seamBoltAdvice, seamHoldN, topSpanOf, wedgeN, type ClipAdvice, type HalfForces, type SeamBoltAdvice } from '../report/clamp';
import type { Rect } from '../solid/rect';
import { fieldSettings, type Field, type FieldSettings } from './grid';
import { exteriorMesh } from './sealed';
import {
  axisOf,
  bedFootprint,
  buildSideField,
  chooseSplit,
  COARSE_CELL,
  fastenerGrowth,
  fitsBed,
  layerRows,
  planSide,
  pullOf,
  seamH,
  seamMask,
  sideFrame,
  sideREff,
  sideRows,
  sideTop,
  splitAxes,
  turnMesh,
  type Pull,
  type SeamAxis,
  type SidePlan,
  type SplitChoice,
  type SplitContext,
  type SplitRows,
} from './side';
import { volumeAbovePlane } from './silicone';

/**
 * MP1: the two-part cover's core run, as MP5 joins it to the pipeline: the model cut at z = 0, the coarse side fields of
 * G13.2 step 8, G13.3's choice, G13.6's rim at the split, the two fine fields, and from them the silicone, G13.9's
 * forces and G13.10's seam bolts or seam clips. The tests and the measurement read this run.
 */

export interface ClamshellPrep {
  params: Params;
  /** The oriented model, and the same cut at z = 0 (G13.1), with its bounds. */
  mesh: WeldedMesh;
  clipped: WeldedMesh;
  bounds: Bounds;
  settings: FieldSettings;
  vertices: ClamVertices;
  mold: MoldBounds;
  ctx: SplitContext;
  /** The model above the plane, voids included, less what overlapping shells count twice. */
  modelVolume: number;
  /** S8's sealed air, as moldSilicone takes it off (sealedAirOf), in mm3. */
  sealedAir: number;
  turned: Partial<Record<Pull, WeldedMesh>>;
}

export interface ClamshellInputs {
  /** M1's overlap of the whole model, as moldSilicone takes it. */
  overlapVolume?: number;
  /** S8's sealed air past the volume filter, from sealedAirOf. */
  sealedAir?: number;
  cellFinal?: number;
}

/** Everything the run reads of the model that no beta, bed or fastener changes. */
export function prepareClamshell(mesh: WeldedMesh, params: Params, inputs: ClamshellInputs = {}): ClamshellPrep {
  const { overlapVolume = 0, sealedAir = 0, cellFinal = params.quality.cellFinal } = inputs;
  const p: Params = { ...params, quality: { ...params.quality, cellFinal } };
  const clipped = clipBelow(mesh);
  const bounds = meshBounds(clipped.positions);
  const settings = fieldSettings(p, meshBounds(mesh.positions));
  const vertices = clamVertices(clipped, sideREff(bounds, settings), settings.draftDeg, seamJointTop(p), settings.closeWidth);
  const mold = moldBounds(mesh, meshBounds(mesh.positions), { ...settings, nx: 1, ny: 1 });
  const modelVolume = volumeAbovePlane(exteriorMesh(mesh)) - overlapVolume;
  return { params: p, mesh, clipped, bounds, settings, vertices, mold, ctx: { vertices, mold, params: p, raise: settings.tinTol, cellFinal: settings.cellFinal }, modelVolume, sealedAir, turned: {} };
}

function turnedFor(prep: ClamshellPrep, pull: Pull): WeldedMesh {
  let t = prep.turned[pull];
  if (!t) {
    t = turnMesh(prep.clipped, sideFrame(pull, prep.bounds));
    prep.turned[pull] = t;
  }
  return t;
}

export interface SideFieldRun {
  field: Field;
  side: SidePlan;
  /** The seam's h in this frame: 0 for a coarse field. */
  hs: number;
}

/**
 * A side field of this pull at `cell`: coarse (hStop 0, padded for any xs) without `xs`, fine (stopped and flattened at
 * its seam) with it. The layer rows stop inside `D`, the rim's at the split, G8's for a coarse field.
 */
export function sideField(prep: ClamshellPrep, pull: Pull, cell: number, betaDeg: number, xs: number | null, D: Rect | null = null): SideFieldRun {
  const { ctx, vertices, settings, params } = prep;
  const side = planSide(pull, prep.bounds, { ...settings, cell }, params.base.thickness, sideTop(vertices, axisOf(pull), xs, betaDeg, ctx.raise, cell));
  const hs = xs === null ? 0 : seamH(pull, prep.bounds, xs);
  const layer = layerRows(pull, prep.bounds, D ?? prep.mold.D, resolveAuto(params, prep.bounds).baseLayer ?? 0, cell);
  const field = buildSideField(turnedFor(prep, pull), side, settings, { betaDeg, hStop: hs, flattenAt: xs === null ? null : hs, layer, Tb: params.base.thickness });
  return { field, side, hs };
}

/** G13.2 step 8's coarse fields, for the pulls the axis setting allows. */
export function coarseRows(prep: ClamshellPrep, betaDeg: number): SplitRows {
  const rows: SplitRows = {};
  for (const axis of splitAxes(prep.params)) {
    for (const sign of [1, -1] as const) {
      const pull = pullOf(axis, sign);
      rows[pull] = sideRows(sideField(prep, pull, COARSE_CELL, betaDeg, null).field, pull, prep.bounds);
    }
  }
  return rows;
}

/** The whole choice of G13.3 at this beta. */
export function chooseFor(prep: ClamshellPrep, betaDeg: number, rows = coarseRows(prep, betaDeg)): SplitChoice {
  const p = { ...prep.params, clamshell: { ...prep.params.clamshell, ceilingDeg: betaDeg } };
  return chooseSplit(rows, prep.bounds, { ...prep.ctx, params: p }, prep.modelVolume);
}

/** G13.6's exact rim at a split, with no field: what the seam bolts' heights read. */
export function exactRim(prep: ClamshellPrep, axis: SeamAxis, xs: number, betaDeg = prep.params.clamshell.ceilingDeg): ClamRim {
  const { vertices, mold, ctx, params } = prep;
  const p = { ...params, clamshell: { ...params.clamshell, ceilingDeg: betaDeg } };
  return deriveClamRim(mold, sideBounds(vertices, axis, xs), sideTop(vertices, axis, xs, betaDeg, ctx.raise, ctx.cellFinal), p, axis, xs, vertices.zJ);
}

export interface FineSplit {
  axis: SeamAxis;
  xs: number;
  rim: ClamRim;
  plus: SideFieldRun;
  minus: SideFieldRun;
  /** Silicone at the fine cell, in ml: both halves' cavity with the raise, less the model above the plane and sealed air. */
  siliconeMl: number;
  forces: [HalfForces, HalfForces];
  filmN: number;
  holdN: number;
}

/** G13.6's exact rim and the fine fields at a split, with what they give. */
export function fineSplit(prep: ClamshellPrep, axis: SeamAxis, xs: number, cell: number, betaDeg = prep.params.clamshell.ceilingDeg): FineSplit {
  const p = { ...prep.params, clamshell: { ...prep.params.clamshell, ceilingDeg: betaDeg } };
  const { ctx } = prep;
  const rim = exactRim(prep, axis, xs, betaDeg);
  const plus = sideField(prep, pullOf(axis, 1), cell, betaDeg, xs, rim.D);
  const minus = sideField(prep, pullOf(axis, -1), cell, betaDeg, xs, rim.D);
  const level = fillLevel(p, rim);
  const density = p.silicone.density;
  const forces: [HalfForces, HalfForces] = [halfForces(minus.field, minus.hs, ctx.raise, level, density), halfForces(plus.field, plus.hs, ctx.raise, level, density)];
  // G13.9's film runs over S out to the band, with J, D grown by e1 across b, up to the joint's top.
  const S = seamMask(plus.field, minus.field, prep.bounds, axis, xs);
  const [d0, d1] = axis === 'x' ? [rim.D.y0, rim.D.y1] : [rim.D.x0, rim.D.x1];
  const j = p.joint;
  const filmN = filmPush(S.mask, S.nb, S.nz, S.cell, p.clamshell.seamLand, [d0 - rim.e1 - S.b0, d1 + rim.e1 - S.b0], j.ridgeHeight + j.grooveExtraDepth, level, density);
  const siliconeMl = (forces[0].volume + forces[1].volume - prep.modelVolume - prep.sealedAir) / 1000;
  return { axis, xs, rim, plus, minus, siliconeMl, forces, filmN, holdN: seamHoldN([forces[0].sideN, forces[1].sideN], filmN) };
}

export interface SeamHold {
  bolts: SeamBoltLayout;
  advice: SeamBoltAdvice;
}

/** G13.10's seam bolts at a split, with the base tape's wedge and the top span. */
export function seamHold(prep: ClamshellPrep, fine: FineSplit): SeamHold {
  const { params } = prep;
  const bolts = placeSeamBolts(seamBoltNeeds(params), fine.rim, fine.axis, fine.xs, fine.holdN);
  const box: [number, number] = [fine.rim.O.x1 - fine.rim.O.x0, fine.rim.O.y1 - fine.rim.O.y0];
  const tape = halvesTape([fine.forces[0].liftN, fine.forces[1].liftN], params.print.tapeStrip, box, fine.axis);
  const advice = seamBoltAdvice(bolts, fine.holdN, wedgeN(tape, params.joint.taperDeg), topSpanOf(fine.rim, fine.axis));
  return { bolts, advice };
}

export interface ClipHold {
  clips: ClipLayout;
  advice: ClipAdvice;
}

/** G13.10.17's seam clips at a split, with the base tape's wedge on the bottom rows and the top span. */
export function clipHold(prep: ClamshellPrep, fine: FineSplit): ClipHold {
  const { params } = prep;
  const clips = placeClips(clipNeeds(params), fine.rim, fine.axis, fine.xs, fine.holdN);
  const box: [number, number] = [fine.rim.O.x1 - fine.rim.O.x0, fine.rim.O.y1 - fine.rim.O.y0];
  const tape = halvesTape([fine.forces[0].liftN, fine.forces[1].liftN], params.print.tapeStrip, box, fine.axis);
  const advice = clipAdvice(clips, fine.holdN, tape, params.joint.taperDeg, topSpanOf(fine.rim, fine.axis), SPARES);
  return { clips, advice };
}

/** The bed outcome of the exact rim at a split, with this fastener's growth. */
export function exactFootprint(prep: ClamshellPrep, fine: Pick<FineSplit, 'rim' | 'axis' | 'xs'>, fastener = prep.params.clamshell.fastener): { width: number; length: number; depth: number; fits: boolean } {
  const fp = bedFootprint(fine.rim, fine.axis, fine.xs, fastenerGrowth(prep.params, fastener));
  return { width: fp.width, length: fp.length, depth: Math.max(...fp.depths), fits: fitsBed(fp, prep.params.print) };
}
