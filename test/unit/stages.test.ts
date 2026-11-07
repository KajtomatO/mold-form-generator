import type { ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { replicateOpenings } from '../../src/core/analysis/placement';
import { openingSizes, placementSpace } from '../../src/core/analysis/validate';
import { resolveAuto, defaultParams } from '../../src/core/params/defaults';
import { PARAM_SCHEMA, type ParamDef, type Params } from '../../src/core/params/schema';
import { hashFloats, hashMesh, hashString } from '../../src/app/hash';
import { downstream, invalidatedBy, invalidatedByInput, STAGES, stageKeys, upstream, type InputName, type ParamPath, type StageId, type StageInputs } from '../../src/app/stages';
import { DEFAULT_PLANE, FieldStages, PLAIN_IMPORT, type PlaneChoice } from '../../src/workers/fieldStages';
import type { OpeningPin } from '../../src/core/analysis/placement';
import { SolidStages } from '../../src/workers/solidStages';
import { exampleBytes, loadManifold } from '../fixtures/loadExamples';

const PATHS = Object.entries(PARAM_SCHEMA).flatMap(([group, defs]) => Object.entries(defs as Record<string, ParamDef>).map(([key, def]) => ({ path: `${group}.${key}` as ParamPath, def })));

const INPUTS: StageInputs = { file: 'f1', import: 'plain', plane: JSON.stringify(DEFAULT_PLANE), tier: 'preview', cellScale: 1, pins: [], removed: [], drag: null };

/** Values that the auto rules would not give, so each change is a real one. */
const AUTO_VALUES: Partial<Record<ParamPath, number>> = {
  'base.pocketDepth': 0.4,
  'base.planeTol': 0.08,
  'silicone.printMargin': 0.3,
  'vents.persistence': 0.4,
  'grid.spacing': 14,
  'grid.edge': 25,
  'quality.cellPreview': 0.75,
};

/** Another valid value for each parameter, one that the stages can still build. */
function changedValue(path: ParamPath, def: ParamDef): unknown {
  switch (def.kind) {
    case 'flag':
      return !def.default;
    case 'choice':
      return def.options.find((option) => option !== def.default);
    case 'auto':
      return AUTO_VALUES[path];
    default: {
      if (def.integer) return def.default + 1;
      const value = def.default * 1.25 + 0.05;
      return def.max !== undefined ? Math.min(value, def.max) : value;
    }
  }
}

function withChange(path: ParamPath, value: unknown): Params {
  const params = defaultParams();
  const [group, key] = path.split('.') as [keyof Params, string];
  (params[group] as Record<string, unknown>)[key] = value;
  return params;
}

const changedKeys = (a: Record<StageId, string>, b: Record<StageId, string>): StageId[] => STAGES.map((s) => s.id).filter((id) => a[id] !== b[id]);
const sorted = (ids: Iterable<StageId>): StageId[] => [...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));

describe('the stage table', () => {
  it('maps every schema parameter to at least one stage, and names no parameter the schema lacks', () => {
    const declared = new Set(STAGES.flatMap((stage) => stage.params));
    const known = new Set(PATHS.map(({ path }) => path));
    expect(PATHS.filter(({ path }) => !declared.has(path)).map(({ path }) => path)).toEqual([]);
    expect([...declared].filter((path) => !known.has(path))).toEqual([]);
  });

  it('is in order and has no cycle: every dependency is a known stage', () => {
    for (const stage of STAGES) {
      for (const dep of stage.deps) expect(STAGES.some((s) => s.id === dep), `${stage.id} needs ${dep}`).toBe(true);
      expect(upstream(stage.deps).has(stage.id), `${stage.id} depends on itself`).toBe(false);
    }
  });

  // Generated from the table: a change of each parameter must change the keys of exactly the stages it names and everything after them.
  describe.each(PATHS)('$path', ({ path, def }) => {
    it('invalidates exactly the stages the table names', () => {
      const before = stageKeys(defaultParams(), INPUTS);
      const after = stageKeys(withChange(path, changedValue(path, def)), INPUTS);
      expect(sorted(changedKeys(before, after))).toEqual(sorted(invalidatedBy(path)));
    });
  });

  const INPUT_CHANGES: [InputName, Partial<StageInputs>][] = [
    ['file', { file: 'f2' }],
    ['import', { import: 'import:x' }],
    ['plane', { plane: JSON.stringify({ rank: 1, upper: false }) }],
    ['tier', { tier: 'export' }],
    ['cellScale', { cellScale: 2 }],
    ['pins', { pins: [{ id: 'b0:pour:0', kind: 'pour', x: 1, y: 2 }] }],
    ['removed', { removed: ['b0:vent:0'] }],
    ['drag', { drag: { id: 'b0:pour:0', x: 1, y: 2 } }],
  ];
  it.each(INPUT_CHANGES)('input %s invalidates exactly the stages the table names', (name, change) => {
    const before = stageKeys(defaultParams(), INPUTS);
    const after = stageKeys(defaultParams(), { ...INPUTS, ...change });
    expect(sorted(changedKeys(before, after))).toEqual(sorted(invalidatedByInput(name)));
  });

  it('a drag changes only the cut, and a pin also the placement before it', () => {
    expect(sorted(invalidatedByInput('drag'))).toEqual(['S13']);
    expect(sorted(invalidatedByInput('pins'))).toEqual(['S7', 'S9', 'S13']);
    expect(sorted(downstream(['S10']))).toEqual(['S7', 'S9', 'S10', 'S11', 'S12', 'S13', 'S14', 'S15']);
  });
});

/**
 * The keys are only as good as the table. This runs the real stages from nothing for each parameter
 * change, and every output that changed must be one the table says the parameter reaches. A stage
 * reading a parameter it does not declare would keep a stale result in the cache, and fails here.
 */
describe('the real stages read nothing the table does not name', () => {
  let api: ManifoldToplevel;
  const bytes = exampleBytes('jersey');
  beforeAll(async () => {
    api = await loadManifold();
  });

  /** One run from nothing, with a hash of each output main can see. The inputs that are not parameters are read as the pipeline sends them. */
  function outputsOf(params: Params, stageInputs: StageInputs = INPUTS): Partial<Record<StageId, string>> {
    const keys = stageKeys(params, stageInputs);
    const field = new FieldStages();
    const { cellScale, pins, removed, drag: dragged } = stageInputs;
    const inputs = { file: bytes.slice().buffer, import: PLAIN_IMPORT, plane: JSON.parse(stageInputs.plane) as PlaneChoice, cellScale, pins, removed };
    const out = field.run(keys, ['S1', 'S2', 'S6', 'S7'], params, inputs);
    const { S1, S2, S6, S7 } = out;
    const space = placementSpace(S6!.field, S6!.rim, S6!.mold.offsets, openingSizes(params));
    const openings = S7!.placement.openings;
    const copies = replicateOpenings(openings, space);
    const moving = dragged ? openings.find((o) => o.id === dragged.id)! : null;
    const drag = moving ? { rest: replicateOpenings(openings.filter((o) => o !== moving), space), moved: replicateOpenings([{ kind: moving.kind, x: dragged!.x, y: dragged!.y }], space) } : null;
    const solid = new SolidStages(api);
    try {
      const parts = solid.run(keys, ['S13', 'S15', 'S16'], params, {
        model: { welded: S1!.welded, audit: S1!.audit },
        plane: { candidate: S2!.chosen, transform: S2!.oriented.transform, needsTrim: S2!.oriented.needsTrim, planeTol: S2!.planeTol, pocketDepth: resolveAuto(params, S2!.bounds).pocketDepth },
        rim: S6!.rim,
        offsets: S6!.mold.offsets,
        field: S6!.field,
        clip: S6!.rim.D,
        tol: params.quality.tinTolPreview,
        copies,
        drag,
      });
      if (stageInputs === INPUTS) baseOpenings = openings;
      return {
        S2: hashString(JSON.stringify([S2!.oriented.transform, S2!.chosen.normal, S2!.chosen.area, S2!.planeTol])),
        S6: hashFloats(S6!.field.values) + S6!.field.cell,
        S10: hashString(JSON.stringify([S6!.mold, S6!.rim])),
        S7: hashString(JSON.stringify(S7!.placement)),
        S13: hashMesh(parts.S13!.positions, parts.S13!.indices),
        S15: hashMesh(parts.S15!.positions, parts.S15!.indices),
        S16: parts.S16 ? hashMesh(parts.S16.positions, parts.S16.indices) : 'none',
      };
    } finally {
      solid.clear();
    }
  }

  let base: Partial<Record<StageId, string>>;
  let baseOpenings: OpeningPin[] = [];
  it('builds at defaults', () => {
    base = outputsOf(defaultParams());
    expect(Object.keys(base)).toHaveLength(7);
  }, 60_000);

  it.each(PATHS)('$path', ({ path, def }) => {
    const after = outputsOf(withChange(path, changedValue(path, def)));
    const changed = (Object.keys(base) as StageId[]).filter((id) => base[id] !== after[id]);
    const allowed = invalidatedBy(path);
    expect(changed.filter((id) => !allowed.has(id)), `${path} changed outputs it is not declared for`).toEqual([]);
  }, 60_000);

  it.each([
    ['silicone.t', 3.5, ['S6', 'S7', 'S10', 'S13', 'S15']],
    ['base.mode', 'merged', ['S15']],
    ['pour.diameter', 8, ['S7', 'S13', 'S16']],
    ['quality.tinTolPreview', 0.2, ['S13']],
  ] as [ParamPath, unknown, StageId[]][])('sees real changes: %s changes %j', (path, value, expected) => {
    const after = outputsOf(withChange(path, value));
    const changed = (Object.keys(base) as StageId[]).filter((id) => base[id] !== after[id]);
    expect(sorted(changed)).toEqual(sorted(expected));
  }, 60_000);

  // The inputs that are not parameters, varied as the pipeline varies them. The file and the import change
  // everything, and the tier is the pipeline's to pass on, so these are the ones a stage could misread.
  const INPUT_RUNS: [InputName, () => Partial<StageInputs>, StageId][] = [
    ['plane', () => ({ plane: JSON.stringify({ rank: 1, upper: false }) }), 'S2'],
    ['cellScale', () => ({ cellScale: 2 }), 'S6'],
    ['pins', () => {
      const pour = baseOpenings.find((o) => o.kind === 'pour')!;
      return { pins: [{ id: pour.id, kind: pour.kind, x: pour.x + 1, y: pour.y }] };
    }, 'S7'],
    ['removed', () => ({ removed: [baseOpenings.find((o) => o.kind === 'vent')!.id] }), 'S7'],
    ['drag', () => {
      const pour = baseOpenings.find((o) => o.kind === 'pour')!;
      return { drag: { id: pour.id, x: pour.x + 0.5, y: pour.y } };
    }, 'S13'],
  ];
  it.each(INPUT_RUNS)('input %s changes only outputs the table says it reaches, and does change one', (name, change, reached) => {
    const after = outputsOf(defaultParams(), { ...INPUTS, ...change() });
    const changed = (Object.keys(base) as StageId[]).filter((id) => base[id] !== after[id]);
    expect(changed).toContain(reached);
    const allowed = invalidatedByInput(name);
    expect(changed.filter((id) => !allowed.has(id)), `${name} changed outputs it is not declared for`).toEqual([]);
  }, 60_000);

  it('negative control: a parameter the cut reads, left out of the table, is caught', () => {
    // The pour's diameter reaches the cut through the copies. With S7 and S16 out of the table, the cut still changes.
    const after = outputsOf(withChange('pour.diameter', 8));
    const changed = (Object.keys(base) as StageId[]).filter((id) => base[id] !== after[id]);
    expect(changed).toContain('S13');
    const pretend = downstream(['S16']);
    expect(changed.filter((id) => !pretend.has(id))).not.toEqual([]);
  }, 60_000);
});
