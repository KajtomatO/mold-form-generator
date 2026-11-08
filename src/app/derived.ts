import { boreSilicone, describeProblem, firstPourPeak, type PlacedOpening } from '../core/analysis/placement';
import { checkOpening, dropOpening, topRadius, type HardProblem } from '../core/analysis/validate';
import { siliconeVolume } from '../core/field/silicone';
import { exportPlan, fieldSettings } from '../core/field/grid';
import type { Bounds } from '../core/mesh/weld';
import type { Params } from '../core/params/schema';
import { boltNeeds } from '../core/parts/bolts';
import type { Rim } from '../core/parts/rim';
import { boltAdvice, GRAVITY, type BoltAdvice, type ClampAdvice } from '../core/report/clamp';
import type { Diagnostic } from '../core/report/diagnostics';
import { plasticDiagnostic, plasticEstimate, printabilityDiagnostics, type PartAmount, type PlasticEstimate } from '../core/report/printability';
import type { Marker, Pipeline, ShownDiagnostic } from './pipeline';
import { paramValue, type ParamPath } from './stages';

/** Values the sidebar and status strip show, read off what the pipeline has on screen. Pure: no DOM. */

/** The outer box of the assembled mold: the cover's footprint, and from the base's underside to the flat top. */
export function moldBox(rim: Rim): [number, number, number] {
  return [rim.O.x1 - rim.O.x0, rim.O.y1 - rim.O.y0, rim.Zt + rim.Tb];
}

/** The same box as corners in mold coordinates: the cover's outline, from the base's underside up to Zt. */
export function moldExtent(rim: Rim): { min: [number, number, number]; max: [number, number, number] } {
  return { min: [rim.O.x0, rim.O.y0, -rim.Tb], max: [rim.O.x1, rim.O.y1, rim.Zt] };
}

export function modelSize(bounds: Bounds): [number, number, number] {
  return [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];
}

/**
 * The plan's silicone volume on the preview field: the integral of H with the preview's TIN raise,
 * less the model above the plane per tile, less the sealed air S8 finds, plus the silicone in the
 * bores. The sealed air comes with the reports, which follow the preview by a job.
 */
export function previewSilicone(pipeline: Pipeline): { ml: number; grams: number } | null {
  const field = pipeline.field?.value, oriented = pipeline.oriented?.value;
  if (!field || !oriented) return null;
  const overlap = pipeline.imported?.value.overlapVolume ?? 0;
  const raise = pipeline.params.quality.tinTolPreview;
  const sealedAir = pipeline.reports?.value.air.sealedAir ?? 0;
  const volume = siliconeVolume(field.field, { exteriorVolume: oriented.modelVolume - overlap, tiles: field.mold.offsets.length, sealedAir, raise });
  const bores = pipeline.placement ? boreSilicone(pipeline.placement.value.copies, field.field, field.rim.Zt) : 0;
  const ml = volume.ml + bores / 1000;
  return { ml, grams: ml * pipeline.params.silicone.density };
}

/** G6: the pitch shown is always the export plan's, as the parts are placed on it. */
export function exportPitch(params: Params, bounds: Bounds): [number, number] {
  const plan = exportPlan(bounds, fieldSettings(params, bounds));
  return [plan.pitchXmm, plan.pitchYmm];
}

/** What an auto parameter follows right now, or null while that needs a model that is not there yet. */
export function autoValue(path: ParamPath, pipeline: Pipeline): number | null {
  const params = pipeline.params;
  const oriented = pipeline.oriented?.value;
  switch (path) {
    case 'base.pocketDepth':
      return params.print.layerHeight;
    case 'silicone.printMargin':
      return params.print.layerHeight / 2;
    case 'vents.persistence':
      return params.silicone.t / 2;
    case 'base.planeTol':
      return oriented ? oriented.planeTol : null;
    case 'grid.spacing':
      return oriented ? exportPlan(oriented.bounds, fieldSettings(params, oriented.bounds)).autoSpacing : null;
    case 'grid.edge':
      return pipeline.field?.value.rim.edge.minimum ?? null;
    case 'quality.cellPreview':
      return pipeline.field?.value.cell ?? null;
    case 'bolts.length':
      return boltNeeds(params).autoLength;
    default:
      return null;
  }
}

/** The value a row shows: the parameter's own, or what its auto rule resolves to. */
export function shownValue(path: ParamPath, pipeline: Pipeline): unknown {
  const value = paramValue(pipeline.params, path);
  return value === null ? autoValue(path, pipeline) : value;
}

/** Where each diagnostic belongs in the sidebar, so it can show under the control it concerns. */
export const DIAGNOSTIC_PARAM: Record<string, ParamPath> = {
  // crossParameterErrors in params/rules.ts
  'seat-too-deep': 'seat.depth',
  'pocket-range': 'base.pocketDepth',
  'funnel-no-seat': 'funnel.generate',
  'funnel-top-small': 'funnel.topDiameter',
  'funnel-no-throat': 'funnel.tipWall',
  'funnel-no-spigot': 'funnel.seatClearance',
  'funnel-no-cone': 'funnel.height',
  'funnel-under-neck': 'funnel.topDiameter',
  'funnel-too-flat': 'funnel.topDiameter',
  'funnel-wall': 'funnel.wall',
  // deriveRim
  'edge-raised': 'grid.edge',
  'corner-clamped': 'base.cornerRadius',
  'groove-too-shallow': 'joint.grooveExtraDepth',
  'ridge-too-thin': 'joint.ridgeWidth',
  'joint-clearance': 'joint.grooveClearance',
  'pry-clamped': 'joint.pryHeight',
  // M10's bolts, from deriveRim and the field: each says what to change, and `also` names the control.
  'bolt-land': 'bolts.enabled',
  'bolt-cover-raised': 'cover.topCap',
  'bolt-short': 'bolts.length',
  'bolt-long': 'bolts.length',
  'bolt-plate-thin': 'base.thickness',
  'bolt-bridge': 'bolts.nutClearance',
  'bolt-collision': 'bolts.minWall',
  // toolDiagnostics: the cavity's reach is set by the room the edge leaves.
  'tool-outside-rebate': 'grid.edge',
  // An open mesh: merged mode needs a closed solid, so its note goes under the mode it turns off.
  'soup-mode': 'base.mode',
  'mode-b-disabled': 'base.mode',
  // G1.8: a model past 2M triangles merges a simplified copy, and says by how much.
  'mode-b-simplified': 'base.mode',
  'mode-b-unsimplified': 'base.mode',
  // The base, the footprint and the grid.
  'base-layers': 'base.thickness',
  'pocket-layers': 'base.pocketDepth',
  'footprint-islands': 'base.minIsland',
  'footprint-empty': 'base.minIsland',
  'plane-rough': 'base.planeTol',
  'upper-level-gone': 'base.planeTol',
  // What the chosen face implies, which shows in the Model section under the face list, where it is chosen.
  'below-plane': 'base.planeTol',
  'below-plane-soup': 'base.planeTol',
  'missing-top-surface': 'base.planeTol',
  'base-from-hole': 'base.planeTol',
  // A project file's saved plane, checked against the plane its choice finds in this version.
  'plane-found': 'base.planeTol',
  'plane-mismatch': 'base.planeTol',
  'tiles-merged': 'grid.spacing',
  'thin-tile-wall': 'grid.spacing',
  'pour-shortfall': 'pour.perModel',
  'funnel-collision': 'funnel.topDiameter',
  // printabilityDiagnostics, worked out on main
  'bed-turn': 'print.bedX',
  'bed-too-small': 'print.bedX',
  'ridge-narrow': 'joint.ridgeWidth',
  'reports-failed': 'quality.analysisCell',
  // siliconeAdvice below
  'silicone-thin': 'silicone.t',
  'silicone-tall': 'silicone.t',
};

/** The parameter table's advice on t: a warning under 3 mm, and 4 to 5 mm for a cavity over 100 mm tall. */
export function siliconeAdvice(params: Params, rim: Rim | null): Diagnostic[] {
  const { t } = params.silicone;
  const advice: Diagnostic[] = [];
  if (t < 3) advice.push({ code: 'silicone-thin', severity: 'warning', message: `A silicone wall of ${t} mm is under the 3 mm this mold is designed around, so it may tear when you demold.` });
  else if (rim && rim.hMax > 100 && t < 4) advice.push({ code: 'silicone-tall', severity: 'info', message: `This cavity is ${rim.hMax.toFixed(0)} mm tall, so 4 to 5 mm of silicone keeps a mold that size from sagging.` });
  return advice;
}

const RANK = { error: 0, warning: 1, info: 2 } as const;

/**
 * The plan's printability checks for the state on screen, from S10's rim alone: the parts against the
 * bed and the ridge against the nozzle. Arithmetic, so they show with the first field and need no report.
 */
export function printabilityOnScreen(pipeline: Pipeline): Diagnostic[] {
  const field = pipeline.field?.value, oriented = pipeline.oriented?.value;
  if (!field || !oriented) return [];
  return printabilityDiagnostics(pipeline.params, field.rim, { offsets: field.mold.offsets, modelTop: oriented.bounds.max[2] });
}

/**
 * Everything the Diagnostics card lists: the pipeline's, its error, the advice on t, the printability
 * checks, and what the last export found while its geometry is current, problems first.
 */
export function allDiagnostics(pipeline: Pipeline): ShownDiagnostic[] {
  const status = pipeline.status();
  const error: ShownDiagnostic[] = status.error ? [{ code: 'pipeline-error', severity: 'error', message: status.error }] : [];
  const plastic = plasticOnScreen(pipeline);
  const all = [...error, ...pipeline.diagnostics, ...siliconeAdvice(pipeline.params, pipeline.field?.value.rim ?? null), ...printabilityOnScreen(pipeline), ...(plastic ? [plasticDiagnostic(plastic, pipeline.params)] : []), ...pipeline.exportNotes()];
  return all.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

/**
 * Why the export buttons are off, or null when they can be used: with no model, and while a hard error
 * stands. What an export found itself does not count, as exporting again is how to see it change.
 */
export function exportBlocked(pipeline: Pipeline): string | null {
  if (!pipeline.modelName) return 'Load a model to export its mold.';
  const error = allDiagnostics(pipeline).find((d) => d.severity === 'error' && !d.byExport);
  return error ? `Fix this first: ${error.message}` : null;
}

/** Codes whose message names a place on the top as "at (x, y)": these get a Show toggle. */
const LOCATED = new Set(['vent-refused', 'cavity-without-pour', 'cavity-closed', 'peak-uncovered', 'long-vent', 'long-pour', 'pour-off-peak', 'opening-invalid', 'pour-shortfall', 'export-opening-invalid']);
const AT = /\((-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\)/;

/** Where a diagnostic points, on the flat top of the first tile, or null if it names no place. */
export function diagnosticPoint(diagnostic: Diagnostic, top: number): [number, number, number] | null {
  if (diagnostic.at) return diagnostic.at;
  if (!LOCATED.has(diagnostic.code)) return null;
  const match = AT.exec(diagnostic.message);
  return match ? [Number(match[1]), Number(match[2]), top] : null;
}

/** What a diagnostic's Show toggle marks: its own place, or every place it stands for, such as the cut hints. */
export function diagnosticMarkers(diagnostic: ShownDiagnostic, top: number): Marker[] {
  if (diagnostic.markers && diagnostic.markers.length > 0) return diagnostic.markers;
  const point = diagnosticPoint(diagnostic, top);
  return point ? [{ at: point }] : [];
}

/** The volume and surface of a part's mesh, worked out once per mesh, as a rebuild sends a new one. */
const amounts = new WeakMap<object, { volume: number; area: number }>();
function meshAmount(mesh: { positions: Float32Array; indices: Uint32Array }): { volume: number; area: number } {
  let known = amounts.get(mesh);
  if (known) return known;
  const { positions: p, indices } = mesh;
  let volume = 0, area = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    area += Math.hypot(nx, ny, nz) / 2;
    volume += (p[a] * nx + p[a + 1] * ny + p[a + 2] * nz) / 6;
  }
  known = { volume, area };
  amounts.set(mesh, known);
  return known;
}

/**
 * The plan's plastic estimate from the parts on screen: the cover, the base and a funnel per pour. Null
 * until T2 has built the cover and base for the rim on screen, as their volumes are what it reads.
 */
export function plasticOnScreen(pipeline: Pipeline): PlasticEstimate | null {
  const { cover, base, funnel, field, placement } = pipeline;
  if (!cover || !base || !field || cover.mold !== field.mold || base.mold !== field.mold) return null;
  const parts: PartAmount[] = [{ ...meshAmount(cover.value), count: 1 }, { ...meshAmount(base.value), count: 1 }];
  const pours = placement ? placement.value.copies.filter((c) => c.kind === 'pour').length : 0;
  if (funnel?.value && pours > 0) parts.push({ ...meshAmount(funnel.value), count: pours });
  return plasticEstimate(parts, pipeline.params);
}

export interface ClampFigure extends ClampAdvice {
  /** The silicone's push on the cover, in N, at the level it was worked out for. */
  liftN: number;
  level: number;
  /** The cover's own weight as printed, in N, or null until its solid is built. */
  coverWeightN: number | null;
}

/** The plan's clamp advice for Cover & joint, with the lift it answers and the cover's weight beside it. */
export function clampFigure(pipeline: Pipeline): ClampFigure | null {
  const reports = pipeline.reports?.value;
  if (!reports) return null;
  const { cover, field } = pipeline;
  const own = cover && field && cover.mold === field.mold ? plasticEstimate([{ ...meshAmount(cover.value), count: 1 }], pipeline.params) : null;
  return { ...reports.clamp, liftN: reports.lift.forceN, level: reports.lift.level, coverWeightN: own ? (own.printed / 1000) * GRAVITY : null };
}

/** M10: with bolts on, Cover & joint shows them in place of the tape count, from the rim on screen and the reports' lift. */
export function boltFigure(pipeline: Pipeline): BoltAdvice | null {
  const bolts = pipeline.field?.value.rim.bolts;
  const reports = pipeline.reports?.value;
  if (!bolts || !reports) return null;
  return boltAdvice(reports.lift.forceN, pipeline.params.print.tapeStrip, bolts);
}

/** The radius an opening shows at the top: its seat's for a pour, its mouth's for a vent. */
export function markerRadius(pipeline: Pipeline, kind: 'pour' | 'vent'): number {
  const sizes = pipeline.placement?.value.space.sizes;
  return sizes ? topRadius(sizes, kind) : 0;
}

/** "Pour 1", "Vent 2": an opening's name as its row in Pour & funnel shows it, numbered by kind in placement order. */
export function openingLabel(openings: readonly Pick<PlacedOpening, 'id' | 'kind'>[], id: string): string {
  const kind = openings.find((o) => o.id === id)?.kind;
  if (!kind) return 'Opening';
  const n = openings.filter((o) => o.kind === kind).findIndex((o) => o.id === id) + 1;
  return `${kind === 'pour' ? 'Pour' : 'Vent'} ${n}`;
}

/** Where a dragged opening would stand, by the plan's hard rules, with why not in a maker's words. */
export interface DragCheck {
  valid: boolean;
  problems: HardProblem[];
  /** The first problem as a sentence part, such as "it is too close to another opening", or null. */
  reason: string | null;
  /** Where a drop now ends up, on the first tile: the spot itself, the nearest valid place, or null if none is valid. */
  lands: { x: number; y: number } | null;
  /** The plan's soft rules where it lands: a long bore, a first pour off its peak, its funnel colliding. */
  warnings: Diagnostic[];
}

/**
 * Drag validation on main, as the plan's Analyses section has it: the hard rules for the opening at
 * (x, y) on the first tile, over all its copies, against every other opening where it stands now, then
 * the drop's own snap and soft rules, so the view can show where a drop lands and what it would say.
 * Reads only the field's nodes under the discs and the distance map, so it runs on every pointer move.
 */
export function dragCheck(pipeline: Pipeline, id: string, x: number, y: number): DragCheck | null {
  const shown = pipeline.placement?.value;
  const opening = shown?.placement.openings.find((o) => o.id === id);
  if (!shown || !opening) return null;
  const others = shown.placement.openings.filter((o) => o.id !== id);
  const spot = { kind: opening.kind, x, y };
  const { valid, problems } = checkOpening(shown.space, spot, others);
  // The same call as the pipeline's drop, so what the tip says is what the drop does.
  const drop = dropOpening(shown.space, spot, others, firstPourPeak(shown.placement, id, pipeline.params.silicone.t / 2));
  return {
    valid,
    problems,
    reason: problems.length > 0 ? describeProblem(problems[0]) : null,
    lands: drop.valid ? { x: drop.x, y: drop.y } : null,
    warnings: drop.valid ? drop.warnings : [],
  };
}
