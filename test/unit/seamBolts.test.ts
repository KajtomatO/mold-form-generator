import { describe, expect, it } from 'vitest';
import { defaultParams } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';
import { BOLT_HOLD_N, FASTENERS, threadPast } from '../../src/core/parts/fasteners';
import { headThickness, LUG_CLEAR, LUG_GAP, PRY_RUN, lugBedGrowth, placeSeamBolts, seamBoltNeeds, slotFace } from '../../src/core/parts/seamBolts';
import type { ClamRim } from '../../src/core/parts/rim';
import { SEAL_SPACING_MM } from '../../src/core/report/clamp';
import { chooseFor, fineSplit, orientedGallery, prepareClamshell } from '../fixtures/clamshell';
import { orientedExample } from '../fixtures/fieldRuns';
import { skipWithout, type ExampleId } from '../fixtures/loadExamples';

/** MP1: G13.10's seam bolts with no solids: sizes, the slot's layer, the length rules and the placement (docs/PLAN.md, MP1's checks). */

function params(change: (p: Params) => void = () => {}): Params {
  const p = defaultParams('clamshell');
  change(p);
  return p;
}

/** A rim of the halves' box alone: O 100 x 60 round the origin, Zt as asked, the joint's defaults. */
function rimOf(Zt: number, O = { x0: -50, x1: 50, y0: -30, y1: 30 }): Pick<ClamRim, 'O' | 'Zt' | 'Tb' | 'proud'> {
  return { O, Zt, Tb: 4, proud: 0.2 };
}

describe('G13.10.2 sizes', () => {
  // The table: rh, rk, sinkDepth, s, apex, slotHeight, e, p, c, hL, f_min, Tn,min, auto length, bed growth, hex key.
  const TABLE = {
    'M2.5': [1.45, 2.95, 1.5, 5.3, 3.06, 2.5, 4.26, 8.52, 4.26, 14, 2.6, 2.7, 10, 17.0, 1.5],
    M3: [1.7, 3.56, 1.86, 5.8, 3.35, 2.9, 4.76, 9.52, 4.76, 14, 2.6, 3.06, 10, 19.0, 2],
    M4: [2.2, 4.68, 2.48, 7.3, 4.21, 3.7, 5.88, 11.76, 5.88, 14, 2.6, 3.68, 12, 23.5, 2.5],
  } as const;
  it.each(Object.entries(TABLE))('%s matches the table', (size, row) => {
    const n = seamBoltNeeds(params((p) => (p.bolts.size = size as Params['bolts']['size'])));
    const got = [n.holeRadius, n.sinkRadius, n.sinkDepth, n.slotWidth, n.apex, n.slotHeight, n.e, n.p, n.c, n.height, n.fMin, n.tnMin, n.autoLength, lugBedGrowth(n), n.hexKey];
    got.forEach((value, k) => expect(Math.abs(value - row[k]), `column ${k}: ${value} against ${row[k]}`).toBeLessThanOrEqual(k === 13 ? 0.05 : 0.005));
    expect(n.length).toBe(n.autoLength);
    // e leaves minWall from the bore to O's face and to the lug's tip, and more beside the slot.
    expect(n.c - n.sinkRadius).toBeGreaterThanOrEqual(n.minWall - 1e-9);
    expect(n.e - n.slotWidth / 2).toBeGreaterThan(n.minWall);
  });

  it('the user\'s length is used where set', () => {
    expect(seamBoltNeeds(params((p) => (p.bolts.length = 12))).length).toBe(12);
  });
});

describe('G13.10.4 and G13.10.5 the slot and the length', () => {
  it('f is a whole number of layers from the back face and lies in [f_min, f_min + layer) over a sweep of H+', () => {
    const n = seamBoltNeeds(params());
    for (let H = 5; H <= 120; H += 0.0173) {
      const f = slotFace(H, n);
      expect(f).toBeGreaterThanOrEqual(n.fMin - 1e-9);
      expect(f).toBeLessThan(n.fMin + n.layer - 1e-9);
      const layers = (H - f) / n.layer;
      expect(Math.abs(layers - Math.round(layers))).toBeLessThan(1e-6);
    }
  });

  it.each(['M2.5', 'M3', 'M4'] as const)('at %s, Tn >= Tn,min at the auto length for every f, a flush head passing the nut by 2 threads', (size) => {
    const n = seamBoltNeeds(params((p) => (p.bolts.size = size)));
    const fastener = FASTENERS[size];
    for (let f = n.fMin; f < n.fMin + n.layer; f += n.layer / 50) {
      const tn = headThickness(n.autoLength, f, fastener);
      expect(tn).toBeGreaterThanOrEqual(n.tnMin - 1e-9);
      expect(n.autoLength - (tn + f + fastener.nutHeight)).toBeCloseTo(threadPast(fastener), 9);
    }
  });

  it('seam-bolt-short at M3 x 6 and seam-bolt-long at M3 x 40, each naming the length that fits', () => {
    const short = placeSeamBolts(seamBoltNeeds(params((p) => (p.bolts.length = 6))), rimOf(80), 'x', 0);
    const s = short.diagnostics.find((d) => d.code === 'seam-bolt-short');
    expect(s?.severity).toBe('warning');
    expect(s?.message).toContain('use 10 mm or longer');
    expect(short.lengthFits).toBe(false);
    // A half 20 mm deep holds a lug of at most 18.8 mm, which an M3 x 40 passes.
    const narrow = { x0: -20, x1: 20, y0: -30, y1: 30 };
    const long = placeSeamBolts(seamBoltNeeds(params((p) => (p.bolts.length = 40))), rimOf(80, narrow), 'x', 0);
    const l = long.diagnostics.find((d) => d.code === 'seam-bolt-long');
    expect(l?.severity).toBe('warning');
    expect(long.lengthFits).toBe(false);
    expect(l?.message).toContain(`use ${long.longest} mm or shorter`);
    expect(long.longest).toBe(20);
    expect(placeSeamBolts(seamBoltNeeds(params((p) => (p.bolts.length = 20))), rimOf(80, narrow), 'x', 0).lengthFits).toBe(true);
    expect(placeSeamBolts(seamBoltNeeds(params((p) => (p.bolts.length = 25))), rimOf(80, narrow), 'x', 0).lengthFits).toBe(false);
    const auto = placeSeamBolts(seamBoltNeeds(params()), rimOf(80), 'x', 0);
    expect(auto.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(auto.lengthFits).toBe(true);
  });
});

describe('G13.10.6 how many and where', () => {
  it('the lowest lug sits at the bottom edge, the top one at most Zt - 13, gaps at least LUG_CLEAR, centres at most 100 apart', () => {
    const n = seamBoltNeeds(params());
    for (let Zt = 23.2; Zt <= 400; Zt += 0.37) {
      const layout = placeSeamBolts(n, rimOf(Zt), 'y', 0);
      expect(layout.perEnd).toBeGreaterThan(0);
      const bottom = -4 + 0.2;
      expect(layout.zs[0] - n.height / 2).toBeCloseTo(bottom, 9);
      const top = layout.zs[layout.zs.length - 1] + n.height / 2;
      expect(top).toBeLessThanOrEqual(Zt - PRY_RUN - LUG_GAP + 1e-9);
      for (let k = 1; k < layout.zs.length; k++) {
        expect(layout.zs[k] - layout.zs[k - 1] - n.height).toBeGreaterThanOrEqual(LUG_CLEAR - 1e-9);
        expect(layout.zs[k] - layout.zs[k - 1]).toBeLessThanOrEqual(SEAL_SPACING_MM + 1e-9);
      }
      // Both end faces alike, each axis c outside its face.
      expect(layout.spots.filter((s) => s.end === 'b0').map((s) => s.z)).toEqual(layout.zs);
      expect(layout.spots.filter((s) => s.end === 'b1').map((s) => s.b)).toEqual(layout.zs.map(() => 50 + n.c));
    }
  });

  it('Zt 30 gives one per end with seam-bolt-single, and Zt 20 seam-bolt-no-room', () => {
    const n = seamBoltNeeds(params());
    const one = placeSeamBolts(n, rimOf(30), 'x', 0);
    expect(one.perEnd).toBe(1);
    expect(one.count).toBe(2);
    expect(one.diagnostics.map((d) => d.code)).toContain('seam-bolt-single');
    const none = placeSeamBolts(n, rimOf(20), 'x', 0);
    expect(none.perEnd).toBe(0);
    const d = none.diagnostics.find((x) => x.code === 'seam-bolt-no-room');
    expect(d?.severity).toBe('error');
    expect(d?.also).toEqual(['clamshell.fastener', 'cover.topCap']);
    // Both heights as printed: 20 + 4 - 0.2, against the lug, the chamfers' run and the gap, 14 + 12 + 1.
    expect(d?.message).toContain('The halves are 23.8 mm tall');
    expect(d?.message).toContain('which needs them at least 27.0 mm tall: set Seam fasteners to None, or raise Top cap by at least 3.2 mm.');
    // The thresholds: 23.2 for one, 45.2 for two.
    expect(placeSeamBolts(n, rimOf(23.2), 'x', 0).perEnd).toBe(1);
    expect(placeSeamBolts(n, rimOf(23.1), 'x', 0).perEnd).toBe(0);
    expect(placeSeamBolts(n, rimOf(45.1), 'x', 0).perEnd).toBe(1);
    expect(placeSeamBolts(n, rimOf(45.2), 'x', 0).perEnd).toBe(2);
  });

  it('a side push of 300 N raises n', () => {
    const n = seamBoltNeeds(params());
    const plain = placeSeamBolts(n, rimOf(116), 'x', 0, 30);
    expect(plain.perEnd).toBe(2);
    const pushed = placeSeamBolts(n, rimOf(116), 'x', 0, 300);
    expect(pushed.perEnd).toBe(3);
    expect(2 * pushed.perEnd * BOLT_HOLD_N).toBeGreaterThanOrEqual(300);
    expect(pushed.heldBack).toBe(false);
    expect(pushed.diagnostics.map((d) => d.code)).not.toContain('seam-bolt-held-back');
  });

  it('a hold past what fits up the end faces is said, as is one past a single pair', () => {
    const n = seamBoltNeeds(params());
    // Zt 116 leaves room for 5 a face: 92.8 mm between the centres, 22 a lug and its gap.
    const short = placeSeamBolts(n, rimOf(116), 'x', 0, 1000);
    expect(short.perEnd).toBe(5);
    expect(short.heldBack).toBe(true);
    const d = short.diagnostics.find((x) => x.code === 'seam-bolt-held-back');
    expect(d?.severity).toBe('warning');
    expect(d?.also).toEqual(['clamshell.fastener', 'bolts.size']);
    expect(d?.message).toContain('holding with 1000 N, and the 10 seam bolts that fit up the end faces are counted at 500 N');
    expect(d?.message).toContain('set Seam fasteners to None');
    // One per end holds 2 BOLT_HOLD_N, and the guard is still read there.
    const single = placeSeamBolts(n, rimOf(30), 'x', 0, 2 * BOLT_HOLD_N + 1);
    expect(single.perEnd).toBe(1);
    expect(single.heldBack).toBe(true);
    expect(single.diagnostics.map((x) => x.code)).toContain('seam-bolt-held-back');
    expect(placeSeamBolts(n, rimOf(30), 'x', 0, 2 * BOLT_HOLD_N).heldBack).toBe(false);
  });

  // G13.10.6's table at the default beta 20: model, axis, lug pairs per end face.
  const TABLE: [string, () => ReturnType<typeof orientedGallery>, 'x' | 'y', number][] = [
    ['sphere', () => orientedGallery('sphere'), 'x', 2],
    ['benchy', () => orientedExample('benchy').mesh, 'y', 2],
    ['goddess', () => orientedExample('goddess').mesh, 'y', 2],
    ['vis35', () => orientedExample('vis35').mesh, 'x', 3],
    ['wolf', () => orientedExample('wolf').mesh, 'x', 3],
    ['vis35', () => orientedExample('vis35').mesh, 'y', 3],
  ];
  for (const [id, mesh, axis, perEnd] of TABLE) {
    it(`G13.10.6's table: ${id} split along ${axis} takes ${perEnd} per end`, (ctx) => {
      if (id === 'vis35') skipWithout(ctx, 'vis35');
      const prep = prepareClamshell(mesh(), params((p) => {
        p.clamshell.axis = axis;
        Object.assign(p.print, { bedX: 1000, bedY: 1000, bedZ: 1000 });
      }));
      const choice = chooseFor(prep, 20);
      // The rule as the app runs it: the exact rim, and the hold the fine fields give, so the force guard is read too.
      const fine = fineSplit(prep, axis, choice.xs, 0.5);
      const layout = placeSeamBolts(seamBoltNeeds(prep.params), fine.rim, axis, choice.xs, fine.holdN);
      expect(fine.holdN).toBeGreaterThan(0);
      expect(layout.perEnd).toBe(perEnd);
      expect(layout.heldBack).toBe(false);
      expect(layout.length).toBe(10);
    }, 600_000);
  }
});
