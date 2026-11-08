import { describe, expect, it } from 'vitest';
import { allDiagnostics, clampFigure, diagnosticMarkers, plasticOnScreen, previewSilicone } from '../../src/app/derived';
import { Pipeline } from '../../src/app/pipeline';
import { buildField } from '../../src/core/field/build';
import { fieldSettings, planField } from '../../src/core/field/grid';
import { defaultParams } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';
import { deriveRim, moldBounds } from '../../src/core/parts/rim';
import { clampAdvice, coverLift, fillLevel, MIN_HOLD_N } from '../../src/core/report/clamp';
import { bedTurn, fitsBed, partBoxes, plasticDiagnostic, plasticEstimate, printabilityDiagnostics, SPOOL_G } from '../../src/core/report/printability';
import { bareSettings, orientedExample } from '../fixtures/fieldRuns';
import { inProcessField, inProcessSolid } from '../fixtures/inProcessWorker';
import { exampleBytes, EXAMPLE_FILES, type ExampleId } from '../fixtures/loadExamples';
import { asciiStl, box, inverted, join, toSoup } from '../fixtures/synthetic';

const rimOf = (id: ExampleId, params: Params = defaultParams()) => {
  const { mesh, bounds } = orientedExample(id);
  return deriveRim(moldBounds(mesh, bounds, fieldSettings(params, bounds)), params);
};

/** The printability checks as main runs them, on the example's own tiles and height. */
const printability = (id: ExampleId, params: Params = defaultParams()) => {
  const { mesh, bounds } = orientedExample(id);
  const mold = moldBounds(mesh, bounds, fieldSettings(params, bounds));
  return printabilityDiagnostics(params, deriveRim(mold, params), { offsets: mold.offsets, modelTop: bounds.max[2] });
};

/** A pipeline with the reports on, run to idle on an example or STL bytes, freed afterwards. */
async function withPipeline<T>(bytes: Uint8Array, name: string, change: (p: Params) => void, read: (p: Pipeline) => T): Promise<T> {
  const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true, reports: true });
  try {
    p.load(bytes, name);
    p.setParams(change);
    await p.idle();
    return read(p);
  } finally {
    p.dispose();
  }
}

describe('the cover\'s lift and the tape', () => {
  it('lifts a box\'s cavity by rho g times the integral of (Zf - H), within 2% of the closed form', () => {
    // A 40 x 30 x 20 box dilated by r with no margin, draft or closing: the box grown by a ball, above
    // the plane. Its volume and footprint are closed forms, so the lift is too, worked out here alone.
    const [a, b, c] = [40, 30, 20];
    const mesh = box([0, 0, 0], [a, b, c]);
    const bounds = { min: [0, 0, 0] as [number, number, number], max: [a, b, c] as [number, number, number] };
    const settings = bareSettings(bounds, 0.125);
    const field = buildField(mesh, planField(bounds, settings), settings).field;
    const r = settings.t;
    const under = a * b * c + r * (a * b + 2 * b * c + 2 * c * a) + ((Math.PI * r * r) / 4) * (4 * c + 2 * a + 2 * b) + (2 / 3) * Math.PI * r ** 3;
    const footprint = a * b + 2 * r * (a + b) + Math.PI * r * r;
    const level = 50, density = 1.1;
    const expected = density * 1000 * 9.81 * (level * footprint - under) * 1e-9;
    const lift = coverLift(field, 0, level, density);
    expect(Math.abs(lift.forceN / expected - 1)).toBeLessThan(0.02);
    expect(Math.abs(lift.area / footprint - 1)).toBeLessThan(0.02);
    // The tool's raise lifts the ceiling, so less silicone stands over it.
    expect(coverLift(field, 1, level, density).forceN).toBeLessThan(lift.forceN);
  });

  it('the level is the rim of a full funnel when there are funnels in seats, and the flat top when not', () => {
    const params = defaultParams();
    expect(fillLevel(params, { Zt: 60 })).toBe(60 + params.funnel.height);
    params.funnel.generate = false;
    expect(fillLevel(params, { Zt: 60 })).toBe(60);
    // A funnel needs a seat to stand in, so with the seats off the silicone stands at the top.
    const unseated = defaultParams();
    unseated.seat.enabled = false;
    expect(unseated.funnel.generate).toBe(true);
    expect(fillLevel(unseated, { Zt: 60 })).toBe(60);
  });

  it('advises twice the lift and never under 10 N, in whole strips, and at least one strip each way per 100 mm of the box', () => {
    const small: [number, number] = [60, 40];
    expect(clampAdvice(1.3, 10, small)).toEqual({ holdN: MIN_HOLD_N, liftStrips: 1, across: [1, 1], strips: 2, stripN: 10 });
    expect(clampAdvice(11, 10, small)).toEqual({ holdN: 22, liftStrips: 3, across: [1, 1], strips: 3, stripN: 10 });
    expect(clampAdvice(11, 4, small)).toEqual({ holdN: 22, liftStrips: 6, across: [1, 1], strips: 6, stripN: 4 });
    expect(clampAdvice(5, 10, small)).toEqual({ holdN: 10, liftStrips: 1, across: [1, 1], strips: 2, stripN: 10 });
    // VIS-35's 63.6 x 230.6 mm box: one strip front to back, three left to right, so no two are over 100 mm apart.
    expect(clampAdvice(4.26, 10, [63.6, 230.6])).toMatchObject({ liftStrips: 1, across: [1, 3], strips: 4 });
    expect(clampAdvice(1, 10, [100, 100.01])).toMatchObject({ across: [1, 2] });
  });

  it('wolf: the Cover & joint figure holds at least 10 N, with the strips and the cover\'s weight beside its lift', async () => {
    const figure = await withPipeline(exampleBytes('wolf'), EXAMPLE_FILES.wolf, () => {}, (p) => clampFigure(p));
    expect(figure!.holdN).toBeGreaterThanOrEqual(MIN_HOLD_N);
    expect(figure!.holdN).toBeCloseTo(Math.max(2 * figure!.liftN, 10), 6);
    expect(figure!.liftStrips).toBe(Math.ceil(figure!.holdN / 10));
    expect(figure!.coverWeightN).toBeGreaterThan(0);
    // Measured at M7: 11.0 N of lift from 197.4 mm, 22.0 N to hold, which 3 strips do. Its 121.2 x 142.4 mm
    // box takes 2 strips each way to press the seal all round, so 4 in all.
    expect(figure!.liftN).toBeCloseTo(10.98, 1);
    expect(figure!.liftStrips).toBe(3);
    expect(figure!.across).toEqual([2, 2]);
    expect(figure!.strips).toBe(4);
  });
});

describe('printability', () => {
  it('VIS-35 does not fit the default bed straight: its cover is about 230 mm long, and its base 224 mm, so both must be turned', () => {
    const rim = rimOf('vis35');
    const [cover, base] = partBoxes(rim);
    expect(cover.size[1]).toBeCloseTo(230.6, 1);
    expect(base.size[1]).toBeCloseTo(224.3, 1);
    const warnings = printability('vis35');
    // Turned 45 degrees on a 220 mm square bed, a box takes (a + b) / sqrt 2 each way: 208.0 and 199.1 mm.
    expect((cover.size[0] + cover.size[1]) / Math.SQRT2).toBeLessThan(220);
    expect((base.size[0] + base.size[1]) / Math.SQRT2).toBeLessThan(220);
    expect(warnings.map((d) => [d.code, d.severity])).toEqual([['bed-turn', 'warning'], ['bed-turn', 'warning']]);
    expect(warnings[0].message).toContain('The cover is 63.6 x 230.6 x 143.1 mm as it prints, which fits the 220.0 x 220.0 x 250.0 mm bed set under Advanced, Printer, only turned about 45 degrees on it: rotate it about the vertical axis in your slicer');
    expect(warnings[1].message).toContain('The base is 57.3 x 224.3 x 5.2 mm');
    // A bed large enough, either way round, takes it straight.
    const big = defaultParams();
    big.print.bedY = 240;
    expect(printability('vis35', big)).toEqual([]);
    big.print.bedY = 220;
    big.print.bedX = 240;
    expect(printability('vis35', big)).toEqual([]);
    // A bed too small even turned says so, and what to do.
    const small = defaultParams();
    small.print.bedX = small.print.bedY = 180;
    const none = printability('vis35', small);
    expect(none.map((d) => d.code)).toEqual(['bed-too-small', 'bed-too-small']);
    expect(none[0].message).toContain('does not fit the 180.0 x 180.0 x 250.0 mm bed set under Advanced, Printer, even turned on it: it needs a larger bed or a smaller model.');
    expect(none[0].also).toBeUndefined();
  });

  it('the turn that fits is the one with the most room, and matches the closed form of a rectangle in a rectangle', () => {
    // On a square bed the most room is at 45 degrees.
    expect(bedTurn([230.6, 63.6, 10], [220, 220, 250])).toBe(45);
    expect(bedTurn([200, 100, 10], [220, 220, 250])).toBe(0);
    expect(bedTurn([100, 200, 10], [220, 150, 250])).toBe(0);
    expect(bedTurn([230, 230, 10], [220, 250, 250])).toBeNull();
    expect(bedTurn([100, 100, 260], [220, 250, 250])).toBeNull();
    // Carver's condition for a p x q rectangle (p >= q, p > a) in an a x b one: b >= (2pqa + (p^2 - q^2) sqrt(p^2 + q^2 - a^2)) / (p^2 + q^2).
    const carver = (p: number, q: number, a: number, b: number): boolean => b >= (2 * p * q * a + (p * p - q * q) * Math.sqrt(p * p + q * q - a * a)) / (p * p + q * q);
    for (const [p, q] of [[230.6, 63.6], [224.3, 57.3], [250, 40], [240, 90], [300, 10], [235, 120]]) {
      expect(bedTurn([p, q, 1], [220, 220, 250]) !== null, `${p} x ${q}`).toBe(carver(p, q, 220, 220));
    }
  });

  it('x8 on a 3 x 3 grid is 393.2 x 290.9 mm, over the bed even turned, while one copy would fit, so it says so under Grid too', () => {
    const params = defaultParams();
    params.grid.nx = params.grid.ny = 3;
    const [cover, base] = partBoxes(rimOf('x8', params));
    expect(cover.size[0]).toBeCloseTo(393.2, 1);
    expect(cover.size[1]).toBeCloseTo(290.9, 1);
    const bed = printability('x8', params).filter((d) => d.code === 'bed-too-small');
    expect(bed).toHaveLength(2);
    expect(bed[0].message).toContain('One copy alone would fit, so use fewer copies under Grid, or a larger bed.');
    expect(bed.map((d) => d.also)).toEqual([['grid.nx', 'grid.ny'], ['grid.nx', 'grid.ny']]);
    expect(base.size[2]).toBe(params.base.thickness + params.joint.ridgeHeight);
    for (const id of ['benchy', 'goddess', 'jersey', 'x8', 'barrel', 'wolf'] as ExampleId[]) expect(printability(id), id).toEqual([]);
  });

  it('in Mode B the base prints with the model on it, so its height is the base\'s and the model\'s', () => {
    const params = defaultParams();
    params.base.mode = 'merged';
    const { bounds } = orientedExample('vis35');
    const [, base] = partBoxes(rimOf('vis35', params), 'merged', bounds.max[2]);
    expect(base.size[2]).toBeCloseTo(params.base.thickness + bounds.max[2], 6);
    expect(printability('vis35', params)[1].message).toContain(`The base is 57.3 x 224.3 x ${(params.base.thickness + bounds.max[2]).toFixed(1)} mm`);
    // Taller than the bed, it fits no way at all.
    params.print.bedZ = 100;
    expect(printability('vis35', params).map((d) => d.code)).toEqual(['bed-too-small', 'bed-too-small']);
  });

  it('warns of a ridge narrower than two lines of the nozzle', () => {
    const params = defaultParams();
    expect(printability('jersey', params)).toEqual([]);
    params.joint.ridgeWidth = 0.7;
    expect(printability('jersey', params).map((d) => [d.code, d.severity])).toEqual([['ridge-narrow', 'warning']]);
    params.print.nozzle = 0.3;
    expect(printability('jersey', params)).toEqual([]);
  });

  it('the plastic is a note up to a spool, and a warning past it', () => {
    const params = defaultParams();
    expect(plasticDiagnostic({ solid: 328, printed: 165 }, params).severity).toBe('info');
    expect(plasticDiagnostic({ solid: 2000, printed: SPOOL_G }, params).severity).toBe('info');
    const heavy = plasticDiagnostic({ solid: 3100, printed: 1270 }, params);
    expect(heavy.severity).toBe('warning');
    expect(heavy.message).toContain('about 1.27 kg of plastic at 35 percent infill, or 3.10 kg printed solid');
    expect(heavy.message).toContain('more than a 1.00 kg spool');
  });

  it('the plastic is the parts\' volume at the plastic\'s density printed solid, and less with the infill and a solid skin', () => {
    const params = defaultParams();
    const cube = { volume: 1e6, area: 6e4, count: 1 };
    const { solid, printed } = plasticEstimate([cube, { volume: 1000, area: 600, count: 3 }], params);
    expect(solid).toBeCloseTo(((1e6 + 3000) * 1.24) / 1000, 6);
    // Three lines of 0.4 mm over the surface print solid; a part thinner than that is solid through.
    const skin = 6e4 * 3 * 0.4, small = Math.min(1000, 600 * 3 * 0.4);
    expect(printed).toBeCloseTo(((skin + 0.35 * (1e6 - skin) + 3 * (small + 0.35 * (1000 - small))) * 1.24) / 1000, 6);
    params.print.infill = 1;
    expect(plasticEstimate([cube], params).printed).toBeCloseTo(plasticEstimate([cube], params).solid, 6);
  });

  it('wolf takes about 3.1 kg printed solid, from the volumes of its cover, base and funnel, and warns as that is more than a spool', async () => {
    const read = await withPipeline(exampleBytes('wolf'), EXAMPLE_FILES.wolf, () => {}, (p) => {
      const rim = p.field!.value.rim, cover = p.cover!.value;
      // The cover's volume from its mesh, as the estimate reads it, against the box less what the box loses.
      let volume = 0;
      const { positions: q, indices } = cover;
      for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
        volume += (q[a] * (q[b + 1] * q[c + 2] - q[b + 2] * q[c + 1]) + q[a + 1] * (q[b + 2] * q[c] - q[b] * q[c + 2]) + q[a + 2] * (q[b] * q[c + 1] - q[b + 1] * q[c])) / 6;
      }
      // The block from the cover's bottom edge to Zt, less the rebate under the shelf and the cavity over it,
      // which is the integral of H with the preview's raise of the TIN.
      const { field } = p.field!.value;
      let cavity = 0;
      for (const h of field.values) if (h > 0) cavity += (h + p.params.quality.tinTolPreview) * field.cell * field.cell;
      const block = (rim.O.x1 - rim.O.x0) * (rim.O.y1 - rim.O.y0) * (rim.Zt + rim.Tb - rim.proud);
      const rebate = (rim.B.x1 - rim.B.x0) * (rim.B.y1 - rim.B.y0) * (rim.Tb - rim.proud);
      return { plastic: plasticOnScreen(p)!, rows: allDiagnostics(p).filter((d) => d.code === 'plastic-mass'), volume, expected: block - rebate - cavity };
    });
    // The plan estimated about 2 kg. The cover alone is 2.43 l, its 121.2 x 142.4 x 171.4 mm box less the
    // cavity: the rebate's taper, the groove, the chamfers, the notches and the bores make up the rest.
    expect(Math.abs(read.volume / read.expected - 1)).toBeLessThan(0.03);
    expect(read.volume / 1e6).toBeCloseTo(2.43, 2);
    expect(read.plastic.solid / 1000).toBeCloseTo(3.1, 1);
    expect(read.plastic.printed).toBeLessThan(read.plastic.solid);
    expect(read.rows).toHaveLength(1);
    expect(read.rows[0].message).toContain('3.10 kg printed solid');
    expect(read.rows[0].severity).toBe('warning');
  });

  it('a pocket of 0.1 mm at 0.2 mm layers warns under its control, as soon as the base is built', async () => {
    const codes = await withPipeline(exampleBytes('jersey'), EXAMPLE_FILES.jersey, (p) => (p.base.pocketDepth = 0.1), (p) => allDiagnostics(p).map((d) => d.code));
    expect(codes).toContain('pocket-layers');
  });
});

describe('the reports in the pipeline', () => {
  it('the preview\'s silicone takes off the sealed air S8 finds: an inverted box on the plate holds its air apart', async () => {
    // A box open at the bottom: 40 x 40 x 20, walls 3, roof 3. Its inside is sealed by the plate.
    const outer = box([0, 0, 0], [40, 40, 20]);
    const shell = join(outer, inverted(box([3, 3, 0], [37, 37, 17])));
    const bytes = asciiStl(toSoup(shell));
    const [withAir, without] = await Promise.all([true, false].map(async (reports) => {
      const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true, reports });
      try {
        p.load(bytes, 'open-box.stl');
        await p.idle();
        return { ml: previewSilicone(p)!.ml, sealed: p.reports?.value.air.sealed ?? [] };
      } finally {
        p.dispose();
      }
    }));
    expect(withAir.sealed).toHaveLength(1);
    expect(withAir.sealed[0].inModel).toBe(false);
    const air = (34 * 34 * 17) / 1000;
    expect(Math.abs(withAir.sealed[0].volume / 1000 / air - 1)).toBeLessThan(0.03);
    expect(without.ml - withAir.ml).toBeCloseTo(withAir.sealed[0].volume / 1000, 6);
  });

  it('never holds up the export: an export asked for during a change waits for the preview, not for the reports job it holds back', async () => {
    const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true, reports: true });
    try {
      p.load(exampleBytes('jersey'), EXAMPLE_FILES.jersey);
      await p.idle();
      const dispatched = (): number => p.log.filter((e) => e.gate === 'reports' && e.event === 'dispatch').length;
      const before = dispatched();
      // The next reports job is held for a minute, and the change asks for one once its preview is done.
      p.armFault('reports', { kind: 'delay', ms: 60_000 });
      p.setParams((params) => (params.silicone.t = 3.5));
      const steps: string[] = [];
      const started = Date.now();
      const result = await p.exportParts((s) => steps.push(s.step));
      const took = Date.now() - started;
      // It began in its wait for the preview, which it got, while the reports job was sent and is still held.
      expect(steps[0]).toBe('wait');
      expect(p.status().stale).toBe(false);
      expect(dispatched()).toBe(before + 1);
      expect(p.reports!.key).not.toBe(p.keys().S9);
      expect(took).toBeLessThan(30_000);
      // The export worked out its own, so its README has the verdict all the same.
      expect(new TextDecoder().decode(result.files['README.txt'])).toContain('Estimate: pull out in the cover.');
    } finally {
      p.dispose();
    }
  }, 120_000);

  it('a change of t runs S9 again on the S8 the worker keeps, and does not run S8 again', async () => {
    const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true, reports: true });
    try {
      p.load(exampleBytes('jersey'), EXAMPLE_FILES.jersey);
      await p.idle();
      expect(p.reportTimes.S8).toHaveLength(1);
      const before = p.reports!.value.lift.forceN;
      p.setParams((params) => (params.silicone.t = 4));
      await p.idle();
      expect(p.reportTimes.S8).toHaveLength(1);
      expect(p.reportTimes.S9).toHaveLength(2);
      expect(p.reports!.key).toBe(p.keys().S9);
      // The flat top rises with t, and the head over the ceiling with it, while the cavity widens: more lift.
      expect(p.reports!.value.lift.forceN).toBeGreaterThan(before);
    } finally {
      p.dispose();
    }
  });

  it('the reports are a note when they fail, never an error that holds the export, and the export says so with no verdict', async () => {
    const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true, reports: true });
    try {
      p.load(exampleBytes('jersey'), EXAMPLE_FILES.jersey);
      p.setParams((params) => (params.quality.analysisCell = 0));
      await p.idle();
      expect(p.reportsError()).toContain('analysis cell');
      const row = allDiagnostics(p).find((d) => d.code === 'reports-failed')!;
      expect(row.severity).toBe('warning');
      expect(p.error).toBeNull();
      // The export's own S8 meets the same cell, and a negative one too, which reads no column at all.
      for (const cell of [0, -0.25]) {
        p.setParams((params) => (params.quality.analysisCell = cell));
        await p.idle();
        const result = await p.exportParts();
        const readme = new TextDecoder().decode(result.files['README.txt']).replace(/\r\n\s*/g, ' ');
        expect(readme, `cell ${cell}`).toContain('The demold estimate could not be worked out for this export (An analysis cell of');
        expect(readme, `cell ${cell}`).not.toContain('Estimate:');
        expect(result.report!.reports).toBeNull();
        expect(result.report!.reportsError).toContain('analysis cell');
        expect(result.diagnostics.map((d) => d.code)).toContain('reports-failed');
        // The silicone still has its figure, with nothing taken off for air S8 would have found.
        expect(result.report!.silicone.ml).toBeGreaterThan(10);
      }
    } finally {
      p.dispose();
    }
  }, 120_000);

  it('the verdict row\'s Show marks every hint: all 16 of wolf\'s, each with its seam', async () => {
    const read = await withPipeline(exampleBytes('wolf'), EXAMPLE_FILES.wolf, () => {}, (p) => {
      const top = p.field!.value.rim.Zt;
      const row = allDiagnostics(p).find((d) => d.code === 'demold-verdict')!;
      return { markers: diagnosticMarkers(row, top), hints: p.reports!.value.demold.hints };
    });
    expect(read.hints).toHaveLength(16);
    expect(read.markers).toEqual(read.hints.map((h) => ({ at: h.at, seam: h.seam })));
  });
});
