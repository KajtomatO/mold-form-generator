import { zipSync } from 'fflate';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { replicateOpenings } from '../core/analysis/placement';
import { checkOpening, openingSizes, placementSpace, type OpeningSpot } from '../core/analysis/validate';
import type { BaseCandidate } from '../core/base/candidates';
import { buildFootprint } from '../core/base/footprint';
import { transformPositions, trimToBase, type OrientedModel, type RigidTransform } from '../core/base/orient';
import { buildField } from '../core/field/build';
import { fieldSettings, planField } from '../core/field/grid';
import type { MeshAudit } from '../core/mesh/audit';
import { importSolid } from '../core/mesh/shells';
import { simplifyForManifold, type MeshSimplifier } from '../core/mesh/simplify';
import { meshBounds, type WeldedMesh } from '../core/mesh/weld';
import { resolveAuto } from '../core/params/defaults';
import { crossParameterErrors } from '../core/params/rules';
import type { Params } from '../core/params/schema';
import { buildBaseBody, buildGlueBase, buildMergedBase, layerDiagnostics, orientedSolid, pocketOutline, triangleContour } from '../core/parts/base';
import { buildCoverBody, buildCoverFinal, toolDiagnostics } from '../core/parts/cover';
import { buildFunnel, funnelPose } from '../core/parts/funnel';
import { basePose, coverPose, modelOrientedStl, poseToStl } from '../core/parts/poses';
import { deriveRim, moldBounds, type Rim } from '../core/parts/rim';
import type { Diagnostic } from '../core/report/diagnostics';
import { withArena, type Arena } from '../core/solid/arena';
import { buildToolMesh, toolSolid } from '../core/solid/tool';
import { InlineError } from './fieldStages';

/** G4: minGap runs against the model decimated to at most this many triangles. */
export const MIN_GAP_TRIANGLES = 60_000;
/** G4: the margin is raised by the shortfall plus this, once. */
const RAISE_EXTRA = 0.05;
/** M3: 8 mm cannot see t = 10, so the search reaches past t. */
const SEARCH_PAST_T = 0.7;
/** Fixed, so the same mold always gives the same ZIP. */
const ZIP_TIME = new Date('2020-01-01T00:00:00Z');

export interface ExportInputs {
  welded: WeldedMesh;
  audit: MeshAudit;
  candidate: Pick<BaseCandidate, 'members' | 'holes'>;
  transform: RigidTransform;
  needsTrim: boolean;
  planeTol: number;
  /** Where the openings are, as the preview placed them or the user dragged them. Their copies and depths come from the export field. */
  openings: OpeningSpot[];
}

export interface Clearance {
  /** minGap between the decimated model and the cover, less the decimation's error. */
  measured: number;
  /** The decimation's error, in mm. 0 when the model itself was measured. */
  error: number;
  /** By how much the margin was raised for a second build, or 0. */
  raisedBy: number;
}

export interface ExportOutputs {
  files: Record<string, Uint8Array>;
  zip: Uint8Array;
  /** Null for an open mesh, which has no solid to measure. */
  clearance: Clearance | null;
  rim: Rim;
  diagnostics: Diagnostic[];
}

export type ProgressReport = (step: string, done: number, total: number) => void;

const STEPS = ['import', 'field', 'tool', 'cover', 'base', 'clearance', 'files'];

interface Built {
  cover: Manifold;
  base: Manifold;
  rim: Rim;
  offsets: [number, number][];
  diagnostics: Diagnostic[];
}

/**
 * T3 in one go, in a fresh solid worker: the export cell, the export tolerance, minGap with one raise of
 * the margin if it comes up short, and the files in their print poses. Nothing is kept, as the worker is
 * terminated when this returns. `cellScale` above 1 is the retry after a crash.
 */
export function runExport(api: ManifoldToplevel, simplifier: MeshSimplifier, params: Params, inputs: ExportInputs, progress: ProgressReport, now: () => number, timings: Record<string, number> = {}, cellScale = 1): ExportOutputs {
  const timed = <T>(step: string, build: () => T): T => {
    progress(step, STEPS.indexOf(step), STEPS.length);
    const t0 = now();
    const value = build();
    timings[step] = (timings[step] ?? 0) + now() - t0;
    return value;
  };
  const scaled: Params = cellScale === 1 ? params : { ...params, quality: { ...params.quality, cellFinal: params.quality.cellFinal * cellScale } };

  return withArena(api, (arena) => {
    const imported = timed('import', () => importSolid(arena, inputs.welded, inputs.audit));
    const mesh: WeldedMesh = { positions: transformPositions(imported.mesh.positions, inputs.transform), indices: imported.mesh.indices };
    const bounds = meshBounds(mesh.positions);
    const model = orientedSolid(arena, imported, { transform: inputs.transform, needsTrim: inputs.needsTrim });
    const cap = inputs.needsTrim && model ? arena.track(model.slice(0.02)) : undefined;
    const footprint = buildFootprint(arena, mesh, inputs.candidate, scaled.base.minIsland, cap);
    const { pocketDepth, printMargin } = resolveAuto(scaled, bounds);
    const diagnostics: Diagnostic[] = [...crossParameterErrors(scaled), ...imported.report.diagnostics, ...footprint.diagnostics];
    // The coarser cell widens the margin of G4, and with it the cavity and the box, past what the preview showed.
    if (cellScale !== 1) diagnostics.push({ code: 'export-coarser', severity: 'warning', message: `The geometry engine failed at a cell of ${params.quality.cellFinal} mm, so the export was built again at ${scaled.quality.cellFinal} mm, with a wider margin and a larger box than the preview shows.` });

    const build = (margin: number): Built => {
      const raised: Params = { ...scaled, silicone: { ...scaled.silicone, printMargin: margin } };
      const own: Diagnostic[] = [];
      const { field, rim, offsets, copies } = timed('field', () => {
        const settings = fieldSettings(raised, bounds);
        const built = buildField(mesh, planField(bounds, settings), settings);
        // The export plan's bounds and offsets, which the preview used as well, so the box is the one shown.
        const mold = moldBounds(mesh, bounds, settings);
        const rim = deriveRim(mold, raised);
        const space = placementSpace(built.field, rim, mold.offsets, openingSizes(raised));
        own.push(...built.diagnostics, ...rim.diagnostics);
        for (const spot of inputs.openings) {
          const check = checkOpening(space, spot, inputs.openings);
          if (!check.valid) own.push({ code: 'export-opening-invalid', severity: 'error', message: `The ${spot.kind} at (${spot.x.toFixed(1)}, ${spot.y.toFixed(1)}) is not valid on the export field (${check.problems.join(', ')}), so please move it.` });
        }
        return { field: built.field, rim, offsets: mold.offsets, copies: replicateOpenings(inputs.openings, space) };
      });
      const tool = timed('tool', () => {
        const toolMesh = buildToolMesh(field, { raise: raised.quality.tinTolFinal, tol: raised.quality.tinTolFinal, clip: rim.D });
        // The export's own field must sit inside its rim. A crop here would take away clearance, so it is a fault.
        if (toolMesh.clippedNodes > 0) throw new Error(`The export field reaches past the rim at ${toolMesh.clippedNodes} nodes, so the cavity would lose clearance there.`);
        own.push(...toolMesh.diagnostics, ...toolDiagnostics(rim, toolMesh));
        return toolSolid(arena, toolMesh);
      });
      const cover = timed('cover', () => buildCoverFinal(arena, buildCoverBody(arena, rim, tool), rim, copies));
      const base = timed('base', () => {
        const body = buildBaseBody(arena, rim);
        own.push(...layerDiagnostics(raised.base.thickness, pocketDepth, raised.print.layerHeight));
        if (raised.base.mode === 'merged') {
          const merged = buildMergedBase(arena, body, model, footprint, { planeTol: inputs.planeTol, offsets });
          if (!merged.base) throw new InlineError('mode-b-disabled', merged.diagnostics[0].message);
          own.push(...merged.diagnostics);
          return merged.base;
        }
        const section = model ? arena.track(model.slice(pocketDepth)) : triangleContour(arena, mesh, pocketDepth);
        const glue = buildGlueBase(arena, body, pocketOutline(arena, footprint, section, raised.base.pocketEnlarge), pocketDepth, offsets);
        own.push(...glue.diagnostics);
        return glue.base;
      });
      return { cover, base, rim, offsets, diagnostics: own };
    };

    let built = build(printMargin);
    let clearance: Clearance | null = null;
    const probe = model ? decimate(arena, simplifier, mesh, model, inputs.needsTrim) : null;
    if (probe) {
      const search = Math.max(8, scaled.silicone.t + SEARCH_PAST_T);
      const gapOf = (b: Built): number => timed('clearance', () => {
        const copies = b.offsets.map(([x, y]) => arena.track(probe.solid.translate([x, y, 0])));
        return arena.track(arena.api.Manifold.compose(copies)).minGap(b.cover, search) - probe.error;
      });
      let measured = gapOf(built);
      let raisedBy = 0;
      if (measured < scaled.silicone.t) {
        raisedBy = scaled.silicone.t - measured + RAISE_EXTRA;
        built = build(printMargin + raisedBy);
        measured = gapOf(built);
        diagnostics.push({ code: 'margin-raised', severity: 'info', message: `The measured clearance came up short, so the margin was raised by ${raisedBy.toFixed(2)} mm and the mold built again.` });
      }
      clearance = { measured, error: probe.error, raisedBy };
      if (measured < scaled.silicone.t) diagnostics.push({ code: 'clearance-short', severity: 'error', message: `The silicone is only ${measured.toFixed(2)} mm thick at its thinnest, under the ${scaled.silicone.t} mm asked for.` });
    } else {
      diagnostics.push({ code: 'clearance-unverified', severity: 'warning', message: 'An open mesh has no solid to measure, so the clearance is nominal and unverified.' });
    }
    diagnostics.push(...built.diagnostics);

    const files = timed('files', () => {
      const out: Record<string, Uint8Array> = {
        'cover.stl': poseToStl(api, built.cover, coverPose(built.rim)),
        'base.stl': poseToStl(api, built.base, basePose(built.rim)),
      };
      if (scaled.funnel.generate && !crossParameterErrors(scaled).some((d) => d.code.startsWith('funnel-'))) out['funnel.stl'] = poseToStl(api, buildFunnel(arena, scaled), funnelPose(scaled));
      if (scaled.base.mode === 'glue') out['model_oriented.stl'] = modelOrientedStl({ mesh, needsTrim: inputs.needsTrim } as OrientedModel, model);
      return out;
    });
    const zip = zipSync(Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, [bytes, { mtime: ZIP_TIME }]])));
    return { files, zip, clearance, rim: built.rim, diagnostics };
  });
}

/** G4: the model for minGap, decimated when it is heavy. The model itself when it is not, or when the decimated copy is no solid. */
function decimate(arena: Arena, simplifier: MeshSimplifier, mesh: WeldedMesh, model: Manifold, needsTrim: boolean): { solid: Manifold; error: number } {
  const simplified = simplifyForManifold(mesh, simplifier, MIN_GAP_TRIANGLES);
  if (!simplified) return { solid: model, error: 0 };
  try {
    const solid = arena.manifold(new arena.api.Mesh({ numProp: 3, vertProperties: simplified.mesh.positions, triVerts: simplified.mesh.indices }));
    return { solid: needsTrim ? trimToBase(arena, solid) : solid, error: simplified.errorMm };
  } catch (error) {
    // A simplified copy can fold onto itself. Measuring the model itself is slower, never wrong.
    if (error instanceof Error && error.name === 'ManifoldError') return { solid: model, error: 0 };
    throw error;
  }
}
