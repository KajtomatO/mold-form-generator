import { describe, expect, it } from 'vitest';
import { distanceToOutside } from '../../src/core/analysis/distance';
import { findPlateau, withinPlateauDrop } from '../../src/core/analysis/plateaus';
import { fieldOf } from '../fixtures/fieldShapes';

const CELL = 0.125;
const TOP = 20;

/** A flat top `w` by `d`, with `edge` around it falling away at 45 degrees. */
function table(w: number, d: number, edge = 5): ReturnType<typeof fieldOf> {
  return fieldOf(w + 2 * edge, d + 2 * edge, CELL, (x, y) => {
    const out = Math.max(edge - x, x - edge - w, edge - y, y - edge - d, 0);
    return TOP - out;
  });
}

describe('the plateau rule', () => {
  it('finds a rectangular top, with its area, and puts the opening at its middle', () => {
    const plateau = findPlateau(table(40, 12), TOP)!;
    expect(plateau).not.toBeNull();
    // The rule reads slope across a node, so the edge nodes are out.
    expect(Math.abs(plateau.area - 40 * 12)).toBeLessThan(0.05 * 40 * 12);
    expect(plateau.x).toBeCloseTo(25, 0);
    expect(plateau.y).toBeCloseTo(11, 0);
    expect(plateau.clearance).toBeCloseTo(6, 0);
  });

  it('breaks the tie along a long top towards the centroid', () => {
    // Every node along the middle line is as far from the edge as the next.
    const plateau = findPlateau(table(60, 8), TOP)!;
    const [cx, cy] = plateau.centroid;
    expect(Math.abs(plateau.x - cx)).toBeLessThanOrEqual(CELL);
    expect(Math.abs(plateau.y - cy)).toBeLessThanOrEqual(CELL);
  });

  it('is at the pole of inaccessibility, not at the centroid, on an L', () => {
    // An L of two arms: the corner region is the deepest, and the centroid is well off it.
    const field = fieldOf(50, 50, CELL, (x, y) => {
      const inVertical = x >= 5 && x <= 21 && y >= 5 && y <= 45;
      const inHorizontal = x >= 5 && x <= 45 && y >= 5 && y <= 15;
      return inVertical || inHorizontal ? TOP : 10;
    });
    const plateau = findPlateau(field, TOP)!;
    const [cx, cy] = plateau.centroid;
    expect(Math.hypot(plateau.x - cx, plateau.y - cy)).toBeGreaterThan(1);
    expect(plateau.x).toBeCloseTo(13, 0);
    // 16 wide, so its clearance is 8 somewhere along the upright arm's middle.
    expect(plateau.clearance).toBeCloseTo(8, 0);
    expect(plateau.y).toBeGreaterThanOrEqual(13 - 1);
    expect(plateau.y).toBeLessThanOrEqual(37 + 1);
  });

  it('asks for at least 50 mm2', () => {
    expect(findPlateau(table(6, 8), TOP)).toBeNull();
    expect(findPlateau(table(8, 8), TOP)).not.toBeNull();
  });

  it('takes a slope under 2 degrees, and refuses one over it', () => {
    const tilted = (degrees: number): ReturnType<typeof fieldOf> => {
      const tan = Math.tan((degrees * Math.PI) / 180);
      return fieldOf(60, 60, CELL, (x) => TOP - x * tan);
    };
    // 0.2 of drop on the peak's side, so the flat part is 0.2 / tan wide on a 60 mm side.
    expect(findPlateau(tilted(1), TOP)!.area).toBeGreaterThan(50);
    expect(findPlateau(tilted(3), TOP)).toBeNull();
  });

  it('asks for within 0.2 mm of the peak, in the height steps of the peaks, whatever the peak\'s own height', () => {
    // A rim of 45 mm2, too small to pass, around the barrel's case of a lid just under it.
    const lifted = (top: number, drop: number): ReturnType<typeof fieldOf> => fieldOf(60, 30, CELL, (x) => (x < 1.5 ? top : x < 5 ? top - 3 : top - drop));
    // A peak on a step, and either side of one: the barrel's lid is 0.202 under its rim, wherever that is.
    for (const top of [TOP, TOP - 0.004, TOP + 0.004, TOP - 0.0049, TOP + 0.0049]) {
      // Under the limit, level with it to a rounding, and clearly past it.
      expect(findPlateau(lifted(top, 0.15), top), `top ${top}`).not.toBeNull();
      expect(findPlateau(lifted(top, 0.2), top), `top ${top}`).not.toBeNull();
      expect(findPlateau(lifted(top, 0.202), top), `top ${top}`).not.toBeNull();
      expect(findPlateau(lifted(top, 0.204), top), `top ${top}`).not.toBeNull();
      expect(findPlateau(lifted(top, 0.206), top), `top ${top}`).toBeNull();
      expect(findPlateau(lifted(top, 0.21), top), `top ${top}`).toBeNull();
    }
  });

  it('counts a drop as within the limit up to 0.205, at any height', () => {
    for (const peak of [0.5, 19.996, 20, 20.004, 133.335]) {
      expect(withinPlateauDrop(peak, peak - 0.204), `${peak}`).toBe(true);
      expect(withinPlateauDrop(peak, peak - 0.206), `${peak}`).toBe(false);
      expect(withinPlateauDrop(peak, peak), `${peak}`).toBe(true);
    }
  });

  it('goes for the highest part that passes, and passes over a higher one too small', () => {
    const field = fieldOf(90, 30, CELL, (x) => (x > 2 && x < 40 ? TOP : x > 50 && x < 88 ? TOP - 0.1 : 10));
    expect(findPlateau(field, TOP)!.x).toBeLessThan(40);
    const smallHigh = fieldOf(90, 30, CELL, (x, y) => (x > 2 && x < 6 && y > 2 && y < 6 ? TOP : x > 50 && x < 88 ? TOP - 0.1 : 10));
    const plateau = findPlateau(smallHigh, TOP)!;
    expect(plateau.x).toBeGreaterThan(50);
    expect(plateau.height).toBeCloseTo(TOP - 0.1, 3);
  });

  it('finds nothing on a dome, whose flat part is too small to matter', () => {
    const dome = fieldOf(60, 60, CELL, (x, y) => {
      const d2 = (x - 30) ** 2 + (y - 30) ** 2;
      return d2 < 900 ? Math.sqrt(900 - d2) : 0;
    });
    expect(findPlateau(dome, 30)).toBeNull();
  });
});

describe('the exact distance map', () => {
  it('agrees with brute force', () => {
    let seed = 99;
    const random = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let run = 0; run < 10; run++) {
      const w = 31, h = 17;
      const mask = Uint8Array.from({ length: w * h }, () => (random() < 0.92 ? 1 : 0));
      const fast = distanceToOutside(mask, w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let best = Infinity;
          for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) if (!mask[u + v * w]) best = Math.min(best, Math.hypot(u - x, v - y));
          expect(fast[x + y * w]).toBeCloseTo(best === Infinity ? fast[x + y * w] : best, 4);
        }
      }
    }
  });

  it('reads 0 at a cell outside, and does not fail on a mask with nothing outside', () => {
    const none = distanceToOutside(new Uint8Array(9).fill(1), 3, 3);
    expect(none[4]).toBeGreaterThan(3);
    const one = new Uint8Array(9).fill(1);
    one[0] = 0;
    expect(distanceToOutside(one, 3, 3)[0]).toBe(0);
    expect(distanceToOutside(one, 3, 3)[8]).toBeCloseTo(Math.SQRT2 * 2, 5);
  });
});
