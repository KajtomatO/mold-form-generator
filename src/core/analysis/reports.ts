import type { Field } from '../field/grid';
import type { Params } from '../params/schema';
import type { Rim } from '../parts/rim';
import { clampAdvice, coverLift, fillLevel, type ClampAdvice, type CoverLift } from '../report/clamp';
import type { Diagnostic } from '../report/diagnostics';
import { airReport, type AirReport } from './air';
import { cavityEdge, demoldReport, type CutHint, type DemoldReport, type Verdict, type Vec3 } from './demold';
import type { IntervalReport } from './intervals';
import type { UncoveredLeaf } from './placement';

/** What S9 reads besides the parameters. */
export interface ReportInputs {
  s8: IntervalReport;
  /** The conditioned composite: the preview's, or the export's own. */
  field: Field;
  /** The TIN tool's raise of the ceiling over H, for the tier the field is from. */
  raise: number;
  rim: Rim;
  tiles: number;
  /** From placement: the cover's ceiling peaks past the vent persistence, and those with no opening. */
  ceiling: { leaves: number; uncovered: UncoveredLeaf[] };
}

/** S9: the plan's geometry reports, on one tile as placement does. Every copy of a grid is the same. */
export interface GeometryReports {
  demold: DemoldReport;
  air: AirReport;
  lift: CoverLift;
  clamp: ClampAdvice;
  tiles: number;
  /** The middle of the first tile's model, which the hints' words measure from. */
  centre: [number, number];
  /** The verdict and the air traps, for Diagnostics and README.txt. */
  diagnostics: Diagnostic[];
}

/** Said after every air result. */
export const RISING = '(assuming the silicone rises slowly)';

const ml = (mm3: number): string => `${(mm3 / 1000).toFixed(mm3 < 1000 ? 2 : 1)} ml`;

/** The cover's lift and the tape that holds it, which need the field and the rim but no S8. */
export function tapeAdvice(params: Params, field: Field, raise: number, rim: Rim): { lift: CoverLift; clamp: ClampAdvice } {
  const lift = coverLift(field, raise, fillLevel(params, rim), params.silicone.density);
  return { lift, clamp: clampAdvice(lift.forceN, params.print.tapeStrip, [rim.O.x1 - rim.O.x0, rim.O.y1 - rim.O.y0]) };
}

export function geometryReports(params: Params, inputs: ReportInputs): GeometryReports {
  const { s8, field, raise, rim, tiles, ceiling } = inputs;
  const minVolume = params.reports.minVolumeMl * 1000;
  const demold = demoldReport(s8, { minVolume, minIsland: params.base.minIsland, outside: cavityEdge(field) });
  const air = airReport(s8, ceiling, { minVolume, minPersistence: params.reports.undersidePersistence });
  const { lift, clamp } = tapeAdvice(params, field, raise, rim);

  const extent = s8.shells.reduce((box, s) => [Math.min(box[0], s.min[0]), Math.min(box[1], s.min[1]), Math.max(box[2], s.max[0]), Math.max(box[3], s.max[1])], [Infinity, Infinity, -Infinity, -Infinity]);
  const centre: [number, number] = Number.isFinite(extent[0]) ? [(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2] : [0, 0];

  const diagnostics: Diagnostic[] = [verdictDiagnostic(demold)];
  for (const p of air.underside) {
    diagnostics.push({
      code: 'air-underside',
      severity: 'warning',
      at: [p.x, p.y, p.z],
      message: `Air stays under an overhang of the model, ${placeWords([p.x, p.y, p.z], centre)}, about ${ml(p.volume)}, where no vent in the top reaches: brush a first coat of silicone onto the model there, tilt the mold as you pour, or degas it in a vacuum ${RISING}.`,
    });
  }
  for (const d of air.sealed) {
    const at: Vec3 = [(d.min[0] + d.max[0]) / 2, (d.min[1] + d.max[1]) / 2, (d.min[2] + d.max[2]) / 2];
    // A hollow of the model is sealed whatever the pour does, so the rising level has nothing to do with it.
    const message = d.inModel
      ? `A sealed hollow of ${ml(d.volume)} inside the model, ${placeWords(at, centre)}: no silicone reaches it, and it is not counted as silicone.`
      : `A space of ${ml(d.volume)} under the model, ${placeWords(at, centre)}, is closed off between the model and the base, so no silicone goes there, which is harmless ${RISING}.`;
    diagnostics.push({ code: 'air-sealed', severity: 'info', at, message });
  }
  return { demold, air, lift, clamp, tiles, centre, diagnostics };
}

/**
 * The import's row on each void of the model says what S9's row on a sealed hollow says, in mm3 and with
 * no place to show, so it goes once S9 has found a hollow inside the model.
 */
export function withoutDoubledVoids<T extends Diagnostic>(list: T[], reports: Pick<GeometryReports, 'air'> | null): T[] {
  if (!reports?.air.sealed.some((d) => d.inModel)) return list;
  return list.filter((d) => d.code !== 'shell-void');
}

/** The verdict as one row, a warning only when cutting is expected. The pipeline gives its Show every hint. */
function verdictDiagnostic(demold: DemoldReport): Diagnostic {
  const first = demold.hints[0];
  const at = first ? { at: first.at } : {};
  switch (demold.verdict) {
    case 'plausible':
      return { code: 'demold-verdict', severity: 'info', message: 'Demold estimate: the model should pull out of the silicone while the silicone stays in the cover.' };
    case 'jacket-out':
      return { code: 'demold-verdict', severity: 'info', ...at, message: 'Demold estimate: slide the silicone out of the cover before you free the model, so it can stretch; the Demold report shows where it holds.' };
    default:
      return { code: 'demold-verdict', severity: 'warning', ...at, message: 'Demold estimate: the silicone will need cutting to free the model, at the places the Demold report marks Cut.' };
  }
}

/** The side of the silicone a seam starts from, as the view's default camera sees it: front is -y. */
function side(hint: CutHint): string | null {
  const dx = hint.seam[0][0] - hint.at[0], dy = hint.seam[0][1] - hint.at[1];
  if (Math.hypot(dx, dy) < 1e-6) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left' : 'right';
  return dy < 0 ? 'front' : 'back';
}

/** Where a point is, in a maker's words: its height, and how far it lies off the model's middle. */
export function placeWords(at: Vec3, centre: [number, number]): string {
  const parts = [`${Math.max(0, at[2]).toFixed(0)} mm up`];
  const dx = at[0] - centre[0], dy = at[1] - centre[1];
  if (Math.abs(dx) >= 1) parts.push(`${Math.abs(dx).toFixed(0)} mm ${dx < 0 ? 'left' : 'right'} of the middle`);
  if (Math.abs(dy) >= 1) parts.push(`${Math.abs(dy).toFixed(0)} mm to the ${dy < 0 ? 'front' : 'back'}`);
  if (parts.length === 1) parts.push('at the middle');
  return parts.join(', ');
}

/**
 * One hint as the Demold report and README.txt say it: what holds, where, and what to do there. Only
 * silicone that holds the model in a loop must be cut; elsewhere it can stretch off, and on a model that
 * should pull out in the cover it only needs flexing if the model holds.
 */
export function hintWords(hint: CutHint, centre: [number, number], verdict: Verdict): string {
  const what =
    hint.reason === 'loop-lock'
      ? `The model stands on the base in ${hint.footprints} separate places joined above them, so the silicone between them holds it in a loop`
      : hint.reason === 'under-plug'
        ? `${ml(hint.volume)} of silicone under an overhang`
        : hint.mouths >= 2
          ? `${ml(hint.volume)} of silicone through a hole in the model, open at ${hint.mouths} places`
          : hint.walls >= 2
            ? `${ml(hint.volume)} of silicone between parts of the model that are joined round it in ${hint.walls} places`
            : `${ml(hint.volume)} of silicone between parts of the model, open on one side`;
  const from = side(hint);
  const cutIn = from ? `cut in from the ${from} of the silicone to there` : 'cut it free there';
  const where = placeWords(hint.at, centre);
  if (hint.reason === 'loop-lock') return `${what}, ${where}: ${cutIn}.`;
  if (hint.cuts) return `${what}, ${where}: it holds the model in a loop there, so ${cutIn}.`;
  if (verdict === 'plausible') return `${what}, ${where}: flex the silicone there if the model holds.`;
  return `${what}, ${where}: stretch the silicone off the model there, or ${cutIn} if it would tear.`;
}

/** What each verdict asks of the maker, in the Demold report and README.txt. */
export const VERDICT_MEANING: Record<Verdict, string> = {
  plausible: 'The model should pull out of the silicone while the silicone stays in the cover.',
  'jacket-out': 'Slide the silicone out of the cover first, so it can stretch as you free the model.',
  'cut-required': 'Expect to cut the silicone to free the model where it holds the model in a loop: the places to cut come first below.',
};

/** The verdict in a few words, for the report's heading. */
export const VERDICT_WORDS: Record<Verdict, string> = {
  plausible: 'Pull out in the cover',
  'jacket-out': 'Silicone out first',
  'cut-required': 'Cutting needed',
};

/**
 * The D2 steps from the sprues to the finished mold, for the verdict: a model that should pull out
 * comes out with the base and the silicone stays in the cover; otherwise the silicone comes out of the
 * cover with the model in it, to stretch off or, where it holds in a loop, to cut. With no verdict, as
 * when the reports failed, the steps are those that work for any model.
 */
export function demoldSteps(verdict: Verdict | null, params: Params): string[] {
  const sprues = params.seat.enabled
    ? 'Cut the sprues: take out any funnels, cut each pour sprue at the floor of its seat, where the cone meets the straight bore, and cut the silicone in each vent flush with the top.'
    : 'Cut the silicone in each pour opening and each vent flush with the top.';
  const lever = `Take off the tape and lever the base out${params.joint.pryNotches ? ' at the pry notches on the bottom edge of the cover' : ''}`;
  const slide = `${lever}, and slide the silicone out of the cover with the model still in it. The cover widens towards the base, so the silicone slides out that way.`;
  const back = 'Put the silicone back into the cover, the way it came out. The cover holds it in shape.';
  switch (verdict) {
    case 'plausible':
      return [
        sprues,
        `${lever}, pulling the model out of the silicone with it, while the silicone stays in the cover.`,
        'If the model holds, slide the silicone out of the cover with the model in it, flex the silicone to free the model, and put the silicone back into the cover the way it came out.',
      ];
    case 'cut-required':
      return [sprues, slide, 'Cut the silicone with a sharp blade at the places to cut, in a wavy line so the cut faces line up again, then stretch it off the model where it still holds.', 'Take out the model.', back];
    default:
      return [sprues, slide, 'Stretch the silicone off the model where it holds. Cut it with a sharp blade, in a wavy line so the cut faces line up again, only where it would tear.', 'Take out the model.', back];
  }
}
