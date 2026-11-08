import type { Field } from '../field/grid';
import type { Params } from '../params/schema';
import type { Rim } from '../parts/rim';

/** Standard gravity, in m/s2. */
export const GRAVITY = 9.81;
/** Plan: clamp with at least this, in N, however light the lift. */
export const MIN_HOLD_N = 10;
/** Plan: and with at least twice the lift. */
const HOLD_FACTOR = 2;

/**
 * Where the liquid silicone stands at its highest: up to the rim of a full funnel when the mold has
 * funnel seats and funnels, as a maker may fill one to the brim, and otherwise at the flat top, where it
 * shows at the vents. The plan writes it Zf.
 */
export function fillLevel(params: Params, rim: Pick<Rim, 'Zt'>): number {
  return params.funnel.generate && params.seat.enabled ? rim.Zt + params.funnel.height : rim.Zt;
}

export interface CoverLift {
  /** Upward push of the liquid silicone on the cover, in N. */
  forceN: number;
  /** The level Zf it was worked out for, in mm. */
  level: number;
  /** The cavity's footprint the push acts on, in mm2. */
  area: number;
}

/**
 * The plan's cover lift: rho g times the integral of (Zf - H) over the cavity. The pressure under the
 * ceiling is the head of liquid above it, and only its upward part lifts the cover, which over a height
 * field is that head over the footprint. `raise` is the TIN tool's lift of the ceiling over H.
 */
export function coverLift(field: Field, raise: number, level: number, densityGcm3: number): CoverLift {
  const { values, cell } = field;
  let head = 0, nodes = 0;
  for (let n = 0; n < values.length; n++) {
    const h = values[n];
    if (h <= 0) continue;
    head += Math.max(0, level - (h + raise));
    nodes++;
  }
  const cellArea = cell * cell;
  // g/cm3 to kg/m3 is 1000, and mm3 to m3 is 1e-9.
  const forceN = densityGcm3 * 1000 * GRAVITY * head * cellArea * 1e-9;
  return { forceN, level, area: nodes * cellArea };
}

/**
 * A strip of tape presses the seal where it crosses the joint, so strips go no further apart than this
 * along a wall, in mm, and the seal is pressed all round. An estimate: tapes and seals differ.
 */
export const SEAL_SPACING_MM = 100;

export interface ClampAdvice {
  /** What the tape must hold, in N: max(2 x lift, 10 N). */
  holdN: number;
  /** Strips the lift alone needs, at `stripN` each. */
  liftStrips: number;
  /**
   * At least this many strips each way across the base, front to back and left to right, each from a
   * side wall to the opposite one, so that no two are more than SEAL_SPACING_MM apart along a wall.
   */
  across: [number, number];
  /** Strips in all: what the lift needs, or what the seal needs if that is more. */
  strips: number;
  stripN: number;
}

/** Plan: tape that holds max(2 x lift, 10 N) in strips, and enough of them to press the seal all round the box. */
export function clampAdvice(liftN: number, stripN: number, box: [number, number]): ClampAdvice {
  const holdN = Math.max(HOLD_FACTOR * liftN, MIN_HOLD_N);
  const liftStrips = stripN > 0 ? Math.ceil(holdN / stripN - 1e-9) : 0;
  // A strip from front to back presses the front and back walls at one place along them.
  const across: [number, number] = [Math.max(1, Math.ceil(box[0] / SEAL_SPACING_MM - 1e-9)), Math.max(1, Math.ceil(box[1] / SEAL_SPACING_MM - 1e-9))];
  return { holdN, liftStrips, across, strips: Math.max(liftStrips, across[0] + across[1]), stripN };
}
