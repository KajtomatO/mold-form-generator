import { describe, expect, it } from 'vitest';
import { HEIGHT_STEP, leavesCovered, mergeTree, significantLeaves } from '../../src/core/analysis/peaks';
import { emptyField, type Field } from '../../src/core/field/grid';
import { coneAt, fieldOf } from '../fixtures/fieldShapes';

const CELL = 0.5;
/** Two cones 40 apart: their surfaces meet halfway along the line between them. */
function twoCones(topA: number, topB: number, slope = 0.5): Field {
  const a = coneAt(15, 20, topA, slope), b = coneAt(55, 20, topB, slope);
  return fieldOf(70, 40, CELL, (x, y) => Math.max(a(x, y), b(x, y)));
}

describe('the merge tree', () => {
  it('gives a known peak its height, saddle and persistence, and the highest its floor', () => {
    const tree = mergeTree(twoCones(30, 24));
    expect(tree.leaves).toHaveLength(2);
    const [root, low] = tree.leaves;
    expect(root.height).toBeCloseTo(30, 5);
    expect([root.x, root.y]).toEqual([15, 20]);
    expect(root.parent).toBe(-1);
    expect(root.saddle).toBe(0);
    expect(root.persistence).toBeCloseTo(30, 2);

    // The cones meet where 30 - d/2 = 24 - (40 - d)/2, so at d = 26 and a height of 17.
    expect(low.height).toBeCloseTo(24, 5);
    expect([low.x, low.y]).toEqual([55, 20]);
    expect(low.parent).toBe(0);
    expect(low.saddle).toBeCloseTo(17, 1);
    expect(low.persistence).toBeCloseTo(7, 1);
    expect(low.persistence).toBeCloseTo(low.height - low.saddle, 1);
  });

  it('reads the air over a saddle as a brute force sum does', () => {
    const field = twoCones(30, 24);
    const tree = mergeTree(field);
    const low = tree.leaves[1];
    // Flood from the peak over nodes above the saddle: the very region of the basin.
    const { nx, ny, values, cell } = field;
    const seen = new Uint8Array(values.length);
    const stack = [low.node];
    seen[low.node] = 1;
    let air = 0;
    while (stack.length > 0) {
      const n = stack.pop()!;
      air += values[n] - low.saddle;
      for (const m of [n - 1, n + 1, n - nx, n + nx]) {
        if (m < 0 || m >= nx * ny || seen[m] || values[m] < low.saddle + HEIGHT_STEP / 2) continue;
        seen[m] = 1;
        stack.push(m);
      }
    }
    expect(Math.abs(low.airVolume - air * cell * cell)).toBeLessThanOrEqual(air * cell * cell * 0.01);
    // A cone of that height and base radius, as a second opinion on the sum itself.
    const r = low.persistence / 0.5;
    expect(low.airVolume).toBeGreaterThan((Math.PI * r * r * low.persistence) / 3 * 0.9);
  });

  it('agrees with the definition, flooded at every level, on random fields', () => {
    let seed = 12345;
    const random = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
    // Small and large, with many levels, with few so that flats and exact ties are common, and with
    // values that differ within one step, which the sweep orders by value.
    const kinds: [number, () => number][] = [
      [4, () => (random() < 0.15 ? 0 : 1 + Math.floor(random() * 300) * 0.01)],
      [15, () => (random() < 0.1 ? 0 : 1 + Math.floor(random() * 300) * 0.01)],
      [15, () => (random() < 0.1 ? 0 : 1 + Math.floor(random() * 12) * 0.01)],
      [15, () => (random() < 0.1 ? 0 : 1 + Math.floor(random() * 40) * 0.01 + random() * 0.004)],
    ];
    let leaves = 0;
    for (const [side, value] of kinds) {
      for (let run = 0; run < 10; run++) {
        const field = fieldOf(side, side, 0.5, value);
        const fast = mergeTree(field).leaves;
        const slow = slowLeaves(field);
        expect(fast.map((leaf) => [leaf.node, Math.round(leaf.persistence * 100)]), `side ${side}, run ${run}`).toEqual(slow);
        leaves += slow.length;
      }
    }
    expect(leaves).toBeGreaterThan(400);
  });

  it('gives each cavity a root of its own', () => {
    const field = fieldOf(60, 20, CELL, (x) => (x < 25 ? 10 : x > 35 ? 8 : 0));
    const tree = mergeTree(field);
    expect(tree.leaves.filter((leaf) => leaf.parent === -1)).toHaveLength(2);
    expect(tree.leaves.map((leaf) => leaf.height)).toEqual([10, 8]);
  });

  it('joins by edges only, as cavities do, so two nodes touching at a corner stay apart', () => {
    const field = emptyField({ nx: 5, ny: 5, cell: 1, x0: 0, y0: 0 });
    const { values } = field;
    values[1 + 1 * 5] = 5;
    values[2 + 2 * 5] = 4;
    expect(mergeTree(field).leaves.map((leaf) => leaf.parent)).toEqual([-1, -1]);
  });

  it('makes one peak of a flat top, however its float noise falls within a step', () => {
    let seed = 7;
    const noise = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647) * HEIGHT_STEP * 0.4;
    const field = fieldOf(20, 20, CELL, () => 10.001 + noise());
    const { leaves, basinParents } = mergeTree(field);
    expect(leaves).toHaveLength(1);
    expect(basinParents.length).toBeGreaterThan(1);
    expect(leaves[0].height).toBeGreaterThan(10);
  });

  it('keeps the true highest node of a level as the peak, though the sweep meets the others first', () => {
    const field = fieldOf(10, 10, CELL, () => 10);
    const at = 7 + 9 * field.nx;
    field.values[at] = 10.004;
    expect(mergeTree(field).leaves[0].node).toBe(at);
  });
});

describe('the persistence filter', () => {
  const ripple = fieldOf(40, 40, 0.125, (x, y) => 20 + 0.1 * Math.sin(x * 1.3) * Math.sin(y * 1.7));

  it('is needed: ripple alone gives many births, each low', () => {
    const { leaves } = mergeTree(ripple);
    expect(leaves.length).toBeGreaterThan(40);
    expect(leaves.slice(1).every((leaf) => leaf.persistence < 0.25)).toBe(true);
  });

  it('keeps only the top of the cavity from it, and a real peak over it', () => {
    expect(significantLeaves(mergeTree(ripple), 1.5)).toHaveLength(1);
    const withPeak = fieldOf(40, 40, 0.125, (x, y) => Math.max(20 + 0.1 * Math.sin(x * 1.3) * Math.sin(y * 1.7), 24 - 2 * Math.hypot(x - 30, y - 30)));
    const kept = significantLeaves(mergeTree(withPeak), 1.5);
    expect(kept).toHaveLength(1);
    expect(kept[0].height).toBeCloseTo(24, 1);
  });

  it.each([[1.51, 1], [1.5, 1], [1.49, 0]])('a leaf of persistence %f against a limit of 1.5 gives %i more', (persistence, more) => {
    // Its top on the grid, with a floor well clear of a step boundary.
    const field = fieldOf(40, 20, CELL, (x) => (x < 10 ? 20 : x < 30 ? 15 : 15 + persistence));
    expect(significantLeaves(mergeTree(field), 1.5)).toHaveLength(1 + more);
  });
});

describe('a leaf covered by an opening', () => {
  const field = twoCones(30, 24);
  const tree = mergeTree(field);
  const drop = 1.5;
  const covers = (x: number, y: number, radius: number): number[] => [...leavesCovered(tree, field, x, y, radius, drop)].sort();

  it('at the peak covers that leaf, and from the higher leaf its basin does not reach the lower', () => {
    expect(covers(55, 20, 1)).toEqual([1]);
    expect(covers(15, 20, 1)).toEqual([0]);
  });

  it('within t/2 of the peak still covers it, and further down does not', () => {
    // 0.5 slope, so 3 mm off the peak is 1.5 down.
    expect(covers(55 + 2.5, 20, 0.2)).toEqual([1]);
    expect(covers(55 + 4, 20, 0.2)).toEqual([]);
  });

  it('counts the whole disc, as air reaches an opening anywhere under it', () => {
    expect(covers(55 + 6, 20, 0.2)).toEqual([]);
    expect(covers(55 + 6, 20, 5)).toEqual([1]);
  });

  it('never across the saddle, even when the other side stands within the drop', () => {
    // Almost level peaks with a deep saddle: the lower one is in reach by height but not by basin.
    const level = twoCones(30, 29.5);
    const tree2 = mergeTree(level);
    expect([...leavesCovered(tree2, level, 55, 20, 1, 3)]).toEqual([1]);
    expect([...leavesCovered(tree2, level, 15, 20, 1, 3)]).toEqual([0]);
  });

  it('counts a small bump on the way up as part of the higher peak, and a deep dip on the way as not', () => {
    const a = coneAt(15, 20, 30, 0.5);
    const near = coneAt(18, 20, 29.8, 3);
    const flank = fieldOf(40, 40, CELL, (x, y) => Math.max(a(x, y), near(x, y)));
    const flankTree = mergeTree(flank);
    expect(flankTree.leaves).toHaveLength(2);
    expect(flankTree.leaves[1].parent).toBe(0);
    expect([...leavesCovered(flankTree, flank, 18, 20, 0.2, 1.5)].sort()).toEqual([0, 1]);
    // A peak further down the flank, with its saddle more than the drop under the top.
    const far = coneAt(30, 20, 26, 3);
    const lower = fieldOf(40, 40, CELL, (x, y) => Math.max(a(x, y), far(x, y)));
    expect([...leavesCovered(mergeTree(lower), lower, 30, 20, 0.2, 1.5)]).toEqual([1]);
  });
});

/**
 * The definition itself, with no sweep and no union-find: flood the set of nodes at or over each level,
 * from the top level down, and label its parts afresh each time. A node is a peak if at its own level it
 * is the highest of its part, by value and then the lower index, as the order of the sweep has it. It
 * dies at the first level down where its part holds a higher one, and its persistence is its level less
 * that one, or less 0 if it never dies, as the floor of the cavity. In whole steps.
 */
function slowLeaves(field: Field): [number, number][] {
  const { nx, values } = field;
  const count = values.length;
  const level = Array.from(values, (v) => (v > 0 ? Math.round(v / HEIGHT_STEP) : -1));
  const above = (a: number, b: number): boolean => values[a] > values[b] || (values[a] === values[b] && a < b);
  const levels = [...new Set(level.filter((l) => l >= 0))].sort((a, b) => b - a);
  const born: number[] = [];
  const death = new Map<number, number>();
  for (const at of levels) {
    const part = new Int32Array(count).fill(-1);
    const highest: number[] = [];
    for (let start = 0; start < count; start++) {
      if (level[start] < at || part[start] >= 0) continue;
      const id = highest.length;
      let best = start;
      const stack = [start];
      part[start] = id;
      while (stack.length > 0) {
        const a = stack.pop()!;
        if (above(a, best)) best = a;
        const i = a % nx;
        for (const b of [i > 0 ? a - 1 : -1, i + 1 < nx ? a + 1 : -1, a - nx, a + nx]) {
          if (b < 0 || b >= count || level[b] < at || part[b] >= 0) continue;
          part[b] = id;
          stack.push(b);
        }
      }
      highest.push(best);
    }
    for (const node of born) if (!death.has(node) && highest[part[node]] !== node) death.set(node, at);
    for (const best of highest) if (level[best] === at) born.push(best);
  }
  return born
    .sort((a, b) => (above(a, b) ? -1 : 1))
    .map((node): [number, number] => [node, level[node] - (death.get(node) ?? 0)]);
}
