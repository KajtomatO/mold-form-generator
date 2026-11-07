import { describe, expect, it } from 'vitest';
import { dilate } from '../../src/core/field/dilate';
import { emptyField, type Field } from '../../src/core/field/grid';
import { NO_SOURCE } from '../../src/core/field/raster';
import { bruteDilate } from '../fixtures/bruteDilate';

const SIZE = 180;
const CELL = 0.125;

/** A field of the given height function, with a clear border wide enough for any radius below. */
function fieldOf(height: (x: number, y: number) => number, border = 45): Field {
  const field = emptyField({ nx: SIZE, ny: SIZE, cell: CELL, x0: 0, y0: 0 }, NO_SOURCE);
  for (let y = border; y < SIZE - border; y++) {
    for (let x = border; x < SIZE - border; x++) field.values[x + y * SIZE] = height(x, y);
  }
  return field;
}

function random(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function worstDifference(raster: Field, radius: number): number {
  const reference = bruteDilate(raster, radius);
  const out = dilate(raster, radius).values;
  let worst = 0;
  for (let n = 0; n < out.length; n++) worst = Math.max(worst, Math.abs(out[n] - reference[n]));
  return worst;
}

// Radii in cells: whole, half, and the awkward fractions the research found rounding on.
const RADII_CELLS = [3, 7.5, 14.3, 26.93, 33.33];

const FIELDS: Record<string, () => Field> = {
  'white noise, the worst case for pruning': () => {
    const next = random(1);
    return fieldOf(() => next() * 30);
  },
  'a figure with ripple and gaps': () => {
    const next = random(2);
    return fieldOf((x, y) => {
      const dx = x - 90, dy = y - 90;
      if (Math.hypot(dx * 1.4, dy) > 40) return NO_SOURCE;
      if (next() < 0.02) return NO_SOURCE;
      return 8 + 6 * Math.sin(x * 0.4) * Math.cos(y * 0.3) + 0.5 * next();
    });
  },
  'plateaus and cliffs, where ties are everywhere': () =>
    fieldOf((x, y) => {
      if (x < 75 && y < 75) return 20;
      if (x < 105) return 5;
      return y < 90 ? 12 : 0;
    }),
  'a single spike on a slope': () => fieldOf((x, y) => (x === 90 && y === 90 ? 60 : 0.3 * x + 0.1 * y)),
  'lone sources with empty neighbours': () => {
    const next = random(3);
    return fieldOf(() => (next() < 0.01 ? next() * 40 : NO_SOURCE));
  },
};

describe('pruned dilation equals brute force', () => {
  describe.each(Object.keys(FIELDS))('%s', (name) => {
    it.each(RADII_CELLS)('radius %s cells', (cells) => {
      const worst = worstDifference(FIELDS[name](), cells * CELL);
      // The plan's limit, and float32 rounding at these heights is well inside it.
      expect(worst).toBeLessThanOrEqual(1e-4);
    });
  });

  it('every node within reach gets a value, and none beyond it does', () => {
    const raster = fieldOf(() => NO_SOURCE);
    raster.values[90 + 90 * SIZE] = 10;
    const out = dilate(raster, 2);
    expect(out.values[90 + 90 * SIZE]).toBe(12);
    // Exactly on the rim, 16 cells away, the sphere has fallen to the source's own height.
    expect(out.values[106 + 90 * SIZE]).toBe(10);
    expect(out.values[107 + 90 * SIZE]).toBe(0);
    expect(out.values[90 + 106 * SIZE]).toBe(10);
    expect(out.values[90 + 107 * SIZE]).toBe(0);
    // A height 0 source on the plane is a real source too.
    const low = fieldOf(() => NO_SOURCE);
    low.values[90 + 90 * SIZE] = 0;
    expect(dilate(low, 2).values[90 + 90 * SIZE]).toBe(2);
  });

  it('refuses a source too near the edge, as it writes without bounds checks', () => {
    const raster = fieldOf(() => NO_SOURCE);
    raster.values[3 + 90 * SIZE] = 1;
    expect(() => dilate(raster, 2)).toThrow(/too close to the edge/);
  });
});
