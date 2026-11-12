import { mapCavities } from '../field/cavities';
import type { Field } from '../field/grid';
import type { Bounds } from '../mesh/weld';
import { resolveAuto } from '../params/defaults';
import type { Params } from '../params/schema';
import type { CutOpening } from '../parts/openings';
import type { Diagnostic } from '../report/diagnostics';
import { BURIED, type Body, type BodyOptions } from './bodies';
import { leavesCovered, mergeTree, significantLeaves } from './peaks';
import { boreLength, boreRadius, checkOpening, clearOfFlanges, discMinimum, flangeOutreachesLand, flangeReach, flangeSpacing, funnelCollision, heightAt, isValid, longBoreWarning, MIN_CEILING, offPeakWarning, snapOpening, topRadius, ventLand, widestFlangeInLand, type HardProblem, type OpeningKind, type OpeningSizes, type OpeningSpot, type PlacementSpace } from './validate';

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

/** The same placement work with every funnel's flange this many mm wide, 0 for none. */
function withFlangeWidth(work: Work, width: number): Work {
  const { sizes } = work.space;
  const flanged: OpeningSizes = { ...sizes, flangeRadius: width > 0 ? topRadius(sizes, 'pour') + width : 0 };
  return { ...work, space: { ...work.space, sizes: flanged } };
}

/** Flange widths are tried this far apart when a vent beside a pour finds no room clear of the one set. */
const FLANGE_TRY_STEP = 0.5;

/**
 * FL: when the flange is what leaves no room for the vent beside a pour, the widest flange that would,
 * in FLANGE_TRY_STEP below the one set, down to the widest the land alone keeps clear (1 mm at defaults),
 * where every vent stands as with none; 0 if only no flange would; null if even that has no room.
 */
function widestFlangeWithRoom(work: Work, pour: OpeningSpot): number | null {
  const { sizes } = work.space;
  if (!flangeOutreachesLand(sizes)) return null;
  const set = sizes.flangeRadius - topRadius(sizes, 'pour');
  const plain = widestFlangeInLand(sizes.minLand);
  for (let width = Math.ceil(set / FLANGE_TRY_STEP - 1e-9) * FLANGE_TRY_STEP - FLANGE_TRY_STEP; width > plain; width -= FLANGE_TRY_STEP) {
    if (ventBesidePour(withFlangeWidth(work, width), pour)) return width;
  }
  return ventBesidePour(withFlangeWidth(work, plain), pour) ? plain : null;
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
      ventLowNote(work, pour, spot);
      add(work, spot, id, b, 'beside');
      return;
    }
    if (typeof floor === 'number') {
      crowded.push(pour);
      return;
    }
    // FL: the flange keeps the vent further out than the land would, which can be why a small model has no
    // room; the warning says so only where a narrower flange would make room, and names the widest.
    const width = widestFlangeWithRoom(work, pour);
    const flange = width === null
      ? ''
      : width > 0
        ? ` clear of its funnel's flange: a Flange width of at most ${width} mm under Pour & funnel leaves room for one`
        : " clear of its funnel's flange: only with no flange (Flange width 0 under Pour & funnel) is there room for one";
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

/**
 * FL: on a peaked top the flange's room pushes the vent beside a pour down the slope. Where it then stands
 * more than t / 2 lower than it would with no flange, a note says so: the air above it there leaves only
 * up the pour, and a narrower flange lets the vent stand nearer.
 */
function ventLowNote(work: Work, pour: OpeningSpot, spot: OpeningSpot): void {
  const { sizes, field } = work.space;
  if (!flangeOutreachesLand(sizes)) return;
  const plain = widestFlangeInLand(sizes.minLand);
  const near = ventBesidePour(withFlangeWidth(work, plain), pour);
  if (!near) return;
  const drop = heightAt(field, near.x, near.y) - heightAt(field, spot.x, spot.y);
  if (drop <= work.settings.coverDrop) return;
  const out = (o: OpeningSpot): string => Math.hypot(o.x - pour.x, o.y - pour.y).toFixed(1);
  const narrower = plain > 0 ? `A Flange width of at most ${plain} mm under Pour & funnel lets the vent stand ${out(near)} mm out` : `Only with no flange (Flange width 0 under Pour & funnel) does the vent stand ${out(near)} mm out`;
  work.diagnostics.push({
    code: 'vent-low',
    severity: 'info',
    message: `The vent at (${spot.x.toFixed(1)}, ${spot.y.toFixed(1)}) beside the pour stands ${out(spot)} mm from it to clear its funnel's flange, where the ceiling is ${drop.toFixed(1)} mm lower than ${out(near)} mm out, so the air in between leaves only up the pour: pour slowly. ${narrower}.`,
  });
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
    const roomy = flangeSpacing(sizes) > 2 * topRadius(sizes, 'pour') + sizes.minLand + 1e-6
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

/**
 * S7, per body on the single tile, then replicated by the export plan and validated against the
 * composite. First pours and vents of all bodies go before any extra pour, so a body's extras cannot
 * take the place that another body's first pour needs. Pure on typed arrays: this runs in field.worker.
 */
export function placeOpenings(input: PlacementInput): Placement {
  const { bodies, settings, space, pins = [], removed = [] } = input;
  const work: Work = {
    ...input,
    openings: [],
    covered: bodies.map(() => new Set<number>()),
    pinnedIds: new Set(pins.map((pin) => pin.id)),
    removedIds: new Set(removed),
    diagnostics: [],
  };

  // Pins first: whatever else is placed must keep its land from them.
  for (const pin of pins) {
    const match = /^b(\d+):/.exec(pin.id);
    add(work, { kind: pin.kind, x: pin.x, y: pin.y }, pin.id, match ? Number(match[1]) : -1, 'pinned', true);
  }

  // FL: where the flange reaches past the land, a vent beside a first pour keeps clear of every flange, so it
  // takes about 2 x 12.8 mm of a body's top from its other pours: placed first, it leaves x8's barriers at 3
  // pours room for the third only down a flank, or none, and at 2 pours sends a barrier's second pour into the
  // trench beside it. So with more than one pour per body the pours go first, and the vent where their flanges
  // leave room as high up, or none, as the other pours open the top too. A flange the land already keeps
  // clear (1 mm at defaults) keeps the order of before FL, and with it every opening.
  const poursFirst = settings.ventsEnabled && settings.perBody > 1 && flangeOutreachesLand(space.sizes);
  placeFirstPours(work);
  const before = poursFirst ? besideHeights(work) : undefined;
  if (settings.ventsEnabled && !poursFirst) placeVentsBeside(work);
  if (settings.ventsEnabled) placeLeafVents(work);
  placeExtraPours(work);
  if (poursFirst) placeVentsBeside(work, before);
  openLeftoverCavities(work);

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

  const collision = funnelCollision(space, work.openings.filter((opening) => opening.kind === 'pour'));
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
