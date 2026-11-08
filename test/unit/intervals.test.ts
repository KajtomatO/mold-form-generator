import type { ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { airReport } from '../../src/core/analysis/air';
import { cavityEdge, demoldReport, PLAUSIBLE_LIMIT_MM3, type DemoldOptions, type DemoldReport } from '../../src/core/analysis/demold';
import { analyseIntervals, type IntervalReport } from '../../src/core/analysis/intervals';
import { cupAir } from '../fixtures/fieldOracles';
import { loadManifold } from '../fixtures/loadExamples';
import { insideMesh } from '../fixtures/rays';
import { arch, blindHoledBlock, blockOnFeet, box, cabin, CABIN, CUP, cup, engravedBlock, holedBlock, HOLED_BLOCK, inverted, invertedCup, join, mushroom, MUSHROOM, standingRing, STANDING_RING, ventedInvertedCup } from '../fixtures/synthetic';

let api: ManifoldToplevel;
beforeAll(async () => {
  api = await loadManifold();
});

const CELL = 0.25;
/** The defaults: 0.05 ml and 5 mm2. */
const OPTIONS: DemoldOptions = { minVolume: 50, minIsland: 5, outside: () => null };

const demold = (s8: IntervalReport, options: Partial<DemoldOptions> = {}): DemoldReport => demoldReport(s8, { ...OPTIONS, ...options });

/** Every verdict but plausible must say where it holds. */
function hasHint(report: DemoldReport): void {
  if (report.verdict !== 'plausible') expect(report.hints.length).toBeGreaterThan(0);
}

describe('S8 and the demold report on synthetic shapes', () => {
  it('a ring standing on its edge is cut-required: the silicone through it opens at two mouths', () => {
    const s8 = analyseIntervals(standingRing(api), CELL);
    expect(s8.shells).toHaveLength(1);
    const through = s8.silicone.filter((s) => s.kind === 'sandwiched' && s.volume >= 50);
    expect(through).toHaveLength(1);
    expect(through[0].mouths).toBe(2);
    // The hole: a cylinder of the inner radius through the ring's depth.
    const { inner, depth } = STANDING_RING;
    expect(Math.abs(through[0].volume / (Math.PI * inner * inner * depth) - 1)).toBeLessThan(0.03);
    const report = demold(s8);
    expect(report.verdict).toBe('cut-required');
    expect(report.bodies[0].loopLock).toBe(false);
    const hint = report.hints.find((h) => h.reason === 'sandwiched' && h.mouths === 2)!;
    // At the middle of the hole.
    expect(Math.hypot(hint.at[0], hint.at[1])).toBeLessThan(0.5);
    expect(Math.abs(hint.at[2] - (STANDING_RING.outer - STANDING_RING.flat))).toBeLessThan(0.5);
    hasHint(report);
  });

  it('a block with a hole through it is cut-required with two mouths, one at each face', () => {
    const s8 = analyseIntervals(holedBlock(api), CELL);
    const through = s8.silicone.filter((s) => s.kind === 'sandwiched' && s.volume >= 50);
    expect(through).toHaveLength(1);
    expect(through[0].mouths).toBe(2);
    const { side, holeRadius } = HOLED_BLOCK;
    expect(Math.abs(through[0].volume / (Math.PI * holeRadius * holeRadius * side) - 1)).toBeLessThan(0.03);
    const report = demold(s8);
    expect(report.verdict).toBe('cut-required');
    expect(report.hints[0].mouths).toBe(2);
  });

  it('negative control: the same hole closed at one end opens at one mouth, so the block is jacket-out and not cut-required', () => {
    const report = demold(analyseIntervals(blindHoledBlock(api), CELL));
    expect(report.hints[0].mouths).toBe(1);
    expect(report.verdict).toBe('jacket-out');
  });

  it('a mushroom is jacket-out, with the hint at its stem, in the silicone and not in the stem', () => {
    const mesh = mushroom(api);
    const s8 = analyseIntervals(mesh, CELL);
    const report = demold(s8);
    expect(report.verdict).toBe('jacket-out');
    expect(report.bodies[0].loopLock).toBe(false);
    const hint = report.hints[0];
    expect(hint.reason).toBe('under-plug');
    expect(hint.cuts).toBe(false);
    // The silicone under the cap is a ring round the stem, so its middle is the stem's axis, in the model.
    // The hint goes to the silicone nearest it instead: against the stem, within a column or two of it.
    const body = s8.silicone.find((b) => b.volume >= 50)!;
    expect(Math.hypot(body.centroid[0], body.centroid[1])).toBeLessThan(MUSHROOM.stemRadius / 4);
    expect(insideMesh(mesh, body.centroid)).toBe(true);
    const off = Math.hypot(hint.at[0], hint.at[1]);
    expect(off).toBeGreaterThan(MUSHROOM.stemRadius);
    expect(off).toBeLessThan(MUSHROOM.stemRadius + 2 * CELL);
    expect(insideMesh(mesh, hint.at)).toBe(false);
    // At the centroid's height, which is half the stem's.
    expect(hint.at[2]).toBeCloseTo(body.centroid[2], 6);
    expect(hint.at[2]).toBeGreaterThan(0);
    expect(hint.at[2]).toBeLessThan(MUSHROOM.stemHeight);
    // Under the cap, round the stem: the ring between the two radii, up to the cap's flat underside.
    const { stemRadius, stemHeight, capRadius } = MUSHROOM;
    expect(Math.abs(hint.volume / (Math.PI * (capRadius ** 2 - stemRadius ** 2) * stemHeight) - 1)).toBeLessThan(0.03);
  });

  it('an arch stands on two footprints of one shell, a loop lock, with the hint between its legs', () => {
    const s8 = analyseIntervals(arch(api), CELL);
    expect(s8.shells).toHaveLength(1);
    expect(s8.shells[0].footprints.map((f) => s8.footprints[f].area)).toEqual([100, 100]);
    const report = demold(s8);
    expect(report.bodies[0].loopLock).toBe(true);
    expect(report.verdict).toBe('cut-required');
    const lock = report.hints.find((h) => h.reason === 'loop-lock')!;
    expect(lock.footprints).toBe(2);
    // Legs at x 0 to 10 and 30 to 40, the bridge from z 20: the hint is in the space under it.
    expect(lock.at[0]).toBeGreaterThan(10);
    expect(lock.at[0]).toBeLessThan(30);
    expect(lock.at[1]).toBeGreaterThanOrEqual(0);
    expect(lock.at[1]).toBeLessThanOrEqual(10);
    expect(lock.at[2]).toBeLessThan(20);
    // The silicone under the bridge does not get a second hint of its own.
    expect(report.hints).toHaveLength(1);
  });

  it('a cabin on its deck: the silicone in it runs round its four posts, so it holds in a loop with one mouth all round', () => {
    const mesh = cabin(api, 'corners');
    const s8 = analyseIntervals(mesh, CELL);
    expect(s8.shells).toHaveLength(1);
    const room = s8.silicone.find((s) => s.kind === 'sandwiched' && s.volume >= 50)!;
    // The room between deck and roof, less the posts: (40 x 30 - 4 x 16) x 20.
    const { deck, roofZ, post } = CABIN;
    expect(Math.abs(room.volume / ((deck[0] * deck[1] - 4 * post * post) * (roofZ - deck[2])) - 1)).toBeLessThan(0.01);
    // The overhang makes the edge one mouth; the posts are four walls inside it.
    expect(room.mouths).toBe(1);
    expect(room.walls).toBe(4);
    const report = demold(s8);
    expect(report.verdict).toBe('cut-required');
    expect(report.bodies[0].loopLock).toBe(false);
    expect(report.hints[0]).toMatchObject({ reason: 'sandwiched', walls: 4, cuts: true });
    expect(insideMesh(mesh, report.hints[0].at)).toBe(false);
    hasHint(report);
  });

  it('negative control: a roof on one post in the middle is a table, which the silicone can stretch off, so jacket-out', () => {
    const s8 = analyseIntervals(cabin(api, 'middle'), CELL);
    const room = s8.silicone.find((s) => s.kind === 'sandwiched' && s.volume >= 50)!;
    expect(room.mouths).toBe(1);
    expect(room.walls).toBe(1);
    const report = demold(s8);
    expect(report.verdict).toBe('jacket-out');
    expect(report.hints.every((h) => !h.cuts)).toBe(true);
  });

  it('a patch of the footprint ringed by an engraving the plate seals is one place with the rest, so no loop lock', () => {
    const s8 = analyseIntervals(engravedBlock(api, false), CELL);
    expect(s8.sealed).toHaveLength(1);
    expect(s8.sealed[0].onPlane).toBe(true);
    // The block's underside less the ring, and the island inside the ring, 16 mm2: one patch.
    expect(s8.footprints.map((f) => f.area)).toEqual([30 * 20 - 10 * 10 + 16]);
    const report = demold(s8);
    expect(report.bodies[0].loopLock).toBe(false);
    expect(report.verdict).toBe('plausible');
    // Negative control: a groove out to the side lets silicone into the ring, which then holds the island in a loop.
    const open = analyseIntervals(engravedBlock(api, true), CELL);
    expect(open.sealed).toEqual([]);
    expect(open.footprints.map((f) => f.area).sort((a, b) => a - b)).toEqual([16, 30 * 20 - 10 * 10 - 12 * 1 + 2 * 1]);
    expect(demold(open).bodies[0].loopLock).toBe(true);
  });

  it('feet under the island limit are no loop lock, as the footprint drops them too', () => {
    const s8 = analyseIntervals(blockOnFeet(api), CELL);
    expect(demold(s8).bodies[0].loopLock).toBe(false);
    expect(demold(s8, { minIsland: 0 }).bodies[0].loopLock).toBe(true);
  });

  it('the inverted cup holds a sealed domain of 130.5 ml within 3%, closed off by the plate and not inside the model', () => {
    const s8 = analyseIntervals(invertedCup(api), CELL);
    expect(cupAir()).toBeCloseTo(130.5, 1);
    expect(s8.sealed).toHaveLength(1);
    expect(Math.abs(s8.sealed[0].volume / 1000 - 130.5)).toBeLessThanOrEqual(130.5 * 0.03);
    expect(s8.sealed[0].inModel).toBe(false);
    // Sealed air is no silicone, so it is no under-plug either.
    expect(s8.silicone.filter((s) => s.volume >= 50)).toEqual([]);
    expect(demold(s8).verdict).toBe('plausible');
    expect(airReport(s8, { leaves: 1, uncovered: [] }, { minVolume: 50, minPersistence: 0.3 }).sealedAir).toBe(s8.sealed[0].volume);
  });

  it('a void inside the model is sealed too, but inside the model, so the silicone figure does not take it off again', () => {
    const hollow = join(box([0, 0, 0], [20, 20, 20]), inverted(box([5, 5, 5], [15, 15, 15])));
    const s8 = analyseIntervals(hollow, CELL);
    expect(s8.sealed).toHaveLength(1);
    expect(s8.sealed[0].inModel).toBe(true);
    expect(Math.abs(s8.sealed[0].volume - 1000)).toBeLessThanOrEqual(30);
    expect(s8.shells).toHaveLength(1);
    expect(airReport(s8, { leaves: 1, uncovered: [] }, { minVolume: 50, minPersistence: 0.3 }).sealedAir).toBe(0);
  });

  it('the inverted cup with a hole in its wall traps the air above the hole as an underside pocket, of the closed form within 2%', () => {
    const diameter = 6;
    const s8 = analyseIntervals(ventedInvertedCup(api, diameter), CELL);
    expect(s8.sealed).toEqual([]);
    const pocket = s8.pockets[0];
    // Air rises to the cup's floor, 57 mm up, and the level closes it off at the top of the hole.
    const { r, height, floor } = CUP;
    const holeTop = height / 2 + diameter / 2;
    const expected = Math.PI * r * r * (height - floor - holeTop);
    expect(Math.abs(pocket.volume / expected - 1)).toBeLessThan(0.02);
    expect(pocket.persistence).toBeCloseTo(height - floor - holeTop, 0);
    expect(pocket.z).toBeCloseTo(height - floor, 0);
  });

  it('an upright cup and a plain box are plausible, with no pocket, sealed space or hint', () => {
    for (const mesh of [cup(api), box([0, 0, 0], [30, 20, 10])]) {
      const s8 = analyseIntervals(mesh, CELL);
      const report = demold(s8);
      expect(report.verdict).toBe('plausible');
      expect(report.hints).toEqual([]);
      expect(s8.sealed).toEqual([]);
      expect(s8.pockets).toEqual([]);
    }
  });
});

describe('the verdict rule', () => {
  /**
   * A 10 mm cube with a ledge `reach` mm long over the plate at 10 mm up: an under-plug of reach x 10 x 10.
   * Columns stand at odd multiples of half a cell, so a reach in whole cells is read exactly.
   */
  const ledge = (reach: number) => join(box([0, 0, 0], [10, 10, 10]), box([0, 0, 10], [10 + reach, 10, 15]));

  it('plausible with both classes under 1 ml, even when together they are more: 0.6 ml under a ledge and 0.6 ml in a slot', () => {
    // A post with a ledge 6 mm long at 10 mm up on one side, and on the other a floor and a roof with a
    // slot 6 mm high between them, open on three sides: under-plug 6 x 10 x 10, sandwiched 10 x 10 x 6.
    const mesh = join(box([0, 0, 0], [10, 10, 20]), box([10, 0, 10], [16, 10, 14]), box([-10, 0, 0], [0, 10, 4]), box([-10, 0, 10], [0, 10, 14]));
    const s8 = analyseIntervals(mesh, CELL);
    expect(s8.silicone.filter((s) => s.volume >= 50).map((s) => [s.kind, s.volume, s.mouths, s.walls]).sort()).toEqual([['sandwiched', 600, 1, 1], ['under-plug', 600, 0, 0]]);
    const report = demold(s8);
    expect(report.bodies[0].underPlug + report.bodies[0].sandwiched).toBeGreaterThan(PLAUSIBLE_LIMIT_MM3);
    expect(report.verdict).toBe('plausible');
    // Each place still has a hint, worded for a model that should pull out: flex there.
    expect(report.hints).toHaveLength(2);
  });

  it('exactly 1 ml of under-plug is not under 1 ml, so jacket-out', () => {
    const report = demold(analyseIntervals(ledge(10), CELL));
    expect(report.bodies[0].underPlug).toBe(PLAUSIBLE_LIMIT_MM3);
    expect(report.verdict).toBe('jacket-out');
  });

  it('plausible under 1 ml of under-plug, jacket-out from 1 ml, and the under-plug is the box under the ledge', () => {
    // Overlapping boxes count once: S8 reads winding, and the shells overlap, so they are one shell.
    const under = analyseIntervals(ledge(9.5), CELL);
    expect(under.shells).toHaveLength(1);
    expect(under.silicone.filter((s) => s.volume >= 50).map((s) => [s.kind, s.volume])).toEqual([['under-plug', 950]]);
    expect(demold(under).verdict).toBe('plausible');
    const over = demold(analyseIntervals(ledge(10.5), CELL));
    expect(over.bodies[0].underPlug).toBe(1050);
    expect(over.bodies[0].underPlug).toBeGreaterThan(PLAUSIBLE_LIMIT_MM3);
    expect(over.verdict).toBe('jacket-out');
    expect(over.hints).toHaveLength(1);
  });

  it('silicone under the smallest reported volume counts for nothing, and gets no hint', () => {
    const tiny = analyseIntervals(ledge(0.25), CELL);
    expect(tiny.silicone).toHaveLength(1);
    expect(tiny.silicone[0].volume).toBe(25);
    expect(demold(tiny).hints).toEqual([]);
    expect(demold(tiny, { minVolume: 0 }).hints).toHaveLength(1);
  });

  it('a seam runs from the silicone\'s outside, the edge of the cavity nearest the hint, in to the hint at its height', () => {
    const s8 = analyseIntervals(mushroom(api), CELL);
    // A cavity of radius 30 round the axis, on a lattice of 0.5.
    const n = 141, cell = 0.5, x0 = -35;
    const values = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) values[i + j * n] = Math.hypot(x0 + i * cell, x0 + j * cell) < 30 ? 40 : 0;
    const report = demold(s8, { outside: cavityEdge({ nx: n, ny: n, cell, x0, y0: x0, values }) });
    const [from, to] = report.hints[0].seam;
    expect(to).toEqual(report.hints[0].at);
    expect(from[2]).toBe(to[2]);
    expect(Math.hypot(from[0], from[1])).toBeGreaterThanOrEqual(30);
    expect(Math.hypot(from[0], from[1])).toBeLessThan(30 + cell * 1.5);
  });
});
