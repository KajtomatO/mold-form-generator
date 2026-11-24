import { describe, expect, it } from 'vitest';
import type { Field } from '../../src/core/field/grid';
import { defaultParams } from '../../src/core/params/defaults';
import { placeSeamBolts, seamBoltNeeds } from '../../src/core/parts/seamBolts';
import { BELT_UNDER_TOP, BELT_WIDTH, clampAdvice, filmPush, GRAVITY, halfForces, halvesTape, MIN_HOLD_N, SEAL_SPACING_MM, seamBelts, seamBoltAdvice, seamHoldN, topSpanOf, wedgeN } from '../../src/core/report/clamp';
import { chooseFor, exactRim, fineSplit, prepareClamshell, seamHold } from '../fixtures/clamshell';
import { orientedExample } from '../fixtures/fieldRuns';
import { skipWithout } from '../fixtures/loadExamples';

/** MP1: G13.9's forces on the halves, G13.10.7's hold, the wedge and the top span, and G13.10.9's belts (docs/PLAN.md, MP1's checks). */

const RHO = 1.1;
const rhoG = RHO * 1000 * GRAVITY * 1e-9;

/** A side field of one column of b, `cell` 1, v = 0 at row 2, with reach hs + depth(z) at each z >= 0 and nothing below. */
function column(depth: (z: number) => number, rows: number, hs = 10): Field {
  const values = new Float32Array(rows + 2);
  for (let j = 0; j < rows; j++) values[j + 2] = depth(j) > 0 ? hs + depth(j) : 0;
  return { nx: 1, ny: rows + 2, cell: 1, x0: 0, y0: -2, values };
}

describe('G13.9 forces on a half', () => {
  it('the side push is the head on the cavity\'s shadow on P', () => {
    const f = column(() => 5, 21);
    const { sideN, seamArea } = halfForces(f, 10, 0, 100, RHO);
    // Rows 0 to 20, the floor at half weight: sum of (100 - z) over them.
    let head = 0;
    for (let z = 0; z <= 20; z++) head += (z === 0 ? 0.5 : 1) * (100 - z);
    expect(sideN).toBeCloseTo(rhoG * head, 12);
    expect(seamArea).toBeCloseTo(20.5, 12);
  });

  it('the net lift is the ceilings\' push up less the floors\' push down: Zf A0 - V', () => {
    // 5 deep up to z 10, 15 deep above it to z 20: a ceiling of 15 at the top, a floor of 10 at z 10.
    const f = column((z) => (z <= 10 ? 5 : 15), 21);
    const Zf = 100;
    const { liftN, volume } = halfForces(f, 10, 0, Zf, RHO);
    expect(volume).toBeCloseTo(0.5 * 5 + 10 * 5 + 10 * 15, 9);
    // A0 is the cavity's depth at z = 0 over the column's width, the face the integration by parts leaves at the floor.
    expect(liftN).toBeCloseTo(rhoG * (Zf * 5 - volume), 12);
    // By the faces, in the continuum: up (Zf - 20) 15, down (Zf - 10) 10, both per mm of b.
    const faces = rhoG * ((Zf - 20) * 15 - (Zf - 10) * 10);
    expect(Math.abs(liftN - faces)).toBeLessThan(rhoG * Zf * 5);
    // An overhang wide enough pushes the half down.
    const down = halfForces(column((z) => (z < 2 ? 1 : 30), 21), 10, 0, 40, RHO);
    expect(down.liftN).toBeLessThan(0);
  });

  it('rows on the far side of P add nothing', () => {
    const f = column((z) => (z < 5 ? 5 : -5), 21);
    const near = halfForces(f, 10, 0, 100, RHO), cut = halfForces(column(() => 5, 5), 10, 0, 100, RHO);
    expect(near.sideN).toBeCloseTo(cut.sideN, 12);
  });

  it('the film\'s worst case holds the side push of either half, and J\'s rows', () => {
    const nb = 40, nz = 30, cell = 0.5;
    const seam = new Uint8Array(nb * nz);
    for (let z = 2; z < 20; z++) for (let b = 10; b < 30; b++) seam[b + z * nb] = 1;
    let shadow = 0;
    for (let z = 0; z < nz; z++) for (let b = 0; b < nb; b++) if (seam[b + z * nb]) shadow += 50 - z * cell;
    const film = filmPush(seam, nb, nz, cell, 2, null, 0, 50, RHO);
    expect(film).toBeGreaterThan(rhoG * shadow * cell * cell);
    const withJ = filmPush(seam, nb, nz, cell, 2, [0, (nb - 1) * cell], 1.5, 50, RHO);
    expect(withJ).toBeGreaterThan(film);
    // A ring of S: its hole is filled.
    const ring = new Uint8Array(nb * nz);
    for (let z = 4; z < 26; z++) for (let b = 4; b < 36; b++) if (z < 6 || z > 23 || b < 6 || b > 33) ring[b + z * nb] = 1;
    const ringFilm = filmPush(ring, nb, nz, cell, 0, null, 0, 50, RHO);
    const full = new Uint8Array(nb * nz);
    for (let z = 4; z < 26; z++) for (let b = 4; b < 36; b++) full[b + z * nb] = 1;
    expect(ringFilm).toBeCloseTo(filmPush(full, nb, nz, cell, 0, null, 0, 50, RHO), 12);
  });

  it('Goddess: a film never pushes less than a half, and the hold is twice the larger with at least MIN_HOLD_N', () => {
    const prep = prepareClamshell(orientedExample('goddess').mesh, defaultParams('clamshell'));
    const choice = chooseFor(prep, 20);
    const fine = fineSplit(prep, choice.axis, choice.xs, 0.5);
    expect(fine.filmN).toBeGreaterThanOrEqual(Math.max(fine.forces[0].sideN, fine.forces[1].sideN));
    expect(fine.holdN).toBeCloseTo(Math.max(2 * fine.filmN, MIN_HOLD_N), 9);
    expect(seamHoldN([1, 2], 1)).toBe(MIN_HOLD_N);
    expect(seamHoldN([7, 2], 6)).toBe(14);
    expect(seamHoldN([1, 2], 8)).toBe(16);
  });
});

describe('G13.9 the base tape and the wedge, G13.10.7 the top span', () => {
  it('the halves\' tape is clampAdvice on their summed lift, with at least one strip per half each way', () => {
    const plain = clampAdvice(3, 10, [80, 60]);
    const x = halvesTape([1, 2], 10, [80, 60], 'x');
    expect(x.holdN).toBe(plain.holdN);
    expect(x.across).toEqual([2, 1]);
    expect(x.strips).toBe(3);
    const y = halvesTape([1, 2], 10, [80, 60], 'y');
    expect(y.across).toEqual([1, 2]);
    // A half pushed down does not take tape from the other.
    expect(halvesTape([-5, 2], 10, [80, 60], 'x').holdN).toBe(MIN_HOLD_N);
    expect(halvesTape([20, 30], 10, [250, 60], 'x').across).toEqual([3, 1]);
  });

  it('the wedge is the tape\'s hold over tan(taper), and past the bottom pair\'s 100 N it says so', () => {
    expect(wedgeN({ holdN: 10 }, 15)).toBeCloseTo(37.32, 2);
    const layout = placeSeamBolts(seamBoltNeeds(defaultParams('clamshell')), { O: { x0: -40, x1: 40, y0: -30, y1: 30 }, Zt: 100, Tb: 4, proud: 0.2 }, 'x', 0);
    const quiet = seamBoltAdvice(layout, 20, 37.3, 60);
    expect(quiet.diagnostics).toEqual([]);
    expect(quiet.boltsHoldN).toBe(200);
    expect(quiet.bottomHoldN).toBe(100);
    const loud = seamBoltAdvice(layout, 20, 120, 60);
    expect(loud.diagnostics.map((d) => [d.code, d.severity])).toEqual([['seam-bolt-wedge', 'info']]);
  });

  it('a top span past SEAL_SPACING_MM asks for one clamp across the back faces', () => {
    const layout = placeSeamBolts(seamBoltNeeds(defaultParams('clamshell')), { O: { x0: -40, x1: 40, y0: -120, y1: 120 }, Zt: 100, Tb: 4, proud: 0.2 }, 'x', 0);
    expect(topSpanOf({ O: { x0: -40, x1: 40, y0: -120, y1: 120 } }, 'x')).toBe(240);
    expect(topSpanOf({ O: { x0: -40, x1: 40, y0: -120, y1: 120 } }, 'y')).toBe(80);
    const wide = seamBoltAdvice(layout, 20, 37, 240);
    expect(wide.topClamp).toBe(true);
    const d = wide.diagnostics.find((x) => x.code === 'seam-top-span');
    expect(d?.message).toContain('one clamp across the two back faces at the middle of the seam, 10 mm under the top');
    expect(seamBoltAdvice(layout, 20, 37, SEAL_SPACING_MM).topClamp).toBe(false);
  });
});

describe('G13.10.9 belts with Seam fasteners None', () => {
  it('at least two, the lowest at the bottom edge, none more than SEAL_SPACING_MM apart, more for the hold', () => {
    for (let Zt = 25; Zt < 400; Zt += 3.7) {
      const belts = seamBelts(20, 10, -3.8, Zt);
      expect(belts.count).toBeGreaterThanOrEqual(2);
      expect(belts.bottoms[0]).toBe(-3.8);
      expect(belts.bottoms[belts.count - 1] + BELT_WIDTH).toBeCloseTo(Math.max(-3.8 + BELT_WIDTH, Zt - BELT_UNDER_TOP), 9);
      for (let k = 1; k < belts.count; k++) expect(belts.bottoms[k] - belts.bottoms[k - 1]).toBeLessThanOrEqual(SEAL_SPACING_MM + 1e-9);
    }
    expect(seamBelts(100, 10, -3.8, 60).count).toBe(5);
  });

  it('Goddess takes 2 belts and VIS-35 pulled along x 3', (ctx) => {
    const goddess = prepareClamshell(orientedExample('goddess').mesh, defaultParams('clamshell'));
    const g = chooseFor(goddess, 20);
    const gr = exactRim(goddess, g.axis, g.xs);
    expect(seamBelts(2 * 5, 10, -gr.Tb + gr.proud, gr.Zt).count).toBe(2);
    skipWithout(ctx, 'vis35');
    const params = defaultParams('clamshell');
    params.clamshell.axis = 'x';
    Object.assign(params.print, { bedX: 300, bedY: 300 });
    const vis = prepareClamshell(orientedExample('vis35').mesh, params);
    const v = chooseFor(vis, 20);
    const fine = fineSplit(vis, v.axis, v.xs, 0.5);
    const vr = fine.rim;
    expect(seamBelts(fine.holdN, params.print.tapeStrip, -vr.Tb + vr.proud, vr.Zt).count).toBe(3);
    // With bolts it has its top clamp, as G13.10.7 says.
    expect(seamHold(vis, fine).advice.topClamp).toBe(true);
  });
});
