import type { ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { hashMesh } from '../../src/app/hash';
import { stageKeys, type StageId } from '../../src/app/stages';
import { replicateOpenings } from '../../src/core/analysis/placement';
import { openingSizes, placementSpace } from '../../src/core/analysis/validate';
import { emptyField } from '../../src/core/field/grid';
import { defaultParams, resolveAuto } from '../../src/core/params/defaults';
import { DEFAULT_PLANE, FieldStages, PLAIN_IMPORT } from '../../src/workers/fieldStages';
import { SolidStages, type SolidInputs } from '../../src/workers/solidStages';
import { exampleBytes, loadManifold } from '../fixtures/loadExamples';

let api: ManifoldToplevel;
beforeAll(async () => {
  api = await loadManifold();
});

/** jersey at defaults, as main would send it to solid.worker. */
function jerseyJob(): { keys: Record<StageId, string>; inputs: SolidInputs } {
  const params = defaultParams();
  const keys = stageKeys(params, { file: 'f', import: 'plain', plane: JSON.stringify(DEFAULT_PLANE), tier: 'preview', cellScale: 1, pins: [], removed: [], drag: null });
  const { S1, S2, S6, S7 } = new FieldStages().run(keys, ['S1', 'S2', 'S6', 'S7'], params, { file: exampleBytes('jersey').slice().buffer, import: PLAIN_IMPORT, plane: DEFAULT_PLANE, cellScale: 1, pins: [], removed: [] });
  const space = placementSpace(S6!.field, S6!.rim, S6!.mold.offsets, openingSizes(params));
  return {
    keys,
    inputs: {
      model: { welded: S1!.welded, audit: S1!.audit },
      plane: { candidate: S2!.chosen, transform: S2!.oriented.transform, needsTrim: S2!.oriented.needsTrim, planeTol: S2!.planeTol, pocketDepth: resolveAuto(params, S2!.bounds).pocketDepth },
      rim: S6!.rim,
      offsets: S6!.mold.offsets,
      field: S6!.field,
      clip: S6!.rim.D,
      tol: params.quality.tinTolPreview,
      copies: replicateOpenings(S7!.placement.openings, space),
      drag: null,
    },
  };
}

describe('solid.worker\'s stage cache', () => {
  it('a build that throws leaves the entry it would have replaced whole, and usable under its own key', () => {
    const stages = new SolidStages(api);
    const { keys, inputs } = jerseyJob();
    const params = defaultParams();
    const first = stages.run(keys, ['S13'], params, inputs).S13!;
    // A field with no cavity cannot make a tool, so this S11 throws part way.
    const empty = { ...inputs, field: emptyField(inputs.field!), copies: [] };
    expect(() => stages.run({ ...keys, S11: 'other', S12: 'other' }, ['S13'], params, empty)).toThrow(/no cavity/);
    expect(stages.cached().S11).toBe(keys.S11);
    // The old tool is still there: a new cover body is cut with it, with no field sent, and comes out the same.
    const again = stages.run({ ...keys, S12: 'rebuilt' }, ['S13'], params, { ...inputs, field: null }).S13!;
    expect(hashMesh(again.positions, again.indices)).toBe(hashMesh(first.positions, first.indices));
    stages.clear();
  });

  it('keeps only the model, tool, cover body, base body and funnel between jobs', () => {
    const stages = new SolidStages(api);
    const { keys, inputs } = jerseyJob();
    stages.run(keys, ['S1', 'S13', 'S15', 'S16'], defaultParams(), inputs);
    expect(Object.keys(stages.cached()).sort()).toEqual(['S1', 'S11', 'S12', 'S14', 'S16', 'S2']);
    expect(stages.heldEntries()).toBe(5);
    // A drag holds the cover cut for the others while it lasts, and any other job frees it.
    const [moved, ...rest] = inputs.copies;
    stages.run({ ...keys, S13: 'drag' }, ['S13'], defaultParams(), { ...inputs, drag: { rest, moved: [{ ...moved, x: moved.x + 0.5 }] } });
    expect(stages.heldEntries()).toBe(6);
    stages.run(keys, ['S13'], defaultParams(), inputs);
    expect(stages.heldEntries()).toBe(5);
    stages.clear();
  });

  it('a drag cuts the other openings once, on its first step, and each step after only cuts the dragged one', () => {
    const stages = new SolidStages(api);
    const { keys, inputs } = jerseyJob();
    const params = defaultParams();
    stages.run(keys, ['S13'], params, inputs);
    const [moved, ...rest] = inputs.copies;
    expect(rest.length).toBeGreaterThan(0);
    const step = (dx: number, others = rest): void => {
      const out = stages.run({ ...keys, S13: `drag ${dx}` }, ['S13'], params, { ...inputs, drag: { rest: others, moved: [{ ...moved, x: moved.x + dx }] } }).S13!;
      expect(out.provisional).toBe(true);
    };
    step(0.5);
    step(1);
    step(1.5);
    expect(stages.dragRestCuts).toBe(1);
    // A drop runs a job with no drag, which frees that cover, so the next drag cuts the rest again.
    stages.run(keys, ['S13'], params, inputs);
    step(0.5);
    expect(stages.dragRestCuts).toBe(2);
    // So does a drag of another opening, whose rest is another set.
    step(0.5, [moved]);
    expect(stages.dragRestCuts).toBe(3);
    stages.clear();
  });
});
