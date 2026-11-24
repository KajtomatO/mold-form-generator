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
import { buildClamCommon, buildClamHalf, trimHalf } from './cover';
import type { CutOpening } from './openings';
import type { ClamRim } from './rim';
import { seamGroove, seamPins, seamSeal, seamSection, seamSockets, seamTongue, type SeamSeal } from './seam';

/**
 * MP2: the two-part cover's parts, G13.7 to G13.9, at a fine split from src/core/field/clamshell.ts: the tools, the seal,
 * the halves and the base, the silicone's solid for the 1% check, and G4 for each half with its one rebuild. The field
 * code stays free of Manifold, so this lives with the parts.
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
  diagnostics: Diagnostic[];
}

export interface ClamshellBuildOptions {
  /** The openings on P, cut from both halves. */
  openings?: CutOpening[];
  /** Tests only: the seal changed before its solids are cut, for the negative controls. */
  seal?: (seal: SeamSeal, rim: ClamRim, params: Params) => SeamSeal;
  /** Tests only: G10's whole ridge ring for the bars, a negative control. */
  ridgeRing?: boolean;
}

/**
 * G13.7 steps 1 to 5 and 7 at a fine split: the two tools (G13.2 step 7's seam held clear of P), the seal from the
 * cavity on P, the shared block, the halves and the base. The handles belong to `arena`.
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
  const common = buildClamCommon(arena, rim);
  const neg = buildClamHalf(arena, rim, common, tools[0], -1, { add: [seamTongue(arena, seal, params), ...seamPins(arena, seal)], cut: [] }, openings);
  const pos = buildClamHalf(arena, rim, common, tools[1], 1, { add: [], cut: [seamGroove(arena, seal), ...seamSockets(arena, seal)] }, openings);
  const base = buildBaseBody(arena, rim, options.ridgeRing ? {} : { ridgeBars: rim.axis });
  const diagnostics = [...rim.diagnostics, ...meshes.flatMap((mesh) => mesh.diagnostics), ...seal.diagnostics];
  return { rim, meshes, tools, seal, common, halves: [neg, pos], base, openings, diagnostics };
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
