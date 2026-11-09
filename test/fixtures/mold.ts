import type { CrossSection, Manifold } from 'manifold-3d';
import { candidateAtLevel, findBaseCandidates, upperLevel, type BaseCandidate } from '../../src/core/base/candidates';
import { buildFootprint, type Footprint } from '../../src/core/base/footprint';
import { orientToBase, type OrientedModel } from '../../src/core/base/orient';
import { buildField, type BuiltField } from '../../src/core/field/build';
import { fieldSettings, planField, type FieldPlan, type FieldSettings } from '../../src/core/field/grid';
import { auditEdges } from '../../src/core/mesh/audit';
import { importSolid, type ImportedSolid } from '../../src/core/mesh/shells';
import { meshBounds, type Bounds, type WeldedMesh } from '../../src/core/mesh/weld';
import { baseOptions, resolveAuto } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';
import { buildBaseBody, buildGlueBase, buildMergedBase, orientedSolid, pocketOutline, triangleContour, type GlueBase, type MergedBase } from '../../src/core/parts/base';
import { buildCoverBody } from '../../src/core/parts/cover';
import { deriveRim, moldBounds, type MoldBounds, type Rim } from '../../src/core/parts/rim';
import type { Arena } from '../../src/core/solid/arena';
import { buildToolMesh, toolSolid, type ToolMesh } from '../../src/core/solid/tool';

export interface MoldOptions {
  /** G2.6: move the plane to the upper level, as "Use upper level" does. */
  useUpper?: boolean;
  /** Which candidate plane to stand on. The top ranked one otherwise, as the user would confirm. */
  pick?: (candidates: BaseCandidate[]) => BaseCandidate;
  /** The closed-volume check raises this a hair above the shelf. */
  plateTop?: number;
  /** Field cell, when it should not be the export cell: this is what a preview does. */
  cell?: number;
  tinTol?: number;
  /** Which bases to build. Both by default. */
  modes?: { glue?: boolean; merged?: boolean };
}

export interface MoldTimings {
  field: number;
  tin: number;
  toolSolid: number;
  rim: number;
  cover: number;
  baseBody: number;
  glue: number;
  merged: number;
}

export interface Mold {
  imported: ImportedSolid;
  candidate: BaseCandidate;
  oriented: OrientedModel;
  /** The oriented solid, trimmed if it needs to be. Null in soup mode. */
  model: Manifold | null;
  footprint: Footprint;
  bounds: Bounds;
  settings: FieldSettings;
  plan: FieldPlan;
  built: BuiltField;
  toolMesh: ToolMesh;
  tool: Manifold;
  mold: MoldBounds;
  rim: Rim;
  cover: Manifold;
  baseBody: Manifold;
  outline: CrossSection;
  glue: GlueBase | null;
  merged: MergedBase | null;
  planeTol: number;
  pocketDepth: number;
  timings: MoldTimings;
}

/**
 * The stages in the order M5's pipeline will run them, on the real builders, with each one timed.
 * Handles belong to the arena passed in.
 */
export function buildMold(arena: Arena, welded: WeldedMesh, params: Params, options: MoldOptions = {}): Mold {
  const { modes = { glue: true, merged: true } } = options;
  const now = (): number => performance.now();
  const whole = meshBounds(welded.positions);
  const planeTol = resolveAuto(params, whole).planeTol;
  const base = baseOptions(params, whole);

  const imported = importSolid(arena, welded, auditEdges(welded));
  const soup = imported.solid === null;
  const candidates = findBaseCandidates(imported.mesh, base, soup ? { openLoops: imported.openLoops } : undefined);
  if (candidates.length === 0) throw new Error('No base candidate.');
  let candidate = options.pick ? options.pick(candidates) : candidates[0];
  if (options.useUpper) {
    const upper = upperLevel(candidate, planeTol);
    if (!upper) throw new Error('No upper level to use.');
    candidate = candidateAtLevel(imported.mesh, candidate, upper.offset, base);
  }
  const oriented = orientToBase(imported.mesh, candidate, { planeTol, soup, openLoops: imported.openLoops });
  const model = orientedSolid(arena, imported, oriented);
  const cap = oriented.needsTrim && model ? arena.track(model.slice(0.02)) : undefined;
  const footprint = buildFootprint(arena, oriented.mesh, candidate, params.base.minIsland, cap);

  const bounds = meshBounds(oriented.mesh.positions);
  const settings = fieldSettings(params, bounds, options.cell);
  const plan = planField(bounds, settings);
  const t0 = now();
  const mold = moldBounds(oriented.mesh, bounds, settings);
  const built = buildField(oriented.mesh, plan, settings, undefined, mold.D);
  const t1 = now();
  // G4: the raise is the tolerance in use, so a preview at 0.1 gets 0.1. plan.raise is the export's.
  const tol = options.tinTol ?? params.quality.tinTolFinal;
  const toolMesh = buildToolMesh(built.field, { raise: tol, tol });
  const t2 = now();
  const tool = toolSolid(arena, toolMesh);
  const t3 = now();
  const rim = deriveRim(mold, params);
  const t4 = now();
  const cover = buildCoverBody(arena, rim, tool);
  const t5 = now();
  const baseBody = buildBaseBody(arena, rim, { plateTop: options.plateTop });
  const t6 = now();

  const pocketDepth = resolveAuto(params, bounds).pocketDepth;
  const section = model ? arena.track(model.slice(pocketDepth)) : triangleContour(arena, oriented.mesh, pocketDepth);
  const outline = pocketOutline(arena, footprint, section, params.base.pocketEnlarge);
  const glue = modes.glue ? buildGlueBase(arena, baseBody, outline, pocketDepth, mold.offsets) : null;
  const t7 = now();
  const merged = modes.merged ? buildMergedBase(arena, baseBody, model, footprint, { planeTol, offsets: mold.offsets }) : null;
  const t8 = now();

  return {
    imported, candidate, oriented, model, footprint, bounds, settings, plan, built, toolMesh, tool, mold, rim, cover, baseBody, outline, glue, merged, planeTol, pocketDepth,
    timings: { field: t1 - t0, tin: t2 - t1, toolSolid: t3 - t2, rim: t4 - t3, cover: t5 - t4, baseBody: t6 - t5, glue: t7 - t6, merged: t8 - t7 },
  };
}
