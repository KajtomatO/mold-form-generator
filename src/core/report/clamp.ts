import type { Field } from '../field/grid';
import type { Params } from '../params/schema';
import { lengthFits, type BoltLayout } from '../parts/bolts';
import type { ClipLayout } from '../parts/clips';
import { BOLT_HOLD_N, CLIP_HOLD_N } from '../parts/fasteners';
import type { Rim } from '../parts/rim';
import type { SeamBoltLayout } from '../parts/seamBolts';
import type { Diagnostic } from './diagnostics';

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

/** M10: the bolts in place of the tape count, and the tape they still need. */
export interface BoltAdvice {
  count: number;
  size: BoltLayout['size'];
  length: number;
  /** What the tape would have to hold, max(2 x lift, 10 N), and what the bolts hold together, at BOLT_HOLD_N each. */
  holdN: number;
  boltsHoldN: number;
  /** From one bolt's axis to the next along x and along y, in mm. */
  spans: [number, number];
  /**
   * Strips of tape across the middle, front to back and left to right, where bolts at the corners stand
   * further apart than SEAL_SPACING_MM, as a printed plate bends between them.
   */
  middle: [number, number];
  /** Strips the lift needs past what the bolts hold. */
  liftStrips: number;
  /** Strips in all: the middle's, or the lift's if that is more. */
  strips: number;
  stripN: number;
  /** The screw length in use passes its nut and stops under the flat top; a screw that does not fit holds nothing to count on. */
  lengthFits: boolean;
  /** Four bolts do it alone: they fit, they hold the lift, and no wall is longer than the spacing between them. */
  enough: boolean;
}

/**
 * Bolts at the corners press the seal where they stand, as a strip of tape does where it crosses the joint,
 * so between them the same spacing holds as for tape: past it, the plate bends and the seal opens.
 */
export function boltAdvice(liftN: number, stripN: number, bolts: BoltLayout): BoltAdvice {
  const holdN = Math.max(HOLD_FACTOR * liftN, MIN_HOLD_N);
  const xs = bolts.spots.map((s) => s.x), ys = bolts.spots.map((s) => s.y);
  const spans: [number, number] = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
  // A strip from front to back presses the front and back walls, which run along x.
  const middle: [number, number] = [Math.max(0, Math.ceil(spans[0] / SEAL_SPACING_MM - 1e-9) - 1), Math.max(0, Math.ceil(spans[1] / SEAL_SPACING_MM - 1e-9) - 1)];
  const boltsHoldN = bolts.spots.length * BOLT_HOLD_N;
  const liftStrips = holdN > boltsHoldN && stripN > 0 ? Math.ceil((holdN - boltsHoldN) / stripN - 1e-9) : 0;
  const strips = Math.max(middle[0] + middle[1], liftStrips);
  const fits = lengthFits(bolts);
  return { count: bolts.spots.length, size: bolts.size, length: bolts.length, holdN, boltsHoldN, spans, middle, liftStrips, strips, stripN, lengthFits: fits, enough: fits && strips === 0 };
}

// ----- G13.9 and G13.10.7: the two-part cover's forces -----

/** liquid density in g/cm3 times g, in N per mm3 of head times mm2 of area. */
const pressure = (densityGcm3: number): number => densityGcm3 * 1000 * GRAVITY * 1e-9;

/** One side's rows of cavity in a fine side field: G past the seam's h, at v >= 0, v = 0 at half weight as G13.3's score. */
function sideRowsOf(field: Field, hs: number, raise: number, visit: (depth: number, z: number, weight: number, j: number) => void): void {
  const { nx, ny, cell, values } = field;
  const jFloor = Math.round(-field.y0 / cell);
  for (let j = jFloor; j < ny; j++) {
    const z = (j - jFloor) * cell, w = j === jFloor ? 0.5 : 1;
    for (let i = 0, n = j * nx; i < nx; i++, n++) {
      const g = values[n];
      if (g > hs) visit(g + raise - hs, z, w, j);
    }
  }
}

export interface HalfForces {
  /** F_side: the liquid's push on this half along its pull, rho g times the sum of (Zf - z) cell2 over its cavity rows, in N. */
  sideN: number;
  /** Net lift: rho g (Zf A0 - V), with A0 the half's cavity at z = 0 and V its volume, in N. Negative pushes it down. */
  liftN: number;
  /** The half's cavity, in mm3, with the tool's raise. */
  volume: number;
  /** Its cavity rows on P, in mm2. */
  seamArea: number;
}

/**
 * G13.9's forces on one half from its fine side field. The side push is the head on the cavity's shadow on P. The net
 * lift is the upward part of the pressure on the half's ceilings, less the downward part on its floors: per column of
 * b, integrating (Zf - z)(-dR/dz) by parts gives Zf times the cavity's depth at z = 0 less the column's cavity area, so
 * over the half it is Zf A0 - V, as the one-piece's lift is Zf A - V over its footprint.
 */
export function halfForces(field: Field, hs: number, raise: number, level: number, densityGcm3: number): HalfForces {
  const cell2 = field.cell * field.cell;
  const jFloor = Math.round(-field.y0 / field.cell);
  let head = 0, volume = 0, floor = 0, rows = 0;
  sideRowsOf(field, hs, raise, (depth, z, w, j) => {
    head += w * Math.max(0, level - z);
    volume += w * depth;
    rows += w;
    if (j === jFloor) floor += depth;
  });
  const rho = pressure(densityGcm3);
  return { sideN: rho * head * cell2, liftN: rho * (level * floor * field.cell - volume * cell2), volume: volume * cell2, seamArea: rows * cell2 };
}

/**
 * The chamfer distance's (1, sqrt 2) steps read at most this times the Euclidean one, 1 / cos(22.5 degrees), on a
 * line half way between an axis and a diagonal.
 */
const CHAMFER_OVER = 1 / Math.cos(Math.PI / 8);

/**
 * G13.9's worst case, a film over the seam face out to the band: the same head summed over E_in, which G13.8 builds as
 * offset(closing(S, 3 mm), seamLand) with the joint's rectangle J and its holes filled. Here it is taken on the lattice
 * as S grown by 1.5 mm + seamLand, which holds that offset, with J's rows and the holes filled. The growth is read on
 * a chamfer distance, which reads up to CHAMFER_OVER long, so the face takes every node within that much of the
 * growth plus a cell, and holds every node a Euclidean offset would. `seam` is S as a mask over (b, z) rows at z >= 0,
 * `cell` apart from z = 0; J reaches `jointB` across b up to `jointZ`.
 */
export function filmPush(seam: Uint8Array, nb: number, nz: number, cell: number, seamLand: number, jointB: [number, number] | null, jointZ: number, level: number, densityGcm3: number): number {
  const grow = (1.5 + seamLand) * CHAMFER_OVER + cell;
  // Chamfer distance to S, in mm, and the face within `grow` of it.
  const dist = new Float32Array(nb * nz).fill(Infinity);
  for (let n = 0; n < seam.length; n++) if (seam[n]) dist[n] = 0;
  const s = cell, d = cell * Math.SQRT2;
  for (let z = 0; z < nz; z++) {
    for (let b = 0, n = z * nb; b < nb; b++, n++) {
      let v = dist[n];
      if (b > 0) v = Math.min(v, dist[n - 1] + s);
      if (z > 0) {
        v = Math.min(v, dist[n - nb] + s);
        if (b > 0) v = Math.min(v, dist[n - nb - 1] + d);
        if (b < nb - 1) v = Math.min(v, dist[n - nb + 1] + d);
      }
      dist[n] = v;
    }
  }
  for (let z = nz - 1; z >= 0; z--) {
    for (let b = nb - 1, n = b + z * nb; b >= 0; b--, n--) {
      let v = dist[n];
      if (b < nb - 1) v = Math.min(v, dist[n + 1] + s);
      if (z < nz - 1) {
        v = Math.min(v, dist[n + nb] + s);
        if (b < nb - 1) v = Math.min(v, dist[n + nb + 1] + d);
        if (b > 0) v = Math.min(v, dist[n + nb - 1] + d);
      }
      dist[n] = v;
    }
  }
  const face = new Uint8Array(nb * nz);
  for (let n = 0; n < face.length; n++) face[n] = dist[n] <= grow + 1e-9 ? 1 : 0;
  if (jointB) {
    for (let z = 0; z * cell <= jointZ + 1e-9 && z < nz; z++) for (let b = Math.max(0, Math.ceil(jointB[0] / cell - 1e-9)); b <= Math.min(nb - 1, Math.floor(jointB[1] / cell + 1e-9)); b++) face[b + z * nb] = 1;
  }
  // Holes filled: what the outside cannot reach through the face's complement is face too. The bottom row opens
  // onto the base, not the outside, so the flood starts from the other three sides.
  const outside = new Uint8Array(nb * nz);
  const stack: number[] = [];
  const seed = (n: number): void => {
    if (!face[n] && !outside[n]) {
      outside[n] = 1;
      stack.push(n);
    }
  };
  for (let b = 0; b < nb; b++) seed(b + (nz - 1) * nb);
  for (let z = 0; z < nz; z++) {
    seed(z * nb);
    seed(nb - 1 + z * nb);
  }
  while (stack.length > 0) {
    const n = stack.pop()!;
    const b = n % nb, z = (n - b) / nb;
    if (b > 0) seed(n - 1);
    if (b < nb - 1) seed(n + 1);
    if (z > 0) seed(n - nb);
    if (z < nz - 1) seed(n + nb);
  }
  let head = 0;
  for (let z = 0; z < nz; z++) {
    const w = z === 0 ? 0.5 : 1;
    for (let b = 0, n = z * nb; b < nb; b++, n++) if (!outside[n]) head += w * Math.max(0, level - z * cell);
  }
  return pressure(densityGcm3) * head * cell * cell;
}

/** G13.10.7: what the seam fasteners must hold, max(2 max over the halves of (F_side, the film's worst case), MIN_HOLD_N). */
export function seamHoldN(sideN: readonly number[], filmN: number): number {
  return Math.max(HOLD_FACTOR * Math.max(...sideN, filmN), MIN_HOLD_N);
}

/**
 * G13.9's base tape for the halves: clampAdvice unchanged on their summed lift, with at least one strip per half each
 * way. A strip across the seam's axis presses one half only, so that way takes two.
 */
export function halvesTape(liftN: readonly number[], stripN: number, box: [number, number], axis: 'x' | 'y'): ClampAdvice {
  const plain = clampAdvice(Math.max(0, liftN.reduce((s, v) => s + v, 0)), stripN, box);
  const across: [number, number] = [...plain.across];
  // across[0] counts the strips from front to back, which stand at one x each; with an x seam each lies under one half.
  const k = axis === 'x' ? 0 : 1;
  across[k] = Math.max(across[k], 2);
  return { ...plain, across, strips: Math.max(plain.liftStrips, across[0] + across[1]) };
}

/** G13.9's taper wedge: the base tape's pull, held by clampAdvice, times 1 / tan(taper), pushing the halves apart at the bottom. */
export function wedgeN(tape: Pick<ClampAdvice, 'holdN'>, taperDeg: number): number {
  return tape.holdN / Math.tan((taperDeg * Math.PI) / 180);
}

/** G13.10.7: the top span, O's extent across b at the top, has no fastener; past SEAL_SPACING_MM README.txt advises one clamp. */
export function topSpanOf(rim: Pick<Rim, 'O'>, axis: 'x' | 'y'): number {
  return axis === 'x' ? rim.O.y1 - rim.O.y0 : rim.O.x1 - rim.O.x0;
}

/** G13.10's hold with seam bolts: what they count against what the seam needs, the wedge, and the top span. */
export interface SeamBoltAdvice {
  size: SeamBoltLayout['size'];
  length: number;
  count: number;
  perEnd: number;
  /** holdN_seam, and what the bolts hold at BOLT_HOLD_N each. */
  holdN: number;
  boltsHoldN: number;
  /** The taper wedge, and what the bottom pair is counted at against it. */
  wedgeN: number;
  bottomHoldN: number;
  topSpan: number;
  topClamp: boolean;
  lengthFits: boolean;
  diagnostics: Diagnostic[];
}

/** G13.10.7's checks on placed seam bolts: `seam-bolt-wedge` past the bottom pair's 100 N, `seam-top-span` past the spacing. */
export function seamBoltAdvice(layout: SeamBoltLayout, holdN: number, wedge: number, topSpan: number): SeamBoltAdvice {
  const boltsHoldN = layout.count * BOLT_HOLD_N;
  const bottomHoldN = 2 * BOLT_HOLD_N;
  const diagnostics: Diagnostic[] = [];
  if (layout.count > 0 && wedge > bottomHoldN + 1e-9) {
    diagnostics.push({ code: 'seam-bolt-wedge', severity: 'info', message: `Taping the base pushes the halves apart at the bottom with up to ${wedge.toFixed(0)} N, more than the ${bottomHoldN} N the bottom seam bolts are counted at: after taping, check that the seam is closed at the bottom edge.` });
  }
  const topClamp = topSpan > SEAL_SPACING_MM + 1e-9;
  if (topClamp) diagnostics.push(topSpanNote(topSpan));
  return { size: layout.size, length: layout.length, count: layout.count, perEnd: layout.perEnd, holdN, boltsHoldN, wedgeN: wedge, bottomHoldN, topSpan, topClamp, lengthFits: layout.lengthFits, diagnostics };
}

/** G13.10.17: the friction the taper wedge's second figure is read at, PLA on PLA. */
export const WEDGE_MU = 0.2;

/** The taper wedge with friction mu on the taper's faces: the tape's pull times (1 - mu tan) / (tan + mu). */
export function wedgeWithFriction(tape: Pick<ClampAdvice, 'holdN'>, taperDeg: number, mu: number): number {
  const t = Math.tan((taperDeg * Math.PI) / 180);
  return (tape.holdN * (1 - mu * t)) / (t + mu);
}

/** G13.10.17's hold with seam clips: what the keys count against what the seam needs, the wedge on the bottom, and the top span. */
export interface ClipAdvice {
  rows: number;
  count: number;
  spares: number;
  /** CLIP_HOLD_N a key, the keys together, and holdN_seam. */
  clipHoldN: number;
  clipsHoldN: number;
  holdN: number;
  /** The bottom row's keys, with the second bottom row's where it fits, at CLIP_HOLD_N each. */
  bottomHoldN: number;
  /** The taper wedge, frictionless and at WEDGE_MU. */
  wedgeN: { frictionless: number; mu02: number };
  topSpan: number;
  topClamp: boolean;
  diagnostics: Diagnostic[];
}

/**
 * G13.10.17's checks on placed clips: `clips-wedge` where the frictionless wedge is over half what the bottom's keys are
 * counted at (4 keys with the second bottom row, 2 without), and `seam-top-span` past the spacing. `spares` is the
 * plate's (SPARES in parts/clips.ts).
 */
export function clipAdvice(layout: Pick<ClipLayout, 'placed' | 'count'>, holdN: number, tape: Pick<ClampAdvice, 'holdN'>, taperDeg: number, topSpan: number, spares: number): ClipAdvice {
  const rows = layout.placed.length;
  const bottomKeys = rows === 0 ? 0 : layout.placed.some((row) => row.kind === 'second') ? 4 : 2;
  const bottomHoldN = bottomKeys * CLIP_HOLD_N;
  const wedge = { frictionless: wedgeN(tape, taperDeg), mu02: wedgeWithFriction(tape, taperDeg, WEDGE_MU) };
  const diagnostics: Diagnostic[] = [];
  if (rows > 0 && wedge.frictionless > bottomHoldN / 2 + 1e-9) {
    diagnostics.push({ code: 'clips-wedge', severity: 'info', also: ['clamshell.fastener'], message: `Taping the base pushes the halves apart at the bottom with up to ${wedge.frictionless.toFixed(0)} N, over half the ${bottomHoldN} N the ${bottomKeys} bottom clips are counted at: after taping, check that the seam is closed at the bottom edge, or set Seam fasteners to Bolts.` });
  }
  const topClamp = topSpan > SEAL_SPACING_MM + 1e-9;
  if (topClamp) diagnostics.push(topSpanNote(topSpan));
  return { rows, count: layout.count, spares, clipHoldN: CLIP_HOLD_N, clipsHoldN: layout.count * CLIP_HOLD_N, holdN, bottomHoldN, wedgeN: wedge, topSpan, topClamp, diagnostics };
}

/** G13.10.7's info line on a wide half, with bolts or clips alike. */
export function topSpanNote(topSpan: number): Diagnostic {
  return { code: 'seam-top-span', severity: 'info', message: `These halves are ${topSpan.toFixed(0)} mm wide at the top, where nothing holds the seam: put one clamp across the two back faces at the middle of the seam, 10 mm under the top, with a flat board or ruler under each jaw.` };
}

/** G13.10.9: the width a tape belt is counted at, in mm, a common roll's. */
export const BELT_WIDTH = 25;
/** G13.10.9: a belt overlaps itself by at least this, in mm. */
export const BELT_OVERLAP = 50;
/** G13.10.9: the top belt, like the top clamp, sits this far under the top, in mm. */
export const BELT_UNDER_TOP = 10;

export interface Belts {
  count: number;
  /** Each belt's lower edge, the lowest at the cover's bottom edge. */
  bottoms: number[];
  holdN: number;
}

/**
 * G13.10.9, Seam fasteners None: tape belts round all four walls, max(2, ceil(holdN / (2 tapeStrip))), raised until no two
 * are more than SEAL_SPACING_MM apart, the lowest's lower edge at the cover's bottom edge and the highest's upper edge
 * BELT_UNDER_TOP under the top.
 */
export function seamBelts(holdN: number, tapeStripN: number, coverBottom: number, Zt: number): Belts {
  let count = Math.max(2, tapeStripN > 0 ? Math.ceil(holdN / (2 * tapeStripN) - 1e-9) : 2);
  const span = Math.max(0, Zt - BELT_UNDER_TOP - BELT_WIDTH - coverBottom);
  while (span / (count - 1) > SEAL_SPACING_MM + 1e-9) count++;
  const bottoms = Array.from({ length: count }, (_, k) => coverBottom + (k * span) / (count - 1));
  return { count, bottoms, holdN };
}
