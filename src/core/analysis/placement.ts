import { mapCavities } from '../field/cavities';
import type { Field } from '../field/grid';
import type { Bounds } from '../mesh/weld';
import { resolveAuto } from '../params/defaults';
import type { Params } from '../params/schema';
import { BELOW_CEILING, type CutOpening } from '../parts/openings';
import type { SeamAxis } from '../parts/rim';
import type { Diagnostic } from '../report/diagnostics';
import { BURIED, type Body, type BodyOptions } from './bodies';
import { leavesCovered, mergeTree, significantLeaves } from './peaks';
import { PLATEAU_DROP, PLATEAU_SLOPE_DEG } from './plateaus';
import { placeWords, RISING } from './reports';
import { seamLeavesCovered, significantSeamLeaves, topRunColumns, type ModelStrip, type SeamLeaf, type SeamTree } from './seam';
import { boreLength, boreRadius, checkOpening, clearOfFlanges, closestPours, discMaximum, discMinimum, flangeOffSeat, flangeOrdersPours, flangeOutreachesLand, flangeReach, funnelCollision, funnelFit, funnelsCollide, heightAt, isValid, longBoreWarning, MIN_CEILING, offPeakWarning, snapOpening, topRadius, ventLand, widestFlangeInLand, type FunnelAdvice, type FunnelFit, type HardProblem, type OpeningKind, type OpeningSizes, type OpeningSpot, type PlacementSpace } from './validate';

/** Plan: spread pours sit on a circle this share of the shorter footprint side from the centroid. */
const SPREAD_RADIUS_SHARE = 0.35;
/** Plan: and move to the local maximum within this many mm. */
const SPREAD_SNAP_MM = 5;
const SPREAD_SNAP_STEP = 0.5;
/** Past a blocked spot, the next spot looked at along the same line. Equal to the snap radius, to leave no gap. */
const SPREAD_RAY_STEP = SPREAD_SNAP_MM;
/** Angles tried around a pour for the vent beside it. */
const VENT_ANGLES = 72;
/** Further circles tried for that vent, in mm past the closest one, when something is in the way. */
const VENT_CIRCLES = [0, 2, 4];
/** So a vent on the closest circle is not refused for float noise in its land. */
const LAND_SLACK = 0.01;

export type OpeningRole = 'peak' | 'plateau' | 'beside' | 'leaf' | 'spread' | 'cavity' | 'pinned';

export interface PlacedOpening extends OpeningSpot {
  /** Stable while the model and counts stay the same, so a pin or a deleted vent can name it. */
  id: string;
  /** Index in `bodies`, or -1 for a cavity no body opens. */
  body: number;
  role: OpeningRole;
  pinned: boolean;
  /** False only on a pin that a later change made invalid. An automatic opening is always valid. */
  valid: boolean;
  /** Lowest ceiling under the disc, over all copies. */
  zb: number;
  /** From the flat top down to the ceiling at its centre, the longest of all copies. */
  boreLength: number;
}

/** A dragged opening: the plan keeps it where it was put, and flags it if a change makes it invalid. */
export interface OpeningPin {
  id: string;
  kind: OpeningKind;
  x: number;
  y: number;
}

export interface PlacementSettings extends BodyOptions {
  perBody: number;
  ventsEnabled: boolean;
  /** Plan: a leaf is covered within this of its peak, t / 2. */
  coverDrop: number;
}

export function placementSettings(params: Params, bounds: Bounds): PlacementSettings {
  const { ventPersistence, planeTol } = resolveAuto(params, bounds);
  return { perBody: params.pour.perModel, ventsEnabled: params.vents.enabled, coverDrop: params.silicone.t / 2, ventPersistence, planeTol };
}

export interface PlacementInput {
  bodies: Body[];
  /** The single conditioned tile, which is all S7 places on. */
  tile: Field;
  space: PlacementSpace;
  settings: PlacementSettings;
  pins?: OpeningPin[];
  /** Ids of automatic vents the user deleted. */
  removed?: readonly string[];
}

export interface BodyPlacement {
  requested: number;
  placed: number;
  /** The body's highest point, where its first pour belongs unless it has a plateau. */
  peak: [number, number, number];
  plateau: boolean;
}

export interface UncoveredLeaf {
  x: number;
  y: number;
  height: number;
  persistence: number;
  /** Air under the ceiling above its saddle, in mm3. */
  airVolume: number;
}

export interface Placement {
  openings: PlacedOpening[];
  bodies: BodyPlacement[];
  /** Peaks of the composite with no opening. Empty unless a vent was refused, removed or turned off. */
  uncovered: UncoveredLeaf[];
  /** Peaks of the composite past the vent persistence, with an opening or not: the air report's ceiling leaves. */
  ceilingLeaves: number;
  diagnostics: Diagnostic[];
}

/** What is left of placing while it runs. */
interface Work extends PlacementInput {
  openings: PlacedOpening[];
  /** Per body, indexes into body.tree.leaves. */
  covered: Set<number>[];
  pinnedIds: Set<string>;
  removedIds: Set<string>;
  diagnostics: Diagnostic[];
  /** VN: a plan made again only for where its pours stand, which leaves out the vent-low note's search. */
  quiet: boolean;
}

function add(work: Work, spot: OpeningSpot, id: string, body: number, role: OpeningRole, pinned = false): PlacedOpening {
  const opening: PlacedOpening = { ...spot, id, body, role, pinned, valid: true, zb: 0, boreLength: 0 };
  work.openings.push(opening);
  const r = boreRadius(work.space.sizes, opening.kind);
  work.bodies.forEach((other, index) => {
    for (const leaf of leavesCovered(other.tree, other.field, opening.x, opening.y, r, work.settings.coverDrop)) work.covered[index].add(leaf);
  });
  return opening;
}

function valid(work: Work, spot: OpeningSpot, ignore?: OpeningSpot): boolean {
  return isValid(work.space, spot, ignore ? work.openings.filter((other) => other !== ignore) : work.openings);
}

/**
 * Whether a spot is over the body itself: inside its extent, with a ceiling of its own there and none
 * of another body above that, by the rule that makes a leaf the body's. A pour of one body on another's
 * ceiling would be that body's pour, and one in the trench between two, where the body's own ceiling
 * still reaches, would only bore down to the trench's floor.
 */
function owns(work: Work, body: Body, x: number, y: number): boolean {
  if (x < body.min[0] || x > body.max[0] || y < body.min[1] || y > body.max[1]) return false;
  const own = heightAt(body.field, x, y);
  return own >= MIN_CEILING && heightAt(work.tile, x, y) - own <= BURIED;
}

function pourId(body: number, k: number): string {
  return `b${body}:pour:${k}`;
}

/**
 * Plan 1: the first pour of each body, at its highest point or at the pole of its plateau. If an earlier
 * body's opening is in the way there, or the disc does not fit, it goes to the highest valid spot over
 * the body's own ceiling, nearest on a tie, and not to the nearest valid spot anywhere. On x8 at pour
 * 20 the nearest one slides down a barrier's far flank towards the next barrier and leaves that one no
 * room, where the highest one moves along the barrier's top.
 */
function placeFirstPours(work: Work): void {
  work.bodies.forEach((body, b) => {
    const id = pourId(b, 0);
    if (work.pinnedIds.has(id)) return;
    const top = body.plateau ?? body.leaves[0];
    const role: OpeningRole = body.plateau ? 'plateau' : 'peak';
    const spot: OpeningSpot = { kind: 'pour', x: top.x, y: top.y };
    if (valid(work, spot)) {
      add(work, spot, id, b, role);
      return;
    }
    // As high as where it belonged is as good, so a plateau keeps it near its pole.
    const near = highestNear(work, body, spot, Infinity, heightAt(work.space.field, spot.x, spot.y));
    if (near) add(work, { kind: 'pour', ...near }, id, b, role);
  });
}

/**
 * G11: on a circle outside the seat at the point maximising H, and shortest bore on a tie, so on a
 * plateau it stays on the flat top. A further circle only if something is in the way. FL: the closest
 * circle is clear of the funnel's flange too, by the rule validation holds it to. No lower than `lowest`.
 */
function ventBesidePour(work: Work, pour: OpeningSpot, lowest = -Infinity): OpeningSpot | null {
  const { space } = work;
  const { sizes, field } = space;
  // A flange the land already keeps clear leaves the circle exactly where it was with none.
  const closest = (flangeOutreachesLand(sizes) ? flangeReach(sizes) : ventLand(sizes)) + LAND_SLACK;
  for (const extra of VENT_CIRCLES) {
    let best: OpeningSpot | null = null;
    let bestHeight = -Infinity, bestFloor = -Infinity;
    for (let k = 0; k < VENT_ANGLES; k++) {
      const angle = (2 * Math.PI * k) / VENT_ANGLES;
      const spot: OpeningSpot = { kind: 'vent', x: pour.x + (closest + extra) * Math.cos(angle), y: pour.y + (closest + extra) * Math.sin(angle) };
      const exact = heightAt(field, spot.x, spot.y);
      const height = Math.round(exact * 100);
      if (height < bestHeight || exact < lowest) continue;
      const floor = discMinimum(field, spot.x, spot.y, boreRadius(sizes, 'vent'));
      if (height === bestHeight && floor <= bestFloor) continue;
      if (!valid(work, spot)) continue;
      best = spot;
      bestHeight = height;
      bestFloor = floor;
    }
    if (best) return best;
  }
  return null;
}

/** These sizes with every funnel's flange this many mm wide, 0 for none. */
function flangedSizes(sizes: OpeningSizes, width: number): OpeningSizes {
  return { ...sizes, flangeRadius: width > 0 ? topRadius(sizes, 'pour') + width : 0 };
}

/** The same placement work with every funnel's flange this many mm wide, 0 for none. */
function withFlangeWidth(work: Work, width: number): Work {
  return { ...work, space: { ...work.space, sizes: flangedSizes(work.space.sizes, width) } };
}

/** Flange widths are tried this far apart when a vent beside a pour finds no room clear of the one set. */
const FLANGE_TRY_STEP = 0.5;

/** The flange width set, in mm past the seat's edge. */
function setFlangeWidth(sizes: OpeningSizes): number {
  return sizes.flangeRadius - topRadius(sizes, 'pour');
}

/**
 * FL: when the flange is what leaves no room for the vent beside a pour, the widest flange that would,
 * in FLANGE_TRY_STEP below the one set, down to the widest the land alone keeps clear (1 mm at defaults),
 * where every vent stands as with none; 0 if only no flange would; null if even that has no room.
 */
function widestFlangeWithRoom(work: Work, pour: OpeningSpot): number | null {
  const { sizes } = work.space;
  if (!flangeOutreachesLand(sizes)) return null;
  const set = setFlangeWidth(sizes);
  const plain = widestFlangeInLand(sizes);
  for (let width = Math.ceil(set / FLANGE_TRY_STEP - 1e-9) * FLANGE_TRY_STEP - FLANGE_TRY_STEP; width > plain; width -= FLANGE_TRY_STEP) {
    if (ventBesidePour(withFlangeWidth(work, width), pour)) return width;
  }
  return ventBesidePour(withFlangeWidth(work, plain), pour) ? plain : null;
}

/** vent-refused's words on the flange, where a narrower one makes room (widestFlangeWithRoom's width), or none. */
function flangeRoomHint(width: number | null): string {
  return width === null
    ? ''
    : width > 0
      ? ` clear of its funnel's flange: a Flange width of at most ${width} mm under Pour & funnel leaves room for one`
      : " clear of its funnel's flange: only with no flange (Flange width 0 under Pour & funnel) is there room for one";
}

/** Each body's first pour, or undefined where it has none. */
function firstPours(work: Work): (OpeningSpot | undefined)[] {
  return work.bodies.map((_, b) => work.openings.find((opening) => opening.body === b && opening.kind === 'pour'));
}

/**
 * FL: how high the vent beside each body's first pour would stand before the body's other pours are
 * placed, or null where there is no room for it even then. Pinned or removed vents count as none.
 */
function besideHeights(work: Work): (number | null)[] {
  const { field } = work.space;
  return firstPours(work).map((pour, b) => {
    const id = `b${b}:vent:beside`;
    if (!pour || work.pinnedIds.has(id) || work.removedIds.has(id)) return null;
    const spot = ventBesidePour(work, pour);
    return spot ? heightAt(field, spot.x, spot.y) : null;
  });
}

/**
 * Plan 2: a vent beside the first pour of each body. With `before`, from besideHeights, the body's other
 * pours are placed already (FL) and open its top too, so the vent goes only where it stands within t / 2
 * of where it would have without them, not down a flank or into a trench, where it would vent nothing.
 */
function placeVentsBeside(work: Work, before?: readonly (number | null)[]): void {
  const pours = firstPours(work);
  const crowded: OpeningSpot[] = [];
  work.bodies.forEach((_, b) => {
    const id = `b${b}:vent:beside`;
    const pour = pours[b];
    if (work.pinnedIds.has(id) || work.removedIds.has(id) || !pour) return;
    const floor = before?.[b];
    const spot = ventBesidePour(work, pour, typeof floor === 'number' ? floor - work.settings.coverDrop : -Infinity);
    if (spot) {
      // Before it is added, so the vent it is weighed against is not kept off by this one.
      ventLowNote(work, pour, spot, before !== undefined);
      add(work, spot, id, b, 'beside');
      return;
    }
    if (typeof floor === 'number') {
      crowded.push(pour);
      return;
    }
    // FL: the flange keeps the vent further out than the land would, which can be why a small model has no
    // room; the warning says so only where a narrower flange would make room, and names the widest.
    const flange = flangeRoomHint(widestFlangeWithRoom(work, pour));
    work.diagnostics.push({ code: 'vent-refused', severity: 'warning', message: `No room for a vent beside the pour at (${pour.x.toFixed(1)}, ${pour.y.toFixed(1)})${flange}.` });
  });
  if (crowded.length > 0) {
    const at = crowded.map((pour) => `(${pour.x.toFixed(1)}, ${pour.y.toFixed(1)})`).join(', ');
    const message = crowded.length === 1
      ? `No vent beside the pour at ${at} on its top: the body's other pours take the room there clear of their funnels' flanges, and let the air out of that top too.`
      : `No vent beside the pours at ${at} on their tops: each body's other pours take the room there clear of their funnels' flanges, and let the air out of that top too.`;
    work.diagnostics.push({ code: 'vent-refused', severity: 'info', message });
  }
}

/** VN: how high the air a vent here lets out can reach: the highest ceiling under its disc, not only at its centre. */
function ventReach(work: Work, spot: OpeningSpot): number {
  const { field, sizes } = work.space;
  return discMaximum(field, spot.x, spot.y, boreRadius(sizes, 'vent'));
}

/**
 * VN: the widest flange, in FLANGE_TRY_STEP above the widest the land alone keeps clear and below the one
 * set, at which the vent beside this pour, placed again with that flange, reaches no more than t / 2 under
 * `nearReach`, the reach of the vent with no flange in its way. Tried upward, so every width up to the one
 * returned passes; `plain` when none above it does. The other openings stay where they stand at the width
 * set, which is where a plan at that width puts them when the vents beside the pours go first: one pour
 * per body. With more, the pours go first, and a narrower flange spaces them again, so the note does not
 * call on this there (ventLowNote).
 */
function widestFlangeWithinDrop(work: Work, pour: OpeningSpot, plain: number, nearReach: number): number {
  const set = setFlangeWidth(work.space.sizes);
  let widest = plain;
  for (let width = (Math.floor(plain / FLANGE_TRY_STEP + 1e-9) + 1) * FLANGE_TRY_STEP; width < set - 1e-9; width += FLANGE_TRY_STEP) {
    const spot = ventBesidePour(withFlangeWidth(work, width), pour);
    if (!spot || nearReach - ventReach(work, spot) > work.settings.coverDrop) break;
    widest = width;
  }
  return widest;
}

/**
 * FL: on a peaked top the flange's room pushes the vent beside a pour down the slope. Where the air it lets
 * out then reaches more than t / 2 lower than it would with no flange in its way, a note says so: the air
 * above it there leaves only up the pour. VN: measured by the highest ceiling under each vent's disc, as air
 * reaches a vent anywhere under it, and the note names the widest flange that keeps the vent within t / 2.
 * With the pours placed first (`poursFirst`), a flange the land keeps clear brings back the order of before
 * FL, where the vent goes before the body's other pours, so the vent it is weighed against is placed with
 * only the first pours, the pins and the vents beside earlier bodies' pours; and as a width between that and
 * the one set spaces those pours again, which the width search does not follow, the note names only the
 * width the land keeps clear, which every plan at it bears out.
 */
function ventLowNote(work: Work, pour: OpeningSpot, spot: OpeningSpot, poursFirst: boolean): void {
  const { sizes } = work.space;
  if (work.quiet || !flangeOutreachesLand(sizes)) return;
  const plain = widestFlangeInLand(sizes);
  const before: Work = poursFirst ? { ...work, openings: work.openings.filter((o) => o.pinned || o.role === 'peak' || o.role === 'plateau' || o.role === 'beside') } : work;
  const near = ventBesidePour(withFlangeWidth(before, plain), pour);
  if (!near) return;
  const nearReach = ventReach(work, near);
  const drop = nearReach - ventReach(work, spot);
  const { coverDrop } = work.settings;
  if (drop <= coverDrop) return;
  const widest = poursFirst ? plain : widestFlangeWithinDrop(work, pour, plain, nearReach);
  work.diagnostics.push({ code: 'vent-low', severity: 'info', message: ventLowMessage(pour, spot, near, drop, widest, plain, coverDrop) });
}

/**
 * vent-low's words: the vent at `spot` beside `pour` lets out air `drop` lower than one at `near`, with no flange in
 * its way; `widest` keeps the drop within t / 2, and `plain` is the widest flange the land keeps clear.
 */
function ventLowMessage(pour: OpeningSpot, spot: OpeningSpot, near: OpeningSpot, drop: number, widest: number, plain: number, coverDrop: number): string {
  const out = (o: OpeningSpot): string => Math.hypot(o.x - pour.x, o.y - pour.y).toFixed(1);
  const within = `A Flange width of at most ${widest} mm under Pour & funnel keeps that drop within ${Number(coverDrop.toFixed(2))} mm`;
  const narrower = widest > plain
    ? plain > 0
      ? `${within}, and one of at most ${plain} mm lets the vent stand ${out(near)} mm out`
      : `${within}, and only with no flange (Flange width 0 under Pour & funnel) does the vent stand ${out(near)} mm out`
    : plain > 0
      ? `A Flange width of at most ${plain} mm under Pour & funnel lets the vent stand ${out(near)} mm out`
      : `Only with no flange (Flange width 0 under Pour & funnel) does the vent stand ${out(near)} mm out`;
  return `The vent at (${spot.x.toFixed(1)}, ${spot.y.toFixed(1)}) beside the pour stands ${out(spot)} mm from it to clear its funnel's flange, where the highest ceiling under it is ${drop.toFixed(1)} mm lower than under a vent ${out(near)} mm out, so the air above that height leaves only up the pour: pour slowly. ${narrower}.`;
}

/** Plan 3: a vent at every other leaf over the persistence limit that nothing covers yet. */
function placeLeafVents(work: Work): void {
  work.bodies.forEach((body, b) => {
    body.leaves.forEach((leaf, rank) => {
      const id = `b${b}:vent:${rank}`;
      if (work.pinnedIds.has(id) || work.removedIds.has(id)) return;
      if (work.covered[b].has(leaf.index)) return;
      const spot: OpeningSpot = { kind: 'vent', x: leaf.x, y: leaf.y };
      // Moved off a leaf, a vent is only worth having if it still lets that leaf's air out.
      const place = valid(work, spot) ? spot : snapOpening(work.space, spot, work.openings);
      if (!place) return;
      const covers = leavesCovered(body.tree, body.field, place.x, place.y, boreRadius(work.space.sizes, 'vent'), work.settings.coverDrop);
      if (covers.has(leaf.index)) add(work, { kind: 'vent', x: place.x, y: place.y }, id, b, 'leaf');
    });
  });
}

/**
 * Plan 4: extra pours take the next-highest leaves, replacing the vent there, and then spread on a
 * circle around where the body stands. What cannot be placed is reported, by the caller, as a shortfall.
 */
function placeExtraPours(work: Work): void {
  const { settings, space } = work;
  const { sizes } = space;
  work.bodies.forEach((body, b) => {
    const count = (): number => work.openings.filter((opening) => opening.body === b && opening.kind === 'pour').length;
    let next = 1;
    const claim = (spot: { x: number; y: number }, role: OpeningRole): void => {
      while (work.pinnedIds.has(pourId(b, next))) next++;
      add(work, { kind: 'pour', x: spot.x, y: spot.y }, pourId(b, next++), b, role);
    };

    for (const leaf of body.leaves.slice(1)) {
      if (count() >= settings.perBody) return;
      const vent = work.openings.find((opening) => opening.body === b && opening.kind === 'vent' && opening.role === 'leaf' && opening.x === leaf.x && opening.y === leaf.y);
      const spot: OpeningSpot = { kind: 'pour', x: leaf.x, y: leaf.y };
      if (!valid(work, spot, vent)) continue;
      if (vent) work.openings.splice(work.openings.indexOf(vent), 1);
      claim(spot, 'leaf');
    }

    const missing = settings.perBody - count();
    if (missing <= 0) return;
    const [cx, cy] = body.centroid;
    const radius = Math.max(SPREAD_RADIUS_SHARE * body.extent, topRadius(sizes, 'pour') + sizes.minLand);
    // Along the body's longer side first, where there is the most room for the rest.
    const start = body.max[0] - body.min[0] >= body.max[1] - body.min[1] ? 0 : Math.PI / 2;
    // FL: where the body has room as high up, a spread pour keeps its flange off the other pours' seats, and
    // theirs off its own, so one funnel at a time leaves the next seat open; else the land alone, as before FL.
    // VN: where the flange reaches past the land by the fixed gap, as the order is decided (flangeOrdersPours),
    // so a seat clearance never turns this on or off; the spacing kept is by the gap the settings need.
    const roomy = flangeOrdersPours(sizes)
      ? (x: number, y: number): boolean => clearOfFlanges(space, { kind: 'pour', x, y }, work.openings)
      : null;
    for (let k = 0; k < missing; k++) {
      const angle = start + (2 * Math.PI * k) / missing;
      const dx = Math.cos(angle), dy = Math.sin(angle);
      // Further out along the line while something is in the way, and off the body's ceiling it stops.
      const alongLine = (accept?: (x: number, y: number) => boolean): { x: number; y: number } | null => {
        let found: { x: number; y: number } | null = null;
        for (let along = radius; !found && heightAt(body.field, cx + along * dx, cy + along * dy) > 0; along += SPREAD_RAY_STEP) {
          found = highestNear(work, body, { x: cx + along * dx, y: cy + along * dy }, SPREAD_SNAP_MM, Infinity, accept);
        }
        return found;
      };
      const from: OpeningSpot = { kind: 'pour', x: cx + radius * dx, y: cy + radius * dy };
      const pick = (accept?: (x: number, y: number) => boolean): { x: number; y: number } | null =>
        alongLine(accept) ?? snapOpening(space, from, work.openings, (x, y) => owns(work, body, x, y) && (!accept || accept(x, y)));
      let spot = pick();
      // Not at any cost: a spot clear of the flanges, but down a flank, would trade a short bore for a long one.
      if (spot && roomy && !roomy(spot.x, spot.y)) {
        const clear = pick(roomy);
        if (clear && heightAt(space.field, clear.x, clear.y) >= heightAt(space.field, spot.x, spot.y) - settings.coverDrop) spot = clear;
      }
      if (spot) claim(spot, 'spread');
    }
  });
}

/**
 * The highest valid spot over this body's own ceiling within `radius` of `from`, on a lattice from it,
 * and the nearest on a tie, as a plateau has many. Heights at or over `cap` all count as equally high.
 * `accept` narrows it further. Null if none is valid.
 */
function highestNear(work: Work, body: Body, from: { x: number; y: number }, radius: number, cap = Infinity, accept?: (x: number, y: number) => boolean): { x: number; y: number } | null {
  const { field } = work.space;
  // The lattice stays inside the body's extent, as nothing past it is the body's.
  const steps = (low: number, high: number, at: number): [number, number] => [
    Math.max(-Math.floor(radius / SPREAD_SNAP_STEP), Math.ceil((low - at) / SPREAD_SNAP_STEP)),
    Math.min(Math.floor(radius / SPREAD_SNAP_STEP), Math.floor((high - at) / SPREAD_SNAP_STEP)),
  ];
  const [iLow, iHigh] = steps(body.min[0], body.max[0], from.x);
  const [jLow, jHigh] = steps(body.min[1], body.max[1], from.y);
  const capLevel = Math.round(cap * 100);
  let best: { x: number; y: number } | null = null;
  let bestHeight = -Infinity, bestDistance = Infinity;
  for (let j = jLow; j <= jHigh; j++) {
    for (let i = iLow; i <= iHigh; i++) {
      const dx = i * SPREAD_SNAP_STEP, dy = j * SPREAD_SNAP_STEP;
      const distance = Math.hypot(dx, dy);
      if (distance > radius) continue;
      const x = from.x + dx, y = from.y + dy;
      const height = Math.min(Math.round(heightAt(field, x, y) * 100), capLevel);
      if (height < bestHeight || (height === bestHeight && distance >= bestDistance)) continue;
      if (!owns(work, body, x, y) || !valid(work, { kind: 'pour', x, y }) || (accept && !accept(x, y))) continue;
      best = { x, y };
      bestHeight = height;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * R11 says the only way into the closed volume is an opening. A cavity away from every body, around a
 * fragment or a body too small for a pour's disc, has none yet. It gets a pour if one fits and a vent
 * if not, as a thin opening still beats a sealed void, or an error if not even that fits.
 */
function openLeftoverCavities(work: Work): void {
  const { cavities, at } = mapCavities(work.tile, 0);
  const opened = new Set(work.openings.map((opening) => at(opening.x, opening.y)));
  // On the whole mold, where the silicone base layer joins the cavities, the silicone reaches a cavity that
  // meets an opened one there through the layer, so it needs no pour. Read only if a cavity is left over.
  let whole: { reached: Set<number>; at: (x: number, y: number) => number; leaves: { x: number; y: number }[] } | null = null;
  const wholeMold = () => {
    if (whole) return whole;
    const map = mapCavities(work.space.field, 0);
    const reached = new Set<number>();
    for (const opening of work.openings) for (const [ox, oy] of work.space.offsets) reached.add(map.at(opening.x + ox, opening.y + oy));
    const tree = mergeTree(work.space.field);
    return (whole = { reached, at: map.at, leaves: significantLeaves(tree, work.settings.ventPersistence) });
  };
  cavities.forEach((cavity, index) => {
    if (opened.has(index)) return;
    const [x, y] = cavity.peak;
    const mold = wholeMold();
    if (mold.reached.has(mold.at(x, y))) {
      // Filled through the layer: only air can be caught, under a peak of its own that stands clear of it.
      if (!work.settings.ventsEnabled) return;
      for (const leaf of mold.leaves) {
        if (at(leaf.x, leaf.y) !== index) continue;
        const spot: OpeningSpot = { kind: 'vent', x: leaf.x, y: leaf.y };
        const place = valid(work, spot) ? spot : snapOpening(work.space, spot, work.openings);
        if (!place || at(place.x, place.y) !== index) continue;
        add(work, { kind: 'vent', x: place.x, y: place.y }, `cavity:${index}`, -1, 'cavity');
        work.diagnostics.push({ code: 'cavity-vent', severity: 'info', message: `The small cavity at (${x.toFixed(1)}, ${y.toFixed(1)}) fills through the base layer, so it got a vent for its air.` });
        return;
      }
      return;
    }
    for (const kind of ['pour', 'vent'] as const) {
      const spot: OpeningSpot = { kind, x, y };
      const place = valid(work, spot) ? spot : snapOpening(work.space, spot, work.openings);
      if (!place || at(place.x, place.y) !== index) continue;
      add(work, { kind, x: place.x, y: place.y }, `cavity:${index}`, -1, 'cavity');
      work.diagnostics.push({ code: 'cavity-without-pour', severity: 'info', message: `The small cavity at (${x.toFixed(1)}, ${y.toFixed(1)}) had no opening of its own, so it got a ${kind} to fill it.` });
      return;
    }
    work.diagnostics.push({ code: 'cavity-closed', severity: 'error', message: `The cavity at (${x.toFixed(1)}, ${y.toFixed(1)}) has no room for an opening, so silicone cannot reach it.` });
  });
}

/**
 * The check on the composite: any peak there with no copy of an opening at it, from a tree of its own,
 * and how many peaks there are. The export runs it again on its own field for the air report.
 */
export function uncoveredOnComposite(openings: readonly OpeningSpot[], space: PlacementSpace, settings: Pick<PlacementSettings, 'coverDrop' | 'ventPersistence'>): { uncovered: UncoveredLeaf[]; leaves: number } {
  const tree = mergeTree(space.field);
  const covered = new Set<number>();
  for (const opening of openings) {
    const r = boreRadius(space.sizes, opening.kind);
    for (const [ox, oy] of space.offsets) {
      for (const leaf of leavesCovered(tree, space.field, opening.x + ox, opening.y + oy, r, settings.coverDrop)) covered.add(leaf);
    }
  }
  const significant = significantLeaves(tree, settings.ventPersistence);
  const uncovered = significant.filter((leaf) => !covered.has(tree.leaves.indexOf(leaf))).map(({ x, y, height, persistence, airVolume }) => ({ x, y, height, persistence, airVolume }));
  return { uncovered, leaves: significant.length };
}

/** A plan's work, its openings placed, before they are checked on the composite. `quiet` leaves out the vent-low note's search. */
function planned(input: PlacementInput, quiet: boolean): Work {
  const { bodies, settings, space, pins = [], removed = [] } = input;
  const work: Work = {
    ...input,
    openings: [],
    covered: bodies.map(() => new Set<number>()),
    pinnedIds: new Set(pins.map((pin) => pin.id)),
    removedIds: new Set(removed),
    diagnostics: [],
    quiet,
  };

  // Pins first: whatever else is placed must keep its land from them.
  for (const pin of pins) {
    const match = /^b(\d+):/.exec(pin.id);
    add(work, { kind: pin.kind, x: pin.x, y: pin.y }, pin.id, match ? Number(match[1]) : -1, 'pinned', true);
  }

  // FL: where the flange reaches past the land, a vent beside a first pour keeps clear of every flange, so it
  // takes about 2 x 12.8 mm of a body's top from its other pours at FL's 4 mm flange (2 x 10.8 at VN's 2): placed
  // first, it leaves x8's barriers at 3 pours room for the third only down a flank, or none, and at 2 pours sends
  // a barrier's second pour into the trench beside it. So with more than one pour per body the pours go first,
  // and the vent where their flanges leave room as high up, or none, as the other pours open the top too. A
  // flange the land already keeps clear (1 mm at defaults) keeps the order of before FL, and with it every
  // opening. VN: decided by the fixed gap (flangeOrdersPours), so a seat clearance never changes the order.
  const poursFirst = settings.ventsEnabled && settings.perBody > 1 && flangeOrdersPours(space.sizes);
  placeFirstPours(work);
  const before = poursFirst ? besideHeights(work) : undefined;
  if (settings.ventsEnabled && !poursFirst) placeVentsBeside(work);
  if (settings.ventsEnabled) placeLeafVents(work);
  placeExtraPours(work);
  if (poursFirst) placeVentsBeside(work, before);
  openLeftoverCavities(work);
  return work;
}

/** VN: plans the funnel-collision advice makes again at widths past those planned as with no flange, before it falls back on those. */
const ADVICE_ROUNDS = 4;

/**
 * VN: the widest flange, in tenths of a mm, that leaves the plan as it is with none: the land keeps it clear
 * of the vents (widestFlangeInLand), so the order and the spacing of before FL hold, and it stays inside the
 * top's edge that a pour's seat and the wall keep anyway (topRect), less a hair so float rounding there decides
 * nothing. 1 mm at defaults.
 */
function widestFlangeAsNone(space: PlacementSpace): number {
  const { sizes, wall } = space;
  return Math.max(0, Math.min(widestFlangeInLand(sizes), Math.floor((wall - sizes.topChamfer) * 10 - 1e-6) / 10));
}

/**
 * VN: whether every pour stands where a plan with any narrower flange puts it too: each pinned, or a body's
 * first pour at the body's own top, where nothing but pins and other first pours is placed before it and a
 * narrower flange only widens the top it may stand on; and every body has all its pours, as a narrower
 * flange could make room for one more.
 */
function poursStayPut(work: Work, pours: readonly PlacedOpening[]): boolean {
  const atTop = (pour: PlacedOpening): boolean => {
    const body = work.bodies[pour.body];
    if (!body || (pour.role !== 'peak' && pour.role !== 'plateau')) return false;
    const top = body.plateau ?? body.leaves[0];
    return pour.x === top.x && pour.y === top.y;
  };
  return pours.every((pour) => pour.pinned || atTop(pour)) && work.bodies.every((_, b) => pours.filter((pour) => pour.body === b).length >= work.settings.perBody);
}

/**
 * VN: the funnel-collision advice as it holds once followed. A narrower flange lets the plan put the pours it
 * spreads nearer each other, as their flanges then need less room, and at a width the land keeps clear back in
 * the order of before FL, so a flange sized to where they stand now can collide again where they go: the
 * chick's 2 pours, 16.1 mm apart at 2 mm, stand 15.0 apart at the 0.8 that distance asks for. So where the
 * advice names a flange width and a pour could move, the plan is made again at that width and the advice
 * worked out from where its pours stand, until the flange fits there, its top then as wide as fits there too.
 * Every width up to widestFlangeAsNone gives the plan of no flange, which is made once, and the widest of those
 * that fits it is named. The one-funnel-at-a-time width likewise. Undefined where nothing collides, or no pour
 * can move, as funnelCollision's own advice then holds.
 */
function followedAdvice(input: PlacementInput, work: Work, pours: readonly PlacedOpening[]): FunnelAdvice | undefined {
  const { space } = input;
  const { sizes } = space;
  const closest = closestPours(space, pours);
  if (!funnelsCollide(sizes, closest) || poursStayPut(work, pours)) return undefined;
  const asNone = widestFlangeAsNone(space);
  const plans = new Map<number, number>();
  const closestAt = (width: number): number => {
    const key = width <= asNone ? 0 : width;
    let at = plans.get(key);
    if (at === undefined) {
      const replanned = planned({ ...input, space: { ...space, sizes: flangedSizes(sizes, key) } }, true);
      plans.set(key, (at = closestPours(space, replanned.openings.filter((opening) => opening.kind === 'pour'))));
    }
    return at;
  };
  const settled = (fit: FunnelFit, width: number): FunnelFit => {
    const then = closestAt(width);
    return Math.abs(then - closest) < 0.05 ? { ...fit, width } : { ...fit, width, then };
  };
  let fit = funnelFit(sizes, closest);
  for (let round = 0, width = fit?.width ?? null; fit && width !== null; round++) {
    if (width <= asNone || round === ADVICE_ROUNDS) {
      const there = funnelFit(flangedSizes(sizes, asNone), closestAt(0));
      fit = there && settled(there, there.width ?? asNone);
      break;
    }
    const there = funnelFit(flangedSizes(sizes, width), closestAt(width));
    if (!there) width = asNone;
    else if (there.width === null) {
      fit = settled(there, width);
      break;
    } else width = there.width;
  }
  // Only where a flange covers the other pour's seat does the warning give it.
  let alone = flangeOffSeat(sizes, closest);
  const covers = sizes.flangeRadius > 0 && closest < sizes.flangeRadius + topRadius(sizes, 'pour');
  for (let round = 0; covers && alone > 0; round++) {
    if (alone <= asNone || round === ADVICE_ROUNDS) {
      alone = Math.min(asNone, flangeOffSeat(sizes, closestAt(0)));
      break;
    }
    const there = flangeOffSeat(sizes, closestAt(alone));
    if (there >= alone) break;
    alone = there;
  }
  return { fit, alone };
}

/**
 * S7, per body on the single tile, then replicated by the export plan and validated against the
 * composite. First pours and vents of all bodies go before any extra pour, so a body's extras cannot
 * take the place that another body's first pour needs. Pure on typed arrays: this runs in field.worker.
 */
export function placeOpenings(input: PlacementInput): Placement {
  const { bodies, settings, space } = input;
  const work = planned(input, false);

  const byBody = bodies.map((body, b): BodyPlacement => {
    const placed = work.openings.filter((opening) => opening.body === b && opening.kind === 'pour').length;
    const top = body.leaves[0];
    return { requested: settings.perBody, placed, peak: [top.x, top.y, top.height], plateau: body.plateau !== null };
  });
  byBody.forEach(({ requested, placed, peak }) => {
    if (placed >= requested) return;
    work.diagnostics.push({
      code: 'pour-shortfall',
      severity: placed === 0 ? 'error' : 'warning',
      message: `Placed ${placed} of ${requested} pours on the body with its peak at (${peak[0].toFixed(1)}, ${peak[1].toFixed(1)}), as its ceiling has no more valid room. A smaller pour or seat needs less.`,
    });
  });

  for (const opening of work.openings) {
    const check = checkOpening(space, opening, work.openings);
    opening.valid = check.valid;
    opening.zb = check.zb;
    opening.boreLength = boreLength(space, opening);
    if (!check.valid) {
      work.diagnostics.push({
        code: 'opening-invalid',
        severity: 'error',
        message: `The ${opening.kind} at (${opening.x.toFixed(1)}, ${opening.y.toFixed(1)}) is no longer valid: ${check.problems.map((problem) => describeProblem(problem, opening.kind)).join(', ')}. Move it again.`,
      });
    }
    const long = longBoreWarning(space, opening);
    if (long) work.diagnostics.push(long);
  }

  byBody.forEach(({ peak }, b) => {
    const first = work.openings.find((opening) => opening.body === b && opening.kind === 'pour');
    const warning = first ? offPeakWarning(space, first, peak[2], settings.coverDrop) : null;
    if (warning) work.diagnostics.push(warning);
  });

  const pours = work.openings.filter((opening) => opening.kind === 'pour');
  const collision = funnelCollision(space, pours, undefined, followedAdvice(input, work, pours));
  if (collision) work.diagnostics.push(collision);

  const { uncovered, leaves: ceilingLeaves } = uncoveredOnComposite(work.openings, space, settings);
  for (const leaf of uncovered) {
    work.diagnostics.push({ code: 'peak-uncovered', severity: 'warning', message: `The peak at (${leaf.x.toFixed(1)}, ${leaf.y.toFixed(1)}), ${leaf.persistence.toFixed(1)} mm above its surroundings, has no opening, so air will stay trapped there (assuming the silicone rises slowly).` });
  }
  return { openings: work.openings, bodies: byBody, uncovered, ceilingLeaves, diagnostics: work.diagnostics };
}

/**
 * The peak a moved opening is held to by the plan's soft rule: its body's highest point, with t / 2 to
 * spare, when it is that body's first pour, which belongs there. Undefined for any other opening.
 */
export function firstPourPeak(placement: Pick<Placement, 'openings' | 'bodies'>, id: string, coverDrop: number): { height: number; drop: number } | undefined {
  const opening = placement.openings.find((o) => o.id === id);
  if (!opening || opening.kind !== 'pour' || opening.body < 0) return undefined;
  const first = placement.openings.find((o) => o.body === opening.body && o.kind === 'pour');
  const body = placement.bodies[opening.body];
  return first?.id === id && body ? { height: body.peak[2], drop: coverDrop } : undefined;
}

/** A hard rule's breach in a maker's words, for the diagnostics here and the drag's own note on main. */
export function describeProblem(problem: HardProblem, kind: OpeningKind): string {
  switch (problem) {
    case 'off-cavity': return 'it runs off the cavity';
    case 'land': return 'it is too close to another opening';
    case 'flange': return kind === 'vent' ? "a funnel's flange would rest on it and close it" : "its funnel's flange would rest on a vent and close it";
    case 'seam-room': return "the seam's seal beside it has no room there";
    default: return 'it is too close to the edge of the top';
  }
}

/** Every copy of every opening, with its own zb, as the cutters need them. */
export function replicateOpenings(openings: readonly OpeningSpot[], space: PlacementSpace): CutOpening[] {
  const { sizes, field, offsets } = space;
  const copies: CutOpening[] = [];
  for (const opening of openings) {
    const r = boreRadius(sizes, opening.kind);
    for (const [ox, oy] of offsets) {
      const x = opening.x + ox, y = opening.y + oy;
      const zb = discMinimum(field, x, y, r);
      copies.push(
        opening.kind === 'pour'
          ? { kind: 'pour', x, y, zb, diameter: sizes.pourDiameter, seatDepth: sizes.seatDepth, seatHalfAngleDeg: sizes.seatHalfAngleDeg }
          : { kind: 'vent', x, y, zb, diameter: sizes.ventDiameter },
      );
    }
  }
  return copies;
}

/**
 * The silicone standing in the bores, for the plan's volume: from the ceiling up to the seat floor for
 * a pour, where the sprue gets cut, and up to the top for a vent. Summed over the nodes under each disc.
 */
export function boreSilicone(copies: readonly CutOpening[], field: Field, Zt: number): number {
  const { nx, ny, cell, x0, y0, values } = field;
  let sum = 0;
  for (const copy of copies) {
    const r = copy.diameter / 2;
    const top = copy.kind === 'pour' ? Zt - copy.seatDepth : Zt;
    const jLow = Math.max(0, Math.ceil((copy.y - r - y0) / cell)), jHigh = Math.min(ny - 1, Math.floor((copy.y + r - y0) / cell));
    for (let j = jLow; j <= jHigh; j++) {
      const dy = y0 + j * cell - copy.y;
      const half = Math.sqrt(Math.max(0, r * r - dy * dy));
      const iLow = Math.max(0, Math.ceil((copy.x - half - x0) / cell)), iHigh = Math.min(nx - 1, Math.floor((copy.x + half - x0) / cell));
      for (let i = iLow, n = iLow + j * nx; i <= iHigh; i++, n++) sum += Math.max(top - values[n], 0);
    }
  }
  return sum * cell * cell;
}

// ----- G13.5: the two-part cover's openings, on the seam line (MP4, stage S7c) -----

/** G13.5's 1D plateau: a stretch within PLATEAU_DROP of the top, under PLATEAU_SLOPE_DEG and at least this long, in mm. */
export const SEAM_PLATEAU_MIN = 10;
/** Steps along P when a vent moves off its leaf, and how far it may go each way, in mm. */
const SEAM_SNAP_STEP = 0.5;
const SEAM_SNAP_MM = 20;

/** A box on P, in (b, z), that the band beside an opening keeps out of. */
export interface SeamBox {
  b0: number;
  b1: number;
  z0: number;
  z1: number;
}

/**
 * G13.5's room rule on P: the band beside an opening, out to its top radius plus `band` (seamLand + gw + BAND_ROOM)
 * across b, from under its bore up through the top face, stays inside O and clear of the pry chamfers, the seam bolts'
 * lugs and their relief, and the clip ears (`keepOut`), and of the registration pins' sockets where the line has room.
 * O is never widened for it.
 */
export interface SeamRoom {
  /** O's span across the pull. */
  o0: number;
  o1: number;
  Zt: number;
  band: number;
  keepOut: SeamBox[];
  /** The pins' sockets on P, in (b, z), with their radius. */
  pins: { b: number; z: number; r: number }[];
}

/** Whether an opening's band here has G13.5's room. With `pins`, it keeps clear of the pins' sockets too. */
export function seamRoomFits(room: SeamRoom, sizes: OpeningSizes, kind: OpeningKind, b: number, zb: number, pins: boolean): boolean {
  const R = topRadius(sizes, kind) + room.band;
  if (b - R < room.o0 - 1e-9 || b + R > room.o1 + 1e-9) return false;
  const z0 = zb - BELOW_CEILING, z1 = room.Zt;
  for (const box of room.keepOut) if (b - R < box.b1 && b + R > box.b0 && z0 < box.z1 && z1 > box.z0) return false;
  if (pins) {
    for (const pin of room.pins) {
      const db = Math.max(Math.abs(b - pin.b) - R, 0), dz = Math.max(z0 - pin.z, 0, pin.z - z1);
      if (Math.hypot(db, dz) < pin.r) return false;
    }
  }
  return true;
}

export interface SeamPlacementInput {
  axis: SeamAxis;
  xs: number;
  /** On H_top (G13.4), with the rim's O, Zt and wall and one tile: what validation reads for an opening at the top. */
  space: PlacementSpace;
  tree: SeamTree;
  /** H_top from the rows at or under z only: a hidden leaf's own run, whose ceiling its vent's zb reads (G13.5). */
  topUnder: (z: number) => Field;
  room: SeamRoom;
  /** S8's columns along P, which a hidden leaf's vent keeps clear of. */
  model: ModelStrip;
  settings: PlacementSettings;
  /** Moved openings, stored as (x, y): on P each sits at (xs, pin.b). */
  pins?: OpeningPin[];
  removed?: readonly string[];
  /** The model's middle in x and y, which the underside-air warning tells its place from. */
  centre: [number, number];
}

export interface SeamOpening extends PlacedOpening {
  /** A hidden leaf's vent: from its own run's ceiling up through the more of S above it to the top (G13.5). */
  hidden: boolean;
  /** MP5: a hidden leaf's vent's run top, H_top from the rows at or under which its space reads (hiddenSpace). */
  under?: number;
}

export interface SeamPlacement {
  openings: SeamOpening[];
  /** The 1D plateau the pour stands on, from b0 to b1 along P, or null. */
  plateau: { b0: number; b1: number } | null;
  /** Whether the bands keep clear of the pins' sockets; where not, the build passes it to the seal, which leaves the pins out. */
  pinsKept: boolean;
  /** Significant leaves of S with no opening. */
  uncovered: UncoveredLeaf[];
  /** Significant leaves of S, with an opening or not. */
  ceilingLeaves: number;
  diagnostics: Diagnostic[];
}

/** What is left of placing on P while it runs. */
interface SeamWork extends SeamPlacementInput {
  openings: SeamOpening[];
  /** Each opening's own space: H_top, or a hidden leaf's run. */
  spaces: Map<SeamOpening, PlacementSpace>;
  covered: Set<number>;
  pinnedIds: Set<string>;
  removedIds: Set<string>;
  diagnostics: Diagnostic[];
  /** Whether this plan keeps the openings' bands clear of the pins' sockets. */
  keepPins: boolean;
  /** A pour went short for room on P, not for want of another high point: pour-shortfall's words. */
  roomShort: boolean;
}

/** An opening on P at b, in the mold's x and y. */
export function seamSpot(axis: SeamAxis, xs: number, kind: OpeningKind, b: number): OpeningSpot {
  return axis === 'x' ? { kind, x: xs, y: b } : { kind, x: b, y: xs };
}

/** The b of a spot or a pin, across the pull. */
export function seamBOf(axis: SeamAxis, spot: { x: number; y: number }): number {
  return axis === 'x' ? spot.y : spot.x;
}

/**
 * G13.5: a pin moved along P keeps its stored a, so switching back to the one-piece cover puts the opening where the
 * one-piece had it across the pull's axis; only b changes. A pin made on P with none stored before takes xs.
 */
export function pinOnSeam(pin: OpeningPin | undefined, id: string, kind: OpeningKind, axis: SeamAxis, xs: number, b: number): OpeningPin {
  const a = pin ? (axis === 'x' ? pin.x : pin.y) : xs;
  return axis === 'x' ? { id, kind, x: a, y: b } : { id, kind, x: b, y: a };
}

function seamAdd(work: SeamWork, spot: OpeningSpot, space: PlacementSpace, zb: number, id: string, role: OpeningRole, hidden: boolean, pinned = false): SeamOpening {
  const opening: SeamOpening = { ...spot, id, body: 0, role, pinned, valid: true, zb, boreLength: 0, hidden };
  work.openings.push(opening);
  work.spaces.set(opening, space);
  const r = boreRadius(work.space.sizes, spot.kind);
  for (const leaf of seamLeavesCovered(work.tree, seamBOf(work.axis, spot), r, zb, work.settings.coverDrop)) work.covered.add(leaf);
  return opening;
}

/** The hard rules on P: G11's, on this space's ceiling, and G13.5's room. Null where it fails, else zb. */
function seamCheck(work: SeamWork, space: PlacementSpace, kind: OpeningKind, b: number, pins: boolean): number | null {
  const spot = seamSpot(work.axis, work.xs, kind, b);
  const check = checkOpening(space, spot, work.openings);
  if (!check.valid || !seamRoomFits(work.room, space.sizes, kind, b, check.zb, pins)) return null;
  return check.zb;
}

/** H_top's nodes along P: b from `first` by its cell. */
function seamNodes(work: SeamWork): { first: number; count: number; cell: number } {
  const H = work.space.field;
  return work.axis === 'x' ? { first: H.y0, count: H.ny, cell: H.cell } : { first: H.x0, count: H.nx, cell: H.cell };
}

/** The slope of a least-squares line through zb[from..to] at nodes `cell` apart, as a rise per mm. */
function fittedSlope(zb: readonly number[], from: number, to: number, cell: number): number {
  const n = to - from + 1;
  if (n < 2) return 0;
  const mid = (from + to) / 2;
  let sz = 0, sk = 0;
  for (let k = from; k <= to; k++) {
    sz += (k - mid) * zb[k];
    sk += (k - mid) ** 2;
  }
  return sz / sk / cell;
}

/**
 * G13.5's pour: where its bore stands highest along P, the most of G11's zb (the lowest ceiling over its disc, from
 * H_top) over H_top's nodes on P, among the spots with the room, not only at a leaf of S; at the middle of the stretch
 * round it within PLATEAU_DROP, as the nodes either side of a flat top are as high. That stretch is a 1D plateau where it
 * is at least SEAM_PLATEAU_MIN long and a least-squares line through it rises under PLATEAU_SLOPE_DEG: H_top comes in
 * whole cells, so from one node to the next any step is a cell over a cell, and the slope is read over the stretch. A
 * plateau gives its warning. Clear of the pins where the plan keeps them.
 */
function placeSeamPour(work: SeamWork): SeamPlacement['plateau'] {
  const id = pourId(0, 0);
  if (work.pinnedIds.has(id)) return null;
  const { space, keepPins: pins } = work;
  const { first, count, cell } = seamNodes(work);
  const r = boreRadius(space.sizes, 'pour');
  const zb = Array.from({ length: count }, (_, k) => {
    const spot = seamSpot(work.axis, work.xs, 'pour', first + k * cell);
    return discMinimum(space.field, spot.x, spot.y, r);
  });
  const fits = zb.map((_, k) => seamCheck(work, space, 'pour', first + k * cell, pins) !== null);
  let top = -1;
  for (let k = 0; k < count; k++) if (fits[k] && (top < 0 || zb[k] > zb[top])) top = k;
  if (top < 0) {
    work.roomShort = true;
    return null;
  }
  let lo = top, hi = top;
  while (lo > 0 && zb[lo - 1] >= zb[top] - PLATEAU_DROP) lo--;
  while (hi < count - 1 && zb[hi + 1] >= zb[top] - PLATEAU_DROP) hi++;
  const tan = Math.tan((PLATEAU_SLOPE_DEG * Math.PI) / 180);
  const flat = (hi - lo) * cell >= SEAM_PLATEAU_MIN - 1e-9 && Math.abs(fittedSlope(zb, lo, hi, cell)) < tan;
  let b = first + ((lo + hi) / 2) * cell;
  let at = seamCheck(work, space, 'pour', b, pins);
  if (at === null) {
    // The middle has no room: the node of the stretch with room nearest it.
    let best = top;
    for (let k = lo; k <= hi; k++) if (fits[k] && Math.abs(first + k * cell - b) < Math.abs(first + best * cell - b)) best = k;
    b = first + best * cell;
    at = seamCheck(work, space, 'pour', b, pins)!;
  }
  const spot = seamSpot(work.axis, work.xs, 'pour', b);
  seamAdd(work, spot, space, at, id, flat ? 'plateau' : 'peak', false);
  if (!flat) return null;
  const [b0, b1] = [first + lo * cell, first + hi * cell];
  work.diagnostics.push({
    code: 'seam-plateau',
    severity: 'warning',
    at: [spot.x, spot.y, at],
    message: `The top of the cavity along the seam is flat for ${(b1 - b0).toFixed(0)} mm, so the pour stands at the middle of it, at (${spot.x.toFixed(1)}, ${spot.y.toFixed(1)}); the silicone reaches a flat top all at once there, and air can stay along it, so pour slowly near the end.`,
  });
  return { b0, b1 };
}

/**
 * G13.5's vent beside a pour at `pourB`, with this space's sizes: on FL's closest circle (flangeReach, or the land where
 * the flange is narrower), intersected with P, so at b either side of the pour, the higher of the two by H_top and the
 * shorter bore on a tie; a further circle only if both are in the way (VENT_CIRCLES), as ventBesidePour does off the
 * seam.
 */
function seamVentBeside(work: SeamWork, space: PlacementSpace, pourB: number): { spot: OpeningSpot; zb: number } | null {
  const { sizes, field } = space;
  const closest = (flangeOutreachesLand(sizes) ? flangeReach(sizes) : ventLand(sizes)) + LAND_SLACK;
  for (const extra of VENT_CIRCLES) {
    let best: { spot: OpeningSpot; zb: number; height: number } | null = null;
    for (const sign of [1, -1]) {
      const b = pourB + sign * (closest + extra);
      const zb = seamCheck(work, space, 'vent', b, work.keepPins);
      if (zb === null) continue;
      const spot = seamSpot(work.axis, work.xs, 'vent', b);
      const height = Math.round(heightAt(field, spot.x, spot.y) * 100);
      if (best && (height < best.height || (height === best.height && zb <= best.zb))) continue;
      best = { spot, zb, height };
    }
    if (best) return { spot: best.spot, zb: best.zb };
  }
  return null;
}

/** The same space with every funnel's flange this many mm wide, 0 for none. */
function seamFlanged(work: SeamWork, width: number): PlacementSpace {
  return { ...work.space, sizes: flangedSizes(work.space.sizes, width) };
}

/** FL's widestFlangeWithRoom on P: the widest flange under the one set at which the vent beside the pour has room. */
function seamWidestFlangeWithRoom(work: SeamWork, pourB: number): number | null {
  const { sizes } = work.space;
  if (!flangeOutreachesLand(sizes)) return null;
  const set = setFlangeWidth(sizes);
  const plain = widestFlangeInLand(sizes);
  for (let width = Math.ceil(set / FLANGE_TRY_STEP - 1e-9) * FLANGE_TRY_STEP - FLANGE_TRY_STEP; width > plain; width -= FLANGE_TRY_STEP) {
    if (seamVentBeside(work, seamFlanged(work, width), pourB)) return width;
  }
  return seamVentBeside(work, seamFlanged(work, plain), pourB) ? plain : null;
}

/**
 * FL's vent-low note on P, as ventLowNote gives it off the seam: where the vent beside the pour lets out air more than
 * t / 2 lower than the one the land alone would place, its reach the highest ceiling under its disc, and the widest
 * flange that keeps it within t / 2. On P the vent beside goes before any other pour, so the search runs in full.
 */
function seamVentLowNote(work: SeamWork, pour: OpeningSpot, spot: OpeningSpot, zb: number): void {
  const { sizes } = work.space;
  if (!flangeOutreachesLand(sizes)) return;
  const pourB = seamBOf(work.axis, pour);
  const plain = widestFlangeInLand(sizes);
  const near = seamVentBeside(work, seamFlanged(work, plain), pourB);
  if (!near) return;
  const reach = (o: OpeningSpot): number => discMaximum(work.space.field, o.x, o.y, boreRadius(sizes, 'vent'));
  const nearReach = reach(near.spot);
  const drop = nearReach - reach(spot);
  const { coverDrop } = work.settings;
  if (drop <= coverDrop) return;
  const set = setFlangeWidth(sizes);
  let widest = plain;
  for (let width = (Math.floor(plain / FLANGE_TRY_STEP + 1e-9) + 1) * FLANGE_TRY_STEP; width < set - 1e-9; width += FLANGE_TRY_STEP) {
    const at = seamVentBeside(work, seamFlanged(work, width), pourB);
    if (!at || nearReach - reach(at.spot) > coverDrop) break;
    widest = width;
  }
  work.diagnostics.push({ code: 'vent-low', severity: 'info', at: [spot.x, spot.y, zb], message: ventLowMessage(pour, spot, near.spot, drop, widest, plain, coverDrop) });
}

/** The first pour on P: b0:pour:0, placed or pinned, or else the first pour pinned. */
function firstSeamPour(openings: readonly SeamOpening[]): SeamOpening | undefined {
  return openings.find((o) => o.id === pourId(0, 0)) ?? openings.find((o) => o.kind === 'pour');
}

/** G13.5's vent beside the first pour on P (seamVentBeside), with FL's vent-low note, or vent-refused with its hint. */
function placeSeamVentBeside(work: SeamWork): void {
  const id = 'b0:vent:beside';
  const pour = firstSeamPour(work.openings);
  if (!pour || work.pinnedIds.has(id) || work.removedIds.has(id)) return;
  const pourB = seamBOf(work.axis, pour);
  const found = seamVentBeside(work, work.space, pourB);
  if (found) {
    // Before it is added, so the vent it is weighed against is not kept off by this one.
    seamVentLowNote(work, pour, found.spot, found.zb);
    seamAdd(work, found.spot, work.space, found.zb, id, 'beside', false);
    return;
  }
  const hint = flangeRoomHint(seamWidestFlangeWithRoom(work, pourB));
  work.diagnostics.push({
    code: 'vent-refused',
    severity: 'warning',
    at: [pour.x, pour.y, pour.zb],
    message: `No room for a vent beside the pour at (${pour.x.toFixed(1)}, ${pour.y.toFixed(1)}) on the seam, with room for the seam's seal beside it${hint ? `,${hint}` : " and clear of its funnel's flange"}.`,
  });
}

/** S8's warning on underside air, for a hidden leaf whose vent finds no line clear of the model (G13.5). */
function hiddenAirWarning(work: SeamWork, leaf: SeamLeaf): Diagnostic {
  const spot = seamSpot(work.axis, work.xs, 'vent', leaf.b);
  const at: [number, number, number] = [spot.x, spot.y, leaf.height];
  return {
    code: 'air-underside',
    severity: 'warning',
    at,
    message: `Air stays under an overhang of the model, ${placeWords(at, work.centre)}, where no vent in the top reaches: brush a first coat of silicone onto the model there before you close the mold, tilt the mold as you pour, or degas the filled mold in a vacuum, which is untested on printed molds ${RISING}.`,
  };
}

/** A hidden leaf's own space: H_top from the rows at or under its top, whose ceiling its vent's zb reads (G13.5). */
function hiddenSpace(input: SeamPlacementInput, leaf: SeamLeaf): PlacementSpace {
  return { ...input.space, field: input.topUnder(leaf.height), clearance: null, fits: {} };
}

/**
 * G13.5's hidden leaf: a straight vent bore on P, from its own run's ceiling (zb by G11's rule on H_top from that run's
 * rows) up through the S above it to the top, at a b inside the leaf's top run whose line clears the model in S8's
 * columns, nearest the leaf first. Otherwise S8's underside-air warning names the spot.
 */
function placeHiddenVent(work: SeamWork, index: number, id: string): void {
  const { tree, settings } = work;
  const leaf = tree.leaves[index];
  const space = hiddenSpace(work, leaf);
  const r = boreRadius(space.sizes, 'vent');
  const { b0, cell } = tree.cells;
  const candidates = topRunColumns(tree, index, settings.coverDrop).map((k) => b0 + k * cell).sort((p, q) => Math.abs(p - leaf.b) - Math.abs(q - leaf.b));
  candidates.unshift(leaf.b);
  for (const b of candidates) {
    const zb = seamCheck(work, space, 'vent', b, work.keepPins);
    if (zb === null || !work.model.clear(b, r, zb - BELOW_CEILING, work.room.Zt)) continue;
    if (!seamLeavesCovered(tree, b, r, zb, settings.coverDrop).has(index)) continue;
    seamAdd(work, seamSpot(work.axis, work.xs, 'vent', b), space, zb, id, 'leaf', true).under = leaf.height;
    return;
  }
  work.diagnostics.push(hiddenAirWarning(work, leaf));
}

/**
 * Along P from `from`, by SEAM_SNAP_STEP out to SEAM_SNAP_MM each way, the first b where an opening of this kind has
 * the room and its bore lets out the air of leaf `index`, with its zb; or null.
 */
function seamNearLeaf(work: SeamWork, kind: OpeningKind, from: number, index: number): { b: number; zb: number } | null {
  const { space, settings } = work;
  const r = boreRadius(space.sizes, kind);
  for (let d = 0; d <= SEAM_SNAP_MM + 1e-9; d += SEAM_SNAP_STEP) {
    for (const b of d === 0 ? [from] : [from + d, from - d]) {
      const zb = seamCheck(work, space, kind, b, work.keepPins);
      if (zb !== null && seamLeavesCovered(work.tree, b, r, zb, settings.coverDrop).has(index)) return { b, zb };
    }
  }
  return null;
}

/** A significant leaf's vent id, by its rank among the significant leaves of S. */
function seamLeafVentId(rank: number): string {
  return `b0:vent:${rank}`;
}

/**
 * G13.5's vents: one at every other significant leaf of S that nothing covers yet. A leaf at the top of its column
 * takes a vent at its flat top's middle, or the nearest spot along P with the room that still lets its air out; a
 * hidden leaf takes placeHiddenVent's. Returns the hidden leaves refused, which have S8's warning already.
 */
function placeSeamLeafVents(work: SeamWork, significant: readonly SeamLeaf[]): Set<number> {
  const refused = new Set<number>();
  significant.forEach((leaf, rank) => {
    const id = seamLeafVentId(rank);
    const index = work.tree.leaves.indexOf(leaf);
    if (work.pinnedIds.has(id) || work.removedIds.has(id) || work.covered.has(index)) return;
    if (leaf.hidden) {
      const before = work.diagnostics.length;
      placeHiddenVent(work, index, id);
      if (work.diagnostics.length > before) refused.add(index);
      return;
    }
    const found = seamNearLeaf(work, 'vent', leaf.b, index);
    if (found) seamAdd(work, seamSpot(work.axis, work.xs, 'vent', found.b), work.space, found.zb, id, 'leaf', false);
  });
  return refused;
}

/**
 * Plan 4 on P: extra pours take the next-highest significant leaves at the top of their columns, each replacing that
 * leaf's own vent, wherever along P placeSeamLeafVents put it, at the leaf's flat top or the nearest spot along P that
 * lets its air out. A leaf with no such spot keeps its vent, and the shortfall's line names the room.
 */
function placeSeamExtraPours(work: SeamWork, significant: readonly SeamLeaf[]): void {
  const count = (): number => work.openings.filter((o) => o.kind === 'pour').length;
  let next = 1;
  significant.forEach((leaf, rank) => {
    if (rank === 0 || leaf.hidden || count() >= work.settings.perBody) return;
    while (work.pinnedIds.has(pourId(0, next))) next++;
    const ventId = seamLeafVentId(rank);
    const vent = work.openings.find((o) => o.id === ventId && !o.pinned);
    if (vent) work.openings.splice(work.openings.indexOf(vent), 1);
    const found = seamNearLeaf(work, 'pour', leaf.b, work.tree.leaves.indexOf(leaf));
    if (!found) {
      if (vent) work.openings.push(vent);
      work.roomShort = true;
      return;
    }
    if (vent) work.spaces.delete(vent);
    seamAdd(work, seamSpot(work.axis, work.xs, 'pour', found.b), work.space, found.zb, pourId(0, next++), 'leaf', false);
  });
}

/** A plan of the openings on P, before they are checked, with or without the pins' sockets kept clear. */
interface SeamPlan {
  work: SeamWork;
  plateau: SeamPlacement['plateau'];
  /** Hidden leaves whose vent found no line clear of the model, which have S8's warning already. */
  refused: Set<number>;
}

function planSeam(input: SeamPlacementInput, significant: readonly SeamLeaf[], pins: boolean): SeamPlan {
  const { settings, space, axis, xs, pins: moved = [], removed = [] } = input;
  const work: SeamWork = {
    ...input,
    openings: [],
    spaces: new Map(),
    covered: new Set(),
    pinnedIds: new Set(moved.map((pin) => pin.id)),
    removedIds: new Set(removed),
    diagnostics: [],
    keepPins: pins,
    roomShort: false,
  };
  for (const pin of moved) {
    const spot = seamSpot(axis, xs, pin.kind, seamBOf(axis, pin));
    // A pinned hidden leaf's vent keeps reading its own run's ceiling, so it still reaches that leaf.
    const rank = pin.kind === 'vent' ? significant.findIndex((_, k) => seamLeafVentId(k) === pin.id) : -1;
    const hidden = rank >= 0 && significant[rank].hidden;
    const own = hidden ? hiddenSpace(input, significant[rank]) : space;
    const added = seamAdd(work, spot, own, discMinimum(own.field, spot.x, spot.y, boreRadius(own.sizes, pin.kind)), pin.id, 'pinned', hidden, true);
    if (hidden) added.under = significant[rank].height;
  }
  const plateau = placeSeamPour(work);
  let refused = new Set<number>();
  if (settings.ventsEnabled) {
    placeSeamVentBeside(work);
    refused = placeSeamLeafVents(work, significant);
  }
  placeSeamExtraPours(work, significant);
  return { work, plateau, refused };
}

/**
 * S7c, G13.5: the two-part cover's openings, every one centred on P. Pins first, at (xs, pin.b); then the pour, the vent
 * beside it, a vent at every other significant leaf of S, and any extra pours; then each is checked as S7 checks its
 * own, the funnels on P among them, and the leaves of S no opening covers are reported. The bands keep clear of the
 * pins' sockets unless that costs a pour, a significant leaf's air (a hidden leaf refused counts as without), or more
 * than t / 2 of the first pour's zb, when the plan made without them is taken: `pinsKept` false, which the build passes
 * to the seal so it leaves the pins out with its line. Pure on typed arrays.
 */
export function placeSeamOpenings(input: SeamPlacementInput): SeamPlacement {
  const { tree, settings, space, axis, xs } = input;
  const significant = significantSeamLeaves(tree, settings.ventPersistence);
  const indexes = significant.map((leaf) => tree.leaves.indexOf(leaf));
  let plan = planSeam(input, significant, input.room.pins.length > 0);
  if (plan.work.keepPins) {
    const free = planSeam(input, significant, false);
    const pourCount = (p: SeamPlan): number => p.work.openings.filter((o) => o.kind === 'pour').length;
    const aired = (p: SeamPlan): number => indexes.filter((index) => p.work.covered.has(index)).length;
    const firstZb = (p: SeamPlan): number => firstSeamPour(p.work.openings)?.zb ?? -Infinity;
    if (pourCount(free) > pourCount(plan) || aired(free) > aired(plan) || firstZb(free) > firstZb(plan) + settings.coverDrop) plan = free;
  }
  const { work, plateau, refused } = plan;

  const pours = work.openings.filter((o) => o.kind === 'pour');
  if (pours.length < settings.perBody) {
    const top = tree.leaves[0];
    const at = top ? seamSpot(axis, xs, 'pour', top.b) : null;
    const where = at ? `(${at.x.toFixed(1)}, ${at.y.toFixed(1)})` : '';
    work.diagnostics.push({
      code: 'pour-shortfall',
      severity: pours.length === 0 ? 'error' : 'warning',
      ...(at && top ? { at: [at.x, at.y, top.height] as [number, number, number] } : {}),
      message: !at
        ? `Placed no pour, as the cavity does not reach the seam.`
        : pours.length === 0 || work.roomShort
          ? `Placed ${pours.length} of ${settings.perBody} pours on the seam, whose highest point is at ${where}, as the seam has no more valid room for one with the seal beside it. A smaller pour or seat needs less.`
          : `Placed ${pours.length} of ${settings.perBody} pours on the seam, one at each of its high points open to the top, the highest at ${where}: on the two-part cover extra pours go only to the seam's other high points, and this seam has no more. Set Pours per body to ${pours.length}.`,
    });
  }
  for (const opening of work.openings) {
    const own = work.spaces.get(opening)!;
    const check = checkOpening(own, opening, work.openings);
    const b = seamBOf(axis, opening);
    // Clear of the pins' sockets where the seal keeps them, as the plan placed every opening and a drop on main checks it.
    const room = seamRoomFits(input.room, own.sizes, opening.kind, b, check.zb, work.keepPins);
    opening.valid = check.valid && room;
    opening.zb = check.zb;
    opening.boreLength = boreLength(own, opening);
    if (!opening.valid) {
      const problems = check.problems.map((problem) => describeProblem(problem, opening.kind));
      if (!room) problems.push("the seam's seal beside it has no room there");
      work.diagnostics.push({ code: 'opening-invalid', severity: 'error', at: [opening.x, opening.y, check.zb], message: `The ${opening.kind} at (${opening.x.toFixed(1)}, ${opening.y.toFixed(1)}) is no longer valid: ${problems.join(', ')}. Move it again.` });
    }
    const long = longBoreWarning(own, opening);
    if (long) work.diagnostics.push(long);
  }
  // Plan D3's soft rule, where the first pour does not let out the air of S's highest leaf itself: where its disc reaches
  // that leaf's top run, air gets out there as at the peak, though its centre stands lower, as on Goddess, whose head is
  // too narrow on P for the disc.
  const first = firstSeamPour(work.openings);
  const top = tree.leaves[0];
  const reaches = first && top ? seamLeavesCovered(tree, seamBOf(axis, first), boreRadius(space.sizes, 'pour'), first.zb, settings.coverDrop).has(0) : false;
  const off = first && top && !reaches ? offPeakWarning(space, first, top.height, settings.coverDrop) : null;
  if (off) work.diagnostics.push(off);
  const collision = funnelCollision(space, pours);
  if (collision) work.diagnostics.push(collision);

  const uncovered: UncoveredLeaf[] = [];
  for (const leaf of significant) {
    const index = tree.leaves.indexOf(leaf);
    if (work.covered.has(index)) continue;
    const spot = seamSpot(axis, xs, 'vent', leaf.b);
    uncovered.push({ x: spot.x, y: spot.y, height: leaf.height, persistence: leaf.persistence, airVolume: 0 });
    if (refused.has(index)) continue;
    work.diagnostics.push({ code: 'peak-uncovered', severity: 'warning', at: [spot.x, spot.y, leaf.height], message: `The peak at (${spot.x.toFixed(1)}, ${spot.y.toFixed(1)}) on the seam, ${leaf.persistence.toFixed(1)} mm above its surroundings, has no opening, so air will stay trapped there (assuming the silicone rises slowly).` });
  }
  return { openings: work.openings, plateau, pinsKept: work.keepPins, uncovered, ceilingLeaves: significant.length, diagnostics: work.diagnostics };
}

/**
 * The cutters' openings of a placement on P, each with its own zb, which openingCutters cuts from both halves. A hidden
 * leaf's vent keeps `hidden`, which the cutters ignore, so the export can count its rods and say to cut them at demold.
 */
export function seamCutOpenings(openings: readonly SeamOpening[], sizes: OpeningSizes): CutOpening[] {
  return openings.map((o) =>
    o.kind === 'pour'
      ? { kind: 'pour', x: o.x, y: o.y, zb: o.zb, diameter: sizes.pourDiameter, seatDepth: sizes.seatDepth, seatHalfAngleDeg: sizes.seatHalfAngleDeg }
      : { kind: 'vent', x: o.x, y: o.y, zb: o.zb, diameter: sizes.ventDiameter, ...(o.hidden ? { hidden: true } : {}) },
  );
}
