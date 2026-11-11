import { beforeAll, describe, expect, it } from 'vitest';
import { airReport } from '../../src/core/analysis/air';
import { demoldReport, holdsInLoop, type DemoldReport } from '../../src/core/analysis/demold';
import { analyseIntervals, type IntervalReport } from '../../src/core/analysis/intervals';
import { exteriorMesh } from '../../src/core/field/sealed';
import { orientedExample } from '../fixtures/fieldRuns';
import { EXAMPLE_IDS, hasExample, type ExampleId } from '../fixtures/loadExamples';
import { insideMesh } from '../fixtures/rays';
import { goldenParams, REPORT_GOLDEN } from './golden';

/** S8 on each example on its default plane, at the default analysis cell, and the reports at default filters. */
const params = goldenParams();
const minVolume = params.reports.minVolumeMl * 1000;
const s8 = new Map<ExampleId, IntervalReport>();
const demold = new Map<ExampleId, DemoldReport>();

beforeAll(() => {
  for (const id of EXAMPLE_IDS) {
    const report = analyseIntervals(orientedExample(id).mesh, params.quality.analysisCell);
    s8.set(id, report);
    demold.set(id, demoldReport(report, { minVolume, minIsland: params.base.minIsland, outside: () => null }));
  }
});

const air = (id: ExampleId) => airReport(s8.get(id)!, { leaves: 0, uncovered: [] }, { minVolume, minPersistence: params.reports.undersidePersistence });
const ml = (mm3: number): number => mm3 / 1000;
const within = (value: number, expected: number, share: number, what: string): void => {
  if (expected === 0) expect(value, what).toBe(0);
  else expect(Math.abs(value / expected - 1), `${what}: ${value} against ${expected}`).toBeLessThanOrEqual(share);
};

describe('S8 and the reports on the 8 examples', () => {
  // The barrel is kept on the maintainer's machine only: a clone checks these on the other models without it.
  it('sealed domains: the barrel\'s void of 3.43 ml within 3%, inside the model, and none past the filter on the others', () => {
    for (const id of EXAMPLE_IDS) {
      const sealed = air(id).sealed;
      if (id === 'barrel') {
        expect(sealed).toHaveLength(1);
        within(ml(sealed[0].volume), 3.43, 0.03, 'barrel void');
        expect(sealed[0].inModel).toBe(true);
        // It is in the model's volume already, so the silicone figure takes off nothing more.
        expect(air(id).sealedAir).toBe(0);
      } else {
        expect(sealed, id).toEqual([]);
        expect(air(id).sealedAir, id).toBe(0);
      }
    }
  });

  it('tiny hits are found and filtered: Benchy\'s 8 letters and wolf\'s 18 recesses under the filter, their stray pockets under it too', () => {
    for (const id of EXAMPLE_IDS) {
      const raw = s8.get(id)!;
      expect({ pockets: raw.pockets.length, sealed: raw.sealed.length }, id).toEqual(REPORT_GOLDEN[id].raw);
      for (const d of raw.sealed) if (!(id === 'barrel' && d.inModel)) expect(d.volume, id).toBeLessThan(minVolume);
    }
    // M3 counted the recesses the plate seals under Benchy and wolf: its 8 letters, and wolf's, which S8
    // reads as 18 domains. All are under the filter, and so are the pockets past Benchy's one.
    expect(air('benchy').filtered).toEqual({ sealed: 8, underside: 1 });
    expect(air('wolf').filtered).toEqual({ sealed: 18, underside: 71 });
    expect(air('goddess').filtered).toEqual({ sealed: 2, underside: 20 });
    if (hasExample('barrel')) expect(air('barrel').filtered).toEqual({ sealed: 0, underside: 0 });
    expect(air('wolf').underside).toEqual([]);
  });

  it('Benchy has one air pocket under it, of about 0.53 ml within 25%, which no top vent reaches', () => {
    const pockets = air('benchy').underside;
    expect(pockets).toHaveLength(1);
    within(ml(pockets[0].volume), 0.53, 0.25, 'Benchy underside');
    expect(pockets[0].persistence).toBeGreaterThanOrEqual(params.reports.undersidePersistence);
    for (const id of EXAMPLE_IDS) if (id !== 'benchy') expect(air(id).underside, id).toEqual([]);
  });

  it('loop lock: wolf stands on 3 places of one shell, x8\'s 8 barriers on one each, and Benchy on one, its lettering sealed', () => {
    const locked = (id: ExampleId): boolean => demold.get(id)!.bodies.some((b) => b.loopLock);
    expect(locked('wolf')).toBe(true);
    expect(locked('x8')).toBe(false);
    expect(demold.get('x8')!.bodies.map((b) => b.footprints)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(demold.get('wolf')!.bodies[0].footprints).toBe(3);
    // The plan expected Benchy's second patch, 8.3 mm2, to lock it. It is the inside of a letter of the
    // engraving under the hull, ringed by the 0.3 mm recess the plate seals, so no silicone gets between
    // the patches and they are one place: 456.3 + 8.3 mm2.
    const benchy = s8.get('benchy')!;
    expect(locked('benchy')).toBe(false);
    expect(benchy.footprints.map((f) => Number(f.area.toFixed(2)))).toEqual([464.56]);
    expect(benchy.sealed.filter((d) => d.onPlane).length).toBeGreaterThan(0);
    // Benchy is held in a loop all the same: the silicone in its cabin runs round the cabin's posts.
    const cabin = benchy.silicone.filter((s) => s.volume >= minVolume && holdsInLoop(s));
    expect(cabin).toHaveLength(1);
    expect(cabin[0].mouths).toBe(1);
    expect(cabin[0].walls).toBeGreaterThanOrEqual(4);
    expect(Math.abs(cabin[0].volume / 1000 - 8.4)).toBeLessThan(0.1);
    expect(demold.get('benchy')!.verdict).toBe('cut-required');
    expect(demold.get('benchy')!.hints[0]).toMatchObject({ reason: 'sandwiched', cuts: true });
  });

  it('every hint lies in the silicone: outside the model and its hollows, in free space a column reads', () => {
    for (const id of EXAMPLE_IDS) {
      const { mesh } = orientedExample(id);
      const outer = exteriorMesh(mesh);
      for (const hint of demold.get(id)!.hints) {
        expect(insideMesh(outer, hint.at), `${id} ${hint.id} at ${hint.at.map((v) => v.toFixed(2))}`).toBe(false);
        expect(hint.at[2], `${id} ${hint.id}`).toBeGreaterThan(0);
      }
    }
    // Negative control: the barrel's under-plug is a ring round its foot, and its middle is in the hollow,
    // which the plain centroid gave. Goddess's largest sandwiched body's middle is in her solid.
    if (hasExample('barrel')) {
      const barrel = s8.get('barrel')!.silicone.filter((s) => s.volume >= minVolume).sort((a, b) => b.volume - a.volume)[0];
      expect(insideMesh(exteriorMesh(orientedExample('barrel').mesh), barrel.centroid)).toBe(true);
    }
    const goddess = s8.get('goddess')!.silicone.filter((s) => s.kind === 'sandwiched').sort((a, b) => b.volume - a.volume)[0];
    expect(insideMesh(orientedExample('goddess').mesh, goddess.centroid)).toBe(true);
  });

  it('verdicts: jersey and x8 plausible, wolf cut-required, Goddess and VIS-35 not plausible, and any other verdict has a hint', () => {
    const verdict = (id: ExampleId) => demold.get(id)!.verdict;
    expect(verdict('jersey')).toBe('plausible');
    expect(verdict('x8')).toBe('plausible');
    expect(verdict('wolf')).toBe('cut-required');
    expect(verdict('goddess')).not.toBe('plausible');
    if (hasExample('vis35')) expect(verdict('vis35')).not.toBe('plausible');
    for (const id of EXAMPLE_IDS) {
      const report = demold.get(id)!;
      if (report.verdict !== 'plausible') expect(report.hints.length, id).toBeGreaterThan(0);
      for (const body of report.bodies) if (body.verdict !== 'plausible') expect(report.hints.some((h) => report.bodies[h.body] === body), id).toBe(true);
    }
  });

  it('every figure matches the M7 goldens within 5%', () => {
    for (const id of EXAMPLE_IDS) {
      const golden = REPORT_GOLDEN[id];
      const report = demold.get(id)!;
      const raw = s8.get(id)!;
      expect(report.verdict, id).toBe(golden.verdict);
      expect(report.bodies.map((b) => b.footprints), id).toEqual(golden.footprints);
      expect(report.hints.length, id).toBe(golden.hints);
      within(ml(report.bodies.reduce((sum, b) => sum + b.underPlug, 0)), golden.underPlugMl, 0.05, `${id} under-plug`);
      within(ml(report.bodies.reduce((sum, b) => sum + b.sandwiched, 0)), golden.sandwichedMl, 0.05, `${id} sandwiched`);
      expect(raw.silicone.filter((s) => s.volume >= minVolume && holdsInLoop(s)).length, id).toBe(golden.looped);
      const a = air(id);
      expect(a.underside.length, id).toBe(golden.undersideMl.length);
      a.underside.forEach((p, k) => within(ml(p.volume), golden.undersideMl[k], 0.05, `${id} pocket`));
      expect(a.sealed.map((d) => d.inModel), id).toEqual(golden.sealed.map((d) => d.inModel));
      a.sealed.forEach((d, k) => within(ml(d.volume), golden.sealed[k].ml, 0.05, `${id} sealed`));
    }
  });
});
