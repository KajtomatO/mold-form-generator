import type { Field } from '../field/grid';
import type { Params } from '../params/schema';
import { funnelProfile } from '../parts/funnelProfile';
import { seatTopRadius, ventTopRadius } from '../parts/openings';
import type { Rim } from '../parts/rim';
import type { Diagnostic } from '../report/diagnostics';
import type { Rect } from '../solid/rect';
import { distanceToOutside } from './distance';

export type OpeningKind = 'pour' | 'vent';

/** Plan G11: an opening needs this much cavity ceiling under all of its disc, in mm. */
export const MIN_CEILING = 1;
/** Plan G11: past these a bore is long enough to say so. */
export const LONG_VENT_RATIO = 40;
export const LONG_POUR_MM = 60;
/** Room to keep between two funnel rims when suggesting a size, in mm. */
const FUNNEL_GAP = 1;

/** Everything about an opening's size that placement and validation need. */
export interface OpeningSizes {
  pourDiameter: number;
  ventDiameter: number;
  /** 0 with the seat off. */
  seatDepth: number;
  seatHalfAngleDeg: number;
  minLand: number;
  /** Top diameter of the funnel, or null when none is generated. */
  funnelTop: number | null;
  /** The smallest top diameter a funnel can have on this seat. */
  funnelMinTop: number;
}

export function openingSizes(params: Params): OpeningSizes {
  return {
    pourDiameter: params.pour.diameter,
    ventDiameter: params.vents.diameter,
    seatDepth: params.seat.enabled ? params.seat.depth : 0,
    seatHalfAngleDeg: params.seat.halfAngleDeg,
    minLand: params.pour.minLand,
    funnelTop: params.funnel.generate && params.seat.enabled ? params.funnel.topDiameter : null,
    funnelMinTop: Math.max(params.pour.diameter + 2 * params.funnel.wall, 2 * funnelProfile(params).rNeck),
  };
}

export function boreRadius(sizes: OpeningSizes, kind: OpeningKind): number {
  return (kind === 'pour' ? sizes.pourDiameter : sizes.ventDiameter) / 2;
}

/** Radius of an opening at the flat top, where it is widest. */
export function topRadius(sizes: OpeningSizes, kind: OpeningKind): number {
  if (kind === 'vent') return ventTopRadius(sizes.ventDiameter);
  return seatTopRadius({ diameter: sizes.pourDiameter, seatDepth: sizes.seatDepth, seatHalfAngleDeg: sizes.seatHalfAngleDeg });
}

/** Where an opening is, in the coordinates of the first tile. Its copies follow from the tile offsets. */
export interface OpeningSpot {
  kind: OpeningKind;
  x: number;
  y: number;
}

/**
 * The plain inputs of validation. The rim comes from analytic bounds and openings never feed back
 * into it, so dragging cannot resize the box. Build one per field and keep it: it holds the distance
 * map once a snap has asked for it.
 */
export interface PlacementSpace {
  /** The conditioned composite. */
  field: Field;
  O: Rect;
  Zt: number;
  wall: number;
  sizes: OpeningSizes;
  offsets: [number, number][];
  /** The tile lattice, read from the offsets. */
  tilesX: number;
  tilesY: number;
  pitchX: number;
  pitchY: number;
  /** Per node, the distance in mm to the nearest node with too little ceiling. Filled by the first snap. */
  clearance: Float32Array | null;
  /** The box of the first tile's nodes each kind's disc can fit on, or null if none. Filled along with it. */
  fits: Partial<Record<OpeningKind, Rect | null>>;
}

export function placementSpace(field: Field, rim: Pick<Rim, 'O' | 'Zt' | 'wall'>, offsets: [number, number][], sizes: OpeningSizes): PlacementSpace {
  const tilesX = offsets.filter(([, y]) => y === 0).length;
  const tilesY = offsets.length / tilesX;
  return {
    field,
    O: rim.O,
    Zt: rim.Zt,
    wall: rim.wall,
    sizes,
    offsets,
    tilesX,
    tilesY,
    pitchX: tilesX > 1 ? offsets[1][0] : 0,
    pitchY: tilesY > 1 ? offsets[tilesX][1] : 0,
    clearance: null,
    fits: {},
  };
}

/**
 * The lowest ceiling a disc can meet, which is zb. A circle cuts through grid squares, and the surface
 * between nodes runs down to the lowest corner of its square, so the nodes one square diagonal past the
 * rim count as well. On a steep wall the bare disc would read high, and the bore's flat end would then
 * leave a sliver of plastic under it. Off the grid there is no cavity, so that reads 0.
 */
export function discMinimum(field: Field, x: number, y: number, radius: number): number {
  const { nx, ny, cell, x0, y0, values } = field;
  const reach = radius + cell * Math.SQRT2;
  const jLow = Math.ceil((y - reach - y0) / cell), jHigh = Math.floor((y + reach - y0) / cell);
  const iLow = Math.ceil((x - reach - x0) / cell), iHigh = Math.floor((x + reach - x0) / cell);
  if (iLow < 0 || jLow < 0 || iHigh >= nx || jHigh >= ny) return 0;
  let lowest = Infinity;
  for (let j = jLow; j <= jHigh; j++) {
    const dy = y0 + j * cell - y;
    const span = reach * reach - dy * dy;
    if (span < 0) continue;
    const half = Math.sqrt(span);
    const from = Math.max(iLow, Math.ceil((x - half - x0) / cell));
    const to = Math.min(iHigh, Math.floor((x + half - x0) / cell));
    for (let i = from, n = from + j * nx; i <= to; i++, n++) if (values[n] < lowest) lowest = values[n];
  }
  return lowest === Infinity ? 0 : Math.max(lowest, 0);
}

/** H between nodes, as the tool's surface follows it. 0 off the grid. */
export function heightAt(field: Field, x: number, y: number): number {
  const { nx, ny, cell, x0, y0, values } = field;
  const u = (x - x0) / cell, v = (y - y0) / cell;
  const i = Math.floor(u), j = Math.floor(v);
  if (i < 0 || j < 0 || i + 1 >= nx || j + 1 >= ny) return 0;
  const fu = u - i, fv = v - j, n = i + j * nx;
  const low = values[n] + (values[n + 1] - values[n]) * fu;
  const high = values[n + nx] + (values[n + nx + 1] - values[n + nx]) * fu;
  return Math.max(low + (high - low) * fv, 0);
}

export type HardProblem = 'off-cavity' | 'land' | 'top-edge';

export interface OpeningCheck {
  valid: boolean;
  problems: HardProblem[];
  /** Lowest ceiling under the disc, over all copies. */
  zb: number;
}

/** How near the closest copy of `b` comes to `a`, which may be the same opening at another tile. */
export function nearestCopy(space: PlacementSpace, ax: number, ay: number, bx: number, by: number): number {
  const { tilesX, tilesY, pitchX, pitchY } = space;
  const along = (delta: number, pitch: number, tiles: number): number => {
    if (tiles === 1) return delta;
    // Copies of b sit at -(tiles-1)..(tiles-1) pitches from a's own tile, seen from any copy of a.
    const k = Math.max(-(tiles - 1), Math.min(tiles - 1, Math.round(delta / pitch)));
    return delta - k * pitch;
  };
  return Math.hypot(along(ax - bx, pitchX, tilesX), along(ay - by, pitchY, tilesY));
}

/** The copies of one opening stand this far apart at the closest, or Infinity with one tile. */
export function selfCopyDistance(space: PlacementSpace): number {
  return Math.min(space.tilesX > 1 ? space.pitchX : Infinity, space.tilesY > 1 ? space.pitchY : Infinity);
}

/** A rectangle holding every position whose copies all stay inside the top by `wall`. It can be empty. */
function topRect(space: PlacementSpace, kind: OpeningKind): Rect {
  const { O, wall, sizes, tilesX, tilesY, pitchX, pitchY } = space;
  const inset = wall + topRadius(sizes, kind);
  return {
    x0: O.x0 + inset,
    y0: O.y0 + inset,
    x1: O.x1 - inset - (tilesX - 1) * pitchX,
    y1: O.y1 - inset - (tilesY - 1) * pitchY,
  };
}

function landOk(space: PlacementSpace, spot: OpeningSpot, others: readonly OpeningSpot[]): boolean {
  const { sizes } = space;
  const own = topRadius(sizes, spot.kind);
  if (selfCopyDistance(space) < 2 * own + sizes.minLand) return false;
  for (const other of others) {
    if (other === spot) continue;
    if (nearestCopy(space, spot.x, spot.y, other.x, other.y) < own + topRadius(sizes, other.kind) + sizes.minLand) return false;
  }
  return true;
}

/**
 * The plan's hard rules, on every copy of the opening, each against every copy of the others: at least
 * 1 mm of ceiling under the disc, the land to other openings, and the seat inside the top by a wall.
 * It reads no solid and only the nodes under the disc, so a drag can call it on the main thread.
 */
export function checkOpening(space: PlacementSpace, spot: OpeningSpot, others: readonly OpeningSpot[]): OpeningCheck {
  const problems: HardProblem[] = [];
  const r = boreRadius(space.sizes, spot.kind);
  let zb = Infinity;
  for (const [ox, oy] of space.offsets) {
    const here = discMinimum(space.field, spot.x + ox, spot.y + oy, r);
    if (here < zb) zb = here;
  }
  if (zb < MIN_CEILING) problems.push('off-cavity');
  if (!landOk(space, spot, others)) problems.push('land');
  const rect = topRect(space, spot.kind);
  if (spot.x < rect.x0 || spot.y < rect.y0 || spot.x > rect.x1 || spot.y > rect.y1) problems.push('top-edge');
  return { valid: problems.length === 0, problems, zb };
}

/** The same answer as checkOpening(...).valid, with the cheap rules first. For code that asks a lot. */
export function isValid(space: PlacementSpace, spot: OpeningSpot, others: readonly OpeningSpot[]): boolean {
  const rect = topRect(space, spot.kind);
  if (spot.x < rect.x0 || spot.y < rect.y0 || spot.x > rect.x1 || spot.y > rect.y1) return false;
  if (!landOk(space, spot, others)) return false;
  const clearance = clearanceOf(space);
  const { field, sizes, offsets } = space;
  const { nx, ny, cell, x0, y0 } = field;
  const r = boreRadius(sizes, spot.kind);
  const certain = certainReach(space, spot.kind);
  for (const [ox, oy] of offsets) {
    const i = Math.round((spot.x + ox - x0) / cell), j = Math.round((spot.y + oy - y0) / cell);
    if (i < 0 || j < 0 || i >= nx || j >= ny || clearance[i + j * nx] <= certain) return false;
  }
  for (const [ox, oy] of offsets) if (discMinimum(field, spot.x + ox, spot.y + oy, r) < MIN_CEILING) return false;
  return true;
}

function clearanceOf(space: PlacementSpace): Float32Array {
  if (!space.clearance) {
    const { field } = space;
    const mask = new Uint8Array(field.values.length);
    for (let n = 0; n < mask.length; n++) mask[n] = field.values[n] >= MIN_CEILING ? 1 : 0;
    const distance = distanceToOutside(mask, field.nx, field.ny);
    for (let n = 0; n < distance.length; n++) distance[n] *= field.cell;
    space.clearance = distance;
  }
  return space.clearance;
}

/**
 * Builds the distance map and both fit boxes now, as the first snap would. field.worker calls this and
 * hands the space over ready, so a drop on the main thread never pays for the map (up to 44 ms on wolf).
 */
export function primeSpace(space: PlacementSpace): void {
  clearanceOf(space);
  fitBox(space, 'pour');
  fitBox(space, 'vent');
}

/** How far a node must be from too little ceiling for a disc there to stand a chance, given the rounding to it. */
function certainReach(space: PlacementSpace, kind: OpeningKind): number {
  return boreRadius(space.sizes, kind) + (space.field.cell * Math.SQRT2) / 2;
}

/**
 * The box a candidate's first copy must be in. It lets a ring far from the cavity pass in one comparison
 * per point, and a mold with no room for this disc anywhere answers at once.
 */
function fitBox(space: PlacementSpace, kind: OpeningKind): Rect | null {
  const known = space.fits[kind];
  if (known !== undefined) return known;
  const clearance = clearanceOf(space);
  const { nx, ny, cell, x0, y0 } = space.field;
  const reach = certainReach(space, kind);
  let iLow = nx, iHigh = -1, jLow = ny, jHigh = -1;
  for (let j = 0, n = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++, n++) {
      if (clearance[n] <= reach) continue;
      if (i < iLow) iLow = i;
      if (i > iHigh) iHigh = i;
      if (j < jLow) jLow = j;
      if (j > jHigh) jHigh = j;
    }
  }
  const box = iHigh < 0 ? null : { x0: x0 + (iLow - 1) * cell, y0: y0 + (jLow - 1) * cell, x1: x0 + (iHigh + 1) * cell, y1: y0 + (jHigh + 1) * cell };
  space.fits[kind] = box;
  return box;
}

/**
 * Step of the ring search. Finer than the cell it would add nothing, as discMinimum reads whole nodes,
 * and on a fine field a quarter of a mm is well under what a hand can place.
 */
const SNAP_STEP = 0.25;
const SNAP_REFINE = 6;

/**
 * The plan's snap: the nearest position that passes checkOpening, or null if none does. It walks
 * outward in rings, so the first hit is the nearest to within a step, and then closes in on the edge of
 * the valid ground along the line back to the drop. Most candidates cost one lookup in the distance map,
 * and only one that passes that gets the real check, so even a drop far off the cavity stays cheap.
 * `accept` narrows where it may land, such as onto one body's own ceiling, and the search then runs
 * on until a place that passes both is found.
 */
export function snapOpening(space: PlacementSpace, spot: OpeningSpot, others: readonly OpeningSpot[], accept: (x: number, y: number) => boolean = () => true): { x: number; y: number } | null {
  const { field, sizes } = space;
  const top = topRect(space, spot.kind);
  const fit = fitBox(space, spot.kind);
  if (!fit || selfCopyDistance(space) < 2 * topRadius(sizes, spot.kind) + sizes.minLand) return null;
  const x0 = Math.max(top.x0, fit.x0), y0 = Math.max(top.y0, fit.y0), x1 = Math.min(top.x1, fit.x1), y1 = Math.min(top.y1, fit.y1);
  if (x0 > x1 || y0 > y1) return null;

  const passes = (x: number, y: number): boolean => accept(x, y) && isValid(space, { kind: spot.kind, x, y }, others);
  if (passes(spot.x, spot.y)) return { x: spot.x, y: spot.y };

  const step = Math.max(SNAP_STEP, field.cell);
  // No ring nearer than this meets the box, and none further than its far corner does.
  const toBox = Math.hypot(Math.max(x0 - spot.x, 0, spot.x - x1), Math.max(y0 - spot.y, 0, spot.y - y1));
  const toFar = Math.hypot(Math.max(Math.abs(spot.x - x0), Math.abs(spot.x - x1)), Math.max(Math.abs(spot.y - y0), Math.abs(spot.y - y1)));
  for (let radius = Math.max(step, Math.ceil(toBox / step) * step); radius <= toFar + step; radius += step) {
    const count = Math.ceil((2 * Math.PI * radius) / step);
    for (let k = 0; k < count; k++) {
      const angle = (2 * Math.PI * k) / count;
      const x = spot.x + radius * Math.cos(angle), y = spot.y + radius * Math.sin(angle);
      if (x < x0 || y < y0 || x > x1 || y > y1 || !passes(x, y)) continue;
      // The ring before had no valid point, so the edge lies within a step nearer along this line. A
      // search all the way back to a far drop would leave most of its halvings off the valid ground.
      let good = { x, y };
      let bad = { x: spot.x + (radius - step) * Math.cos(angle), y: spot.y + (radius - step) * Math.sin(angle) };
      for (let n = 0; n < SNAP_REFINE; n++) {
        const middle = { x: (good.x + bad.x) / 2, y: (good.y + bad.y) / 2 };
        if (passes(middle.x, middle.y)) good = middle;
        else bad = middle;
      }
      return good;
    }
  }
  return null;
}

/** The longest bore of an opening's copies, from the flat top down to the ceiling at its centre. */
export function boreLength(space: PlacementSpace, spot: OpeningSpot): number {
  let longest = 0;
  for (const [ox, oy] of space.offsets) longest = Math.max(longest, space.Zt - heightAt(space.field, spot.x + ox, spot.y + oy));
  return longest;
}

/** Plan G11: a vent past L/d of 40, or a pour bore past 60 mm. Each is still placed, as a peak needs it. */
export function longBoreWarning(space: PlacementSpace, spot: OpeningSpot): Diagnostic | null {
  const length = boreLength(space, spot);
  const { ventDiameter } = space.sizes;
  if (spot.kind === 'vent' && length > LONG_VENT_RATIO * ventDiameter) {
    return { code: 'long-vent', severity: 'warning', message: `A vent at (${spot.x.toFixed(1)}, ${spot.y.toFixed(1)}) runs ${length.toFixed(0)} mm, ${(length / ventDiameter).toFixed(0)} times its ${ventDiameter} mm diameter, so it may need clearing after printing and could be slow to fill.` };
  }
  if (spot.kind === 'pour' && length > LONG_POUR_MM) {
    return { code: 'long-pour', severity: 'warning', message: `A pour bore at (${spot.x.toFixed(1)}, ${spot.y.toFixed(1)}) runs ${length.toFixed(0)} mm, which holds extra silicone and slows the pour.` };
  }
  return null;
}

/** Plan D3: the first pour belongs at the highest point. Within the plan's t / 2 of it, air still gets out. */
export function offPeakWarning(space: PlacementSpace, spot: OpeningSpot, peakHeight: number, drop: number): Diagnostic | null {
  if (spot.kind !== 'pour' || heightAt(space.field, spot.x, spot.y) >= peakHeight - drop) return null;
  return { code: 'pour-off-peak', severity: 'warning', message: `The pour at (${spot.x.toFixed(1)}, ${spot.y.toFixed(1)}) is not at the body's highest point, so air could stay trapped above it.` };
}

/**
 * The plan's soft rule on funnels, from the rim and the closest pair of pours. Default 40 mm funnels
 * collide at x8's 22 mm pitch, so this says what size would fit. Null if nothing collides.
 */
export function funnelCollision(space: PlacementSpace, pours: readonly OpeningSpot[]): Diagnostic | null {
  const { funnelTop, funnelMinTop } = space.sizes;
  if (funnelTop === null || pours.length === 0) return null;
  let closest = selfCopyDistance(space);
  for (let a = 0; a < pours.length; a++) {
    for (let b = a + 1; b < pours.length; b++) {
      closest = Math.min(closest, nearestCopy(space, pours[a].x, pours[a].y, pours[b].x, pours[b].y));
    }
  }
  if (closest >= funnelTop) return null;
  const fits = Math.floor(closest - FUNNEL_GAP);
  const advice = fits >= funnelMinTop ? `A top diameter of ${fits} mm would fit.` : 'No funnel fits between them, so pour them one at a time or move them apart.';
  return { code: 'funnel-collision', severity: 'warning', message: `Funnels of ${funnelTop} mm collide, as two pours are only ${closest.toFixed(1)} mm apart. ${advice}` };
}

export interface DropResult {
  x: number;
  y: number;
  /** It was invalid where it was dropped, and moved to the nearest valid place. */
  snapped: boolean;
  /** False only if no valid place exists at all, and then it stays where it was dropped. */
  valid: boolean;
  problems: HardProblem[];
  warnings: Diagnostic[];
}

/**
 * What happens on the drop of a dragged opening. Runs on the main thread, so it reads only the plain
 * inputs and no solid. `peakHeight` is the height of its body's highest point, when it is a first pour.
 */
export function dropOpening(space: PlacementSpace, spot: OpeningSpot, others: readonly OpeningSpot[], peak?: { height: number; drop: number }): DropResult {
  const check = checkOpening(space, spot, others);
  const moved = check.valid ? null : snapOpening(space, spot, others);
  const at = moved ? { kind: spot.kind, x: moved.x, y: moved.y } : spot;
  const final = moved ? checkOpening(space, at, others) : check;
  const warnings: Diagnostic[] = [];
  const long = longBoreWarning(space, at);
  if (long) warnings.push(long);
  const offPeak = peak ? offPeakWarning(space, at, peak.height, peak.drop) : null;
  if (offPeak) warnings.push(offPeak);
  if (at.kind === 'pour') {
    const collision = funnelCollision(space, [at, ...others.filter((other) => other.kind === 'pour' && other !== spot)]);
    if (collision) warnings.push(collision);
  }
  return { x: at.x, y: at.y, snapped: moved !== null, valid: final.valid, problems: final.problems, warnings };
}
