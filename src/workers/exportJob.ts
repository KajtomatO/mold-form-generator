import { zipSync } from 'fflate';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { projectFile, type Project } from '../app/project';
import { APP_NAME, APP_VERSION } from '../app/version';
import { boreSilicone, replicateOpenings } from '../core/analysis/placement';
import { boreLength, checkOpening, openingSizes, placementSpace, type OpeningSpot, type PlacementSpace } from '../core/analysis/validate';
import type { BaseCandidate } from '../core/base/candidates';
import { buildFootprint } from '../core/base/footprint';
import { transformPositions, trimToBase, type OrientedModel, type RigidTransform } from '../core/base/orient';
import { buildField } from '../core/field/build';
import { fieldSettings, planField, type Field, type FieldPlan, type FieldSettings } from '../core/field/grid';
import { moldSilicone } from '../core/field/silicone';
import type { MeshAudit } from '../core/mesh/audit';
import { importSolid, type ImportedSolid } from '../core/mesh/shells';
import { simplifyForManifold, type MeshSimplifier } from '../core/mesh/simplify';
import { meshBounds, type WeldedMesh } from '../core/mesh/weld';
import { resolveAuto } from '../core/params/defaults';
import { crossParameterErrors } from '../core/params/rules';
import { SCHEMA_VERSION, type Params } from '../core/params/schema';
import { buildBaseBody, buildGlueBase, buildMergedBase, layerDiagnostics, orientedSolid, pocketOutline, triangleContour } from '../core/parts/base';
import { buildCoverBody, buildCoverFinal, toolDiagnostics } from '../core/parts/cover';
import { fitTestFiles } from '../core/parts/fitTest';
import { buildFunnel, funnelFile, funnelPose } from '../core/parts/funnel';
import type { CutOpening } from '../core/parts/openings';
import { basePose, coverPose, modelOrientedStl, poseToStl } from '../core/parts/poses';
import { deriveRim, moldBounds, type Rim } from '../core/parts/rim';
import type { Diagnostic } from '../core/report/diagnostics';
import { exportReadme } from '../core/report/readme';
import { withArena, type Arena } from '../core/solid/arena';
import { buildToolMesh, toolSolid } from '../core/solid/tool';
import { InlineError, type PlaneChoice } from './fieldStages';

/** G4: minGap runs against the model decimated to at most this many triangles. */
export const MIN_GAP_TRIANGLES = 60_000;
/** G4: the margin is raised by the shortfall plus this, once. */
const RAISE_EXTRA = 0.05;
/** M3: 8 mm cannot see t = 10, so the search reaches past t. */
const SEARCH_PAST_T = 0.7;
/** Fixed, so the same mold always gives the same ZIP. */
const ZIP_TIME = new Date('2020-01-01T00:00:00Z');

/** The ZIP, or one of the single-part buttons. Each runs on this one path, in a fresh solid worker. */
export type ExportWant = 'zip' | 'cover' | 'base' | 'funnel' | 'fit-test';

export interface ExportRequest {
  want: ExportWant;
  /** The ZIP only: the fit-test pieces go in as fit_test/. */
  fitTest: boolean;
}

/** An opening where the preview placed it or the user pinned it. Its copies and depths come from the export field. */
export interface ExportOpening extends OpeningSpot {
  id: string;
  pinned: boolean;
}

export interface ExportInputs {
  welded: WeldedMesh;
  audit: MeshAudit;
  candidate: Pick<BaseCandidate, 'members' | 'holes'>;
  transform: RigidTransform;
  needsTrim: boolean;
  planeTol: number;
  openings: ExportOpening[];
}

/** What main knows and the export does not, for the README, report.json and project.json. */
export interface ExportMeta {
  /** The STL's file name. */
  model: string;
  /** As parsed: the file's own count, and what is left once collapsed triangles are dropped. */
  triangles: { format: 'binary' | 'ascii'; inFile: number; kept: number };
  project: Project;
  plane: { normal: [number, number, number]; offset: number; area: number; planeTol: number };
  /** The diagnostics in force on main, which the README and report list with the export's own. */
  notes: Diagnostic[];
}

/** The funnel and the fit test need no model, so they come with no inputs and no meta. */
export interface ExportJob extends ExportRequest {
  params: Params;
  inputs: ExportInputs | null;
  /** Above 1 on the retry after a crash. */
  cellScale: number;
  meta: ExportMeta | null;
}

export interface Clearance {
  /** minGap between the decimated model and the cover, less the decimation's error. */
  measured: number;
  /** The decimation's error, in mm. 0 when the model itself was measured. */
  error: number;
  /** By how much the margin was raised for a second build, or 0. */
  raisedBy: number;
}

/** report.json: every number of the export, for the maker to check and for M9 and support to read. */
export interface ExportReport {
  app: string;
  appVersion: string;
  schemaVersion: number;
  model: { file: string; format: 'binary' | 'ascii'; trianglesInFile: number; triangles: number; bodies: number; volumeMm3: number | null };
  params: Params;
  plane: { choice: PlaneChoice; normal: [number, number, number]; offset: number; areaMm2: number; planeTol: number };
  /** Each copy's shift from the first, in mm. */
  tiles: [number, number][];
  box: { x: number; y: number; z: number; Zt: number; Tb: number };
  /** Per opening of the first tile: zb is the lowest ceiling under any copy's disc, the bore the longest copy's. */
  openings: { id: string; kind: 'pour' | 'vent'; x: number; y: number; pinned: boolean; zb: number; boreLength: number; copies: number }[];
  silicone: { ml: number; grams: number; density: number; boresMl: number; sealedAirMl: number };
  clearance: { asked: number; measured: number | null; minGap: number | null; decimationError: number | null; marginRaisedBy: number; searchMm: number | null };
  parts: Record<string, { triangles: number; volumeMm3: number | null }>;
  diagnostics: Diagnostic[];
  /** In ms, per step of this export, and the total until the ZIP is packed, which is the one step left out. */
  timings: Record<string, number>;
}

export interface ExportOutputs {
  want: ExportWant;
  /** By path, as in the ZIP. */
  files: Record<string, Uint8Array>;
  /** The ZIP's bytes for the ZIP and the fit test, empty for a single part. */
  zip: Uint8Array;
  /** Null for an open mesh, which has no solid to measure, and for the parts that need no model. */
  clearance: Clearance | null;
  /** Null for the funnel and the fit test, which have no rim of the mold. */
  rim: Rim | null;
  diagnostics: Diagnostic[];
  report: ExportReport | null;
}

export type ProgressReport = (step: string, done: number, total: number) => void;

/** The steps each request goes through, in order, which the stage bar counts. */
export function exportSteps(request: ExportRequest): string[] {
  switch (request.want) {
    case 'funnel':
      return ['funnel'];
    case 'fit-test':
      return ['fit-test', 'zip'];
    case 'cover':
      return ['import', 'field', 'tool', 'cover', 'clearance', 'files'];
    case 'base':
      return ['import', 'field', 'tool', 'cover', 'base', 'clearance', 'files'];
    default:
      return ['import', 'field', 'tool', 'cover', 'base', 'clearance', 'files', ...(request.fitTest ? ['fit-test'] : []), 'zip'];
  }
}

interface Built {
  cover: Manifold;
  /** Null when only the cover was asked for. */
  base: Manifold | null;
  rim: Rim;
  offsets: [number, number][];
  field: Field;
  plan: FieldPlan;
  settings: FieldSettings;
  space: PlacementSpace;
  copies: CutOpening[];
  diagnostics: Diagnostic[];
}

const zip = (files: Record<string, Uint8Array>): Uint8Array => zipSync(Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, [bytes, { mtime: ZIP_TIME }]])));

const triangles = (stl: Uint8Array): number => (stl.length - 84) / 50;

/** Each diagnostic once, by its code and message, in the order first given. */
function unique(list: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return list.filter((d) => {
    const key = `${d.code}|${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * T3 in one go, in a fresh solid worker: the export cell, the export tolerance, minGap with one raise of
 * the margin if it comes up short, and the files in their print poses. Nothing is kept, as the worker is
 * terminated when this returns. A cellScale above 1 is the retry after a crash. The single parts run
 * the same steps as the ZIP, so a part saved alone is the one the ZIP holds; only what nothing needs is
 * left out. The base needs the cover still, as a raise of the margin moves the rim of both.
 */
export function runExport(api: ManifoldToplevel, simplifier: MeshSimplifier, job: ExportJob, progress: ProgressReport, now: () => number, timings: Record<string, number> = {}): ExportOutputs {
  const steps = exportSteps(job);
  // After a raise of the margin the build runs again. Its steps show as one, 'raise', where the clearance
  // stands, so the stage bar never runs backwards. A step is reported once, when it begins.
  let raising = false;
  let shown = '';
  const timed = <T>(step: string, build: () => T): T => {
    const label = raising && step !== 'clearance' ? 'raise' : step;
    if (label !== shown) progress(label, steps.indexOf(raising ? 'clearance' : step), steps.length);
    shown = label;
    const t0 = now();
    const value = build();
    timings[step] = (timings[step] ?? 0) + now() - t0;
    return value;
  };
  const { params, inputs, cellScale, want } = job;
  const started = now();

  // These two need no model, so they skip the mold altogether.
  if (want === 'funnel') {
    const problem = params.funnel.generate ? crossParameterErrors(params).find((d) => d.code.startsWith('funnel-')) : { message: 'The funnel is turned off under Pour & funnel.' };
    if (problem) throw new InlineError('funnel-unavailable', problem.message);
    const files = { 'funnel.stl': timed('funnel', () => funnelFile(api, params, 0).stl) };
    return { want, files, zip: new Uint8Array(), clearance: null, rim: null, diagnostics: [], report: null };
  }
  if (want === 'fit-test') {
    const files = timed('fit-test', () => fitTestFiles(api, params));
    return { want, files, zip: timed('zip', () => zip(files)), clearance: null, rim: null, diagnostics: [], report: null };
  }

  const { meta } = job;
  if (!inputs || !meta) throw new Error(`An export of the ${want} needs the model.`);
  const scaled: Params = cellScale === 1 ? params : { ...params, quality: { ...params.quality, cellFinal: params.quality.cellFinal * cellScale } };
  return withArena(api, (arena) => {
    const imported = timed('import', () => importSolid(arena, inputs.welded, inputs.audit));
    const mesh: WeldedMesh = { positions: transformPositions(imported.mesh.positions, inputs.transform), indices: imported.mesh.indices };
    const bounds = meshBounds(mesh.positions);
    const model = orientedSolid(arena, imported, { transform: inputs.transform, needsTrim: inputs.needsTrim });
    const cap = inputs.needsTrim && model ? arena.track(model.slice(0.02)) : undefined;
    const footprint = buildFootprint(arena, mesh, inputs.candidate, scaled.base.minIsland, cap);
    const { pocketDepth, printMargin, ventPersistence } = resolveAuto(scaled, bounds);
    const diagnostics: Diagnostic[] = [...crossParameterErrors(scaled), ...imported.report.diagnostics, ...footprint.diagnostics];
    // The coarser cell widens the margin of G4, and with it the cavity and the box, past what the preview showed.
    if (cellScale !== 1) diagnostics.push({ code: 'export-coarser', severity: 'warning', message: `The geometry engine failed at full detail, so the export was built again at half the detail, on a ${scaled.quality.cellFinal} mm grid instead of ${params.quality.cellFinal} mm, with a wider safety margin and a larger box than the preview shows.` });

    const build = (margin: number): Built => {
      const raised: Params = { ...scaled, silicone: { ...scaled.silicone, printMargin: margin } };
      const own: Diagnostic[] = [];
      const shaped = timed('field', () => {
        const settings = fieldSettings(raised, bounds);
        const plan = planField(bounds, settings);
        const built = buildField(mesh, plan, settings);
        // The export plan's bounds and offsets, which the preview used as well, so the box is the one shown.
        const mold = moldBounds(mesh, bounds, settings);
        const rim = deriveRim(mold, raised);
        const space = placementSpace(built.field, rim, mold.offsets, openingSizes(raised));
        own.push(...built.diagnostics, ...rim.diagnostics);
        for (const spot of inputs.openings) {
          const check = checkOpening(space, spot, inputs.openings);
          if (!check.valid) own.push({ code: 'export-opening-invalid', severity: 'error', message: `The ${spot.kind} at (${spot.x.toFixed(1)}, ${spot.y.toFixed(1)}) is not valid on the export field (${check.problems.join(', ')}), so please move it.` });
        }
        return { field: built.field, plan, settings, rim, space, offsets: mold.offsets, copies: replicateOpenings(inputs.openings, space) };
      });
      const { rim, offsets, copies } = shaped;
      const tool = timed('tool', () => {
        const toolMesh = buildToolMesh(shaped.field, { raise: raised.quality.tinTolFinal, tol: raised.quality.tinTolFinal, clip: rim.D });
        // The export's own field must sit inside its rim. A crop here would take away clearance, so it is a fault.
        if (toolMesh.clippedNodes > 0) throw new Error(`At full detail the cavity reaches past the joint around it at ${toolMesh.clippedNodes} points, so the silicone would come out thinner there, and nothing was saved. Try a slightly different Export cell under Advanced, Quality; if that does not help, please report it with the model.`);
        own.push(...toolMesh.diagnostics, ...toolDiagnostics(rim, toolMesh));
        return toolSolid(arena, toolMesh);
      });
      const cover = timed('cover', () => buildCoverFinal(arena, buildCoverBody(arena, rim, tool), rim, copies));
      const base = want === 'cover' ? null : timed('base', () => {
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
      return { ...shaped, cover, base, diagnostics: own };
    };

    let built = build(printMargin);
    let clearance: Clearance | null = null;
    const search = Math.max(8, scaled.silicone.t + SEARCH_PAST_T);
    // Decimating a heavy model is part of measuring it, so it shows as that step.
    const probe = model ? timed('clearance', () => decimate(arena, simplifier, mesh, model, inputs.needsTrim)) : null;
    if (probe) {
      const gapOf = (b: Built): number => timed('clearance', () => {
        const copies = b.offsets.map(([x, y]) => arena.track(probe.solid.translate([x, y, 0])));
        return arena.track(arena.api.Manifold.compose(copies)).minGap(b.cover, search) - probe.error;
      });
      let measured = gapOf(built);
      let raisedBy = 0;
      if (measured < scaled.silicone.t) {
        raisedBy = scaled.silicone.t - measured + RAISE_EXTRA;
        raising = true;
        built = build(printMargin + raisedBy);
        raising = false;
        measured = gapOf(built);
        diagnostics.push({ code: 'margin-raised', severity: 'warning', message: `The silicone measured thinner than ${scaled.silicone.t} mm in places, so the safety margin was raised by ${raisedBy.toFixed(2)} mm and the mold built again, a little larger than the preview shows.` });
      }
      clearance = { measured, error: probe.error, raisedBy };
      if (measured < scaled.silicone.t) diagnostics.push({ code: 'clearance-short', severity: 'error', message: `Even after a wider safety margin, the silicone is only ${measured.toFixed(2)} mm thick at its thinnest, under the ${scaled.silicone.t} mm asked for. Raise Print margin under Advanced, Silicone, and export again.` });
    } else {
      diagnostics.push({ code: 'clearance-unverified', severity: 'warning', message: `The model's mesh has holes, so the silicone thickness could not be measured: the mold is planned to leave at least ${scaled.silicone.t} mm, but that is not checked.` });
    }
    diagnostics.push(...built.diagnostics);

    const funnel = want === 'zip' && scaled.funnel.generate && !crossParameterErrors(scaled).some((d) => d.code.startsWith('funnel-')) ? buildFunnel(arena, scaled) : null;
    const files = timed('files', () => {
      const out: Record<string, Uint8Array> = {};
      if (want !== 'base') out['cover.stl'] = poseToStl(api, built.cover, coverPose(built.rim));
      if (built.base && want !== 'cover') out['base.stl'] = poseToStl(api, built.base, basePose(built.rim));
      if (funnel) out['funnel.stl'] = poseToStl(api, funnel, funnelPose(scaled));
      if (want === 'zip' && scaled.base.mode === 'glue') out['model_oriented.stl'] = modelOrientedStl({ mesh, needsTrim: inputs.needsTrim } as OrientedModel, model);
      return out;
    });
    if (want !== 'zip') return { want, files, zip: new Uint8Array(), clearance, rim: built.rim, diagnostics, report: null };

    if (job.fitTest) Object.assign(files, timed('fit-test', () => fitTestFiles(api, params)));
    return timed('zip', () => {
      const silicone = moldSilicone(mesh, built.plan, built.field, imported.report, built.settings);
      const boresMl = boreSilicone(built.copies, built.field, built.rim.Zt) / 1000;
      const ml = silicone.ml + boresMl;
      const inForce = unique([...diagnostics, ...meta.notes]);
      const volumes: Record<string, number | null> = {
        'cover.stl': built.cover.volume(),
        'base.stl': built.base!.volume(),
        'funnel.stl': funnel ? funnel.volume() : null,
        'model_oriented.stl': model ? model.volume() : null,
      };
      const report = buildReport(params, inputs, meta, { imported, model, built, clearance, search: probe ? search : null, silicone: { ml, boresMl, sealedAirMl: (silicone.sealedAir * built.plan.nx * built.plan.ny) / 1000 }, files, volumes, diagnostics: inForce, timings: { ...timings, total: now() - started } });
      const pours = built.copies.filter((c) => c.kind === 'pour').length;
      const { requested, minimum } = built.rim.edge;
      const readme = exportReadme({
        app: APP_NAME,
        version: APP_VERSION,
        model: meta.model,
        params: scaled,
        // The margin is the one asked for: a raise of it has a line of its own.
        resolved: {
          'base.pocketDepth': pocketDepth,
          'base.planeTol': inputs.planeTol,
          'silicone.printMargin': printMargin,
          'vents.persistence': ventPersistence,
          'grid.spacing': built.plan.spacing,
          'grid.edge': Math.max(requested ?? minimum, minimum),
        },
        files: Object.keys(files),
        pours,
        vents: built.copies.length - pours,
        tiles: built.offsets.length,
        pitch: built.offsets.length > 1 ? [built.plan.pitchXmm, built.plan.pitchYmm] : null,
        box: [report.box.x, report.box.y, report.box.z],
        clearance,
        silicone: { ml, grams: ml * scaled.silicone.density },
        diagnostics: inForce,
      });
      const text = new TextEncoder();
      files['README.txt'] = text.encode(readme);
      files['report.json'] = text.encode(`${JSON.stringify(report, null, 2)}\n`);
      files['project.json'] = text.encode(`${JSON.stringify(projectFile(meta.project, meta.model), null, 2)}\n`);
      return { want, files, zip: zip(files), clearance, rim: built.rim, diagnostics, report };
    });
  });
}

interface Measured {
  imported: ImportedSolid;
  model: Manifold | null;
  built: Built;
  clearance: Clearance | null;
  search: number | null;
  silicone: { ml: number; boresMl: number; sealedAirMl: number };
  files: Record<string, Uint8Array>;
  volumes: Record<string, number | null>;
  diagnostics: Diagnostic[];
  timings: Record<string, number>;
}

function buildReport(params: Params, inputs: ExportInputs, meta: ExportMeta, m: Measured): ExportReport {
  const { rim, space, copies } = m.built;
  const tiles = space.offsets.length;
  return {
    app: APP_NAME,
    appVersion: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    model: { file: meta.model, format: meta.triangles.format, trianglesInFile: meta.triangles.inFile, triangles: meta.triangles.kept, bodies: m.imported.report.bodies, volumeMm3: m.model ? m.model.volume() : null },
    params,
    plane: { choice: meta.project.plane, normal: meta.plane.normal, offset: meta.plane.offset, areaMm2: meta.plane.area, planeTol: meta.plane.planeTol },
    tiles: space.offsets,
    box: { x: rim.O.x1 - rim.O.x0, y: rim.O.y1 - rim.O.y0, z: rim.Zt + rim.Tb, Zt: rim.Zt, Tb: rim.Tb },
    openings: inputs.openings.map((opening, k) => {
      const own = copies.slice(k * tiles, (k + 1) * tiles);
      return { id: opening.id, kind: opening.kind, x: opening.x, y: opening.y, pinned: opening.pinned, zb: Math.min(...own.map((c) => c.zb)), boreLength: boreLength(space, opening), copies: own.length };
    }),
    silicone: { ml: m.silicone.ml, grams: m.silicone.ml * params.silicone.density, density: params.silicone.density, boresMl: m.silicone.boresMl, sealedAirMl: m.silicone.sealedAirMl },
    clearance: {
      asked: params.silicone.t,
      measured: m.clearance?.measured ?? null,
      minGap: m.clearance ? m.clearance.measured + m.clearance.error : null,
      decimationError: m.clearance?.error ?? null,
      marginRaisedBy: m.clearance?.raisedBy ?? 0,
      searchMm: m.search,
    },
    parts: Object.fromEntries(Object.entries(m.files).filter(([name]) => name.endsWith('.stl')).map(([name, bytes]) => [name, { triangles: triangles(bytes), volumeMm3: m.volumes[name] ?? null }])),
    diagnostics: m.diagnostics,
    timings: m.timings,
  };
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
