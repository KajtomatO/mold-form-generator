import type { Params } from '../params/schema';
import type { Rim } from '../parts/rim';
import type { Diagnostic } from './diagnostics';

/** A printed part's box in its print pose, in mm: footprint on the bed, then height. */
export interface PartBox {
  part: 'cover' | 'base';
  size: [number, number, number];
}

/**
 * The cover prints flat top down from Zt to its bottom edge, and the base flat underside down, up to the
 * top of its ridge, or in Mode B up to the top of the model built onto it. The base is widest just above
 * its bed relief, where the taper has spread it most. `modelTop` is the model's height over the plane.
 */
export function partBoxes(rim: Rim, mode: Params['base']['mode'] = 'glue', modelTop = 0): PartBox[] {
  const coverHeight = rim.Zt + rim.Tb - rim.proud;
  const spread = 2 * (rim.Tb - rim.reliefHeight) * rim.tanTaper;
  const baseHeight = rim.Tb + (mode === 'merged' ? Math.max(rim.ridgeHeight, modelTop) : rim.ridgeHeight);
  return [
    { part: 'cover', size: [rim.O.x1 - rim.O.x0, rim.O.y1 - rim.O.y0, coverHeight] },
    { part: 'base', size: [rim.B.x1 - rim.B.x0 + spread, rim.B.y1 - rim.B.y0 + spread, baseHeight] },
  ];
}

/** Turns tried on the bed, in degrees, from straight to a quarter turn, which is the other way round. */
const TURN_STEP = 0.25;

/**
 * How a box goes on the bed: straight, either way round (turn 0), turned about the vertical axis by
 * the angle in degrees that leaves it the most room, or not at all (null). A rectangle's bounding box
 * turned by an angle is a cos + b sin by a sin + b cos, so a short search over the angles is exact to
 * within its step.
 */
export function bedTurn(size: [number, number, number], bed: [number, number, number]): number | null {
  const [a, b, h] = size;
  const [x, y, z] = bed;
  if (h > z) return null;
  if ((a <= x && b <= y) || (a <= y && b <= x)) return 0;
  let best: number | null = null, room = -Infinity;
  for (let deg = TURN_STEP; deg < 90; deg += TURN_STEP) {
    const t = (deg * Math.PI) / 180;
    const w = a * Math.cos(t) + b * Math.sin(t), d = a * Math.sin(t) + b * Math.cos(t);
    const slack = Math.min(x - w, y - d);
    if (slack >= 0 && slack > room) {
      room = slack;
      best = deg;
    }
  }
  return best === null ? null : Math.min(best, 90 - best);
}

/** Whether a box fits the bed, turned on it in any way about the vertical axis. */
export function fitsBed(size: [number, number, number], bed: [number, number, number]): boolean {
  return bedTurn(size, bed) !== null;
}

const dims = (v: number[]): string => v.map((d) => d.toFixed(1)).join(' x ');

/** What the printability checks read besides the parameters and the rim. */
export interface PrintLayout {
  /** The tiles' offsets, so a grid too big for the bed can say that one copy would fit. */
  offsets: [number, number][];
  /** The model's height over the plane, which Mode B's base carries. */
  modelTop: number;
}

/**
 * Plan: a part larger than the bed, and a ridge narrower than two lines of the nozzle. Pure arithmetic
 * on the rim, so main works it out for the state on screen, apart from the reports.
 */
export function printabilityDiagnostics(params: Params, rim: Rim, layout: PrintLayout): Diagnostic[] {
  const { bedX, bedY, bedZ, nozzle } = params.print;
  const bed: [number, number, number] = [bedX, bedY, bedZ];
  const out: Diagnostic[] = [];
  // One tile's parts are the grid's less the span between the first copy and the last.
  const span = (axis: 0 | 1): number => (layout.offsets.length > 0 ? Math.max(...layout.offsets.map((o) => o[axis])) - Math.min(...layout.offsets.map((o) => o[axis])) : 0);
  const spanX = span(0), spanY = span(1);
  for (const { part, size } of partBoxes(rim, params.base.mode, layout.modelTop)) {
    const turn = bedTurn(size, bed);
    if (turn === 0) continue;
    const name = part === 'cover' ? 'The cover' : 'The base';
    const said = `${name} is ${dims(size)} mm as it prints`;
    if (turn !== null) {
      out.push({ code: 'bed-turn', severity: 'warning', message: `${said}, which fits the ${dims(bed)} mm bed set under Advanced, Printer, only turned about ${Math.round(turn)} degrees on it: rotate it about the vertical axis in your slicer, and do not lay it on another side.` });
      continue;
    }
    const grid = spanX > 0 || spanY > 0;
    const one: [number, number, number] = [size[0] - spanX, size[1] - spanY, size[2]];
    if (grid && bedTurn(one, bed) !== null) {
      out.push({ code: 'bed-too-small', severity: 'warning', also: ['grid.nx', 'grid.ny'], message: `${said}, which does not fit the ${dims(bed)} mm bed set under Advanced, Printer, even turned on it. One copy alone would fit, so use fewer copies under Grid, or a larger bed.` });
    } else {
      out.push({ code: 'bed-too-small', severity: 'warning', message: `${said}, which does not fit the ${dims(bed)} mm bed set under Advanced, Printer, even turned on it: it needs a larger bed${grid ? ', fewer copies' : ''} or a smaller model.` });
    }
  }
  const { ridgeWidth } = params.joint;
  if (ridgeWidth < 2 * nozzle) {
    out.push({ code: 'ridge-narrow', severity: 'warning', message: `The ridge is ${ridgeWidth} mm wide, narrower than two ${nozzle} mm lines of the nozzle, so it may print thin or broken.` });
  }
  return out;
}

/** A part's solid volume and surface, in mm3 and mm2, and how many of it the mold needs. */
export interface PartAmount {
  volume: number;
  area: number;
  count: number;
}

export interface PlasticEstimate {
  /** In g, printed solid. */
  solid: number;
  /** In g, at the set infill with solid walls. */
  printed: number;
}

/** README.txt asks for at least 3 walls, so that much of every surface prints solid whatever the infill. */
const SOLID_WALL_LINES = 3;

/**
 * Plan: the plastic from the parts' volumes, the infill and the plastic's density. A slicer prints the
 * skin of each part solid and fills the rest at the infill, so the skin is taken as three lines of the
 * nozzle over the whole surface. An estimate: slicers differ.
 */
export function plasticEstimate(parts: PartAmount[], params: Params): PlasticEstimate {
  const gramsPerMm3 = params.print.density / 1000;
  const skin = SOLID_WALL_LINES * params.print.nozzle;
  const infill = Math.min(1, Math.max(0, params.print.infill));
  let solid = 0, printed = 0;
  for (const { volume, area, count } of parts) {
    const shell = Math.min(volume, area * skin);
    solid += volume * count;
    printed += (shell + infill * (volume - shell)) * count;
  }
  return { solid: solid * gramsPerMm3, printed: printed * gramsPerMm3 };
}

/** The common spool, in g. A print that takes more needs a second one, so the plastic row warns. */
export const SPOOL_G = 1000;

/** The plastic as one row of Diagnostics and of README.txt: a warning once the print takes more than a spool. */
export function plasticDiagnostic(estimate: PlasticEstimate, params: Params): Diagnostic {
  const grams = (g: number): string => (g >= 1000 ? `${(g / 1000).toFixed(2)} kg` : `${g.toFixed(0)} g`);
  const amount = `about ${grams(estimate.printed)} of plastic at ${Math.round(params.print.infill * 100)} percent infill, or ${grams(estimate.solid)} printed solid, as an estimate at ${params.print.density} g/cm3`;
  if (estimate.printed > SPOOL_G) {
    return { code: 'plastic-mass', severity: 'warning', message: `The printed parts take ${amount}: more than a ${grams(SPOOL_G)} spool, so have enough plastic ready.` };
  }
  return { code: 'plastic-mass', severity: 'info', message: `The printed parts take ${amount}.` };
}
