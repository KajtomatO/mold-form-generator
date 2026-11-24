import type { Manifold } from 'manifold-3d';
import { boreRadius, discMinimum, openingSizes } from '../analysis/validate';
import { orientSolid } from '../base/orient';
import { fineSplit, prepareClamshell, type ClamshellInputs, type ClamshellPrep, type FineSplit } from '../field/clamshell';
import { frameInverse, seamEps, topMap, type SeamAxis } from '../field/side';
import type { WeldedMesh } from '../mesh/weld';
import { resolveAuto } from '../params/defaults';
import type { Params } from '../params/schema';
import type { Diagnostic } from '../report/diagnostics';
import { checked, type Arena } from '../solid/arena';
import { buildToolMesh, toolSolid, type ToolMesh } from '../solid/tool';
import { buildBaseBody } from './base';
import { buildClamCommon, buildClamHalf, trimHalf, type HalfFeatures } from './cover';
import type { CutOpening } from './openings';
import type { ClamRim } from './rim';
import { seamGroove, seamPins, seamSeal, seamSection, seamSockets, seamTongue, type SeamSeal } from './seam';
import { clipDiagnostics, clipNeeds, earSolids, placeClips, socketCutters, type ClipLayout, type EarOptions } from './clips';
import { lugRelief, lugSolid, placeSeamBolts, seamBoltCuts, seamBoltDiagnostics, seamBoltNeeds, type LugOptions, type SeamBoltCutOptions, type SeamBoltLayout } from './seamBolts';

/**
 * MP2: the two-part cover's parts, G13.7 to G13.9, at a fine split from src/core/field/clamshell.ts: the tools, the seal,
 * the halves and the base, the silicone's solid for the 1% check, and G4 for each half with its one rebuild; MP3: the
 * seam bolts' lugs and cuts (G13.10); MP3b: the seam clips' ears and sockets (G13.10.16). The field code stays free of
 * Manifold, so this lives with the parts.
 */

/**
 * A pour or a vent on P at b, centred on the seam, its zb by G11's rule: the lowest ceiling over its disc, read from
 * H_top. MP4 places the openings on P; until then the tests place them by hand with this.
 */
export function seamOpening(prep: ClamshellPrep, fine: Pick<FineSplit, 'axis' | 'xs' | 'plus' | 'minus'>, kind: 'pour' | 'vent', b: number): CutOpening {
  const sizes = openingSizes(prep.params);
  const H = topMap(fine.plus.field, fine.minus.field, prep.bounds, fine.axis, fine.xs);
  const [x, y] = fine.axis === 'x' ? [fine.xs, b] : [b, fine.xs];
  const zb = discMinimum(H, x, y, boreRadius(sizes, kind));
  return kind === 'pour'
    ? { kind, x, y, zb, diameter: sizes.pourDiameter, seatDepth: sizes.seatDepth, seatHalfAngleDeg: sizes.seatHalfAngleDeg }
    : { kind, x, y, zb, diameter: sizes.ventDiameter };
}

export interface ClamshellBuild {
  rim: ClamRim;
  /** Each half's tool, its TIN and its solid in the mold, the - half's (neg) first. */
  meshes: [ToolMesh, ToolMesh];
  tools: [Manifold, Manifold];
  seal: SeamSeal;
  /** G13.7 step 2's block, before the trim. */
  common: Manifold;
  /** G13.7 step 4's halves, neg (a <= xs) first. */
  halves: [Manifold, Manifold];
  /** G13.7 step 7's base body, its ridge as two bars along a. */
  base: Manifold;
  openings: CutOpening[];
  /** G13.10's seam bolts with Seam fasteners Bolts, with no lugs where there is no room for one; null with Clips or None. */
  bolts: SeamBoltLayout | null;
  /** G13.10.16's seam clips with Seam fasteners Clips, with no rows where there is no room for one; null with Bolts or None. */
  clips: ClipLayout | null;
  diagnostics: Diagnostic[];
}

export interface ClamshellBuildOptions {
  /** The openings on P, cut from both halves. */
  openings?: CutOpening[];
  /** Tests only: the seal changed before its solids are cut, for the negative controls. */
  seal?: (seal: SeamSeal, rim: ClamRim, params: Params) => SeamSeal;
  /** Tests only: G10's whole ridge ring for the bars, a negative control. */
  ridgeRing?: boolean;
  /** Tests only: the lugs and the bolt cuts changed, for the negative controls. */
  lugs?: LugOptions;
  cuts?: SeamBoltCutOptions;
  /** Tests only: the ears and sockets changed, for the negative controls. */
  ears?: EarOptions;
}

/** G13.10.6: the seam bolts at this split with Seam fasteners Bolts, placed for the hold the fields give; null otherwise. */
export function clamBolts(params: Params, fine: Pick<FineSplit, 'rim' | 'axis' | 'xs' | 'holdN'>): SeamBoltLayout | null {
  return params.clamshell.fastener === 'bolts' ? placeSeamBolts(seamBoltNeeds(params), fine.rim, fine.axis, fine.xs, fine.holdN) : null;
}

/** G13.10.17: the seam clips at this split with Seam fasteners Clips, placed for the hold the fields give; null otherwise. */
export function clamClips(params: Params, fine: Pick<FineSplit, 'rim' | 'axis' | 'xs' | 'holdN'>): ClipLayout | null {
  return params.clamshell.fastener === 'clips' ? placeClips(clipNeeds(params), fine.rim, fine.axis, fine.xs, fine.holdN) : null;
}

/**
 * G13.7 steps 2 to 5 from the tools and the seal: the shared block, with the seam bolts' lugs where `bolts` has any, and
 * the halves, pos less the groove and the sockets and neg with the tongue and the pins, each less the lugs' relief and
 * its own bolt cuts in the same batch; with seam clips where `clips` has rows, each half with its own ears, less their
 * sockets, last (G13.10.16).
 */
export function buildHalves(arena: Arena, rim: ClamRim, tools: readonly [Manifold, Manifold], seal: SeamSeal, params: Params, openings: CutOpening[], bolts: SeamBoltLayout | null, clips: ClipLayout | null, options: Pick<ClamshellBuildOptions, 'lugs' | 'cuts' | 'ears'> = {}): { common: Manifold; halves: [Manifold, Manifold] } {
  const lugged = bolts !== null && bolts.spots.length > 0 ? bolts : null;
  const clipped = clips !== null && clips.zs.length > 0 ? clips : null;
  const common = buildClamCommon(arena, rim, undefined, lugged ? lugSolid(arena, lugged, options.lugs) : []);
  const relief = lugged && options.lugs?.relief !== false ? lugRelief(arena, lugged) : [];
  const fastened = (sign: 1 | -1): Manifold[] => (lugged ? [...relief, ...seamBoltCuts(arena, lugged, sign, options.cuts)] : []);
  const eared = (sign: 1 | -1): Pick<HalfFeatures, 'ears' | 'sockets'> => (clipped ? { ears: earSolids(arena, clipped, sign, options.ears), sockets: socketCutters(arena, clipped, sign, options.ears) } : {});
  const neg = buildClamHalf(arena, rim, common, tools[0], -1, { add: [seamTongue(arena, seal, params), ...seamPins(arena, seal)], cut: fastened(-1), ...eared(-1) }, openings);
  const pos = buildClamHalf(arena, rim, common, tools[1], 1, { add: [], cut: [seamGroove(arena, seal), ...seamSockets(arena, seal), ...fastened(1)], ...eared(1) }, openings);
  return { common, halves: [neg, pos] };
}

/**
 * G13.7 steps 1 to 5 and 7 at a fine split: the two tools (G13.2 step 7's seam held clear of P), the seal from the
 * cavity on P, the seam bolts with Seam fasteners Bolts or the seam clips with Clips, the shared block, the halves and
 * the base. The handles belong to `arena`.
 */
export function buildClamshell(arena: Arena, prep: ClamshellPrep, fine: FineSplit, options: ClamshellBuildOptions = {}): ClamshellBuild {
  const { params, settings } = prep;
  const { rim } = fine;
  const openings = options.openings ?? [];
  const eps = seamEps(settings.tinTol);
  const sides = [fine.minus, fine.plus] as const;
  const meshes = sides.map((side) => buildToolMesh(side.field, { raise: prep.ctx.raise, tol: settings.tinTol, seam: { hs: side.hs, eps } })) as [ToolMesh, ToolMesh];
  const tools = meshes.map((mesh, k) => orientSolid(arena, toolSolid(arena, mesh), frameInverse(sides[k].side.frame))) as [Manifold, Manifold];
  const S = seamSection(arena, rim.axis, rim.xs, tools);
  const made = seamSeal(arena, rim, S, openings, params);
  const seal = options.seal ? options.seal(made, rim, params) : made;
  const bolts = clamBolts(params, fine);
  const clips = clamClips(params, fine);
  const { common, halves } = buildHalves(arena, rim, tools, seal, params, openings, bolts, clips, options);
  const base = buildBaseBody(arena, rim, options.ridgeRing ? {} : { ridgeBars: rim.axis });
  const diagnostics = [...rim.diagnostics, ...meshes.flatMap((mesh) => mesh.diagnostics), ...seal.diagnostics, ...(bolts ? seamBoltDiagnostics(bolts) : []), ...(clips ? clipDiagnostics(clips) : [])];
  return { rim, meshes, tools, seal, common, halves, base, openings, bolts, clips, diagnostics };
}

/**
 * G13.7 step 6, for the tests and the 1% volume check only: each tool on its own side of P, above z = 0, less the model.
 * `model` is the oriented solid, or null where only the cavity is wanted.
 */
export function siliconeSolid(arena: Arena, build: Pick<ClamshellBuild, 'rim' | 'tools'>, model: Manifold | null): Manifold {
  const { rim, tools } = build;
  const cavity = arena.track(trimHalf(arena, tools[0], rim.axis, rim.xs, -1).add(trimHalf(arena, tools[1], rim.axis, rim.xs, 1)));
  const above = arena.track(cavity.trimByPlane([0, 0, 1], 0));
  return checked(model ? arena.track(above.subtract(model)) : above, 'The silicone');
}

/** G4 is raised by the shortfall plus this, once, as the one-piece's export does (RAISE_EXTRA). */
export const G4_RAISE_EXTRA = 0.05;
/** M3's search for minGap: 8 mm, or past t. */
export function gapSearch(params: Params): number {
  return Math.max(8, params.silicone.t + 0.7);
}

export interface ClamshellG4 {
  prep: ClamshellPrep;
  fine: FineSplit;
  build: ClamshellBuild;
  /** minGap(model, half) less `error`, the - half's first. */
  gaps: [number, number];
  /** How far rEff was raised for the rebuild, 0 with none. */
  raisedBy: number;
  /** The first build, kept while the second is made, as the heap budget counts both pairs. Null with no rebuild. */
  first: ClamshellBuild | null;
  /** The one-piece export's own: margin-raised with the rebuild, and clearance-short when a gap is under t even after it. */
  diagnostics: Diagnostic[];
}

/**
 * G13.4's G4 for each half: two minGap(model, half) calls less GC's proved `error`. If the least is under t, rEff is
 * raised by the shortfall plus G4_RAISE_EXTRA and the mold built once more at the first build's axis and xs, so its
 * bed outcome stands, and the gaps measured again. `mesh` is the oriented model, `model` its solid (or what minGap reads
 * for it). The diagnostics are the one-piece export's, with its codes.
 */
export function clamshellG4(arena: Arena, mesh: WeldedMesh, params: Params, split: { axis: SeamAxis; xs: number }, model: Manifold, options: ClamshellBuildOptions & { cell?: number; error?: number; inputs?: ClamshellInputs; openingsFor?: (prep: ClamshellPrep, fine: FineSplit) => CutOpening[] } = {}): ClamshellG4 {
  const { cell = params.quality.cellFinal, error = 0, inputs = {} } = options;
  const search = gapSearch(params);
  const make = (p: Params): { prep: ClamshellPrep; fine: FineSplit; build: ClamshellBuild; gaps: [number, number] } => {
    const prep = prepareClamshell(mesh, p, inputs);
    const fine = fineSplit(prep, split.axis, split.xs, cell);
    const openings = options.openingsFor ? options.openingsFor(prep, fine) : options.openings;
    const build = buildClamshell(arena, prep, fine, { ...options, openings });
    const gaps = build.halves.map((half) => model.minGap(half, search) - error) as [number, number];
    return { prep, fine, build, gaps };
  };
  const { t } = params.silicone;
  const first = make(params);
  const least = Math.min(...first.gaps);
  if (least >= t) return { ...first, raisedBy: 0, first: null, diagnostics: [] };
  const raisedBy = t - least + G4_RAISE_EXTRA;
  const margin = resolveAuto(params, first.prep.bounds).printMargin;
  const second = make({ ...params, silicone: { ...params.silicone, printMargin: margin + raisedBy } });
  const diagnostics: Diagnostic[] = [{ code: 'margin-raised', severity: 'warning', message: `The silicone measured thinner than ${t} mm in places, so the safety margin was raised by ${raisedBy.toFixed(2)} mm and the mold built again, a little larger than the preview shows.` }];
  const measured = Math.min(...second.gaps);
  if (measured < t) diagnostics.push({ code: 'clearance-short', severity: 'error', message: `Even after a wider safety margin, the silicone is only ${measured.toFixed(2)} mm thick at its thinnest, under the ${t} mm asked for. Raise Print margin under Advanced, Silicone, and export again.` });
  return { ...second, raisedBy, first: first.build, diagnostics };
}
