import { zipSync } from 'fflate';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { sha256 } from '../app/hash';
import { projectFile, projectJson, type Project, type StoredPlane } from '../app/project';
import { BUILD } from '../app/buildInfo';
import { APP_NAME } from '../app/version';
import { analyseIntervals, analysisCellProblem, type IntervalReport } from '../core/analysis/intervals';
import { boreSilicone, placementSettings, replicateOpenings, uncoveredOnComposite } from '../core/analysis/placement';
import { geometryReports, tapeAdvice, withoutDoubledVoids, type GeometryReports } from '../core/analysis/reports';
import { boreLength, checkOpening, openingSizes, placementSpace, type OpeningSpot, type PlacementSpace } from '../core/analysis/validate';
import type { BaseCandidate } from '../core/base/candidates';
import { buildFootprint } from '../core/base/footprint';
import { transformPositions, trimToBase, type OrientedModel, type RigidTransform } from '../core/base/orient';
import { buildField } from '../core/field/build';
import { fieldSettings, planField, type Field, type FieldPlan, type FieldSettings } from '../core/field/grid';
import { moldSilicone } from '../core/field/silicone';
import { auditEdges, type MeshAudit } from '../core/mesh/audit';
import { DEVIATION_CELL_MM, SurfaceIndex } from '../core/mesh/deviation';
import { importSolid, reversed, sharedVolume, signedVolumeAbout, type ImportedSolid, type SolidReport } from '../core/mesh/shells';
import { HEAVY_LIMITS, importFromCopy, manifoldPathSolid, simplifyForManifold, type HeavyLimits, type ManifoldPath, type MeshSimplifier } from '../core/mesh/simplify';
import { meshBounds, weld, type WeldedMesh } from '../core/mesh/weld';
import { resolveAuto } from '../core/params/defaults';
import { crossParameterErrors } from '../core/params/rules';
import { SCHEMA_VERSION, type Params } from '../core/params/schema';
import { moldTypeOf, type MoldTypeId } from '../core/mold/types';
import { MOLD_TYPE_UI } from '../ui/mold/moldTypeUi';
import { buildBaseBody, buildGlueBase, buildMergedBase, layerDiagnostics, orientedSolid, pocketOutline, triangleContour } from '../core/parts/base';
import { boltCavityDiagnostics, boltCavityWallAnywhere, type BoltClearance } from '../core/parts/bolts';
import { buildCoverBody, buildCoverFinal, toolDiagnostics } from '../core/parts/cover';
import { fitTestFiles } from '../core/parts/fitTest';
import { buildFunnel, funnelFile, funnelPose } from '../core/parts/funnel';
import type { CutOpening } from '../core/parts/openings';
import { basePose, coverPose, modelOrientedStl, poseToStl } from '../core/parts/poses';
import { boltWalls, deriveRim, moldBounds, type Rim } from '../core/parts/rim';
import { boltAdvice, type BoltAdvice } from '../core/report/clamp';
import type { Diagnostic } from '../core/report/diagnostics';
import { plasticDiagnostic, plasticEstimate, printabilityDiagnostics, type PartAmount, type PlasticEstimate } from '../core/report/printability';
import { exportReadme } from '../core/report/readme';
import { GALLERY_LICENCES, sourceName, type GalleryCredit } from '../gallery/catalogue';
import { withArena, type Arena } from '../core/solid/arena';
import { buildToolMesh, toolSolid } from '../core/solid/tool';
import { parseStl } from '../core/stl/parse';
import { writeBinaryStl } from '../core/stl/write';
import { repairedEntry, simplifiedEntry, type OriginalFacts, type OriginalImport, type OriginalSource, type RepairRecord, type SimplifiedRecord } from '../app/simplified';
import { orientedOutside, withOutside } from '../core/field/outsidePart';
import { clipBelow } from '../core/mesh/clip';
import { farPrisms } from '../core/mesh/outside';
import { OUTSIDE_MEASURE_LIMIT } from '../core/mesh/repair';
import { outsideFoot } from '../core/parts/base';
import { InlineError, type PlaneChoice } from './fieldStages';
import { originalBytes } from './prepareJob';

/** G4: minGap runs against the model decimated to at most this many triangles. */
export const MIN_GAP_TRIANGLES = 60_000;
export { OUTSIDE_MEASURE_LIMIT };
/** G4: the margin is raised by the shortfall plus this, once. */
export const RAISE_EXTRA = 0.05;
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
  /** The STL's own bytes, sent only while main does not know their hash, which project.json records. */
  stl: Uint8Array | null;
  /**
   * M11: the preview's import of a mesh past G1.8's limit, which checked it whole. The export then builds
   * only the simplified copy every Manifold step uses, as the whole solid would hold 1.3 GB of its heap.
   */
  importReport?: SolidReport | null;
  /**
   * MM2: a simplified model's proved error, in mm, which widens G4's margin as the preview's does. Only for a
   * simplified model: the welded mesh above is then its copy.
   */
  modelErrorMm?: number;
  /**
   * MM2: the maker's own file a simplified model was made from, for a glue-mode Export ZIP, whose
   * model_oriented.stl it is: read here, checked against its hash, and turned as the copy is.
   */
  original?: { source: OriginalSource; sha256: string; facts: OriginalFacts; wholeSolid?: boolean; repaired?: OriginalImport } | null;
  /**
   * RM, glue mode only: how far a repaired model's file lies outside its copy (e_near), which widens G4's margin
   * and is taken off the gap measured on the copy, and the file's parts the copy left out (O_far), in the file's
   * coordinates, which the field holds and whose own gap is measured apart (D26).
   */
  repairNearMm?: number;
  outside?: WeldedMesh | null;
}

/** What main knows and the export does not, for the README, report.json and project.json. */
export interface ExportMeta {
  /** The STL's file name. */
  model: string;
  /** SHA-256 of the STL, when main knows it already. */
  modelSha256: string | null;
  /** The plane the model stands on, in the STL's coordinates, which project.json keeps beside the choice. */
  basePlane: StoredPlane | null;
  /** As parsed: the file's own count, and what is left once collapsed triangles are dropped. */
  triangles: { format: 'binary' | 'ascii'; inFile: number; kept: number };
  project: Project;
  plane: { normal: [number, number, number]; offset: number; area: number; planeTol: number };
  /** The diagnostics in force on main, which the README and report list with the export's own. */
  notes: Diagnostic[];
  /** MM2: a simplified model's file and copy, which report.json, README.txt and project.json name. Only when simplified. */
  simplified?: { from: OriginalFacts; record: SimplifiedRecord };
  /** RM: a repaired model's file and copy, which report.json, README.txt and project.json name. Only when repaired. */
  repaired?: { from: OriginalFacts; record: RepairRecord };
  /** GA: a gallery model not ours, whose credit README.txt and project.json carry (R48). Only for such a model. */
  gallery?: GalleryCredit;
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
  /**
   * The decimation's error, in mm, proved over every point of the surface the gap is for (GC): how far that surface
   * lies from what minGap measured. When the model's own solid was measured, 0; past G1.8's limit in glue mode, how
   * far the whole mesh lies from the copy measured.
   */
  error: number;
  /** By how much the margin was raised for a second build, or 0. */
  raisedBy: number;
  /**
   * MM2, glue mode: how far the simplified copy the mold was made from lies from the maker's file, measured, also
   * taken off, so `measured` holds for the file. Only for a simplified model.
   */
  simplify?: number;
  /** GC: past G1.8's limit in merged mode, the gap is the copy's the base carries, not the whole mesh's. */
  copy?: true;
  /** RM, glue mode: how far a repaired model's file lies outside its copy, also taken off the copy's gap. */
  near?: number;
  /** RM, glue mode: the copy's own least gap to the cover, as minGap gave it, before anything was taken off. */
  gap?: number;
  /**
   * RM, glue mode: the file's parts a rebuilt copy left out, their own least gap to the cover (`gap`, measured on
   * prisms round them), which `measured` is at most, and their triangles. Past OUTSIDE_MEASURE_LIMIT `gap` is null:
   * `measured` then holds for the rest of the file only, and the file's clearance is unverified (report.json's null).
   */
  outside?: { gap: number | null; triangles: number };
}

/** report.json: every number of the export, for the maker to check and for M9 and support to read. */
export interface ExportReport {
  app: string;
  appVersion: string;
  schemaVersion: number;
  /** MT: the mold type, by its id, as project.json's params.mold.type has it. */
  moldType: string;
  model: { file: string; format: 'binary' | 'ascii'; trianglesInFile: number; triangles: number; bodies: number; volumeMm3: number | null; simplified?: SimplifiedRecord; repaired?: ReportedRepair };
  params: Params;
  plane: { choice: PlaneChoice; normal: [number, number, number]; offset: number; areaMm2: number; planeTol: number };
  /** Each copy's shift from the first, in mm. */
  tiles: [number, number][];
  box: { x: number; y: number; z: number; Zt: number; Tb: number };
  /** Per opening of the first tile: zb is the lowest ceiling under any copy's disc, the bore the longest copy's. */
  openings: { id: string; kind: 'pour' | 'vent'; x: number; y: number; pinned: boolean; zb: number; boreLength: number; copies: number }[];
  silicone: { ml: number; grams: number; density: number; boresMl: number; sealedAirMl: number };
  /** S9 as the export works it out on its own field: the demold estimate, the air, the lift and the tape. Null if it failed. */
  reports: Omit<GeometryReports, 'diagnostics'> | null;
  /** Why S8 or S9 failed, which never stops an export. */
  reportsError: string | null;
  /** In g, for every part the mold needs, a funnel per pour. */
  plastic: PlasticEstimate;
  /** M10: the bolts as cut, the walls they leave and the advice on them, or null with the bolts off. */
  bolts: ExportBolts | null;
  clearance: { asked: number; measured: number | null; minGap: number | null; decimationError: number | null; simplifyErrorMm?: number; repairNearMm?: number; outsideGap?: number | null; outsideTriangles?: number; marginRaisedBy: number; searchMm: number | null };
  parts: Record<string, { triangles: number; volumeMm3: number | null }>;
  diagnostics: Diagnostic[];
  /** In ms, per step of this export, and the total until the ZIP is packed, which is the one step left out. */
  timings: Record<string, number>;
}

/** RM: report.json's record of a repaired copy: project.json's, but the runs of the file's triangles it left out. */
export type ReportedRepair = Omit<RepairRecord, 'outside'> & { outside: Omit<NonNullable<RepairRecord['outside']>, 'runs'> | null };

/** report.json's bolts, in mm, mold coordinates. */
export interface ExportBolts {
  size: string;
  length: number;
  autoLength: number;
  screw: string;
  nut: string;
  holeDiameter: number;
  countersink: { diameter: number; depth: number };
  slot: { width: number; floor: number; top: number; membrane: number };
  holeTop: number;
  axes: { x: number; y: number; slotOpensAt: string }[];
  /** The least wall each kind of neighbour gets, the cavity's from the export field; null where there is none, as with the pry notches off. */
  walls: { groove: number; outside: number; plate: number; notches: number | null; cavity: number | null };
  advice: BoltAdvice;
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
  /** SHA-256 of the STL as project.json has it, which main keeps for the model; null without a model. */
  modelSha256: string | null;
}

export type ProgressReport = (step: string, done: number, total: number) => void;

/**
 * The steps each request goes through, in order, which the stage bar counts. MM2: a simplified model's glue-mode
 * ZIP reads the maker's file for model_oriented.stl, `original`: before the build where the plane trims it, as
 * that needs its whole solid, whose heap the build then reuses; otherwise after the clearance, so its STL is
 * never held through the build.
 */
export function exportSteps(request: ExportRequest, original: 'before' | 'after' | null = null): string[] {
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
      return ['import', ...(original === 'before' ? ['original'] : []), 'field', 'tool', 'cover', 'base', 'clearance', ...(original === 'after' ? ['original'] : []), 'files', ...(request.fitTest ? ['fit-test'] : []), 'zip'];
  }
}

/**
 * Where an export reads the maker's file, if it does: see exportSteps. RM: a repaired open file is cut, if at all,
 * with no solid (clipBelow), so after the build, whatever the copy's plane does; a repaired closed file that folds
 * may reach below a plane its copy only stands on, which only reading it tells, and then takes its whole solid's
 * trim, so before.
 */
export function originalStep(job: Pick<ExportJob, 'want' | 'inputs'>): 'before' | 'after' | null {
  if (job.want !== 'zip' || !job.inputs?.original) return null;
  const repaired = job.inputs.original.repaired;
  if (repaired) return repaired.route === 'soup' ? 'after' : 'before';
  return job.inputs.needsTrim || job.inputs.original.wholeSolid ? 'before' : 'after';
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
 * left out. The base needs the cover still, as a raise of the margin moves the rim of both. `holding` is
 * given the largest things it builds as it goes, for the memory meter, which counts them at each step's
 * progress (MM1): the oriented mesh from the import on, the export field once the field step ends, the build
 * from the clearance on, and the files. A raise's build takes the first one's place there once it is done,
 * so `holding` keeps nothing alive that the export itself has let go, and it changes nothing the export makes.
 */
export function runExport(api: ManifoldToplevel, simplifier: MeshSimplifier, job: ExportJob, progress: ProgressReport, now: () => number, timings: Record<string, number> = {}, limits: HeavyLimits = HEAVY_LIMITS, holding: unknown[] = [], readBlob: (blob: Blob) => Uint8Array = noReader): ExportOutputs {
  const reads = originalStep(job);
  const steps = exportSteps(job, reads);
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
    return { want, files, zip: new Uint8Array(), clearance: null, rim: null, diagnostics: [], report: null, modelSha256: null };
  }
  if (want === 'fit-test') {
    const files = timed('fit-test', () => fitTestFiles(api, params));
    return { want, files, zip: timed('zip', () => zip(files)), clearance: null, rim: null, diagnostics: [], report: null, modelSha256: null };
  }

  const { meta } = job;
  if (!inputs || !meta) throw new Error(`An export of the ${want} needs the model.`);
  const scaled: Params = cellScale === 1 ? params : { ...params, quality: { ...params.quality, cellFinal: params.quality.cellFinal * cellScale } };
  return withArena(api, (arena) => {
    // A trimmed model_oriented.stl needs the whole solid, so only an untrimmed one may come from the copy alone.
    const known = inputs.importReport && !inputs.needsTrim ? inputs.importReport : null;
    const fromCopy = known ? timed('import', () => importFromCopy(arena, inputs.welded, known, simplifier, limits.limit, limits.target)) : null;
    // The import ladder makes many pieces on the way, such as decompose's, which share the solid's memory:
    // only the solid is kept, so freeing it below frees it all.
    const imported =
      fromCopy ??
      timed('import', () => {
        const found = withArena(api, (scratch) => {
          const whole = importSolid(scratch, inputs.welded, inputs.audit);
          if (whole.solid) scratch.release(whole.solid);
          return whole;
        });
        if (found.solid) arena.track(found.solid);
        return found;
      });
    const mesh: WeldedMesh = { positions: transformPositions(imported.mesh.positions, inputs.transform), indices: imported.mesh.indices };
    holding.push(mesh);
    const bounds = meshBounds(mesh.positions);
    // RM: in glue mode the field and the box of a rebuilt model hold the parts of the file its copy left out, as the
    // maker prints the file (D26); as the preview's S3 and S10 do, so the box is the one shown.
    const far = inputs.outside ? orientedOutside(inputs.outside, inputs.transform) : null;
    const fieldMesh = far ? withOutside(mesh, far) : mesh;
    const fieldBounds = far ? meshBounds(fieldMesh.positions) : bounds;
    if (far) holding.push(far, fieldMesh);
    // Past G1.8's limit, what only the whole solid can tell is read before the copy is made, so the whole
    // solid is freed before the build: the model's volume, and a trimmed model_oriented.stl, which otherwise
    // comes from the mesh. A trim makes two more solids the whole mesh's size, in an arena that ends here.
    // A solid's own volume counts twice what its parts share, and a trim keeps them apart too: the model's
    // volume is their union, the parts less their overlap, as a slicer prints them. A trim takes away what
    // they share below the plane, so a trimmed model's overlap is measured on it again (`shared`); that is
    // also what the silicone takes off. The import measured the whole model's, and only parts that overlap
    // there can overlap once trimmed.
    const overlap = imported.report.overlapVolume;
    let shared = overlap;
    let wholeVolume: number | null = null;
    let trimmedStl: Uint8Array | null = null;
    if (fromCopy) {
      // The copy came only where no inside-out shell was flipped, so the whole solid is the bodies less their voids.
      wholeVolume = known!.solidVolume - known!.voidVolume - overlap;
    } else if (imported.solid && imported.mesh.indices.length / 3 > limits.limit) {
      if (inputs.needsTrim) {
        const read = withArena(api, (scratch) => {
          const trimmed = orientedSolid(scratch, imported, { transform: inputs.transform, needsTrim: true })!;
          return { volume: trimmed.volume(), shared: overlap > 0 ? sharedVolume(scratch, trimmed) : 0, stl: want === 'zip' && params.base.mode === 'glue' ? modelOrientedStl({ mesh, needsTrim: true } as OrientedModel, trimmed) : null };
        });
        shared = read.shared;
        wholeVolume = read.volume - shared;
        trimmedStl = read.stl;
      } else {
        wholeVolume = imported.solid.volume() - overlap;
      }
    }
    // MM2: the maker's own file for model_oriented.stl, where the plane trims it, before the build: see exportSteps.
    const original = reads === 'before' ? timed('original', () => readOriginal(api, inputs, imported.report, overlap, readBlob, holding)) : null;
    // G1.8: past the limit every Manifold step after the import uses a simplified copy.
    const path: ManifoldPath = fromCopy ? { solid: fromCopy.solid, heavy: true, diagnostics: fromCopy.simplified, copy: fromCopy.copy } : timed('import', () => manifoldPathSolid(arena, imported, simplifier, limits.limit, limits.target));
    // The copy stands in for the whole solid from here on. One that is no closed solid leaves the whole one in use.
    if (path.heavy && !fromCopy) arena.release(imported.solid!).delete();
    // GC: the copy's mesh as the model stands, for the clearance, which proves how far it lies (see decimate).
    const copyMesh: WeldedMesh | null = path.heavy && path.copy ? { positions: transformPositions(path.copy.positions, inputs.transform), indices: path.copy.indices } : null;
    if (copyMesh) holding.push(copyMesh);
    const model = orientedSolid(arena, { solid: path.solid }, { transform: inputs.transform, needsTrim: inputs.needsTrim });
    // The whole solid trimmed: past the limit that was read above, from the whole one, not from the copy.
    if (inputs.needsTrim && model && !path.heavy) shared = overlap > 0 ? timed('import', () => sharedVolume(arena, model)) : 0;
    const cap = inputs.needsTrim && model ? arena.track(model.slice(0.02)) : undefined;
    const footprint = buildFootprint(arena, mesh, inputs.candidate, scaled.base.minIsland, cap);
    const { pocketDepth, printMargin, ventPersistence, boltLength, baseLayer } = resolveAuto(scaled, bounds);
    const diagnostics: Diagnostic[] = [...crossParameterErrors(scaled), ...imported.report.diagnostics, ...path.diagnostics, ...footprint.diagnostics];
    // The coarser cell widens the margin of G4, and with it the cavity and the box, past what the preview showed.
    if (cellScale !== 1) diagnostics.push({ code: 'export-coarser', severity: 'warning', message: `The geometry engine failed at full detail, so the export was built again at half the detail, on a ${scaled.quality.cellFinal} mm grid instead of ${params.quality.cellFinal} mm, with a wider safety margin and a larger box than the preview shows.` });

    // The build the export stands on, in one place: the field as soon as it is built, then the whole build.
    const slot = holding.push(null) - 1;
    const build = (margin: number): Built => {
      const raised: Params = { ...scaled, silicone: { ...scaled.silicone, printMargin: margin } };
      const own: Diagnostic[] = [];
      const shaped = timed('field', () => {
        const settings = fieldSettings(raised, fieldBounds);
        const plan = planField(fieldBounds, settings);
        // The export plan's bounds and offsets, which the preview used as well, so the box is the one shown.
        const mold = moldBounds(fieldMesh, fieldBounds, settings);
        const built = buildField(fieldMesh, plan, settings, undefined, mold.D);
        const rim = deriveRim(mold, raised);
        const space = placementSpace(built.field, rim, mold.offsets, openingSizes(raised));
        own.push(...built.diagnostics, ...rim.diagnostics, ...boltCavityDiagnostics(rim.bolts, built.field, raised.quality.tinTolFinal, rim.D));
        for (const spot of inputs.openings) {
          const check = checkOpening(space, spot, inputs.openings);
          if (!check.valid) own.push({ code: 'export-opening-invalid', severity: 'error', message: `The ${spot.kind} at (${spot.x.toFixed(1)}, ${spot.y.toFixed(1)}) is not valid on the export field (${check.problems.join(', ')}), so please move it.` });
        }
        return { field: built.field, plan, settings, rim, space, offsets: mold.offsets, copies: replicateOpenings(inputs.openings, space) };
      });
      // In a raise the first build stands until this one is done, so both count until then.
      holding[slot] = raising ? [holding[slot], shaped] : shaped;
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
        const modelSection = model ? arena.track(model.slice(pocketDepth)) : triangleContour(arena, mesh, pocketDepth);
        // RM: the file is what is glued in, so the pocket takes its left-out parts' foot, and its margin past the copy.
        const foot = far ? outsideFoot(arena, far, pocketDepth) : null;
        const section = foot ? arena.track(modelSection.add(foot)) : modelSection;
        const glue = buildGlueBase(arena, body, pocketOutline(arena, footprint, section, raised.base.pocketEnlarge + (inputs.repairNearMm ?? 0)), pocketDepth, offsets);
        own.push(...glue.diagnostics);
        return glue.base;
      });
      return { ...shaped, cover, base, diagnostics: own };
    };

    // MM2: a simplified model's copy lies up to its proved error from the maker's file, so the cavity planned on
    // it is widened by that much, as the preview's is: it then holds the file too. 0 adds nothing. RM: a rebuilt
    // model's file lies up to e_near outside its copy where it is not one of the left-out parts, so the same.
    const extra = (inputs.modelErrorMm ?? 0) + (inputs.repairNearMm ?? 0);
    let built = build(printMargin + extra);
    holding[slot] = built;
    let clearance: Clearance | null = null;
    const search = Math.max(8, scaled.silicone.t + SEARCH_PAST_T);
    // MM2: a simplified model's gap is measured through its copy, with both errors measured, not meshoptimizer's
    // figure: in glue mode the maker's file lies within `extra` of the copy, which lies within the decimation's
    // error of what minGap measures. In merged mode the base carries the copy, so the copy is the model in the mold.
    // GC: every model's decimation error is proved so, also for a model loaded as it is.
    const simplified = inputs.modelErrorMm !== undefined;
    const throughCopy = simplified && scaled.base.mode === 'glue' ? inputs.modelErrorMm! : null;
    const merged = scaled.base.mode === 'merged';
    // RM, glue mode (D26): the file lies within e_near of a rebuilt copy where it is not one of the parts the copy
    // left out, so that is taken off the copy's gap too; and those parts, each triangle in a prism 0.01 mm either side
    // of it, have their own gap measured, past OUTSIDE_MEASURE_LIMIT triangles not. Every point of the file is then at
    // least the smaller of the two from the cover: within e_near of a point of the copy, inside the copy, or in a prism.
    const near = inputs.repairNearMm;
    const farTriangles = far ? far.indices.length / 3 : 0;
    // The file's own count of them decides, as the Diagnostics row's does: cutting them at the plane may add a few.
    const leftOut = inputs.outside ? inputs.outside.indices.length / 3 : 0;
    const prisms = far && leftOut <= OUTSIDE_MEASURE_LIMIT
      ? timed('clearance', () => {
          const prism = farPrisms(far);
          return arena.manifold(new arena.api.Mesh({ numProp: 3, vertProperties: prism.positions, triVerts: prism.indices }));
        })
      : null;
    if (far && !prisms) diagnostics.push({ code: 'outside-unmeasured', severity: 'warning', message: `The repair left out ${leftOut.toLocaleString('en-US')} triangles of your file, too many to measure on their own: the mold leaves room for them, at least ${scaled.silicone.t} mm as planned, but the silicone thickness round them is not checked.` });
    let copyGap = 0;
    let farGap: number | null = null;
    // Decimating a heavy model is part of measuring it, so it shows as that step.
    const probe = model ? timed('clearance', () => decimate(arena, simplifier, mesh, { solid: model, copy: copyMesh }, inputs.needsTrim, merged)) : null;
    if (probe) {
      const gapOf = (b: Built): number => timed('clearance', () => {
        const copies = b.offsets.map(([x, y]) => arena.track(probe.solid.translate([x, y, 0])));
        copyGap = arena.track(arena.api.Manifold.compose(copies)).minGap(b.cover, search);
        const gap = copyGap - probe.error;
        const own = throughCopy === null ? gap : gap - throughCopy;
        if (near === undefined) return own;
        farGap = prisms ? arena.track(arena.api.Manifold.compose(b.offsets.map(([x, y]) => arena.track(prisms.translate([x, y, 0]))))).minGap(b.cover, search) : null;
        return Math.min(own - near, farGap ?? Infinity);
      });
      let measured = gapOf(built);
      let raisedBy = 0;
      if (measured < scaled.silicone.t) {
        raisedBy = scaled.silicone.t - measured + RAISE_EXTRA;
        raising = true;
        built = build(printMargin + extra + raisedBy);
        holding[slot] = built;
        raising = false;
        measured = gapOf(built);
        diagnostics.push({ code: 'margin-raised', severity: 'warning', message: `The silicone measured thinner than ${scaled.silicone.t} mm in places, so the safety margin was raised by ${raisedBy.toFixed(2)} mm and the mold built again, a little larger than the preview shows.` });
      }
      clearance = { measured, error: probe.error, raisedBy, ...(throughCopy === null ? {} : { simplify: throughCopy }), ...(merged && copyMesh ? { copy: true as const } : {}), ...(near === undefined ? {} : { near, gap: copyGap, ...(far ? { outside: { gap: farGap, triangles: farTriangles } } : {}) }) };
      if (measured < scaled.silicone.t) diagnostics.push({ code: 'clearance-short', severity: 'error', message: `Even after a wider safety margin, the silicone is only ${measured.toFixed(2)} mm thick at its thinnest, under the ${scaled.silicone.t} mm asked for. Raise Print margin under Advanced, Silicone, and export again.` });
    } else {
      diagnostics.push({ code: 'clearance-unverified', severity: 'warning', message: `The model's mesh has holes, so the silicone thickness could not be measured: the mold is planned to leave at least ${scaled.silicone.t} mm, but that is not checked.` });
    }
    diagnostics.push(...built.diagnostics);
    // MM2: the maker's file, where the plane does not trim it, now the build is done: see exportSteps.
    const originalModel = original ?? (reads === 'after' ? timed('original', () => readOriginal(api, inputs, imported.report, overlap, readBlob, holding)) : null);

    const funnel = want === 'zip' && scaled.funnel.generate && !crossParameterErrors(scaled).some((d) => d.code.startsWith('funnel-')) ? buildFunnel(arena, scaled) : null;
    const files = timed('files', () => {
      const out: Record<string, Uint8Array> = {};
      if (want !== 'base') out['cover.stl'] = poseToStl(api, built.cover, coverPose(built.rim));
      if (built.base && want !== 'cover') out['base.stl'] = poseToStl(api, built.base, basePose(built.rim));
      if (funnel) out['funnel.stl'] = poseToStl(api, funnel, funnelPose(scaled));
      if (want === 'zip' && scaled.base.mode === 'glue') out['model_oriented.stl'] = originalModel?.stl ?? trimmedStl ?? modelOrientedStl({ mesh, needsTrim: inputs.needsTrim } as OrientedModel, model);
      return out;
    });
    holding.push(files, trimmedStl);
    if (want !== 'zip') return { want, files, zip: new Uint8Array(), clearance, rim: built.rim, diagnostics, report: null, modelSha256: meta.modelSha256 };

    if (job.fitTest) Object.assign(files, timed('fit-test', () => fitTestFiles(api, params)));
    return timed('zip', () => {
      // S8 and S9 on the export's own field, as the preview's reports may still be on their way. They say
      // nothing the mold needs, so a failure is a note in the README and never stops the export.
      const r0 = now();
      let s8: IntervalReport | null = null;
      let reports: GeometryReports | null = null;
      let reportsError: string | null = analysisCellProblem(scaled.quality.analysisCell);
      if (reportsError === null) {
        try {
          s8 = analyseIntervals(mesh, scaled.quality.analysisCell);
          // No shell from a mesh with triangles is no reading of the model, and no verdict comes from it.
          if (s8.shells.length === 0 && mesh.indices.length > 0) throw new Error('the analysis found no solid in the model');
          const ceiling = uncoveredOnComposite(inputs.openings, built.space, placementSettings(scaled, bounds));
          reports = geometryReports(scaled, { s8, field: built.field, raise: scaled.quality.tinTolFinal, rim: built.rim, tiles: built.offsets.length, ceiling });
        } catch (error) {
          s8 = null;
          reportsError = error instanceof Error ? error.message : String(error);
        }
      }
      if (reportsError !== null) diagnostics.push({ code: 'reports-failed', severity: 'warning', message: `The demold and air reports could not be worked out for this export, so README.txt has no demold estimate and the silicone figure keeps any sealed air: ${reportsError}` });
      // Without S8 no sealed air is known, so none is taken off.
      const silicone = moldSilicone(mesh, built.plan, built.field, { overlapVolume: shared }, built.settings, s8 ?? { sealed: [] });
      const boresMl = boreSilicone(built.copies, built.field, built.rim.Zt) / 1000;
      const ml = silicone.ml + boresMl;
      const tape = reports ? { lift: reports.lift, clamp: reports.clamp } : tapeAdvice(scaled, built.field, scaled.quality.tinTolFinal, built.rim);
      const layout = built.rim.bolts;
      const bolts = layout ? { layout, advice: boltAdvice(tape.lift.forceN, scaled.print.tapeStrip, layout) } : null;
      // Part of the zip step, as the README needs them, and recorded apart for the plan's timing note.
      timings.reports = now() - r0;
      const pours = built.copies.filter((c) => c.kind === 'pour').length;
      const amount = (solid: Manifold, count: number): PartAmount => ({ volume: solid.volume(), area: solid.surfaceArea(), count });
      const parts = [amount(built.cover, 1), amount(built.base!, 1), ...(funnel && pours > 0 ? [amount(funnel, pours)] : [])];
      const plastic = plasticEstimate(parts, scaled);
      const printable = printabilityDiagnostics(scaled, built.rim, { offsets: built.offsets, modelTop: bounds.max[2] });
      const inForce = unique(withoutDoubledVoids([...diagnostics, ...(reports?.diagnostics ?? []), ...printable, plasticDiagnostic(plastic, scaled), ...meta.notes], reports));
      const volumes: Record<string, number | null> = {
        'cover.stl': built.cover.volume(),
        'base.stl': built.base!.volume(),
        'funnel.stl': funnel ? funnel.volume() : null,
        'model_oriented.stl': originalModel ? originalModel.volume : wholeVolume ?? (model ? model.volume() - shared : null),
      };
      const found = reports ? (({ diagnostics: _shown, ...rest }) => rest)(reports) : null;
      const report = buildReport(params, inputs, meta, { imported, modelVolume: wholeVolume ?? (model ? model.volume() - shared : null), built, clearance, search: probe ? search : null, silicone: { ml, boresMl, sealedAirMl: (silicone.sealedAir * built.plan.nx * built.plan.ny) / 1000 }, reports: found, reportsError, plastic, bolts: bolts ? exportBolts(built, bolts.advice, scaled.quality.tinTolFinal) : null, files, volumes, diagnostics: inForce, timings: { ...timings, total: now() - started } });
      const { requested, minimum } = built.rim.edge;
      const readme = exportReadme({
        app: APP_NAME,
        version: BUILD.version,
        model: meta.model,
        moldType: MOLD_TYPE_UI[moldTypeOf(scaled).id as MoldTypeId].name,
        params: scaled,
        // The margin is the one asked for: a raise of it has a line of its own.
        resolved: {
          'base.pocketDepth': pocketDepth,
          'base.planeTol': inputs.planeTol,
          'silicone.printMargin': printMargin,
          'silicone.baseLayer': baseLayer,
          'vents.persistence': ventPersistence,
          'grid.spacing': built.plan.spacing,
          'grid.edge': Math.max(requested ?? minimum, minimum),
          'bolts.length': boltLength,
        },
        files: Object.keys(files),
        pours,
        vents: built.copies.length - pours,
        tiles: built.offsets.length,
        pitch: built.offsets.length > 1 ? [built.plan.pitchXmm, built.plan.pitchYmm] : null,
        box: [report.box.x, report.box.y, report.box.z],
        clearance,
        silicone: { ml, grams: ml * scaled.silicone.density },
        reports,
        reportsError,
        tape,
        bolts,
        plastic,
        diagnostics: inForce,
        parts: { count: imported.report.shells.filter((shell) => shell.kind !== 'void').length, bodies: imported.report.bodies },
        ...(meta.simplified ? { simplified: { ...meta.simplified, merged: scaled.base.mode === 'merged', ...(originalModel && inputs.needsTrim ? { trimmedTo: originalModel.triangles } : {}) } } : {}),
        ...(meta.repaired ? { repaired: { from: { name: meta.repaired.from.name, triangles: meta.repaired.from.triangles }, record: meta.repaired.record, merged: scaled.base.mode === 'merged', ...(originalModel?.trimmed ? { trimmedTo: originalModel.triangles } : {}) } } : {}),
        ...(meta.gallery ? { credit: readmeCredit(meta.gallery) } : {}),
      });
      const text = new TextEncoder();
      files['README.txt'] = text.encode(readme);
      files['report.json'] = text.encode(`${JSON.stringify(report, null, 2)}\n`);
      const modelSha256 = meta.modelSha256 ?? (inputs.stl ? sha256(inputs.stl) : null);
      files['project.json'] = text.encode(projectJson(projectFile(meta.project, meta.model, { modelSha256, basePlane: meta.basePlane, ...(meta.simplified ? { simplified: simplifiedEntry(meta.simplified) } : {}), ...(meta.repaired ? { repaired: repairedEntry(meta.repaired.from, meta.repaired.record) } : {}), gallery: meta.gallery ?? null })));
      return { want, files, zip: zip(files), clearance, rim: built.rim, diagnostics, report, modelSha256 };
    });
  });
}

interface Measured {
  imported: ImportedSolid;
  /** The oriented model's volume, the whole one's past the simplification limit; null for an open mesh. */
  modelVolume: number | null;
  built: Built;
  clearance: Clearance | null;
  search: number | null;
  silicone: { ml: number; boresMl: number; sealedAirMl: number };
  reports: Omit<GeometryReports, 'diagnostics'> | null;
  reportsError: string | null;
  plastic: PlasticEstimate;
  bolts: ExportBolts | null;
  files: Record<string, Uint8Array>;
  volumes: Record<string, number | null>;
  diagnostics: Diagnostic[];
  timings: Record<string, number>;
}

/** GA: a gallery model's credit as README.txt says it, its licence by its full name and deed. */
function readmeCredit(credit: GalleryCredit): NonNullable<Parameters<typeof exportReadme>[0]['credit']> {
  const licence = GALLERY_LICENCES[credit.licence];
  return { title: credit.title, author: credit.author, authorUrl: credit.authorUrl, url: credit.url, source: sourceName(credit.url), licence: licence.name, deed: licence.deed };
}

function buildReport(params: Params, inputs: ExportInputs, meta: ExportMeta, m: Measured): ExportReport {
  const { rim, space, copies } = m.built;
  const tiles = space.offsets.length;
  return {
    app: APP_NAME,
    appVersion: BUILD.version,
    schemaVersion: SCHEMA_VERSION,
    moldType: params.mold.type,
    model: { file: meta.model, format: meta.triangles.format, trianglesInFile: meta.triangles.inFile, triangles: meta.triangles.kept, bodies: m.imported.report.bodies, volumeMm3: m.modelVolume, ...(meta.simplified ? { simplified: meta.simplified.record } : {}), ...(meta.repaired ? { repaired: reportedRepair(meta.repaired.record) } : {}) },
    params,
    plane: { choice: meta.project.plane, normal: meta.plane.normal, offset: meta.plane.offset, areaMm2: meta.plane.area, planeTol: meta.plane.planeTol },
    tiles: space.offsets,
    box: { x: rim.O.x1 - rim.O.x0, y: rim.O.y1 - rim.O.y0, z: rim.Zt + rim.Tb, Zt: rim.Zt, Tb: rim.Tb },
    openings: inputs.openings.map((opening, k) => {
      const own = copies.slice(k * tiles, (k + 1) * tiles);
      return { id: opening.id, kind: opening.kind, x: opening.x, y: opening.y, pinned: opening.pinned, zb: Math.min(...own.map((c) => c.zb)), boreLength: boreLength(space, opening), copies: own.length };
    }),
    silicone: { ml: m.silicone.ml, grams: m.silicone.ml * params.silicone.density, density: params.silicone.density, boresMl: m.silicone.boresMl, sealedAirMl: m.silicone.sealedAirMl },
    reports: m.reports,
    reportsError: m.reportsError,
    plastic: m.plastic,
    bolts: m.bolts,
    clearance: {
      asked: params.silicone.t,
      // RM: past OUTSIDE_MEASURE_LIMIT the parts of the file a rebuild left out are not measured, so the file's is not either.
      measured: m.clearance && !(m.clearance.outside && m.clearance.outside.gap === null) ? m.clearance.measured : null,
      // MM2: a gap measured through a simplified copy gave up the copy's error too. RM: a repaired model's is the copy's own.
      minGap: m.clearance ? (m.clearance.gap !== undefined ? m.clearance.gap : m.clearance.simplify === undefined ? m.clearance.measured + m.clearance.error : m.clearance.measured + m.clearance.error + m.clearance.simplify) : null,
      decimationError: m.clearance?.error ?? null,
      ...(m.clearance?.simplify === undefined ? {} : { simplifyErrorMm: m.clearance.simplify }),
      ...(m.clearance?.near === undefined ? {} : { repairNearMm: m.clearance.near }),
      ...(m.clearance?.outside ? { outsideGap: m.clearance.outside.gap, outsideTriangles: m.clearance.outside.triangles } : {}),
      marginRaisedBy: m.clearance?.raisedBy ?? 0,
      searchMm: m.search,
    },
    parts: Object.fromEntries(Object.entries(m.files).filter(([name]) => name.endsWith('.stl')).map(([name, bytes]) => [name, { triangles: triangles(bytes), volumeMm3: m.volumes[name] ?? null }])),
    diagnostics: m.diagnostics,
    timings: m.timings,
  };
}

/** RM: report.json's record of a repaired copy: project.json's, but the runs of the file's triangles it left out. */
function reportedRepair(record: RepairRecord): ReportedRepair {
  if (!record.outside) return { ...record, outside: null };
  const { runs: _runs, ...far } = record.outside;
  // Spread first, so `outside` keeps its place among the record's keys.
  return { ...record, outside: far };
}

/** A wall to nothing, as with no notches, is no number: JSON would write its Infinity as null anyway. */
const wallOrNull = (wall: BoltClearance): number | null => (wall.by === null ? null : wall.wall);

/** report.json's bolts: as cut, with the walls they leave, the cavity's read off the export field. */
function exportBolts(built: Built, advice: BoltAdvice, raise: number): ExportBolts {
  const bolts = built.rim.bolts!;
  const walls = boltWalls(built.rim)!;
  return {
    size: bolts.size,
    length: bolts.length,
    autoLength: bolts.autoLength,
    screw: bolts.fastener.screw,
    nut: 'ISO 4032',
    holeDiameter: 2 * bolts.holeRadius,
    countersink: { diameter: 2 * bolts.sinkRadius, depth: bolts.sinkDepth },
    slot: { width: bolts.slotWidth, floor: bolts.slotFloor, top: bolts.slotTop, membrane: bolts.layer },
    holeTop: bolts.holeTop,
    axes: bolts.spots.map((s) => ({ x: s.x, y: s.y, slotOpensAt: s.exit })),
    walls: { groove: walls.groove.wall, outside: walls.outside.wall, plate: walls.plate.wall, notches: wallOrNull(walls.notches), cavity: wallOrNull(boltCavityWallAnywhere(bolts, built.field, raise, built.rim.D)) },
    advice,
  };
}

/**
 * G4: the model for minGap, decimated to MIN_GAP_TRIANGLES when it has more, and how far the surface the gap is for
 * lies from it at most, proved over every point of that surface (measuredError), as meshoptimizer's own figure is
 * no bound: on the examples the surface moved 1.7 to 6.7 times what it reported (GC; MM2 proved it so for a
 * simplified model alone). That surface is the mesh (the model, or a simplified model's copy, MM2), except past
 * G1.8's limit in merged mode, where the base carries `model.copy`, the copy every Manifold step uses, so the
 * silicone's gap is that copy's. The model's own solid is measured where the mesh is light enough or the decimated
 * copy is no solid: its error is 0, as it is the model, or the base's copy itself in merged mode; past G1.8's limit
 * in glue mode it is the copy, and how far the whole mesh lies from it is proved the same way.
 */
function decimate(arena: Arena, simplifier: MeshSimplifier, mesh: WeldedMesh, model: { solid: Manifold; copy: WeldedMesh | null }, needsTrim: boolean, merged: boolean): { solid: Manifold; error: number } {
  const own = (): { solid: Manifold; error: number } => ({ solid: model.solid, error: model.copy && !merged ? measuredError(mesh, model.copy) : 0 });
  const simplified = simplifyForManifold(mesh, simplifier, MIN_GAP_TRIANGLES);
  if (!simplified) return own();
  try {
    const solid = arena.manifold(new arena.api.Mesh({ numProp: 3, vertProperties: simplified.mesh.positions, triVerts: simplified.mesh.indices }));
    return { solid: needsTrim ? trimToBase(arena, solid) : solid, error: measuredError(merged && model.copy ? model.copy : mesh, simplified.mesh) };
  } catch (error) {
    // A simplified copy can fold onto itself. Measuring the model's own solid is slower, and as close as its error.
    if (error instanceof Error && error.name === 'ManifoldError') return own();
    throw error;
  }
}

const noReader = (): Uint8Array => {
  throw new Error('This worker cannot read files.');
};

/**
 * MM2: how far `mesh`'s surface lies from `copy`'s at most, proved over every point of it (SurfaceIndex.bound), with
 * a reach that grows until no point is beyond it. GC: G4's error for every decimation it makes.
 */
export function measuredError(mesh: WeldedMesh, copy: WeldedMesh): number {
  for (let reach = 0.5; ; reach *= 2) {
    const found = new SurfaceIndex(copy, reach, Math.max(DEVIATION_CELL_MM, reach)).bound(mesh, null);
    if (!found.beyond) return found.bound;
  }
}

/**
 * MM2: model_oriented.stl of a simplified model is the maker's own file (the user's answer of 2026-11-16): read
 * again from where it was opened, checked against its hash, parsed and welded as a load does, and turned by the
 * plan's transform, with the import's flip, into the same writer's STL. Where the plane trims the model, or the
 * copy's import flipped an inside-out separate body (`copy`'s 'shell-inverted', which only the whole solid can
 * do again: MM2's review), the file takes the whole-solid path a model loaded as it is takes, trimmed if need be.
 * Its volume less what its parts share is what report.json gives. Its arrays go in one slot of `holding`, which
 * each step replaces.
 */
function readOriginal(api: ManifoldToplevel, inputs: ExportInputs, copy: SolidReport, overlap: number, readBlob: (blob: Blob) => Uint8Array, holding: unknown[]): { stl: Uint8Array; volume: number | null; triangles: number; trimmed: boolean } {
  const { source, sha256: expected, facts } = inputs.original!;
  const slot = holding.push(null) - 1;
  const changed = (): InlineError => new InlineError('original-unreadable', `${facts.name} could not be read again for model_oriented.stl, so nothing was saved: it may have been moved, renamed or changed since you opened it. Open it again, then export.`);
  let bytes: Uint8Array | null;
  try {
    bytes = originalBytes(source, facts.name, readBlob);
  } catch {
    throw changed();
  }
  holding[slot] = bytes;
  if (sha256(bytes) !== expected) throw changed();
  const parsed = parseStl(bytes);
  bytes = null;
  holding[slot] = parsed.positions;
  const welded = weld(parsed.positions);
  holding[slot] = welded;
  // RM: a repaired model's file is turned as its own import turns it, which the record keeps, not as the copy's is.
  // Whether the plane trims it is the file's own (decision C, RM's review): the copy's trim says nothing of it, and a
  // part the copy left out may reach below a plane the copy only stands on.
  const repaired = inputs.original!.repaired;
  if (repaired?.route === 'soup') return openOriginal(inputs, welded, repaired, holding, slot);
  const inverted = repaired ? repaired.inverted : copy.diagnostics.some((d) => d.code === 'shell-inverted');
  const flipped = repaired ? repaired.flipped : copy.flipped;
  const needsTrim = repaired ? reachesBelow(welded, inputs.transform, inputs.planeTol) : inputs.needsTrim;
  if (needsTrim || inputs.original!.wholeSolid || inverted) {
    const read = withArena(api, (scratch) => {
      const whole = importSolid(scratch, welded, auditEdges(welded));
      const mesh: WeldedMesh = { positions: transformPositions(whole.mesh.positions, inputs.transform), indices: whole.mesh.indices };
      holding[slot] = [welded, mesh];
      if (!needsTrim) return { stl: writeBinaryStl(mesh.positions, mesh.indices), volume: whole.solid ? whole.solid.volume() - whole.report.overlapVolume : 0 };
      const trimmed = orientedSolid(scratch, whole, { transform: inputs.transform, needsTrim: true });
      const stl = modelOrientedStl({ mesh, needsTrim: true } as OrientedModel, trimmed);
      if (!trimmed) return { stl, volume: 0 };
      const shared = whole.report.overlapVolume > 0 ? sharedVolume(scratch, trimmed) : 0;
      return { stl, volume: trimmed.volume() - shared };
    });
    holding[slot] = read.stl;
    return { ...read, triangles: (read.stl.length - 84) / 50, trimmed: needsTrim };
  }
  const mesh: WeldedMesh = { positions: transformPositions(welded.positions, inputs.transform), indices: flipped ? reversed(welded.indices) : welded.indices };
  holding[slot] = mesh;
  const stl = writeBinaryStl(mesh.positions, mesh.indices);
  holding[slot] = stl;
  const { min, max } = meshBounds(mesh.positions);
  // A repaired file's parts' overlap is not the copy's, which has none: a closed file that folds keeps its own volume.
  const volume = signedVolumeAbout(mesh, null, (min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2) - (repaired ? 0 : overlap);
  return { stl, volume, triangles: mesh.indices.length / 3, trimmed: false };
}

/** RM: how close to the base plane a corner of an open file is taken as on it, where the file is cut there (clipBelow). */
export const CLIP_TOLERANCE_MM = 0.001;

/**
 * RM, decision C: model_oriented.stl of a repaired open file, which HEAD loaded in soup mode: the welded file turned
 * by the repaired model's transform, its whole mesh reversed where its own import reversed it (by its signed volume
 * about its centre), as HEAD writes such a file. Where the plane trims the repaired copy, or the file reaches more
 * than the plane tolerance below the plane (a part the copy left out), it is cut at the plane triangle by triangle
 * (clipBelow), as an open surface has no solid to trim: the cut is left open, as the rest of the file is. An open
 * surface has no volume, so none is given, as HEAD gives none for a soup.
 */
function openOriginal(inputs: ExportInputs, welded: WeldedMesh, facts: OriginalImport, holding: unknown[], slot: number): { stl: Uint8Array; volume: null; triangles: number; trimmed: boolean } {
  const turned: WeldedMesh = { positions: transformPositions(welded.positions, inputs.transform), indices: facts.flipped ? reversed(welded.indices) : welded.indices };
  holding[slot] = turned;
  let below = false;
  for (let k = 2; k < turned.positions.length && !below; k += 3) below = turned.positions[k] < -inputs.planeTol;
  // A cut that took nothing leaves the file as it is, so no corner is moved onto the plane for nothing.
  const clipped = below ? clipBelow(turned, CLIP_TOLERANCE_MM) : null;
  const mesh = clipped && clipped.cut > 0 ? clipped : turned;
  holding[slot] = mesh;
  const stl = writeBinaryStl(mesh.positions, mesh.indices);
  holding[slot] = stl;
  return { stl, volume: null, triangles: mesh.indices.length / 3, trimmed: mesh !== turned };
}

/** RM: whether a file, turned by `transform`, reaches more than the plane tolerance below the base plane, as orientToBase's trim reads it. */
function reachesBelow(welded: WeldedMesh, transform: RigidTransform, planeTol: number): boolean {
  const [, , , , , , g, h, i] = transform.rotation;
  const P = welded.positions, tz = transform.translation[2];
  for (let k = 0; k < P.length; k += 3) if (Math.fround(g * P[k] + h * P[k + 1] + i * P[k + 2] + tz) < -planeTol) return true;
  return false;
}
