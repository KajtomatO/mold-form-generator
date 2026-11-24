import type { ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { replicateOpenings } from '../../src/core/analysis/placement';
import { openingSizes, placementSpace } from '../../src/core/analysis/validate';
import { resolveAuto, defaultParams } from '../../src/core/params/defaults';
import { PARAM_SCHEMA, type ParamDef, type Params } from '../../src/core/params/schema';
import { hashFloats, hashMesh, hashString } from '../../src/app/hash';
import { CLAM_ROWS, downstream, invalidatedBy, invalidatedByInput, MAIN_ONLY, NO_STAGE, STAGES, stageKeys, typedKeys, upstream, type InputName, type ParamPath, type StageId, type StageInputs } from '../../src/app/stages';
import { effectiveParams } from '../../src/core/mold/types';
import type { HalfField } from '../../src/core/parts/clamshell';
import { loadGallery } from '../fixtures/loadGallery';
import { DEFAULT_PLANE, FieldStages, PLAIN_IMPORT, type PlaneChoice } from '../../src/workers/fieldStages';
import type { OpeningPin } from '../../src/core/analysis/placement';
import { ReportStages } from '../../src/workers/reportStages';
import { SolidStages } from '../../src/workers/solidStages';
import { exampleBytes, loadManifold, type ExampleId } from '../fixtures/loadExamples';

const PATHS = Object.entries(PARAM_SCHEMA).flatMap(([group, defs]) => Object.entries(defs as Record<string, ParamDef>).map(([key, def]) => ({ path: `${group}.${key}` as ParamPath, def })));

const INPUTS: StageInputs = { file: 'f1', import: 'plain', plane: JSON.stringify(DEFAULT_PLANE), tier: 'preview', cellScale: 1, pins: [], removed: [], drag: null, outside: '' };

/** Values that the auto rules would not give, so each change is a real one. */
const AUTO_VALUES: Partial<Record<ParamPath, number>> = {
  'base.pocketDepth': 0.4,
  'base.planeTol': 0.08,
  'silicone.printMargin': 0.3,
  'vents.persistence': 0.4,
  'grid.spacing': 14,
  'grid.edge': 25,
  'quality.cellPreview': 0.75,
  'bolts.length': 16,
  'silicone.baseLayer': 1.5,
  'clamshell.offset': 5,
  'clips.rows': 3,
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

function withChange(path: ParamPath, value: unknown, params: Params = defaultParams()): Params {
  const [group, key] = path.split('.') as [keyof Params, string];
  (params[group] as Record<string, unknown>)[key] = value;
  return params;
}

const changedKeys = (a: Record<StageId, string>, b: Record<StageId, string>): StageId[] => STAGES.map((s) => s.id).filter((id) => a[id] !== b[id]);
/** In the table's order, the one-piece rows S1 to S16 first, then the two-part cover's (MP5). */
const ORDER = new Map(STAGES.map((stage, k) => [stage.id, k]));
const sorted = (ids: Iterable<StageId>): StageId[] => [...ids].sort((a, b) => ORDER.get(a)! - ORDER.get(b)!);
/** The one-piece cover's rows of a set, which every test before MP5 was written for. */
const onePiece = (ids: Iterable<StageId>): StageId[] => sorted([...ids].filter((id) => /^S\d+$/.test(id)));

describe('the stage table', () => {
  it('maps every schema parameter to at least one stage or to main alone, and names no parameter the schema lacks', () => {
    const declared = new Set(STAGES.flatMap((stage) => stage.params));
    const known = new Set(PATHS.map(({ path }) => path));
    // MT: but the type and the two-part cover's settings, which no stage of the one-piece cover reads (NO_STAGE).
    expect(PATHS.filter(({ path }) => !declared.has(path) && !MAIN_ONLY.includes(path) && !NO_STAGE.includes(path)).map(({ path }) => path)).toEqual([]);
    expect(NO_STAGE.filter((path) => declared.has(path) || MAIN_ONLY.includes(path) || !known.has(path))).toEqual([]);
    expect([...declared].filter((path) => !known.has(path))).toEqual([]);
    // What main reads alone is in no stage, so a change of it rebuilds nothing.
    expect(MAIN_ONLY.filter((path) => declared.has(path) || !known.has(path))).toEqual([]);
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
    ['outside', { outside: 'glue' }],
  ];
  it.each(INPUT_CHANGES)('input %s invalidates exactly the stages the table names', (name, change) => {
    const before = stageKeys(defaultParams(), INPUTS);
    const after = stageKeys(defaultParams(), { ...INPUTS, ...change });
    expect(sorted(changedKeys(before, after))).toEqual(sorted(invalidatedByInput(name)));
  });

  it('RM: a rebuilt model\'s left-out parts in glue mode change its raster and box and what is built on them, never the import, the plane or the intervals', () => {
    expect(onePiece(invalidatedByInput('outside'))).toEqual(['S3', 'S4', 'S5', 'S6', 'S7', 'S9', 'S10', 'S11', 'S12', 'S13', 'S14', 'S15']);
  });

  it('a drag changes only the cut, and a pin also the placement before it', () => {
    expect(onePiece(invalidatedByInput('drag'))).toEqual(['S13']);
    expect(onePiece(invalidatedByInput('pins'))).toEqual(['S7', 'S9', 'S13']);
    expect(onePiece(downstream(['S10']))).toEqual(['S7', 'S9', 'S10', 'S11', 'S12', 'S13', 'S14', 'S15']);
  });
});

/**
 * The keys are only as good as the table. This runs the real stages from nothing for each parameter
 * change, and every output that changed must be one the table says the parameter reaches. A stage
 * reading a parameter it does not declare would keep a stale result in the cache, and fails here.
 */
describe('the real stages read nothing the table does not name', () => {
  let api: ManifoldToplevel;
  beforeAll(async () => {
    api = await loadManifold();
  });

  /** One run from nothing, with a hash of each output main can see. The inputs that are not parameters are read as the pipeline sends them. */
  function outputsOf(params: Params, stageInputs: StageInputs = INPUTS, model: ExampleId = 'jersey'): Partial<Record<StageId, string>> {
    const bytes = exampleBytes(model);
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
      if (stageInputs === INPUTS && model === 'jersey') baseOpenings = openings;
      // S8 and S9 as the pipeline sends them to their own worker.
      const reports = new ReportStages();
      const { S9 } = reports.run(keys, params, {
        mesh: S1!.welded,
        transform: S2!.oriented.transform,
        field: S6!.field,
        raise: params.quality.tinTolPreview,
        rim: S6!.rim,
        tiles: S6!.mold.offsets.length,
        ceiling: { leaves: S7!.placement.ceilingLeaves, uncovered: S7!.placement.uncovered },
        estimate: null,
      });
      return {
        S8: hashString(JSON.stringify(reports.intervals)),
        S9: hashString(JSON.stringify(S9)),
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
    expect(Object.keys(base)).toHaveLength(9);
  }, 60_000);

  // With the bolts off their settings reach nothing, so each is changed on a mold with the bolts on, where it must reach something.
  const boltSetting = (path: ParamPath): boolean => path.startsWith('bolts.') && path !== 'bolts.enabled';
  const bolted = (): Params => withChange('bolts.enabled', true);
  let boltBase: Partial<Record<StageId, string>> | undefined;
  // The mold type is no setting of these rows: a change of it builds the two-part cover's (MP5, below).
  it.each(PATHS.filter(({ path }) => path !== 'mold.type'))('$path', ({ path, def }) => {
    const before = boltSetting(path) ? (boltBase ??= outputsOf(bolted())) : base;
    const after = outputsOf(withChange(path, changedValue(path, def), boltSetting(path) ? bolted() : defaultParams()));
    const changed = (Object.keys(before) as StageId[]).filter((id) => before[id] !== after[id]);
    const allowed = invalidatedBy(path);
    expect(changed.filter((id) => !allowed.has(id)), `${path} changed outputs it is not declared for`).toEqual([]);
    if (boltSetting(path)) expect(changed, `${path} changed nothing on a bolted mold`).toContain('S10');
  }, 60_000);

  it.each([
    // The cover's lift and the seams of the cut hints follow the field.
    ['silicone.t', 3.5, ['S6', 'S7', 'S9', 'S10', 'S13', 'S15']],
    ['base.mode', 'merged', ['S15']],
    ['pour.diameter', 8, ['S7', 'S13', 'S16']],
    // The lift reads the preview's raise too.
    ['quality.tinTolPreview', 0.2, ['S9', 'S13']],
    ['quality.analysisCell', 0.3, ['S8', 'S9']],
    // Jersey's silicone under its chamfers is tiny: only a filter this low lets it show.
    ['reports.minVolumeMl', 0.001, ['S9']],
    // The lift's level: with no seat a funnel has nowhere to stand, so the silicone stops at the top.
    ['seat.enabled', false, ['S7', 'S9', 'S13', 'S16']],
    ['funnel.height', 40, ['S9', 'S16']],
    // FL: the flange moves jersey's vent out past its edge, so the cut follows, and the funnel gets its ring.
    ['funnel.flangeWidth', 0, ['S7', 'S13', 'S16']],
    // VN: past 0.26 mm in a 30 degree seat a funnel pushed to one side and half a line need more than the 0.5 mm
    // gap, so the vent beside the pour moves out with the funnel's own change.
    ['funnel.seatClearance', 0.3, ['S7', 'S13', 'S16']],
    // VN: and a 1 mm nozzle, whose half line takes the gap past 0.5 mm.
    ['print.nozzle', 1, ['S7', 'S13']],
    ['funnel.flangeThickness', 2, ['S16']],
    // M10: the bolts grow the rim and cut both parts; on jersey the bigger box changes no opening and no report.
    ['bolts.enabled', true, ['S10', 'S13', 'S15']],
  ] as [ParamPath, unknown, StageId[]][])('sees real changes: %s changes %j', (path, value, expected) => {
    const after = outputsOf(withChange(path, value));
    const changed = (Object.keys(base) as StageId[]).filter((id) => base[id] !== after[id]);
    expect(sorted(changed)).toEqual(sorted(expected));
    // And the table says so, or a cached stage would keep its old result.
    expect(changed.filter((id) => !invalidatedBy(path).has(id)), `${path} is missing from the rows of`).toEqual([]);
  }, 60_000);

  it('VN: S7 reads the nozzle itself, as the gap between a flange and a vent takes half a printed line, not only through S5 and S10', () => {
    expect(STAGES.find((stage) => stage.id === 'S7')!.params).toContain('print.nozzle');
    expect(STAGES.find((stage) => stage.id === 'S7')!.params).toContain('funnel.seatClearance');
    expect(STAGES.find((stage) => stage.id === 'S7')!.params).toContain('seat.halfAngleDeg');
  });

  // S9's filters on models they act on: wolf's two smaller feet, 160.5 and 152.6 mm2, which an island
  // filter past them drops from its loop lock and from the base's pocket, and Benchy's one air pocket,
  // 2.5 mm deep. Wolf's crumbs under 5 mm2 are no test of it: they lie in the recesses the plate seals.
  const MODEL_CHANGES: [ExampleId, ParamPath, unknown, StageId[]][] = [
    ['wolf', 'base.minIsland', 200, ['S9', 'S15']],
    ['benchy', 'reports.undersidePersistence', 3, ['S9']],
  ];
  it.each(MODEL_CHANGES)('sees real changes on %s: %s set to %j changes %j', (model, path, value, expected) => {
    const before = outputsOf(defaultParams(), INPUTS, model);
    const after = outputsOf(withChange(path, value), INPUTS, model);
    const changed = (Object.keys(before) as StageId[]).filter((id) => before[id] !== after[id]);
    expect(sorted(changed)).toEqual(sorted(expected));
    expect(changed.filter((id) => !invalidatedBy(path).has(id)), `${path} is missing from the rows of`).toEqual([]);
  }, 120_000);

  it('what main reads alone changes no stage\'s output', () => {
    for (const path of MAIN_ONLY) {
      const def = PATHS.find((p) => p.path === path)!.def;
      const after = outputsOf(withChange(path, changedValue(path, def)));
      expect((Object.keys(base) as StageId[]).filter((id) => base[id] !== after[id]), path).toEqual([]);
    }
  }, 120_000);

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

/**
 * MP5 (G13.15): the two-part cover's rows. The one-piece rows keep the keys they had before them, a value the type
 * holds changes no key, and the real stages of the two-part cover read nothing their rows do not name.
 */
describe('MP5: the two-part cover\'s rows', () => {
  const two = (change: (params: Params) => void = () => {}): Params => {
    const params = defaultParams('clamshell');
    change(params);
    return params;
  };

  it('leave the one-piece rows\' keys as they were before them (the keys at MP4\'s commit, 135c29a)', () => {
    expect(stageKeys(defaultParams(), INPUTS)).toMatchObject({
      S1: '15ed4dfeb41758', S2: '0eb8b9cff258b9', S3: '1964bbcf0811bc', S4: '0c24e1b5a46e67', S5: '12536efc0ea934', S6: '111f2f25451bd5', S7: '182dccb64b998d', S8: '0d1500602f81f7',
      S9: '03aa21a7f81d4a', S10: '0af2f0ff5ebc39', S11: '0fa889051ef0df', S12: '17a8179abf40ae', S13: '08c9dbaede6936', S14: '0f2fb5ffa8460b', S15: '1f9ff0c493a3cc', S16: '12ae200f655971',
    });
    // The one-piece cover's typed keys are stageKeys' own.
    expect(typedKeys(defaultParams(), INPUTS)).toEqual(stageKeys(defaultParams(), INPUTS));
  });

  it('name the two-part cover\'s rows under the one-piece\'s ids in that type, S9 from its own and theirs', () => {
    const keys = typedKeys(two(), INPUTS);
    for (const [id, row] of Object.entries(CLAM_ROWS)) expect(keys[id as StageId], id).toBe(keys[row as StageId]);
    expect(keys.S9).not.toBe(stageKeys(two(), INPUTS).S9);
    expect(keys.S1).toBe(stageKeys(defaultParams(), INPUTS).S1);
  });

  it('take their inputs: a pin and a removed vent reach the openings on P and the halves, the tier the fine fields on, a drag nothing', () => {
    const rows = (ids: Iterable<StageId>): StageId[] => sorted([...ids].filter((id) => !/^S\d+$/.test(id)));
    expect(rows(invalidatedByInput('pins'))).toEqual(['S7c', 'S12c', 'S13c']);
    expect(rows(invalidatedByInput('removed'))).toEqual(['S7c', 'S12c', 'S13c']);
    expect(rows(invalidatedByInput('tier'))).toEqual(['S6x', 'S7c', 'S11c', 'S12c', 'S13c']);
    expect(rows(invalidatedByInput('cellScale'))).toEqual(['S6x', 'S7c', 'S11c', 'S12c', 'S13c']);
    // A drag moves the ring along P; the halves are cut again on the drop, which pins it.
    expect(rows(invalidatedByInput('drag'))).toEqual([]);
    expect(rows(invalidatedByInput('plane'))).toEqual(['S3x', 'S4x', 'S6c', 'S10c', 'S6x', 'S7c', 'S11c', 'S12c', 'S13c', 'S14c', 'S15c']);
    // S16 is the one-piece's own, which the two-part cover's funnel is.
    expect(STAGES.find((stage) => stage.id === 'S16')!.deps).toEqual([]);
  });

  it('a value the type holds changes no key: a hidden grid of 2, the corner bolts on, the pry notches on', () => {
    const base = typedKeys(two(), INPUTS);
    expect(typedKeys(two((p) => (p.grid.nx = 2)), INPUTS)).toEqual(base);
    expect(typedKeys(two((p) => (p.grid.ny = 3)), INPUTS)).toEqual(base);
    expect(typedKeys(two((p) => (p.bolts.enabled = true)), INPUTS)).toEqual(base);
    expect(typedKeys(two((p) => (p.joint.pryNotches = true)), INPUTS)).toEqual(base);
    // Negative control: a value it does not hold changes keys.
    expect(typedKeys(two((p) => (p.clamshell.ceilingDeg = 30)), INPUTS)).not.toEqual(base);
  });

  describe('the real stages read nothing their rows do not name', () => {
    let api: ManifoldToplevel;
    beforeAll(async () => {
      api = await loadManifold();
    });
    const sphere = loadGallery('sphere');

    /** One run of the two-part cover from nothing on the sphere, at a 1 mm preview cell, each output main sees hashed. */
    function clamOutputsOf(params: Params, stageInputs: StageInputs = INPUTS): Partial<Record<StageId, string>> {
      const keys = typedKeys(params, stageInputs);
      const run = effectiveParams(params);
      const field = new FieldStages();
      const { cellScale, pins, removed } = stageInputs;
      const out = field.run(keys, ['S1', 'S2', 'S6', 'S7'], run, { file: sphere.slice().buffer, import: PLAIN_IMPORT, plane: JSON.parse(stageInputs.plane) as PlaneChoice, cellScale, pins, removed });
      const { S1, S2, S6, S7 } = out;
      const clam = S6!.clam!, seam = S7!.seam!;
      const solid = new SolidStages(api);
      try {
        const parts = solid.run(keys, ['S13', 'S15', 'S16'], run, {
          model: { welded: S1!.welded, audit: S1!.audit },
          plane: { candidate: S2!.chosen, transform: S2!.oriented.transform, needsTrim: S2!.oriented.needsTrim, planeTol: S2!.planeTol, pocketDepth: resolveAuto(run, S2!.bounds).pocketDepth },
          rim: S6!.rim,
          offsets: S6!.mold.offsets,
          field: null,
          clip: null,
          tol: run.quality.tinTolPreview,
          copies: seam.cuts,
          drag: null,
          clam: { sides: clam.sides.map((side) => ({ field: side.field, frame: side.frame, hs: side.hs })) as [HalfField, HalfField], cuts: seam.cuts, pinsKept: seam.pinsKept, bolts: clam.bolts, clips: clam.clips },
        });
        return {
          S6x: hashString(JSON.stringify([clam.sides.map((side) => hashFloats(side.field.values) + side.field.cell + side.hs), clam.axis, clam.xs, clam.siliconeMl, clam.bolts, clam.clips])),
          S10c: hashString(JSON.stringify(S6!.rim)),
          S7c: hashString(JSON.stringify([S7!.placement, seam])),
          S13c: hashMesh(parts.S13!.positions, parts.S13!.indices),
          S15c: hashMesh(parts.S15!.positions, parts.S15!.indices),
          S16: parts.S16 ? hashMesh(parts.S16.positions, parts.S16.indices) : 'none',
        };
      } finally {
        solid.clear();
      }
    }

    const coarse = (change: (params: Params) => void = () => {}): Params => two((p) => {
      p.quality.cellPreview = 1;
      change(p);
    });
    let base: Partial<Record<StageId, string>>;
    it('builds at the two-part defaults', () => {
      base = clamOutputsOf(coarse());
      expect(Object.keys(base)).toHaveLength(6);
    }, 60_000);

    // The type itself and the grid it holds at 1 are no setting of these rows; the preview cell is held at 1 mm here.
    const skipped = new Set<ParamPath>(['mold.type', 'grid.nx', 'grid.ny', 'quality.cellPreview', 'bolts.enabled', 'joint.pryNotches']);
    it.each(PATHS.filter(({ path }) => !skipped.has(path)))('$path', ({ path, def }) => {
      const value = changedValue(path, def);
      const after = clamOutputsOf(coarse((p) => withChange(path, path === 'clamshell.offset' ? 3 : value, p)));
      const changed = (Object.keys(base) as StageId[]).filter((id) => base[id] !== after[id]);
      // Each output is the row's, and the field's and the rim's come with S6 and S10 of the one-piece's ids.
      const allowed = invalidatedBy(path);
      expect(changed.filter((id) => !allowed.has(id)), `${path} changed outputs it is not declared for`).toEqual([]);
    }, 60_000);

    it('a worker that holds the rows gives, for a change, what a fresh one gives: the rows after S3x read the job\'s own settings', () => {
      const fieldOf = (stages: FieldStages, params: Params): string => {
        const out = stages.run(typedKeys(params, INPUTS), ['S1', 'S2', 'S6', 'S7'], effectiveParams(params), { file: sphere.slice().buffer, import: PLAIN_IMPORT, plane: DEFAULT_PLANE, cellScale: 1, pins: [], removed: [] });
        const clam = out.S6!.clam!;
        return hashString(JSON.stringify([clam.bolts, clam.clips, clam.belts, clam.forces, clam.holdN, out.S6!.rim, out.S6!.diagnostics, out.S7!.seam, out.S7!.placement.openings]));
      };
      const held = new FieldStages();
      fieldOf(held, coarse());
      for (const change of [(p: Params) => (p.clamshell.fastener = 'clips'), (p: Params) => (p.clamshell.fastener = 'none'), (p: Params) => (p.silicone.density = 1.3), (p: Params) => (p.funnel.height = 40), (p: Params) => (p.clips.clearance = 0.2), (p: Params) => (p.print.tapeStrip = 20)]) {
        const params = coarse(change);
        expect(fieldOf(held, params), String(change)).toBe(fieldOf(new FieldStages(), params));
      }
      // A setting tried and put back finds its fine pair kept, with G13.3's bed line of its own split, not the last one's.
      const bed = (fastener: Params['clamshell']['fastener']) => coarse((p) => ((p.print.bedX = 40), (p.print.bedY = 40), (p.clamshell.fastener = fastener)));
      const again = new FieldStages();
      for (const fastener of ['bolts', 'clips', 'bolts'] as const) expect(fieldOf(again, bed(fastener)), fastener).toBe(fieldOf(new FieldStages(), bed(fastener)));
    }, 180_000);

    it('sees real changes: the ceiling slope and the fastener', () => {
      const steeper = clamOutputsOf(coarse((p) => (p.clamshell.ceilingDeg = 35)));
      expect((Object.keys(base) as StageId[]).filter((id) => base[id] !== steeper[id])).toEqual(expect.arrayContaining(['S6x', 'S10c', 'S7c', 'S13c']));
      const clipped = clamOutputsOf(coarse((p) => (p.clamshell.fastener = 'clips')));
      expect((Object.keys(base) as StageId[]).filter((id) => base[id] !== clipped[id])).toEqual(expect.arrayContaining(['S6x', 'S13c']));
    }, 120_000);
  });
});
