import { describe, expect, it } from 'vitest';
import { applyClosing, closingHalfWidth } from '../../src/core/field/closing';
import { applyDraft } from '../../src/core/field/draft';
import { emptyField, type Field } from '../../src/core/field/grid';

const CELL = 0.125;

function fieldOf(nx: number, ny: number, height: (x: number, y: number) => number): Field {
  const field = emptyField({ nx, ny, cell: CELL, x0: 0, y0: 0 });
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) field.values[x + y * nx] = height(x, y);
  return field;
}

function random(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

/** Closing written out from its definition, node by node, with the window cut short at the edges. */
function bruteClosing(field: Field, m: number): Float32Array {
  const { nx, ny, values } = field;
  const pass = (input: Float32Array, pick: (a: number, b: number) => number, start: number): Float32Array => {
    const out = new Float32Array(input.length);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        let best = start;
        for (let b = Math.max(0, y - m); b <= Math.min(ny - 1, y + m); b++) {
          for (let a = Math.max(0, x - m); a <= Math.min(nx - 1, x + m); a++) best = pick(best, input[a + b * nx]);
        }
        out[x + y * nx] = best;
      }
    }
    return out;
  };
  return pass(pass(values, Math.max, -Infinity), Math.min, Infinity);
}

describe('draft', () => {
  // A tall square column at the middle of an empty field.
  const column = (height: number): Field => fieldOf(301, 301, (x, y) => (Math.abs(x - 150) <= 40 && Math.abs(y - 150) <= 40 ? height : 0));

  /** Where the drafted wall reaches z = 0, along a ray from the column's corner region. */
  function reach(field: Field, dx: number, dy: number, fromX: number, fromY: number): number {
    let k = 0;
    while (field.values[fromX + k * dx + (fromY + k * dy) * field.nx] > 0) k++;
    return k * CELL * Math.hypot(dx, dy);
  }

  it('widens a cliff by height * tan(angle) along an axis', () => {
    const field = column(50);
    applyDraft(field, 5);
    const expected = 50 * Math.tan((5 * Math.PI) / 180);
    expect(Math.abs(reach(field, 1, 0, 190, 150) - expected)).toBeLessThanOrEqual(expected * 0.1);
  });

  it('widens the same on all four sides', () => {
    const field = column(50);
    applyDraft(field, 5);
    const expected = 50 * Math.tan((5 * Math.PI) / 180);
    for (const [dx, dy, x, y] of [[1, 0, 190, 150], [-1, 0, 110, 150], [0, 1, 150, 190], [0, -1, 150, 110]]) {
      expect(Math.abs(reach(field, dx, dy, x, y) - expected)).toBeLessThanOrEqual(expected * 0.1);
    }
  });

  it('off-axis stays within 10% of the nominal, and at most 8% short, from every corner both ways', () => {
    const field = column(50);
    applyDraft(field, 5);
    const expected = 50 * Math.tan((5 * Math.PI) / 180);
    // 22.5 degrees from an axis is where the chamfer is furthest from true distance, and a corner of
    // the column is where a ray leaves it along true distance. Each of the 8 needs its own diagonal term.
    const along = Math.cos(Math.PI / 8), across = Math.sin(Math.PI / 8);
    let rays = 0;
    for (const sx of [1, -1]) {
      for (const sy of [1, -1]) {
        for (const [ux, uy] of [[along, across], [across, along]]) {
          const at = (k: number): number => Math.round(150 + sx * (40 + k * ux)) + Math.round(150 + sy * (40 + k * uy)) * field.nx;
          let k = 0;
          while (field.values[at(k)] > 0) k++;
          const widening = k * CELL;
          const name = `corner ${sx}, ${sy}, direction ${ux.toFixed(2)}`;
          expect(Math.abs(widening - expected), name).toBeLessThanOrEqual(expected * 0.1);
          expect(widening, name).toBeGreaterThanOrEqual(expected * 0.92);
          expect(widening, name).toBeLessThanOrEqual(expected + CELL);
          rays++;
        }
      }
    }
    expect(rays).toBe(8);
  });

  it('is exact along a diagonal from every corner, where the chamfer needs one term per quadrant', () => {
    const field = column(50);
    applyDraft(field, 5);
    const expected = 50 * Math.tan((5 * Math.PI) / 180);
    for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const widening = reach(field, sx, sy, 150 + sx * 40, 150 + sy * 40);
      expect(Math.abs(widening - expected), `corner ${sx}, ${sy}`).toBeLessThanOrEqual(CELL * Math.SQRT2);
    }
  });

  it('never lowers a node, and is exact at 0 degrees', () => {
    const next = random(5);
    const original = fieldOf(120, 120, (x, y) => (x > 30 && x < 90 && y > 30 && y < 90 ? next() * 40 : 0));
    const field: Field = { ...original, values: original.values.slice() };
    applyDraft(field, 0);
    expect(field.values).toEqual(original.values);
    applyDraft(field, 1);
    let lowered = 0, raised = 0;
    for (let n = 0; n < field.values.length; n++) {
      if (field.values[n] < original.values[n]) lowered++;
      if (field.values[n] > original.values[n]) raised++;
    }
    expect(lowered).toBe(0);
    expect(raised).toBeGreaterThan(100);
  });

  it('leaves nothing steeper than the draft: no drop between neighbours beyond one chamfer step', () => {
    const next = random(6);
    const field = fieldOf(120, 120, (x, y) => (x > 30 && x < 90 && y > 30 && y < 90 ? next() * 40 : 0));
    applyDraft(field, 2);
    const step = CELL / Math.tan((2 * Math.PI) / 180) + 1e-4;
    for (let y = 1; y < 119; y++) {
      for (let x = 1; x < 119; x++) {
        const n = x + y * 120;
        for (const m of [n - 1, n + 1, n - 120, n + 120]) {
          if (field.values[m] > 0 && field.values[n] > 0) expect(Math.abs(field.values[m] - field.values[n])).toBeLessThanOrEqual(step);
        }
      }
    }
  });
});

describe('closing', () => {
  it('picks the smallest whole-node element that spans closeWidth', () => {
    expect(closingHalfWidth(1.2, 0.125)).toBe(5);
    expect(closingHalfWidth(1.25, 0.125)).toBe(5);
    expect(closingHalfWidth(1.2, 0.25)).toBe(3);
    expect(closingHalfWidth(0, 0.125)).toBe(0);
  });

  it('removes a plastic fin narrower than closeWidth and keeps a wider one', () => {
    const fin = (widthNodes: number): Field => fieldOf(101, 101, (x) => (x >= 50 && x < 50 + widthNodes ? 2 : 20));
    // 10 plastic nodes span 9 cells, which is 1.125 mm: under 1.2.
    const narrow = fin(10);
    applyClosing(narrow, 1.2);
    expect(narrow.values[55 + 50 * 101]).toBe(20);
    // 11 nodes span 1.25 mm: the element fits, so the fin stays.
    const wide = fin(11);
    applyClosing(wide, 1.2);
    expect(wide.values[55 + 50 * 101]).toBe(2);
  });

  it('matches closing written out from the definition, edges included', () => {
    const next = random(9);
    const original = fieldOf(70, 53, () => (next() < 0.3 ? 0 : next() * 30));
    const expected = bruteClosing(original, 3);
    const field: Field = { ...original, values: original.values.slice() };
    applyClosing(field, 6 * CELL);
    expect(Array.from(field.values)).toEqual(Array.from(expected));
  });

  it('never lowers a node and is idempotent', () => {
    const next = random(10);
    const original = fieldOf(120, 90, () => (next() < 0.5 ? 0 : next() * 30));
    const field: Field = { ...original, values: original.values.slice() };
    applyClosing(field, 1.2);
    for (let n = 0; n < field.values.length; n++) expect(field.values[n]).toBeGreaterThanOrEqual(original.values[n]);
    const again: Field = { ...field, values: field.values.slice() };
    applyClosing(again, 1.2);
    expect(again.values).toEqual(field.values);
  });

  it('does nothing at closeWidth 0, and never leaves -0 behind', () => {
    const original = fieldOf(40, 40, (x, y) => (x + y) % 7);
    const field: Field = { ...original, values: original.values.slice() };
    applyClosing(field, 0);
    expect(field.values).toEqual(original.values);
    applyClosing(field, 0.5);
    expect(field.values.every((v) => !Object.is(v, -0))).toBe(true);
  });
});

describe('conditioning order', () => {
  // Two tall towers 2 mm apart. Draft narrows the valley between them first, so closing sees it at
  // its final width. The other order leaves a tall plastic blade thinner than closeWidth.
  const towers = (): Field => fieldOf(141, 101, (x, y) => (y > 20 && y < 80 && (Math.abs(x - 50) < 12 || Math.abs(x - 90) < 12) ? 40 : 0));

  it('draft then closing leaves a field that closing does not change', () => {
    const field = towers();
    applyDraft(field, 1);
    applyClosing(field, 1.2);
    const again: Field = { ...field, values: field.values.slice() };
    applyClosing(again, 1.2);
    expect(again.values).toEqual(field.values);
  });

  it('closing then draft does not, which is why the order matters', () => {
    const field = towers();
    applyClosing(field, 1.2);
    applyDraft(field, 1);
    const again: Field = { ...field, values: field.values.slice() };
    applyClosing(again, 1.2);
    let changed = 0;
    for (let n = 0; n < field.values.length; n++) if (again.values[n] > field.values[n] + 0.01) changed++;
    expect(changed).toBeGreaterThan(0);
  });
});
