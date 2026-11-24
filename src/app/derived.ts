import { boreSilicone, describeProblem, firstPourPeak, type PlacedOpening } from '../core/analysis/placement';
import { checkOpening, dropOpening, FLANGE_GAP, flangeReach, topRadius, type HardProblem, type OpeningKind, type OpeningSizes } from '../core/analysis/validate';
import { siliconeVolume } from '../core/field/silicone';
import { exportPlan, fieldSettings } from '../core/field/grid';
import type { Bounds } from '../core/mesh/weld';
import type { Params } from '../core/params/schema';
import { boltNeeds } from '../core/parts/bolts';
import { seamBoltNeeds } from '../core/parts/seamBolts';
import type { ClamField } from '../workers/clamshellField';
import type { Rim } from '../core/parts/rim';
import type { Rect } from '../core/solid/rect';
import { boltAdvice, GRAVITY, type BoltAdvice, type ClampAdvice } from '../core/report/clamp';
import type { Diagnostic } from '../core/report/diagnostics';
import { plasticDiagnostic, plasticEstimate, printabilityDiagnostics, type PartAmount, type PlasticEstimate } from '../core/report/printability';
import type { Marker, Pipeline, ShownDiagnostic } from './pipeline';
import { paramValue, type ParamPath } from './stages';
import type { Clearance } from '../workers/exportJob';
import { onSeam, seamCheck, seamDrop, seamSpace } from './seamDrag';

/** Values the sidebar and status strip show, read off what the pipeline has on screen. Pure: no DOM. */

/** The outer box of the assembled mold: the cover's footprint, and from the base's underside to the flat top. */
export function moldBox(rim: Rim): [number, number, number] {
  return [rim.O.x1 - rim.O.x0, rim.O.y1 - rim.O.y0, rim.Zt + rim.Tb];
}

/** The same box as corners in mold coordinates: the cover's outline, from the base's underside up to Zt. */
export function moldExtent(rim: Rim): { min: [number, number, number]; max: [number, number, number] } {
  return { min: [rim.O.x0, rim.O.y0, -rim.Tb], max: [rim.O.x1, rim.O.y1, rim.Zt] };
}

/**
 * RM: how many triangles of the file a rebuilt model's last export left out and could not measure the silicone round
 * (past OUTSIDE_MEASURE_LIMIT), or null where it measured the whole model: then the status strip says unverified,
 * as report.json's null does, and not the figure, which holds for the rest of the file only (RM's review).
 */
export function unmeasuredParts(clearance: Pick<Clearance, 'outside'> | null): number | null {
  return clearance?.outside && clearance.outside.gap === null ? clearance.outside.triangles : null;
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
  // What the parts share above the plane: on a plane that trims the model, the solid worker's figure for the
  // trimmed parts once it is in for this plane, and until then, as on every other plane, the import's.
  const trimmed = pipeline.footprint && pipeline.footprint.key === pipeline.oriented?.key ? pipeline.footprint.value.overlap : null;
  const overlap = trimmed ?? pipeline.imported?.value.overlapVolume ?? 0;
  const raise = pipeline.run.quality.tinTolPreview;
  const sealedAir = pipeline.reports?.value.air.sealedAir ?? 0;
  // MP5: the two-part cover's from its fine pair (G13.13), which took off the model alone, with the bores on P.
  if (field.clam) {
    const bores = pipeline.placement ? boreSilicone(pipeline.placement.value.copies.filter((c) => !(c.kind === 'vent' && c.hidden)), field.field, field.rim.Zt) : 0;
    const ml = field.clam.siliconeMl + (overlap - sealedAir + bores) / 1000;
    return { ml, grams: ml * pipeline.run.silicone.density };
  }
  const volume = siliconeVolume(field.field, { exteriorVolume: oriented.modelVolume - overlap, tiles: field.mold.offsets.length, sealedAir, raise });
  const bores = pipeline.placement ? boreSilicone(pipeline.placement.value.copies, field.field, field.rim.Zt) : 0;
  const ml = volume.ml + bores / 1000;
  return { ml, grams: ml * pipeline.run.silicone.density };
}

/** G13.13: under this share saved, the two-part cover's line says it saves nothing worth the split on this model. */
export const NO_SAVING_SHARE = 0.03;

/**
 * MP5: what the two-part cover saves against the one-piece cover at the same settings, from the preview on screen and
 * the reports job's estimate of the other type; null until both are in, or where the two-part cover is not offered.
 */
export function typeSaving(pipeline: Pipeline): { ml: number; share: number; twoPartMl: number; onePieceMl: number } | null {
  const shown = previewSilicone(pipeline), estimate = pipeline.currentEstimate();
  if (!shown || !estimate) return null;
  const clam = pipeline.field?.value.clam !== undefined;
  if ((estimate.kind === 'one-piece') !== clam) return null;
  const [twoPartMl, onePieceMl] = clam ? [shown.ml, estimate.ml] : [estimate.ml, shown.ml];
  if (!(onePieceMl > 0)) return null;
  return { ml: onePieceMl - twoPartMl, share: (onePieceMl - twoPartMl) / onePieceMl, twoPartMl, onePieceMl };
}

/** MP5: the Two-part tile's line, "Saves about N ml (P%)", or that it saves nothing here (G13.13). */
export function savingText(saving: ReturnType<typeof typeSaving>): string | null {
  if (!saving) return null;
  if (saving.share < NO_SAVING_SHARE) return 'No saving on this model';
  return `Saves about ${savingMl(saving.ml)} ml (${Math.round(saving.share * 100)}%)`;
}

/**
 * MP5: the Two-part tile's title past its blurb. Each side compares a coarse estimate of the other type with its own
 * preview, so the figure is worked out again from the fine pair once the Two-part cover is on screen.
 */
export function savingTitle(saving: ReturnType<typeof typeSaving>): string | null {
  if (!saving) return null;
  if (saving.share < NO_SAVING_SHARE) return 'On this model it saves no silicone worth the split.';
  return `On this model it saves about ${savingMl(saving.ml)} ml (${Math.round(saving.share * 100)}%) against a One-piece cover at the same settings; the figure is worked out again once it is on screen.`;
}

function savingMl(ml: number): string {
  return ml.toFixed(ml < 10 ? 1 : 0);
}

/** G6: the pitch shown is always the export plan's, as the parts are placed on it. */
export function exportPitch(params: Params, bounds: Bounds, modelErrorMm = 0): [number, number] {
  const plan = exportPlan(bounds, fieldSettings(params, bounds, undefined, modelErrorMm));
  return [plan.pitchXmm, plan.pitchYmm];
}

/** What an auto parameter follows right now, or null while that needs a model that is not there yet. */
export function autoValue(path: ParamPath, pipeline: Pipeline): number | null {
  const params = pipeline.run;
  const oriented = pipeline.oriented?.value;
  switch (path) {
    case 'base.pocketDepth':
      return params.print.layerHeight;
    case 'silicone.printMargin':
      return params.print.layerHeight / 2;
    case 'vents.persistence':
      return params.silicone.t / 2;
    case 'silicone.baseLayer':
      return params.silicone.t;
    case 'base.planeTol':
      return oriented ? oriented.planeTol : null;
    case 'grid.spacing':
      // RM: the plan's box, which a rebuilt model's left-out parts widen in glue mode.
      return oriented ? exportPlan(pipeline.planBounds()!, fieldSettings(params, pipeline.planBounds()!, undefined, pipeline.modelErrorMm())).autoSpacing : null;
    case 'grid.edge':
      return pipeline.field?.value.rim.edge.minimum ?? null;
    case 'quality.cellPreview':
      return pipeline.field?.value.cell ?? null;
    case 'bolts.length':
      // MP5: the two-part cover's seam bolts have their own auto length (G13.10.2), 10 mm at M3 where the corner bolts' is 12.
      return params.mold.type === 'clamshell' ? seamBoltNeeds(params).autoLength : boltNeeds(params).autoLength;
    default:
      return null;
  }
}

/** The value a row shows: the parameter's own, or what its auto rule resolves to. */
export function shownValue(path: ParamPath, pipeline: Pipeline): unknown {
  const value = paramValue(pipeline.run, path);
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
  'funnel-flange': 'funnel.flangeWidth',
  // MT: the two-part cover's rules between settings (G13.14).
  'seam-cap': 'cover.topCap',
  'seam-land': 'clamshell.seamLand',
  // crossParameterWarnings: G13.8 step 6's flange beside the seam.
  'seam-flange': 'funnel.flangeWidth',
  // MP2: the seal's pins, dropped when the seam's top corners have no room.
  'seam-pins-dropped': 'clamshell.pins',
  // MP5: the two-part cover's own lines from its stages (G13.3, G13.6, G13.10, G13.13), under the rows they name. Its
  // "no saving" line advises the other type, and its hold line is drawn in Cover & joint already, so neither has a row.
  'clamshell-bed': 'print.bedX',
  'seam-wall-raised': 'cover.wall',
  'seam-bolt-no-room': 'clamshell.fastener',
  'seam-bolt-single': 'clamshell.fastener',
  'seam-bolt-held-back': 'clamshell.fastener',
  'seam-bolt-short': 'bolts.length',
  'seam-bolt-long': 'bolts.length',
  'seam-bolt-wedge': 'clamshell.fastener',
  'seam-top-span': 'clamshell.fastener',
  'clips-no-room': 'clamshell.fastener',
  'clips-rows-lowered': 'clips.rows',
  'clips-single': 'clips.rows',
  'clips-hold': 'clips.rows',
  'clips-wedge': 'clamshell.fastener',
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
  // FL: the flange's room is what holds the vent there.
  'vent-low': 'funnel.flangeWidth',
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

/** G13.13's "no saving on this model", on the two-part cover where it saves under NO_SAVING_SHARE of the one-piece's silicone. */
function noSaving(pipeline: Pipeline): Diagnostic[] {
  const line = pipeline.field?.value.clam ? noSavingLine(typeSaving(pipeline)) : null;
  return line ? [line] : [];
}

/** MP5 (G13.10.11, G13.10.19): the hold line on the card too, as an info line, once the fine pair is in. */
function seamHoldOnCard(pipeline: Pipeline): Diagnostic[] {
  const clam = pipeline.field?.value.clam;
  const line = clam ? seamHoldLine(clam) : null;
  return line ? [{ code: 'seam-hold', severity: 'info', message: line }] : [];
}

/** The line itself, for a saving worked out on the two-part cover; null where it saves NO_SAVING_SHARE or more. */
export function noSavingLine(saving: ReturnType<typeof typeSaving>): Diagnostic | null {
  if (!saving || saving.share >= NO_SAVING_SHARE) return null;
  const more = saving.ml < 0 ? `takes ${(-saving.ml).toFixed(1)} ml more silicone` : `saves only ${saving.ml.toFixed(1)} ml of silicone`;
  return { code: 'clamshell-no-saving', severity: 'info', message: `No saving on this model: the Two-part cover ${more} than a One-piece cover at the same settings (${saving.twoPartMl.toFixed(1)} against ${saving.onePieceMl.toFixed(1)} ml), as its ceilings slope to the seam over what a flat top would cover. A One-piece cover makes the same mold with one part less.` };
}

/**
 * The plan's printability checks for the state on screen, from S10's rim alone: the parts against the
 * bed and the ridge against the nozzle. Arithmetic, so they show with the first field and need no report.
 */
export function printabilityOnScreen(pipeline: Pipeline): Diagnostic[] {
  const field = pipeline.field?.value, oriented = pipeline.oriented?.value;
  if (!field || !oriented) return [];
  // MP5: the two-part cover's halves are checked against the bed in their own poses by S6c (G13.3's clamshell-bed).
  if (field.clam) return printabilityDiagnostics(pipeline.run, field.rim, { offsets: field.mold.offsets, modelTop: oriented.bounds.max[2] }).filter((d) => d.code !== 'bed-turn' && d.code !== 'bed-too-small');
  return printabilityDiagnostics(pipeline.run, field.rim, { offsets: field.mold.offsets, modelTop: (pipeline.planBounds() ?? oriented.bounds).max[2] });
}

/**
 * Everything the Diagnostics card lists: the pipeline's, its error, the advice on t, the printability
 * checks, and what the last export found while its geometry is current, problems first.
 */
export function allDiagnostics(pipeline: Pipeline): ShownDiagnostic[] {
  const status = pipeline.status();
  const error: ShownDiagnostic[] = status.error ? [{ code: 'pipeline-error', severity: 'error', message: status.error }] : [];
  const plastic = plasticOnScreen(pipeline);
  const all = [...error, ...pipeline.diagnostics, ...siliconeAdvice(pipeline.run, pipeline.field?.value.rim ?? null), ...printabilityOnScreen(pipeline), ...(plastic ? [plasticDiagnostic(plastic, pipeline.run)] : []), ...noSaving(pipeline), ...seamHoldOnCard(pipeline), ...pipeline.exportNotes()];
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
const LOCATED = new Set(['vent-refused', 'vent-low', 'cavity-without-pour', 'cavity-closed', 'peak-uncovered', 'long-vent', 'long-pour', 'pour-off-peak', 'opening-invalid', 'pour-shortfall', 'export-opening-invalid']);
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
  return plasticEstimate(parts, pipeline.run);
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
  const own = cover && field && cover.mold === field.mold ? plasticEstimate([{ ...meshAmount(cover.value), count: 1 }], pipeline.run) : null;
  return { ...reports.clamp, liftN: reports.lift.forceN, level: reports.lift.level, coverWeightN: own ? (own.printed / 1000) * GRAVITY : null };
}

/** M10: with bolts on, Cover & joint shows them in place of the tape count, from the rim on screen and the reports' lift. */
export function boltFigure(pipeline: Pipeline): BoltAdvice | null {
  const bolts = pipeline.field?.value.rim.bolts;
  const reports = pipeline.reports?.value;
  if (!bolts || !reports) return null;
  return boltAdvice(reports.lift.forceN, pipeline.run.print.tapeStrip, bolts);
}

/**
 * MP5: the two-part cover's hold in one line, as the sidebar and the card give it (G13.10.14, G13.10.19, G13.10.9), from
 * the fine pair on screen, or null until it is in.
 */
export function seamHoldLine(clam: ClamField | null): string | null {
  if (!clam) return null;
  const needs = `${clam.holdN.toFixed(0)} N the seam needs`;
  if (clam.bolts && clam.boltAdvice) {
    const { count, perEnd, size, length } = clam.bolts;
    if (count === 0) return 'No seam bolts fit these halves: see the error under Seam fasteners.';
    return `Held by ${count} ${size} x ${length} mm seam bolts, ${perEnd} on each end: ${clam.boltAdvice.boltsHoldN} N together, against the ${needs}.`;
  }
  if (clam.clips && clam.clipAdvice) {
    const { count, zs } = clam.clips;
    if (count === 0) return 'No seam clips fit these halves: see the error under Seam fasteners.';
    return `Held by ${count} printed clips, ${zs.length} on each end: about ${clam.clipAdvice.clipsHoldN} N together (40 N each, an estimate for printed plastic), against the ${needs}.`;
  }
  const belts = clam.belts;
  return `Held by two clamps across the back faces, each through a board, or ${belts ? `${belts.count} tape belts round all four walls` : 'tape belts round all four walls'}, against the ${needs}.`;
}

/** The radius an opening shows at the top: its seat's for a pour, its mouth's for a vent. */
export function markerRadius(pipeline: Pipeline, kind: 'pour' | 'vent'): number {
  const sizes = pipeline.placement?.value.space.sizes;
  return sizes ? topRadius(sizes, kind) : 0;
}

/** One copy of an opening's ring on the cover's top, as the view draws it and a press picks it. */
export interface OpeningRing {
  x: number;
  y: number;
  kind: OpeningKind;
  valid: boolean;
  /** Where a dragged opening would land if let go now: drawn faint, never pressed. */
  ghost?: boolean;
  /** At the flat top: the seat's for a pour, the mouth's for a vent. */
  radius: number;
}

/** What openingRings needs of a drag in progress (the store's OpeningDrag). */
export interface RingDrag {
  id: string;
  kind: OpeningKind;
  x: number;
  y: number;
  check: Pick<DragCheck, 'valid' | 'lands'>;
}

/**
 * Every copy of every opening's ring, listed opening by opening with a copy per tile, then the landing
 * spots of a drag. The one being dragged is where the pointer has it, on every tile, invalid while it may
 * not stand there; where a drop would land instead comes last, faint, on every tile.
 */
export function openingRings(pipeline: Pipeline, drag: RingDrag | null): OpeningRing[] {
  const rim = pipeline.field?.value.rim;
  const placement = pipeline.placement?.value;
  const rings: OpeningRing[] = [];
  if (!rim || !placement) return rings;
  const { offsets } = placement.space;
  placement.copies.forEach((copy, k) => {
    const opening = placement.placement.openings[Math.floor(k / offsets.length)];
    const [ox, oy] = offsets[k % offsets.length];
    const moving = drag !== null && opening?.id === drag.id;
    const at = moving ? { x: drag.x + ox, y: drag.y + oy } : copy;
    rings.push({ x: at.x, y: at.y, kind: copy.kind, valid: moving ? drag.check.valid : (opening?.valid ?? true), radius: markerRadius(pipeline, copy.kind) });
  });
  const lands = drag && !drag.check.valid ? drag.check.lands : null;
  if (drag && lands) for (const [ox, oy] of offsets) rings.push({ x: lands.x + ox, y: lands.y + oy, kind: drag.kind, valid: true, ghost: true, radius: markerRadius(pipeline, drag.kind) });
  return rings;
}

/** OL: one copy of a pour's funnel flange on the cover's top. */
export interface FlangeSpot {
  x: number;
  y: number;
  radius: number;
  /** Refused, drawn red: a vent's mouth within the flange's reach, or the flange's edge past the top's chamfer. */
  refused: boolean;
}

/**
 * OL: where each funnel's flange will rest, one per copy of each pour's ring, none at a landing spot, and
 * none with no funnel, no seat or no flange (a flange radius of 0, the hard rule's own condition). A copy
 * is refused where a vent's ring stands nearer than the flange rule's reach (flangeReach: the flange,
 * the vent's mouth and the gap between), so it turns red exactly where that rule refuses a vent or a pour,
 * copy by copy; or where the flange and the top's chamfer run past the top, the flange's share of the
 * top-edge rule. Pairwise over the copies drawn, which on a tile lattice is what nearestCopy finds.
 */
export function flangeOutlines(sizes: OpeningSizes, O: Rect, rings: readonly Pick<OpeningRing, 'x' | 'y' | 'kind' | 'ghost'>[]): FlangeSpot[] {
  const radius = sizes.flangeRadius;
  if (!(radius > 0)) return [];
  const reach = flangeReach(sizes);
  const edge = radius + sizes.topChamfer;
  const vents = rings.filter((ring) => ring.kind === 'vent' && !ring.ghost);
  return rings
    .filter((ring) => ring.kind === 'pour' && !ring.ghost)
    .map(({ x, y }) => ({
      x,
      y,
      radius,
      refused: vents.some((vent) => Math.hypot(vent.x - x, vent.y - y) < reach) || x < O.x0 + edge || y < O.y0 + edge || x > O.x1 - edge || y > O.y1 - edge,
    }));
}

/**
 * OL: the drag tip's line where the flange is the problem: the red dashed circle is that flange, and what keeps
 * a vent's mouth the gap clear of it. A ring is drawn 0.3 mm past the mouth's edge and the dashes 0.2 mm past
 * the flange's, so at FLANGE_GAP the two touch where the rule starts to refuse. VN: a wider gap, as a larger
 * seat clearance or nozzle needs (flangeGap), keeps the ring that much further off the dashes.
 */
export function flangeTip(kind: OpeningKind, gap: number): string {
  const more = gap - FLANGE_GAP;
  const [circle, ring, mouth] = kind === 'vent' ? ["that funnel's flange", "the vent's ring", "the vent's mouth"] : ["this pour's flange", "every vent's ring", 'each mouth'];
  if (more < 0.005) return `The red dashed circle is ${circle}: keep ${ring} wholly outside it, which leaves ${mouth} ${FLANGE_GAP.toFixed(1)} mm clear of the flange.`;
  return `The red dashed circle is ${circle}: keep ${ring} ${more.toFixed(2)} mm or more outside it, which leaves ${mouth} ${gap.toFixed(2)} mm clear of the flange, as the funnel's play in its seat and half a printed line need.`;
}

/** "Pour 1", "Vent 2": an opening's name as its row in Pour & funnel shows it, numbered by kind in placement order. */
export function openingLabel(openings: readonly Pick<PlacedOpening, 'id' | 'kind'>[], id: string): string {
  const kind = openings.find((o) => o.id === id)?.kind;
  if (!kind) return 'Opening';
  const n = openings.filter((o) => o.kind === kind).findIndex((o) => o.id === id) + 1;
  return `${kind === 'pour' ? 'Pour' : 'Vent'} ${n}`;
}

/**
 * Why an opening may not stand somewhere, in a maker's words, or null if it may: the first problem, and
 * a flange's too (FL), which reaches further than the land and so is the one to clear.
 */
export function refusalReason(problems: readonly HardProblem[], kind: OpeningKind): string | null {
  if (problems.length === 0) return null;
  const first = describeProblem(problems[0], kind);
  return problems[0] !== 'flange' && problems.includes('flange') ? `${first}, and ${describeProblem('flange', kind)}` : first;
}

/** Where a dragged opening would stand, by the plan's hard rules, with why not in a maker's words. */
export interface DragCheck {
  valid: boolean;
  problems: HardProblem[];
  /** The first problem as a sentence part, such as "it is too close to another opening", or null, by refusalReason. */
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
  // MP5: on the two-part cover an opening moves along P, with the seal's room beside it (G13.5).
  if (shown.seam) {
    const at = onSeam(shown.seam, opening.kind, x, y);
    const space = seamSpace(shown.space, shown.seam, id);
    const check = seamCheck(space, shown.seam, at, others);
    const drop = seamDrop(space, shown.seam, opening.kind, x, y, others);
    return { valid: check.valid, problems: check.problems, reason: refusalReason(check.problems, opening.kind), lands: drop.valid ? { x: drop.x, y: drop.y } : null, warnings: [] };
  }
  const spot = { kind: opening.kind, x, y };
  const { valid, problems } = checkOpening(shown.space, spot, others);
  // The same call as the pipeline's drop, so what the tip says is what the drop does.
  const drop = dropOpening(shown.space, spot, others, firstPourPeak(shown.placement, id, pipeline.run.silicone.t / 2));
  return {
    valid,
    problems,
    reason: refusalReason(problems, opening.kind),
    lands: drop.valid ? { x: drop.x, y: drop.y } : null,
    warnings: drop.valid ? drop.warnings : [],
  };
}
