import { beforeAll, describe, expect, it } from 'vitest';
import { diagnosticPoint, modelSize, moldBox, previewSilicone, siliconeAdvice } from '../../src/app/derived';
import { Pipeline } from '../../src/app/pipeline';
import { fieldSettings } from '../../src/core/field/grid';
import { defaultParams } from '../../src/core/params/defaults';
import { deriveRim, moldBounds, type Rim } from '../../src/core/parts/rim';
import { orientedExample } from '../fixtures/fieldRuns';
import { inProcessField, inProcessSolid } from '../fixtures/inProcessWorker';
import { exampleBytes, EXAMPLE_FILES, EXAMPLE_IDS, type ExampleId } from '../fixtures/loadExamples';
import { OPENING_GOLDEN, SOLID_GOLDEN } from '../regression/golden';

/**
 * What the sidebar and status strip show, read off the pipeline. These are the M6 figures: the preview's
 * silicone at defaults as docs/PLAN.md records it, which a change in the bores, the tile count or the
 * raise would move, and the box, which M3's solids measured independently.
 */

/** ml at defaults, on the preview field, with the bores: the "Silicone figure" note of M6. */
const PREVIEW_ML: Record<ExampleId, number> = { benchy: 43.32, goddess: 118.39, vis35: 530.02, jersey: 11.53, x8: 89.52, barrel: 10.52, wolf: 207.41 };

/** M3's export-cell silicone with M4's bores: an independent figure, from the solids. */
const solidMl = (id: ExampleId): number => SOLID_GOLDEN[id].silicone + OPENING_GOLDEN[id].boreMl;

const within = (value: number, expected: number, share: number): void => {
  expect(Math.abs(value / expected - 1), `${value} against ${expected}`).toBeLessThan(share);
};

describe('the box and the model size', () => {
  it('the box is the cover\'s outer box O, from the base\'s underside to the flat top, as M3 measured it', () => {
    const params = defaultParams();
    for (const id of EXAMPLE_IDS) {
      const { mesh, bounds } = orientedExample(id);
      const box = moldBox(deriveRim(moldBounds(mesh, bounds, fieldSettings(params, bounds)), params));
      const golden = SOLID_GOLDEN[id];
      // M3's box sizes, at their own 0.1%, and the height the plan states: Zt + Tb.
      within(box[0], golden.boxX, 0.001);
      within(box[1], golden.boxY, 0.001);
      within(box[2], golden.Zt + params.base.thickness, 0.001);
    }
  });

  it('the model size is its extent on each axis', () => {
    expect(modelSize({ min: [-1, 2, 0], max: [3, 2.5, 10] })).toEqual([4, 0.5, 10]);
  });
});

describe('the preview\'s silicone figure', () => {
  // One pipeline at a time, each freed once read: seven Manifold heaps at once would not be kind to the server.
  const read = new Map<ExampleId, { silicone: ReturnType<typeof previewSilicone>; rim: Rim }>();
  beforeAll(async () => {
    for (const id of EXAMPLE_IDS) {
      const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true });
      try {
        p.load(exampleBytes(id), EXAMPLE_FILES[id]);
        await p.idle();
        read.set(id, { silicone: previewSilicone(p), rim: p.field!.value.rim });
      } finally {
        p.dispose();
      }
    }
  }, 300_000);

  it.each(EXAMPLE_IDS)('%s reads as recorded at M6, and near M3\'s solids with the bores', (id) => {
    const { ml, grams } = read.get(id)!.silicone!;
    within(ml, PREVIEW_ML[id], 0.001);
    // 3%: the preview runs at its own cell (0.5 mm here, against 0.125) and TIN raise (0.1 against 0.05).
    // The barrel reads 2.5% over, the most of the seven; at the export's cell and raise it is 0.13% over.
    within(ml, solidMl(id), 0.03);
    expect(grams).toBeCloseTo(ml * defaultParams().silicone.density, 9);
  });

  it('at the export\'s cell and raise, the same sum matches M3\'s solids within 0.5%', async () => {
    for (const id of ['barrel', 'jersey'] as ExampleId[]) {
      const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true });
      try {
        p.load(exampleBytes(id), EXAMPLE_FILES[id]);
        p.setParams((params) => {
          params.quality.cellPreview = params.quality.cellFinal;
          params.quality.tinTolPreview = params.quality.tinTolFinal;
        });
        await p.idle();
        within(previewSilicone(p)!.ml, solidMl(id), 0.005);
      } finally {
        p.dispose();
      }
    }
  }, 120_000);

  it('a grid takes the model off once per tile: two jerseys take twice one\'s silicone', async () => {
    const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true });
    try {
      p.load(exampleBytes('jersey'), EXAMPLE_FILES.jersey);
      p.setParams((params) => (params.grid.nx = 2));
      await p.idle();
      expect(p.field!.value.mold.offsets).toHaveLength(2);
      // Apart, at auto spacing, the two cavities are two of one: 1.9999 times it, measured.
      within(previewSilicone(p)!.ml, 2 * read.get('jersey')!.silicone!.ml, 0.001);
    } finally {
      p.dispose();
    }
  }, 120_000);

  it('nothing to show before a field exists', () => {
    expect(previewSilicone(new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true }))).toBeNull();
  });

  it('the advice on t: a warning under 3 mm, and 4 to 5 mm for a cavity over 100 mm tall such as VIS-35\'s', () => {
    const vis35 = read.get('vis35')!.rim, jersey = read.get('jersey')!.rim;
    // VIS-35's cavity is 134 mm tall, the plan's figure, and jersey's 24.
    expect(vis35.hMax).toBeGreaterThan(130);
    expect(jersey.hMax).toBeLessThan(100);
    const params = defaultParams();
    expect(siliconeAdvice(params, vis35).map((d) => d.code)).toEqual(['silicone-tall']);
    expect(siliconeAdvice(params, vis35)[0].message).toContain('134 mm tall');
    expect(siliconeAdvice(params, jersey)).toEqual([]);
    expect(siliconeAdvice(params, null)).toEqual([]);
    params.silicone.t = 4;
    expect(siliconeAdvice(params, vis35)).toEqual([]);
    params.silicone.t = 2.5;
    expect(siliconeAdvice(params, jersey).map((d) => d.code)).toEqual(['silicone-thin']);
    expect(siliconeAdvice(params, jersey)[0].message).toContain('2.5 mm');
  });
});

describe('where a diagnostic points', () => {
  it('reads the "at (x, y)" a located message names, on the flat top', () => {
    expect(diagnosticPoint({ code: 'long-vent', severity: 'warning', message: 'The vent at (-12.25, 3) is 147.3 mm long.' }, 50)).toEqual([-12.25, 3, 50]);
    expect(diagnosticPoint({ code: 'opening-invalid', severity: 'error', message: 'Pour 1 at (4.5, -0.75) is not valid.' }, 7)).toEqual([4.5, -0.75, 7]);
  });

  it('gives no place for a code that names none, or a message without one', () => {
    expect(diagnosticPoint({ code: 'footprint-islands', severity: 'info', message: 'Dropped at (1, 2).' }, 5)).toBeNull();
    expect(diagnosticPoint({ code: 'long-vent', severity: 'warning', message: 'A vent is long.' }, 5)).toBeNull();
  });
});
