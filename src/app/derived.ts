import { boreSilicone } from '../core/analysis/placement';
import { topRadius } from '../core/analysis/validate';
import { siliconeVolume } from '../core/field/silicone';
import { exportPlan, fieldSettings } from '../core/field/grid';
import type { Bounds } from '../core/mesh/weld';
import type { Params } from '../core/params/schema';
import type { Rim } from '../core/parts/rim';
import type { Diagnostic } from '../core/report/diagnostics';
import type { Pipeline, ShownDiagnostic } from './pipeline';
import { paramValue, type ParamPath } from './stages';

/** Values the sidebar and status strip show, read off what the pipeline has on screen. Pure: no DOM. */

/** The outer box of the assembled mold: the cover's footprint, and from the base's underside to the flat top. */
export function moldBox(rim: Rim): [number, number, number] {
  return [rim.O.x1 - rim.O.x0, rim.O.y1 - rim.O.y0, rim.Zt + rim.Tb];
}

export function modelSize(bounds: Bounds): [number, number, number] {
  return [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];
}

/**
 * The plan's silicone volume on the preview field: the integral of H with the preview's TIN raise,
 * less the model above the plane per tile, plus the silicone in the bores. Sealed air comes with
 * M7's reports, so a model that traps air under it reads a little high here.
 */
export function previewSilicone(pipeline: Pipeline): { ml: number; grams: number } | null {
  const field = pipeline.field?.value, oriented = pipeline.oriented?.value;
  if (!field || !oriented) return null;
  const overlap = pipeline.imported?.value.overlapVolume ?? 0;
  const raise = pipeline.params.quality.tinTolPreview;
  const volume = siliconeVolume(field.field, { exteriorVolume: oriented.modelVolume - overlap, tiles: field.mold.offsets.length, sealedAir: 0, raise });
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
  // toolDiagnostics: the cavity's reach is set by the room the edge leaves.
  'tool-outside-rebate': 'grid.edge',
  // The base, the footprint and the grid.
  'base-layers': 'base.thickness',
  'pocket-layers': 'base.pocketDepth',
  'footprint-islands': 'base.minIsland',
  'footprint-empty': 'base.minIsland',
  'plane-rough': 'base.planeTol',
  'upper-level-gone': 'base.planeTol',
  'tiles-merged': 'grid.spacing',
  'thin-tile-wall': 'grid.spacing',
  'pour-shortfall': 'pour.perModel',
  'funnel-collision': 'funnel.topDiameter',
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
 * Everything the Diagnostics card lists: the pipeline's, its error, the advice on t, and what the last
 * export found while its geometry is current, problems first.
 */
export function allDiagnostics(pipeline: Pipeline): ShownDiagnostic[] {
  const status = pipeline.status();
  const error: ShownDiagnostic[] = status.error ? [{ code: 'pipeline-error', severity: 'error', message: status.error }] : [];
  const all = [...error, ...pipeline.diagnostics, ...siliconeAdvice(pipeline.params, pipeline.field?.value.rim ?? null), ...pipeline.exportNotes()];
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
  if (!LOCATED.has(diagnostic.code)) return null;
  const match = AT.exec(diagnostic.message);
  return match ? [Number(match[1]), Number(match[2]), top] : null;
}

/** The radius an opening shows at the top: its seat's for a pour, its mouth's for a vent. */
export function markerRadius(pipeline: Pipeline, kind: 'pour' | 'vent'): number {
  const sizes = pipeline.placement?.value.space.sizes;
  return sizes ? topRadius(sizes, kind) : 0;
}
