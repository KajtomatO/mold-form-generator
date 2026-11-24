import { afterEach, describe, expect, it } from 'vitest';
import { tableBudgetMs } from '../../src/app/budgets';
import { Pipeline } from '../../src/app/pipeline';
import { defaultParams } from '../../src/core/params/defaults';
import { inProcessField, inProcessSolid } from '../fixtures/inProcessWorker';
import { exampleBytes, EXAMPLE_FILES, skipWithout, type ExampleId } from '../fixtures/loadExamples';

/**
 * MP5 (G13.16): the two-part cover's rows of NODE_PREVIEW_MS, held in Node by the pipeline's own jobs, as they were
 * measured. T1 is the field job after a change of the ceiling slope, S3x to S6x with the coarse fields built again; T2
 * the solid job after it, S11c to S15c. Each is the median of three changes, against tableBudgetMs of its row.
 */
const MODELS: ExampleId[] = ['goddess', 'vis35', 'benchy', 'wolf'];

const pipelines: Pipeline[] = [];
afterEach(() => {
  pipelines.splice(0).forEach((p) => p.dispose());
});

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

describe('MP5: the two-part cover\'s preview budgets in Node', () => {
  for (const id of MODELS) it(`${id}: T1 and T2 after a change of the ceiling slope, within its NODE_PREVIEW_MS row`, async (ctx) => {
    skipWithout(ctx, id);
    const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true });
    pipelines.push(p);
    p.load(exampleBytes(id), EXAMPLE_FILES[id]);
    p.setParams((params) => Object.assign(params, defaultParams('clamshell')));
    await p.idle();
    expect(p.status().error).toBeNull();
    expect(p.field?.value.clam).toBeDefined();
    const t1: number[] = [], t2: number[] = [];
    const beta = p.params.clamshell.ceilingDeg;
    for (const step of [1, 2, 3]) {
      const from = performance.now();
      p.setParams((params) => (params.clamshell.ceilingDeg = beta + step));
      await p.idle();
      expect(p.status().error).toBeNull();
      const results = p.log.filter((entry) => entry.at >= from && entry.event === 'result' && entry.ms !== undefined);
      const field = results.filter((entry) => entry.gate === 'field'), solid = results.filter((entry) => entry.gate === 'solid');
      expect(field.length, `step ${step}`).toBeGreaterThan(0);
      expect(solid.length, `step ${step}`).toBeGreaterThan(0);
      t1.push(field[field.length - 1].ms!);
      t2.push(solid[solid.length - 1].ms!);
    }
    const name = `${id} two-part`;
    expect(median(t1), `${name} t1, samples ${t1.map(Math.round)}`).toBeLessThanOrEqual(tableBudgetMs(name, 't1')!);
    expect(median(t2), `${name} t2, samples ${t2.map(Math.round)}`).toBeLessThanOrEqual(tableBudgetMs(name, 't2')!);
  }, 600_000);
});
