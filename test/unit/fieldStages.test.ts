import { describe, expect, it } from 'vitest';
import { stageKeys } from '../../src/app/stages';
import { buildField } from '../../src/core/field/build';
import { fieldSettings, planField } from '../../src/core/field/grid';
import { defaultParams } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';
import { DEFAULT_PLANE, FieldStages, PLAIN_IMPORT, previewCell } from '../../src/workers/fieldStages';
import { orientedExample } from '../fixtures/fieldRuns';
import { exampleBytes, type ExampleId } from '../fixtures/loadExamples';

const INPUTS = { file: 'f', import: 'plain', plane: JSON.stringify(DEFAULT_PLANE), tier: 'preview' as const, cellScale: 1, pins: [], removed: [], drag: null };

/** S6 as field.worker builds it, one stage at a time. `ran` gets an entry for each stage that ran. */
function staged(id: ExampleId, params: Params, stages = new FieldStages(), ran: Record<string, number> = {}) {
  const keys = stageKeys(params, INPUTS);
  return stages.run(keys, ['S6'], params, { file: exampleBytes(id).slice().buffer, import: PLAIN_IMPORT, plane: DEFAULT_PLANE, cellScale: 1, pins: [], removed: [] }, ran).S6!.field;
}

describe('the staged field', () => {
  it.each([
    ['jersey', 1, 1],
    ['benchy', 1, 1],
    ['x8', 2, 1],
  ] as [ExampleId, number, number][])('%s %i x %i is the field buildField makes in one go, value for value', (id, nx, ny) => {
    const params = defaultParams();
    params.grid.nx = nx;
    params.grid.ny = ny;
    const { mesh, bounds } = orientedExample(id);
    const settings = fieldSettings(params, bounds, previewCell(params, bounds));
    const whole = buildField(mesh, planField(bounds, settings), settings).field;
    const field = staged(id, params);
    expect({ ...field, values: null }).toEqual({ ...whole, values: null });
    let differ = 0;
    for (let n = 0; n < whole.values.length; n++) if (field.values[n] !== whole.values[n]) differ++;
    expect(differ).toBe(0);
  });

  it('a change of t dilates again without rastering, and a change of draft neither', () => {
    const stages = new FieldStages();
    const params = defaultParams();
    const first: Record<string, number> = {};
    staged('jersey', params, stages, first);
    expect(new Set(Object.keys(first))).toEqual(new Set(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S10']));
    const moved = { ...params, silicone: { ...params.silicone, t: 3.5 } };
    const afterT: Record<string, number> = {};
    staged('jersey', moved, stages, afterT);
    expect(new Set(Object.keys(afterT))).toEqual(new Set(['S4', 'S5', 'S6', 'S10']));
    const drafted = { ...moved, silicone: { ...moved.silicone, wallDraftDeg: 2 } };
    const afterDraft: Record<string, number> = {};
    staged('jersey', drafted, stages, afterDraft);
    expect(new Set(Object.keys(afterDraft))).toEqual(new Set(['S5', 'S6', 'S10']));
  });

  it('the preview cell follows the rule and the size of the grid', () => {
    const params = defaultParams();
    const box = { min: [0, 0, 0] as [number, number, number], max: [300, 100, 50] as [number, number, number] };
    expect(previewCell(params, box)).toBe(0.5);
    params.grid.nx = 3;
    expect(previewCell(params, box)).toBeCloseTo(900 / 1024, 12);
    params.quality.cellPreview = 0.75;
    expect(previewCell(params, box)).toBe(0.75);
  });
});
