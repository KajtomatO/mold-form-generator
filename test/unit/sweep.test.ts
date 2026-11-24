import { describe, expect, it } from 'vitest';
import { bedFootprint, fastenerGrowth, quickRim, sideOverrun, scoreSplit, scoreSplitBrute, sideRows, SWEEP_FROM, SWEEP_TO, typedSeam, type SeamAxis } from '../../src/core/field/side';
import { weld, type WeldedMesh } from '../../src/core/mesh/weld';
import { defaultParams } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';
import { hmaxClam, sideBounds, sideBoundsFast } from '../../src/core/parts/rim';
import type { Rect } from '../../src/core/solid/rect';
import { chooseFor, coarseRows, exactRim, fineSplit, prepareClamshell, seamHold, sideField, type ClamshellPrep } from '../fixtures/clamshell';
import { orientedExample } from '../fixtures/fieldRuns';
import { EXAMPLE_IDS, skipWithout, type ExampleId } from '../fixtures/loadExamples';
import { box, join } from '../fixtures/synthetic';
import { CLAMSHELL_GOLDEN, GOLDEN, type ClamshellGolden } from '../regression/golden';

/** MP1: G13.3's sweep, Hmax_clam, the bed filter and the goldens (docs/PLAN.md, MP1's checks). */

const FULL = process.env.CFG_FULL === '1';
const DEGREE = Math.PI / 180;

function clamParams(change: (p: Params) => void = () => {}): Params {
  const params = defaultParams('clamshell');
  change(params);
  return params;
}

const prepFor = (mesh: WeldedMesh, change?: (p: Params) => void, overlap = 0): ClamshellPrep => prepareClamshell(mesh, clamParams(change), { overlapVolume: overlap });

describe('G13.3 the sweep', () => {
  it('the sorted sums equal brute force at every candidate, on both axes', () => {
    const prep = prepFor(orientedExample('goddess').mesh);
    for (const axis of ['x', 'y'] as const) {
      const plus = sideField(prep, `+${axis}`, 1, 20, null).field, minus = sideField(prep, `-${axis}`, 1, 20, null).field;
      const rp = sideRows(plus, `+${axis}`, prep.bounds), rm = sideRows(minus, `-${axis}`, prep.bounds);
      const a = axis === 'x' ? 0 : 1;
      for (let f = 0.1; f <= 0.9; f += 0.05) {
        const xs = prep.bounds.min[a] + f * (prep.bounds.max[a] - prep.bounds.min[a]);
        const fast = scoreSplit(rp, rm, xs, prep.ctx.raise), brute = scoreSplitBrute(plus, minus, prep.bounds, axis, xs, prep.ctx.raise);
        expect(fast.volume).toBeCloseTo(brute.volume, 3);
        expect(fast.rows).toBeCloseTo(brute.rows, 6);
        expect(fast.seamTop).toBe(brute.seamTop);
      }
    }
  });

  it('the O(1) Hmax equals brute force over the vertices', () => {
    const prep = prepFor(orientedExample('goddess').mesh);
    const { vertices, ctx } = prep;
    const p = vertices.positions;
    for (const axis of ['x', 'y'] as const) {
      const a = axis === 'x' ? 0 : 1;
      for (const beta of [0, 20, 45, 60]) {
        const tb = Math.tan(beta * DEGREE);
        for (const f of [0, 0.3, 0.5, 0.77, 1]) {
          const xs = vertices.min[a] + f * (vertices.max[a] - vertices.min[a]);
          let worst = -Infinity;
          for (let v = 0; v < p.length; v += 3) {
            const d = Math.abs(p[v + a] - xs);
            worst = Math.max(worst, p[v + 2] + d * tb + vertices.rEff / Math.cos(beta * DEGREE) + (d + vertices.rEff) * vertices.tanDraft);
          }
          const brute = worst + (ctx.raise + 0.5) * Math.max(1, tb);
          expect(hmaxClam(vertices, axis, xs, beta, ctx.raise, 0.5)).toBeCloseTo(brute, 6);
        }
      }
    }
  });

  it('a synthetic L picks the right axis', () => {
    // A long arm along x and a short one along y: split across the long arm, each half's roof is short.
    const long = join(box([0, 0, 0], [60, 8, 20]), box([0, 8, 0], [8, 30, 20]));
    expect(chooseFor(prepFor(long), 20).axis).toBe('y');
    const turned = join(box([0, 0, 0], [8, 60, 20]), box([8, 0, 0], [30, 8, 20]));
    expect(chooseFor(prepFor(turned), 20).axis).toBe('x');
  });

  it('a typed axis and offset skip the choice, the offset clamped to the extent less 1 mm and snapped to cellFinal', () => {
    const prep = prepFor(orientedExample('goddess').mesh, (p) => {
      p.clamshell.axis = 'x';
      p.clamshell.offset = 3.06;
    });
    const choice = chooseFor(prep, 20);
    expect(choice.axis).toBe('x');
    const mid = (prep.bounds.min[0] + prep.bounds.max[0]) / 2;
    expect(choice.xs).toBeCloseTo(Math.round((mid + 3.06) / 0.125) * 0.125, 9);
    expect(choice.candidates).toBe(1);
    expect(typedSeam(0, 40, 100, 0.125)).toBe(39);
    expect(typedSeam(0, 40, -100, 0.125)).toBe(1);
    expect(typedSeam(0.05, 40.03, -100, 0.125)).toBe(1.125);
  });

  it('candidates lie in [0.2, 0.8] of the extent', () => {
    const prep = prepFor(orientedExample('goddess').mesh);
    const choice = chooseFor(prep, 20);
    const a = choice.axis === 'x' ? 0 : 1;
    const f = (choice.xs - prep.bounds.min[a]) / (prep.bounds.max[a] - prep.bounds.min[a]);
    expect(f).toBeGreaterThanOrEqual(SWEEP_FROM - 1e-9);
    expect(f).toBeLessThanOrEqual(SWEEP_TO + 1e-9);
  });
});

describe('G13.3 the bed', () => {
  const bed = (x: number, y: number, z: number) => (p: Params) => Object.assign(p.print, { bedX: x, bedY: y, bedZ: z });

  it('VIS-35: at 220 and beta 20 a y split, at 300 an x split, and on the user\'s 250 x 210 x 220 x with M3 lugs and y with M4', (ctx) => {
    skipWithout(ctx, 'vis35');
    const mesh = orientedExample('vis35').mesh;
    const rows = coarseRows(prepFor(mesh), 20);
    const axisAt = (change: (p: Params) => void): SeamAxis => {
      const choice = chooseFor(prepFor(mesh, change), 20, rows);
      expect(choice.fitted).toBe(true);
      return choice.axis;
    };
    expect(axisAt(bed(220, 220, 250))).toBe('y');
    expect(axisAt(bed(300, 300, 250))).toBe('x');
    expect(axisAt(bed(250, 210, 220))).toBe('x');
    expect(axisAt((p) => {
      bed(250, 210, 220)(p);
      p.bolts.size = 'M4';
    })).toBe('y');
  });

  /** The narrowest pose across b over both axes at the middle, the candidate a centred box gives its least. */
  function narrowest(prep: ClamshellPrep): { width: number; length: number } {
    const r = quickRim(prep.ctx, 'x', 0);
    const O = r.O;
    return { width: O.y1 - O.y0, length: r.Zt + r.Tb - r.proud };
  }

  it('a box that fits at O.b but not at O.b + 2p is refused, and the card names Seam fasteners: None', () => {
    const cube = join(box([-20, -20, 0], [20, 20, 40]));
    const { width, length } = narrowest(prepFor(cube));
    const side = Math.max(width + 10, length);
    const prep = prepFor(cube, bed(side, side, 250));
    expect(fastenerGrowth(prep.params)).toBeCloseTo(19.04, 9);
    const choice = chooseFor(prep, 20);
    expect(choice.fitted).toBe(false);
    expect(choice.fitsWith).toBe('none');
    const [d] = choice.diagnostics;
    expect(d.code).toBe('clamshell-bed');
    expect(d.severity).toBe('warning');
    expect(d.message).toContain('fits with Seam fasteners: None');
    // The same with no fastener fits, and nothing is said.
    const none = chooseFor(prepFor(cube, (p) => {
      bed(side, side, 250)(p);
      p.clamshell.fastener = 'none';
    }), 20);
    expect(none.fitted).toBe(true);
    expect(none.diagnostics).toEqual([]);
  });

  it('a box that fits at O.b + 19 but not + 20 names Bolts with clips set', () => {
    const cube = join(box([-20, -20, 0], [20, 20, 40]));
    const { width, length } = narrowest(prepFor(cube));
    const side = Math.max(width + 19.5, length);
    const prep = prepFor(cube, (p) => {
      bed(side, side, 250)(p);
      p.clamshell.fastener = 'clips';
    });
    expect(fastenerGrowth(prep.params)).toBe(20);
    const choice = chooseFor(prep, 20);
    expect(choice.fitted).toBe(false);
    expect(choice.fitsWith).toBe('bolts');
    expect(choice.diagnostics[0].message).toContain('fits with Seam fasteners: Bolts');
  });

  it('with no split fitting, the card names the largest beta at which one fits, and beta is not lowered', () => {
    const cube = join(box([-20, -20, 0], [20, 20, 40]));
    const prep20 = prepFor(cube);
    const at = (beta: number): number => {
      const r = quickRim(prep20.ctx, 'x', 0, beta);
      return r.Zt + r.Tb - r.proud;
    };
    // A bed whose length takes the cover at 10 degrees but not at 11, with the width at no limit.
    const length = (at(10) + at(11)) / 2;
    const prep = prepFor(cube, bed(length, 400, 250));
    const choice = chooseFor(prep, 20);
    expect(choice.fitted).toBe(false);
    expect(choice.fitsAtBeta).toBe(10);
    expect(choice.diagnostics[0].message).toContain('A split fits at a ceiling slope of 10 degrees or less.');
    expect(prep.params.clamshell.ceilingDeg).toBe(20);
  });
});

describe('G13.2 step 8 coarse and fine', () => {
  // Every example under CFG_FULL=1, which MP1's exit was run green with; by default Goddess, the wolf and Benchy.
  const ids: ExampleId[] = FULL ? EXAMPLE_IDS : ['goddess', 'wolf', 'benchy'];
  it.each(ids)('the xs chosen from coarse fields, rebuilt from fine fields at that xs, is within 2 percent of a fine sweep on %s', (id) => {
    const mesh = orientedExample(id).mesh;
    const prep = prepFor(mesh, (p) => Object.assign(p.print, { bedX: 1000, bedY: 1000, bedZ: 1000 }), GOLDEN[id].overlapVolume);
    const choice = chooseFor(prep, 20);
    let best = Infinity;
    for (const axis of ['x', 'y'] as const) {
      const rp = sideRows(sideField(prep, `+${axis}`, 0.5, 20, null).field, `+${axis}`, prep.bounds);
      const rm = sideRows(sideField(prep, `-${axis}`, 0.5, 20, null).field, `-${axis}`, prep.bounds);
      const a = axis === 'x' ? 0 : 1;
      const lo = prep.bounds.min[a] + SWEEP_FROM * (prep.bounds.max[a] - prep.bounds.min[a]), hi = prep.bounds.min[a] + SWEEP_TO * (prep.bounds.max[a] - prep.bounds.min[a]);
      for (let xs = Math.ceil(lo / 0.25) * 0.25; xs <= hi; xs += 0.25) best = Math.min(best, scoreSplit(rp, rm, xs, prep.ctx.raise).volume - prep.modelVolume);
    }
    // The chosen split's own fine pair, its roof stopped and its far side flattened at hs, as the export builds it.
    const plus = sideField(prep, `+${choice.axis}`, 0.5, 20, choice.xs), minus = sideField(prep, `-${choice.axis}`, 0.5, 20, choice.xs);
    const chosen = scoreSplitBrute(plus.field, minus.field, prep.bounds, choice.axis, choice.xs, prep.ctx.raise).volume - prep.modelVolume;
    expect(chosen / best - 1).toBeLessThanOrEqual(0.02);
  }, 600_000);
});

describe('G13.6 the O(1) bounds', () => {
  const contains = (outer: Rect, inner: Rect): boolean => outer.x0 <= inner.x0 + 1e-9 && outer.y0 <= inner.y0 + 1e-9 && outer.x1 >= inner.x1 - 1e-9 && outer.y1 >= inner.y1 - 1e-9;
  const cases: [string, () => WeldedMesh][] = [
    ['goddess', () => orientedExample('goddess').mesh],
    // A random soup over z >= 0, with some vertices high above the joint, so the z filter matters.
    ['a random mesh', () => {
      let seed = 7;
      const next = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
      const soup = new Float32Array(40 * 9);
      for (let k = 0; k < soup.length; k += 3) soup.set([next() * 60 - 30, next() * 40 - 10, next() ** 2 * 50], k);
      return weld(soup);
    }],
  ];
  it.each(cases)('sideBoundsFast holds sideBounds and quickRim the exact rim on %s, both axes, across the extent', (_name, mesh) => {
    const prep = prepFor(mesh(), (p) => (p.silicone.wallDraftDeg = 3));
    const { vertices } = prep;
    let checked = 0;
    for (const axis of ['x', 'y'] as const) {
      const a = axis === 'x' ? 0 : 1;
      for (const f of [0, 0.13, 0.5, 0.77, 1]) {
        const xs = vertices.min[a] + f * (vertices.max[a] - vertices.min[a]);
        const fast = sideBoundsFast(vertices, axis, xs), exact = sideBounds(vertices, axis, xs);
        expect(contains(fast.side, exact.side), `D_side at ${axis} ${f}`).toBe(true);
        expect(contains(fast.all, exact.all), `D3 at ${axis} ${f}`).toBe(true);
        const quick = quickRim(prep.ctx, axis, xs), rim = exactRim(prep, axis, xs);
        for (const k of ['D', 'Dside', 'D3', 'O'] as const) expect(contains(quick[k], rim[k]), `${k} at ${axis} ${f}`).toBe(true);
        expect(quick.Zt).toBeGreaterThanOrEqual(rim.Zt - 1e-9);
        const growth = fastenerGrowth(prep.params);
        const q = bedFootprint(quick, axis, xs, growth), e = bedFootprint(rim, axis, xs, growth);
        expect(q.width).toBeGreaterThanOrEqual(e.width - 1e-9);
        expect(q.length).toBeGreaterThanOrEqual(e.length - 1e-9);
        for (const k of [0, 1]) expect(q.depths[k]).toBeGreaterThanOrEqual(e.depths[k] - 1e-9);
        checked++;
      }
      // The widest z filter holds only inside the extent, so a seam outside it is refused.
      expect(() => sideBoundsFast(vertices, axis, vertices.max[a] + 1)).toThrow(/outside the model's extent/);
    }
    expect(checked).toBe(10);
  });
});

describe('MP1 goldens', () => {
  for (const id of ['goddess', 'vis35'] as const satisfies readonly (keyof typeof CLAMSHELL_GOLDEN)[]) {
    it(`the two-part cover of ${id} at defaults holds its golden within 1%`, (ctx) => {
      if (id === 'vis35') skipWithout(ctx, 'vis35');
      const g: ClamshellGolden = CLAMSHELL_GOLDEN[id];
      const prep = prepFor(orientedExample(id).mesh, undefined, GOLDEN[id].overlapVolume);
      const choice = chooseFor(prep, prep.params.clamshell.ceilingDeg);
      expect(choice.axis).toBe(g.axis);
      expect(choice.xs).toBeCloseTo(g.xs, 6);
      const fine = fineSplit(prep, choice.axis, choice.xs, prep.params.quality.cellFinal);
      const hold = seamHold(prep, fine);
      const within = (actual: number, expected: number): void => {
        expect(Math.abs(actual - expected), `${actual} against ${expected}`).toBeLessThanOrEqual(Math.abs(expected) * 0.01);
      };
      within(fine.siliconeMl, g.silicone);
      within(fine.rim.Zt, g.Zt);
      within(fine.holdN, g.holdN);
      within(fine.forces[0].sideN, g.push[0]);
      within(fine.forces[1].sideN, g.push[1]);
      expect(hold.bolts.perEnd).toBe(g.boltsPerEnd);
      expect(hold.bolts.heldBack).toBe(false);
      // G13.6: at the export cell neither half's cavity at z <= zJ passes D_side, so it keeps off the joint.
      for (const side of [fine.plus, fine.minus]) {
        expect(sideOverrun(side.field, side.side.pull, prep.bounds, side.hs, side.side.plan.raise, fine.rim.Dside, fine.rim.zJ), side.side.pull).toBe(0);
      }
    }, 600_000);
  }
});
