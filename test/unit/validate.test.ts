import { describe, expect, it } from 'vitest';
import { boreLength, checkOpening, discMinimum, dropOpening, funnelCollision, heightAt, isValid, longBoreWarning, nearestCopy, offPeakWarning, openingSizes, placementSpace, snapOpening, topRadius, type OpeningSizes, type OpeningSpot, type PlacementSpace } from '../../src/core/analysis/validate';
import { describeProblem } from '../../src/core/analysis/placement';
import { defaultParams } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';
import type { Rect } from '../../src/core/solid/rect';
import { fieldOf } from '../fixtures/fieldShapes';

const CELL = 0.25;
const CEILING = 20;
const ZT = 30;
const WALL = 3;
const sizes: OpeningSizes = openingSizes(defaultParams());
const SEAT = topRadius(sizes, 'pour');
const MOUTH = topRadius(sizes, 'vent');
const LAND = sizes.minLand;
/** FL: the funnel's flange at defaults, by hand: the seat's radius at the top, 5 + 3 tan 30, plus the 4 mm flange width. */
const FLANGE = 5 + 3 * Math.tan(Math.PI / 6) + 4;
/** The sizes with no flange, as before FL, where only the land keeps a vent from a pour. */
const unflanged = defaultParams();
unflanged.funnel.flangeWidth = 0;
const plainSizes = openingSizes(unflanged);

/** A cavity with a flat ceiling across x and y in [10, 70] and [10, 50], and a box well around it. */
const cavity = fieldOf(80, 60, CELL, (x, y) => (x >= 10 && x <= 70 && y >= 10 && y <= 50 ? CEILING : 0));
const O: Rect = { x0: -10, y0: -10, x1: 90, y1: 70 };

function spaceOf(offsets: [number, number][] = [[0, 0]], box: Rect = O): PlacementSpace {
  return placementSpace(cavity, { O: box, Zt: ZT, wall: WALL }, offsets, sizes);
}
const pour = (x: number, y: number): OpeningSpot => ({ kind: 'pour', x, y });
const vent = (x: number, y: number): OpeningSpot => ({ kind: 'vent', x, y });

describe('the hard rules', () => {
  const space = spaceOf();

  it('pass a disc well inside the cavity', () => {
    expect(checkOpening(space, pour(40, 30), [])).toEqual({ valid: true, problems: [], zb: CEILING });
  });

  it('reject a disc off the cavity, by any part of it', () => {
    const off = checkOpening(space, pour(5, 30), []);
    expect(off.valid).toBe(false);
    expect(off.problems).toEqual(['off-cavity']);
    expect(off.zb).toBe(0);
    // Half on, half off, with its centre still over the ceiling.
    expect(checkOpening(space, pour(12, 30), []).problems).toEqual(['off-cavity']);
    // The disc's reach, one square diagonal past its rim, must clear the cavity's edge.
    const reach = 5 + CELL * Math.SQRT2;
    expect(checkOpening(space, pour(10 + reach + 0.01, 30), []).valid).toBe(true);
    expect(checkOpening(space, pour(10 + reach - 0.3, 30), []).valid).toBe(false);
  });

  it('ask for 1 mm of ceiling at least, not just a cavity', () => {
    const low = fieldOf(80, 60, CELL, (x) => (x < 40 ? 0.9 : 1.1));
    const space2 = placementSpace(low, { O, Zt: ZT, wall: WALL }, [[0, 0]], sizes);
    expect(checkOpening(space2, pour(20, 30), []).problems).toEqual(['off-cavity']);
    expect(checkOpening(space2, pour(60, 30), []).valid).toBe(true);
  });

  it('reject overlapping seats, and a land under the limit', () => {
    const apart = 2 * SEAT + LAND;
    expect(checkOpening(space, pour(40, 30), [pour(40 + apart + 0.001, 30)]).valid).toBe(true);
    expect(checkOpening(space, pour(40, 30), [pour(40 + apart - 0.01, 30)]).problems).toEqual(['land']);
    expect(checkOpening(space, pour(40, 30), [pour(40 + 5, 30)]).problems).toEqual(['land']);
  });

  it('measure a vent\'s land to its mouth, and to a seat at the flat top', () => {
    // With no flange, as before FL: the flange's own rule is the next test's.
    const plainSpace = placementSpace(cavity, { O, Zt: ZT, wall: WALL }, [[0, 0]], plainSizes);
    const apart = SEAT + MOUTH + LAND;
    expect(MOUTH).toBeCloseTo(1.25 + 0.3, 9);
    expect(checkOpening(plainSpace, vent(40, 30), [pour(40 + apart + 0.001, 30)]).valid).toBe(true);
    expect(checkOpening(plainSpace, vent(40, 30), [pour(40 + apart - 0.01, 30)]).problems).toEqual(['land']);
  });

  it('FL: keep a vent\'s mouth 0.5 mm clear of a pour\'s flange, which the land alone would not, and say it is the flange', () => {
    expect(sizes.flangeRadius).toBeCloseTo(FLANGE, 9);
    const reach = FLANGE + MOUTH + 0.5;
    // The flange's rule is the larger at defaults, by about 3 mm.
    expect(reach - (SEAT + MOUTH + LAND)).toBeCloseTo(4 - LAND + 0.5, 9);
    expect(checkOpening(space, vent(40, 30), [pour(40 + reach + 0.001, 30)]).valid).toBe(true);
    expect(checkOpening(space, vent(40, 30), [pour(40 + reach - 0.01, 30)]).problems).toEqual(['flange']);
    expect(checkOpening(space, vent(40, 30), [pour(40 + SEAT + MOUTH + LAND + 0.5, 30)]).problems).toEqual(['flange']);
    // Closer than the land, both.
    expect(checkOpening(space, vent(40, 30), [pour(40 + 5, 30)]).problems).toEqual(['land', 'flange']);
    // The pour's side of the same pair, which is how a dragged pour meets a vent.
    expect(checkOpening(space, pour(40 + reach - 0.01, 30), [vent(40, 30)]).problems).toEqual(['flange']);
    // In a maker's words, not only the land's.
    expect(describeProblem('flange', 'vent')).toBe("a funnel's flange would rest on it and close it");
    expect(describeProblem('flange', 'pour')).toBe("its funnel's flange would rest on a vent and close it");
    // Between two pours, and two vents, only the land counts: flanges that overlap are the soft rule's.
    expect(checkOpening(space, pour(40, 30), [pour(40 + 2 * SEAT + LAND + 0.001, 30)]).valid).toBe(true);
    expect(checkOpening(space, vent(40, 30), [vent(40 + 2 * MOUTH + LAND + 0.001, 30)]).valid).toBe(true);
    // No funnel, no seat or no flange: no flange to keep clear of.
    for (const change of [(p: Params) => (p.funnel.generate = false), (p: Params) => (p.seat.enabled = false), (p: Params) => (p.funnel.flangeWidth = 0)]) {
      const params = defaultParams();
      change(params);
      expect(openingSizes(params).flangeRadius).toBe(0);
    }
  });

  it('FL: on a grid, keep every copy of a vent clear of every copy of a pour\'s flange', () => {
    const reach = FLANGE + MOUTH + 0.5;
    // 30 mm apart in the first tile, but the vent's copy in the next tile stands reach - 0.5 from the pour.
    const grid = spaceOf([[0, 0], [30 + reach - 0.5, 0]]);
    expect(nearestCopy(grid, 15, 30, 45, 30)).toBeCloseTo(reach - 0.5, 9);
    expect(checkOpening(grid, vent(15, 30), [pour(45, 30)]).problems).toEqual(['flange']);
    expect(isValid(grid, vent(15, 30), [pour(45, 30)])).toBe(false);
    expect(checkOpening(spaceOf([[0, 0], [30 + reach + 0.5, 0]]), vent(15, 30), [pour(45, 30)]).valid).toBe(true);
  });

  it('FL: snap a vent dropped under a flange out to where its mouth is clear', () => {
    const space2 = spaceOf();
    const taken = pour(40, 30);
    const spot = snapOpening(space2, vent(40 + 10, 30), [taken])!;
    const apart = Math.hypot(spot.x - 40, spot.y - 30);
    expect(apart).toBeGreaterThanOrEqual(FLANGE + MOUTH + 0.5);
    expect(apart).toBeLessThanOrEqual(FLANGE + MOUTH + 0.5 + 0.25);
    const drop = dropOpening(space2, vent(40 + 10, 30), [taken]);
    // Valid where it lands, and with why it could not stay where it was dropped, for the note that says so.
    expect(drop).toMatchObject({ snapped: true, valid: true, problems: [], refused: ['flange'] });
    expect(checkOpening(space2, vent(40 + 10, 30), [taken]).problems).toEqual(['flange']);
    expect(dropOpening(space2, vent(40 + 20, 30), [taken])).toMatchObject({ snapped: false, valid: true, refused: [] });
  });

  it('do not hold an opening against itself', () => {
    const spot = pour(40, 30);
    expect(checkOpening(space, spot, [spot]).valid).toBe(true);
  });

  it('FL: keep a pour\'s flange on the flat of the top, inside its chamfer, where that is more than a wall past the seat', () => {
    const near = { x0: 0, y0: 0, x1: 80, y1: 60 };
    const tight = spaceOf([[0, 0]], near);
    // 4 mm of flange past the seat's edge against a 3 mm wall, and the 0.4 mm top chamfer.
    const inset = FLANGE + 0.4;
    expect(inset).toBeGreaterThan(WALL + SEAT);
    expect(checkOpening(tight, pour(inset + 0.01, 30), []).problems).not.toContain('top-edge');
    expect(checkOpening(tight, pour(inset - 0.01, 30), []).problems).toContain('top-edge');
    expect(checkOpening(tight, pour(40, 60 - inset + 0.01), []).problems).toContain('top-edge');
    // A vent's inset is its own, as before.
    expect(checkOpening(tight, vent(WALL + MOUTH + 0.01, 30), []).problems).not.toContain('top-edge');
  });

  it('keep a seat inside the top by a wall', () => {
    const near = { x0: 0, y0: 0, x1: 80, y1: 60 };
    // With no flange, as before FL.
    const tight = placementSpace(cavity, { O: near, Zt: ZT, wall: WALL }, [[0, 0]], plainSizes);
    const inset = WALL + SEAT;
    expect(checkOpening(tight, pour(inset + 0.01, 30), []).problems).not.toContain('top-edge');
    expect(checkOpening(tight, pour(inset - 0.01, 30), []).problems).toContain('top-edge');
    expect(checkOpening(tight, pour(80 - inset - 0.01, 30), []).problems).not.toContain('top-edge');
    expect(checkOpening(tight, pour(80 - inset + 0.01, 30), []).problems).toContain('top-edge');
    expect(checkOpening(tight, pour(40, 60 - inset + 0.01), []).problems).toContain('top-edge');
    // A smaller opening may sit closer than a seat can.
    expect(checkOpening(tight, vent(WALL + MOUTH + 0.01, 30), []).problems).not.toContain('top-edge');
  });

  it('report every rule that fails', () => {
    const near = { x0: 0, y0: 0, x1: 80, y1: 60 };
    expect(checkOpening(spaceOf([[0, 0]], near), pour(2, 30), [pour(5, 30)]).problems.sort()).toEqual(['land', 'off-cavity', 'top-edge']);
  });
});

describe('the hard rules across a grid', () => {
  it('see a seat collide with its own copy in the next tile', () => {
    const fits = 2 * SEAT + LAND;
    const close = spaceOf([[0, 0], [fits - 0.5, 0]]);
    const far = spaceOf([[0, 0], [fits + 0.5, 0]]);
    expect(checkOpening(far, pour(30, 30), []).valid).toBe(true);
    expect(checkOpening(close, pour(30, 30), []).problems).toEqual(['land']);
  });

  it('see two different openings collide in neighbouring tiles only', () => {
    const space = spaceOf([[0, 0], [25, 0]]);
    // 22 apart in the first tile, but the next copy of the second stands right beside the first.
    expect(nearestCopy(space, 34, 30, 12, 30)).toBeCloseTo(3, 9);
    expect(checkOpening(space, vent(34, 30), [vent(12, 30)]).problems).toEqual(['land']);
    expect(checkOpening(spaceOf(), vent(34, 30), [vent(12, 30)]).valid).toBe(true);
  });

  it('see only as far as the grid goes', () => {
    const space = spaceOf([[0, 0], [30, 0]]);
    // Three pitches off, and the grid has only one to offer.
    expect(nearestCopy(space, 100, 30, 10, 30)).toBeCloseTo(60, 9);
    const grid = spaceOf([[0, 0], [30, 0], [0, 25], [30, 25]]);
    expect(nearestCopy(grid, 20, 40, 18, 16)).toBeCloseTo(Math.hypot(2, 1), 9);
  });

  it('check the disc of every copy, and the top over the last', () => {
    // The copy at +45 of a spot at x = 30 is off the cavity at 75.
    const space = spaceOf([[0, 0], [45, 0]]);
    expect(checkOpening(space, pour(30, 30), []).problems).toEqual(['off-cavity']);
    expect(checkOpening(space, pour(18, 30), []).valid).toBe(true);
    const narrow = spaceOf([[0, 0], [45, 0]], { x0: -10, y0: -10, x1: 70, y1: 70 });
    expect(checkOpening(narrow, pour(18, 30), []).problems).toEqual(['top-edge']);
  });
});

describe('the fast check', () => {
  /** Random spots over the box and past it: how many the full check passes, and how many it fails for the flange alone. */
  function agree(space: PlacementSpace, others: OpeningSpot[]): { goods: number; flangeOnly: number } {
    let seed = 42;
    const random = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let goods = 0, flangeOnly = 0;
    for (let k = 0; k < 2000; k++) {
      const spot: OpeningSpot = { kind: random() < 0.5 ? 'pour' : 'vent', x: -5 + random() * 90, y: -5 + random() * 70 };
      const check = checkOpening(space, spot, others);
      expect(isValid(space, spot, others), `${spot.kind} at ${spot.x}, ${spot.y}`).toBe(check.valid);
      if (check.valid) goods++;
      if (check.problems.join() === 'flange') flangeOnly++;
    }
    return { goods, flangeOnly };
  }

  it('always says the same as the full one', () => {
    // With no flange, as before FL, on a 2 x 2 grid.
    const grid = placementSpace(cavity, { O, Zt: ZT, wall: WALL }, [[0, 0], [25, 0], [0, 20], [25, 20]], plainSizes);
    expect(agree(grid, [pour(32, 20), vent(15, 15)]).goods).toBeGreaterThan(20);
    // FL: with the flange, on one tile, where the flange's rule alone turns many spots away.
    const flanged = agree(spaceOf(), [pour(32, 20), vent(60, 40)]);
    expect(flanged.goods).toBeGreaterThan(200);
    expect(flanged.flangeOnly).toBeGreaterThan(20);
  });
});

describe('zb and H(o)', () => {
  it('reads one square diagonal past the rim, so a bore on a steep wall leaves no sliver under it', () => {
    const slope = fieldOf(40, 40, 0.5, (x) => (x > 20 ? 30 : 10));
    // Nodes at the wall on either side of a disc whose rim just stops short of the low side.
    const atRim = discMinimum(slope, 25.2, 20, 5);
    expect(atRim).toBe(10);
    expect(discMinimum(slope, 26, 20, 5)).toBe(30);
  });

  it('reads 0 off the grid and over no cavity', () => {
    expect(discMinimum(cavity, -100, 30, 5)).toBe(0);
    expect(discMinimum(cavity, 5, 30, 1)).toBe(0);
  });

  it('interpolates H(o) between nodes', () => {
    const ramp = fieldOf(40, 40, 0.5, (x) => x);
    expect(heightAt(ramp, 10.25, 20.1)).toBeCloseTo(10.25, 5);
    expect(heightAt(ramp, -5, 20)).toBe(0);
  });

  it('gives a bore\'s length on sloped ground from the ceiling at its centre, not under its disc, and the longest copy\'s', () => {
    const ramp = fieldOf(80, 60, CELL, (x) => 5 + x / 2);
    const one = placementSpace(ramp, { O, Zt: 60, wall: WALL }, [[0, 0]], sizes);
    expect(boreLength(one, pour(30.1, 30))).toBeCloseTo(60 - (5 + 30.1 / 2), 5);
    expect(boreLength(one, vent(52.3, 30))).toBeCloseTo(60 - (5 + 52.3 / 2), 5);
    // The disc's lowest point is 2.5 mm lower here, which is zb and not the length.
    expect(discMinimum(ramp, 30.1, 30, 5)).toBeLessThan(5 + 30.1 / 2 - 2.5);
    // A copy further up the slope has the shorter bore.
    const two = placementSpace(ramp, { O, Zt: 60, wall: WALL }, [[0, 0], [20, 0]], sizes);
    expect(boreLength(two, pour(30.1, 30))).toBeCloseTo(60 - (5 + 30.1 / 2), 5);
    const down = placementSpace(ramp, { O, Zt: 60, wall: WALL }, [[0, 0], [-20, 0]], sizes);
    expect(boreLength(down, pour(30.1, 30))).toBeCloseTo(60 - (5 + 10.1 / 2), 5);
  });
});

describe('the snap', () => {
  it('leaves a valid drop where it is', () => {
    expect(snapOpening(spaceOf(), pour(40, 30), [])).toEqual({ x: 40, y: 30 });
  });

  it('moves a drop off the cavity back on it, by the shortest way, to the edge of the valid ground', () => {
    const space = spaceOf();
    const spot = snapOpening(space, pour(0, 30), [])!;
    expect(checkOpening(space, { kind: 'pour', ...spot }, []).valid).toBe(true);
    // Valid once the last empty node, a cell short of the cavity's edge, is out of the disc's reach.
    const edge = 10 - CELL + 5 + CELL * Math.SQRT2;
    expect(checkOpening(space, pour(edge, 30), []).valid).toBe(false);
    expect(checkOpening(space, pour(edge + 0.001, 30), []).valid).toBe(true);
    // Its rings are a quarter of a mm apart, and it closes in on that edge from the ring it hit.
    expect(spot.x).toBeGreaterThan(edge);
    expect(spot.x).toBeLessThan(edge + 0.01);
    expect(spot.y).toBeCloseTo(30, 9);
  });

  it('moves a drop off another opening, and lands clear of it', () => {
    const space = spaceOf();
    const taken = pour(40, 30);
    const spot = snapOpening(space, pour(41, 30), [taken])!;
    expect(checkOpening(space, { kind: 'pour', ...spot }, [taken]).valid).toBe(true);
    const apart = Math.hypot(spot.x - 40, spot.y - 30);
    expect(apart).toBeGreaterThanOrEqual(2 * SEAT + LAND);
    expect(apart).toBeLessThanOrEqual(2 * SEAT + LAND + 1);
  });

  it('finds the nearest valid spot to within its step, against a brute force by the full check', () => {
    const space = spaceOf();
    const others = [pour(30, 25), pour(50, 35), vent(62, 20)];
    // Every valid point of a lattice twice as fine as the snap's step, by checkOpening alone.
    const fine = 0.125;
    const valid: [number, number][] = [];
    for (let x = 10; x <= 70; x += fine) {
      for (let y = 10; y <= 50; y += fine) if (checkOpening(space, pour(x, y), others).valid) valid.push([x, y]);
    }
    expect(valid.length).toBeGreaterThan(1000);
    let seed = 2024;
    const random = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let k = 0; k < 25; k++) {
      const spot = pour(-5 + random() * 90, -5 + random() * 70);
      const snapped = snapOpening(space, spot, others)!;
      expect(checkOpening(space, { kind: 'pour', ...snapped }, others).valid).toBe(true);
      const moved = Math.hypot(snapped.x - spot.x, snapped.y - spot.y);
      const nearest = Math.min(...valid.map(([x, y]) => Math.hypot(x - spot.x, y - spot.y)));
      // The rings are a step apart, so the first that has a valid point is at most a step past the nearest.
      expect(moved, `drop ${k}`).toBeLessThanOrEqual(nearest + 0.25);
    }
  });

  it('lands only where it is told it may, and searches on for such a place', () => {
    const space = spaceOf();
    const spot = snapOpening(space, pour(0, 30), [], (x) => x > 40)!;
    expect(spot.x).toBeGreaterThan(40);
    expect(spot.x).toBeLessThan(40.3);
    expect(checkOpening(space, { kind: 'pour', ...spot }, []).valid).toBe(true);
    expect(snapOpening(space, pour(0, 30), [], () => false)).toBeNull();
  });

  it('says so when no spot is valid, rather than leave the rest to the caller', () => {
    const tiny = fieldOf(80, 60, CELL, (x, y) => (Math.hypot(x - 40, y - 30) < 3 ? CEILING : 0));
    const none = placementSpace(tiny, { O, Zt: ZT, wall: WALL }, [[0, 0]], sizes);
    expect(snapOpening(none, pour(40, 30), [])).toBeNull();
    expect(snapOpening(spaceOf([[0, 0], [5, 0]]), pour(30, 30), [])).toBeNull();
    const small = spaceOf([[0, 0]], { x0: 30, y0: 20, x1: 40, y1: 30 });
    expect(snapOpening(small, pour(40, 30), [])).toBeNull();
  });

  it('is cheap: drops at the far side of a large field take a fraction of a frame each', () => {
    const large = fieldOf(400, 400, CELL, (x, y) => (Math.hypot(x - 200, y - 200) < 30 ? CEILING : 0));
    const space = placementSpace(large, { O: { x0: 0, y0: 0, x1: 400, y1: 400 }, Zt: ZT, wall: WALL }, [[0, 0]], sizes);
    snapOpening(space, pour(390, 390), []);
    const started = performance.now();
    for (let k = 0; k < 20; k++) expect(snapOpening(space, pour(5 + k, 390), [])).not.toBeNull();
    // A generous limit, on a field of 2.5M nodes: the map above is what makes this hold.
    expect((performance.now() - started) / 20).toBeLessThan(50);
  });
});

describe('the soft rules', () => {
  const tallOpening = fieldOf(80, 60, CELL, (x, y) => (x >= 10 && x <= 70 && y >= 10 && y <= 50 ? 5 : 0));

  it('warn at a vent past L/d of 40 and a pour bore past 60 mm', () => {
    const at = (Zt: number): PlacementSpace => placementSpace(tallOpening, { O, Zt, wall: WALL }, [[0, 0]], sizes);
    const maxVent = 40 * sizes.ventDiameter;
    expect(longBoreWarning(at(5 + maxVent - 0.1), vent(40, 30))).toBeNull();
    expect(longBoreWarning(at(5 + maxVent + 0.1), vent(40, 30))?.code).toBe('long-vent');
    expect(longBoreWarning(at(5 + 60 - 0.1), pour(40, 30))).toBeNull();
    expect(longBoreWarning(at(5 + 60 + 0.1), pour(40, 30))?.code).toBe('long-pour');
    expect(longBoreWarning(at(5 + 60 + 0.1), pour(40, 30))?.severity).toBe('warning');
  });

  it('warn when a first pour stands more than t/2 under the peak', () => {
    const space = spaceOf();
    expect(offPeakWarning(space, pour(40, 30), CEILING + 1, 1.5)).toBeNull();
    expect(offPeakWarning(space, pour(40, 30), CEILING + 2, 1.5)?.code).toBe('pour-off-peak');
    expect(offPeakWarning(space, vent(40, 30), CEILING + 2, 1.5)).toBeNull();
  });

  it('warn when funnels collide, within a tile and between tiles, and say what would fit', () => {
    const space = spaceOf();
    expect(funnelCollision(space, [pour(20, 30), pour(60, 30)])).toBeNull();
    const near = funnelCollision(space, [pour(20, 30), pour(45, 30)])!;
    expect(near.code).toBe('funnel-collision');
    expect(near.message).toContain('25.0 mm apart');
    expect(near.message).toContain('top diameter of 24 mm');
    expect(funnelCollision(spaceOf([[0, 0], [22, 0]]), [pour(20, 30)])?.message).toContain('22.0 mm apart');
    expect(funnelCollision(spaceOf([[0, 0], [41, 0]]), [pour(20, 30)])).toBeNull();
  });

  it('for one pour, count only the pairs it is in', () => {
    const space = spaceOf();
    const moved = pour(100, 30);
    // Two other pours collide with each other, 25 mm apart, but not with the one asked about.
    const pours = [moved, pour(20, 30), pour(45, 30)];
    expect(funnelCollision(space, pours)?.message).toContain('25.0 mm apart');
    expect(funnelCollision(space, pours, moved)).toBeNull();
    expect(funnelCollision(space, pours, pours[2])?.message).toContain('25.0 mm apart');
  });

  it('FL: count a flange wider than the rim, say when it would cover the other pour\'s seat, and size the flange in the advice', () => {
    const params = defaultParams();
    params.funnel.topDiameter = 15;
    const small = placementSpace(cavity, { O, Zt: ZT, wall: WALL }, [[0, 0]], openingSizes(params));
    // The rim alone fits 18 mm apart, the flange, 2 x 10.73 mm across, does not.
    expect(funnelCollision(placementSpace(cavity, { O, Zt: ZT, wall: WALL }, [[0, 0]], openingSizes(Object.assign(defaultParams(), { funnel: { ...params.funnel, flangeWidth: 0 } }))), [pour(20, 30), pour(38, 30)])).toBeNull();
    const wide = funnelCollision(small, [pour(20, 30), pour(38, 30)])!;
    expect(wide.message).toContain(`Funnels with flanges ${(2 * FLANGE).toFixed(1)} mm across collide, as two pours are only 18.0 mm apart.`);
    expect(wide.message).not.toContain('seat');
    // At 17 mm the room left is 16, so the flange may be at most 8 - 6.73 = 1.2 mm wide.
    const close = funnelCollision(small, [pour(20, 30), pour(37, 30)])!;
    expect(close.message).toContain("A funnel's flange would also cover part of the other pour's seat");
    expect(close.message).toContain('Funnels with a flange width of at most 1.2 mm would fit.');
    // One at a time still puts its flange over the other seat, so it says what width keeps it off:
    // 17 mm less the two seats of 6.73 and the 0.5 mm gap, 3 mm.
    expect(close.message).toContain("To pour through one funnel at a time instead, a flange width of at most 3 mm keeps its flange off the other pour's seat.");
    expect(wide.message).not.toContain('one funnel at a time');
    // At 14 mm apart, inside the two seats and the gap, only no flange does.
    expect(funnelCollision(small, [pour(20, 30), pour(34, 30)])!.message).toContain('To pour through one funnel at a time instead, use no flange (a flange width of 0), as any would reach the other pour\'s seat.');
    // With the default 40 mm top both must shrink.
    expect(funnelCollision(spaceOf(), [pour(20, 30), pour(37, 30)])!.message).toContain('A top diameter of 16 mm with a flange width of at most 1.2 mm would fit.');
    // x8's 22 mm pitch: the 40 mm rim collides, and a 21 mm top alone would still leave the flange too wide.
    expect(funnelCollision(spaceOf([[0, 0], [22, 0]]), [pour(20, 30)])!.message).toBe('Funnels of 40 mm collide, as two pours are only 22.0 mm apart. A top diameter of 21 mm with a flange width of at most 3.7 mm would fit.');
  });

  it('say so when no funnel fits at all, and nothing when no funnel is made', () => {
    expect(funnelCollision(spaceOf(), [pour(20, 30), pour(33, 30)])?.message).toContain('No funnel fits');
    const params = defaultParams();
    params.funnel.generate = false;
    const off = placementSpace(cavity, { O, Zt: ZT, wall: WALL }, [[0, 0]], openingSizes(params));
    expect(funnelCollision(off, [pour(20, 30), pour(33, 30)])).toBeNull();
  });
});

describe('a drop', () => {
  it('stays put when valid, and says what is soft about it', () => {
    const space = spaceOf();
    const result = dropOpening(space, pour(40, 30), [pour(10 + 9, 22)], { height: CEILING + 2, drop: 1.5 });
    expect(result).toMatchObject({ x: 40, y: 30, snapped: false, valid: true, problems: [] });
    expect(result.warnings.map((w) => w.code).sort()).toEqual(['funnel-collision', 'pour-off-peak']);
  });

  it('snaps when invalid, to a place that then passes', () => {
    const space = spaceOf();
    const result = dropOpening(space, pour(0, 30), []);
    expect(result.snapped).toBe(true);
    expect(result.valid).toBe(true);
    expect(checkOpening(space, pour(result.x, result.y), []).valid).toBe(true);
  });

  it('stays where it was and says why, when nowhere is valid', () => {
    const result = dropOpening(spaceOf([[0, 0], [5, 0]]), pour(30, 30), []);
    expect(result).toMatchObject({ x: 30, y: 30, snapped: false, valid: false, problems: ['land'] });
  });
});
