import { describe, expect, it } from 'vitest';
import { changedPaths, PARAM_PATHS, paramDef, paramValue, setParamValue, stageKeys, type ParamPath, type StageInputs } from '../../src/app/stages';
import { baseOptions, defaultOf, defaultParams, isDefaultAt, isDefaultIn, resolveAuto } from '../../src/core/params/defaults';
import { effectiveParams, MOLD_TYPE_IDS, MOLD_TYPES } from '../../src/core/mold/types';
import { DEFAULT_PLANE } from '../../src/workers/fieldStages';
import { PARAM_SCHEMA, type ParamDef } from '../../src/core/params/schema';
import { sliderRange, stepOf } from '../../src/ui/layout';

const entries = Object.entries(PARAM_SCHEMA).flatMap(([group, defs]) =>
  Object.entries(defs as Record<string, ParamDef>).map(([key, def]) => ({ path: `${group}.${key}`, def })),
);
const BOUNDS = { min: [0, 0, 0] as [number, number, number], max: [100, 0, 0] as [number, number, number] };

// Default and range for each row of the plan's table, typed out separately from the schema.
const PLAN_TABLE: Record<string, [value: unknown, min?: number, max?: number]> = {
  'base.mode': ['glue'],
  'base.thickness': [4, 3, 20],
  'base.pocketDepth': [null, 0.05, 2],
  'base.pocketEnlarge': [0.2, 0, 1],
  'base.planeTol': [null, 0.01, 1],
  'base.minIsland': [5, 0, 100],
  'base.cornerRadius': [3],
  'base.bedReliefHeight': [0.4],
  'base.bedReliefRun': [0.3],
  'silicone.t': [3, 1, 20],
  'silicone.wallDraftDeg': [1, 0, 5],
  'silicone.closeWidth': [1.2, 0, 5],
  // The base layer, which the user asked for on 2026-11-09: it follows t until set, and 0 leaves it out.
  'silicone.baseLayer': [null, 0, 20],
  'silicone.baseLayerSlopeDeg': [2, 0, 10],
  'silicone.density': [1.1],
  'silicone.printMargin': [null],
  'cover.wall': [3],
  'cover.topCap': [5, 3, 30],
  'cover.topChamfer': [0.4],
  'joint.taperDeg': [15, 5, 30],
  'joint.taperClearance': [0.1],
  'joint.landInner': [2, 0.8],
  'joint.landOuter': [2, 0.8],
  'joint.ridgeWidth': [1.6],
  'joint.ridgeHeight': [1.2],
  'joint.ridgeDraftDeg': [10],
  'joint.grooveClearance': [0.25],
  'joint.grooveExtraDepth': [0.3],
  'joint.baseProud': [0.2],
  'joint.pryNotches': [true],
  'joint.pryWidth': [12],
  'joint.pryHeight': [1.2],
  // M10: off by default, so the taped mold of version 1 is what a new model gets.
  'bolts.enabled': [false],
  'bolts.size': ['M3'],
  'bolts.length': [null, 6, 40],
  'bolts.holeClearance': [0.2, 0, 1],
  'bolts.nutClearance': [0.15, 0, 2],
  'bolts.minWall': [1.2, 0.4, 5],
  'pour.perModel': [1, 1, 16],
  'pour.diameter': [10, 4, 30],
  'pour.minLand': [1.5],
  'vents.enabled': [true],
  'vents.diameter': [2.5, 2, 6],
  'vents.persistence': [null],
  'seat.enabled': [true],
  'seat.depth': [3, 1, 10],
  'seat.halfAngleDeg': [30, 10, 45],
  'funnel.generate': [true],
  'funnel.topDiameter': [40],
  'funnel.height': [30],
  'funnel.neckHeight': [10],
  'funnel.wall': [1.2],
  'funnel.tipWall': [0.86],
  'funnel.seatClearance': [0.1],
  // FL: the flange the user's first pour asked for on 2026-11-12; 0 leaves it out. 2 mm since VN, the user's choice of 2026-11-16 (D21).
  'funnel.flangeWidth': [2, 0, 10],
  'funnel.flangeThickness': [1.2, 0.6, 5],
  'grid.nx': [1, 1, 20],
  'grid.ny': [1, 1, 20],
  'grid.spacing': [null, 0, 100],
  'grid.edge': [null, 0, 100],
  'print.layerHeight': [0.2],
  'print.nozzle': [0.4],
  'print.bedX': [220],
  'print.bedY': [220],
  'print.bedZ': [250],
  // D19: 5 percent, after the user's note of 2026-11-12; it was 0.35.
  'print.infill': [0.05],
  'print.density': [1.24],
  'print.tapeStrip': [10],
  'quality.cellFinal': [0.125, 0.05, 0.5],
  'quality.cellPreview': [null],
  'quality.analysisCell': [0.25],
  'quality.tinTolFinal': [0.05],
  'quality.tinTolPreview': [0.1],
  'reports.minVolumeMl': [0.05],
  'reports.undersidePersistence': [0.3],
  // MT: the type, one-piece by default, and the two-part cover's own settings (G13.14).
  'mold.type': ['one-piece'],
  'clamshell.axis': ['auto'],
  'clamshell.offset': [null, -250, 250],
  'clamshell.ceilingDeg': [20, 0, 60],
  'clamshell.seamLand': [2, 0.8, undefined],
  'clamshell.pins': [true],
  'clamshell.fastener': ['bolts'],
  'clips.clearance': [0.1, 0, 0.5],
  'clips.rows': [null, 1, 8],
};

/** What the one-piece cover holds a setting's default to, the schema's own. */
const isDefault = (path: string, value: unknown): boolean => isDefaultIn(path as ParamPath, value, 'one-piece');

describe('parameter schema', () => {
  it('has exactly the rows of the plan, with its defaults and ranges', () => {
    const actual = Object.fromEntries(
      entries.map(({ path, def }) => {
        const range = 'min' in def || 'max' in def ? [def.min, def.max] : [];
        return [path, [def.default, ...range]];
      }),
    );
    const expected = Object.fromEntries(
      Object.entries(PLAN_TABLE).map(([path, row]) => {
        const [value, min, max] = row;
        return [path, min === undefined ? [value] : [value, min, max]];
      }),
    );
    expect(actual).toEqual(expected);
  });

  it('has the bolts of M10 in a group of their own, off by default, with the sizes and lengths screws are sold in', () => {
    expect(entries.filter(({ path }) => /bolt|nut|screw/i.test(path)).map(({ path }) => path)).toEqual(['bolts.enabled', 'bolts.size', 'bolts.length', 'bolts.holeClearance', 'bolts.nutClearance', 'bolts.minWall']);
    expect(PARAM_SCHEMA.bolts.size.options).toEqual(['M2.5', 'M3', 'M4']);
    expect(PARAM_SCHEMA.bolts.length.options).toEqual([6, 8, 10, 12, 16, 20, 25, 30, 35, 40]);
    expect(defaultParams().bolts.enabled).toBe(false);
  });

  it('keeps every number default inside its own range', () => {
    for (const { path, def } of entries) {
      if (def.kind !== 'number') continue;
      if (def.min !== undefined) expect(def.default, path).toBeGreaterThanOrEqual(def.min);
      if (def.max !== undefined) expect(def.default, path).toBeLessThanOrEqual(def.max);
    }
  });

  it('gives every parameter a label', () => {
    for (const { path, def } of entries) expect(def.label, path).not.toBe('');
  });

  it('marks counts as integers', () => {
    const integers = entries.filter(({ def }) => def.kind === 'number' && def.integer).map(({ path }) => path);
    expect(integers).toEqual(['pour.perModel', 'grid.nx', 'grid.ny']);
  });
});

describe('default parameters', () => {
  it('are a fresh object each call', () => {
    const a = defaultParams();
    a.base.thickness = 99;
    expect(defaultParams().base.thickness).toBe(4);
  });

  it('match the plan: the groove keeps its margin over the taper, and r_eff is 3.366', () => {
    const p = defaultParams();
    const { printMargin } = resolveAuto(p, BOUNDS);
    expect(p.joint.grooveClearance).toBeCloseTo(p.joint.taperClearance + 0.15, 9);
    expect(p.silicone.t + 2.13 * p.quality.cellFinal + printMargin).toBeCloseTo(3.366, 3);
  });

  it('tie the auto values to their rules until edited', () => {
    const p = defaultParams();
    expect(resolveAuto(p, BOUNDS)).toEqual({ pocketDepth: 0.2, printMargin: 0.1, ventPersistence: 1.5, planeTol: 0.05, baseLayer: 3, boltLength: 12 });

    // Pocket follows layer height until the user types a value.
    p.print.layerHeight = 0.3;
    expect(resolveAuto(p, BOUNDS).pocketDepth).toBe(0.3);
    p.base.pocketDepth = 0.1;
    p.print.layerHeight = 0.2;
    expect(resolveAuto(p, BOUNDS).pocketDepth).toBe(0.1);
    p.base.pocketDepth = null;
    expect(resolveAuto(p, BOUNDS).pocketDepth).toBe(0.2);

    p.silicone.t = 5;
    expect(resolveAuto(p, BOUNDS).ventPersistence).toBe(2.5);
    p.vents.persistence = 1;
    expect(resolveAuto(p, BOUNDS).ventPersistence).toBe(1);

    // The base layer follows t until set, and 0 is a value of its own, not a return to auto.
    expect(resolveAuto(p, BOUNDS).baseLayer).toBe(5);
    p.silicone.baseLayer = 0;
    expect(resolveAuto(p, BOUNDS).baseLayer).toBe(0);
  });

  it('supply the options base detection needs, and honour an edited tolerance', () => {
    const p = defaultParams();
    expect(baseOptions(p, BOUNDS)).toEqual({ planeTol: 0.05, minIsland: 5 });
    p.base.planeTol = 0.5;
    p.base.minIsland = 0;
    expect(baseOptions(p, BOUNDS)).toEqual({ planeTol: 0.5, minIsland: 0 });
  });
});

describe('the marks on changed settings (CS)', () => {
  it('a setting is at its default while it holds the schema\'s default, and an auto one only while it is null, whatever its rule gives', () => {
    expect(PARAM_PATHS).toEqual(entries.map(({ path }) => path));
    for (const { path, def } of entries) {
      expect(paramDef(path as ParamPath)).toBe(def);
      expect(isDefault(path, def.default), path).toBe(true);
      if (def.kind === 'number') {
        // A step either way, where the range allows it, as the slider and the wheel would leave it.
        const step = stepOf(path as ParamPath, def);
        for (const off of [def.default + step, def.default - step]) {
          if (off >= (def.min ?? 0) && off <= (def.max ?? Infinity)) expect(isDefault(path, Number(off.toFixed(6))), `${path} at ${off}`).toBe(false);
        }
      }
      if (def.kind === 'flag') expect(isDefault(path, !def.default), path).toBe(false);
      if (def.kind === 'choice') for (const option of def.options.filter((o) => o !== def.default)) expect(isDefault(path, option), `${path} ${option}`).toBe(false);
      // Any number on an auto one is the user's, its slider's ends among them.
      if (def.kind === 'auto') for (const value of [...sliderRange(path as ParamPath, def), ...(def.options ?? [])]) expect(isDefault(path, value), `${path} at ${value}`).toBe(false);
    }
    expect(changedPaths(defaultParams())).toEqual([]);
    // One change at a time: the one changed, and nothing else. The type, and the settings the one-piece cover
    // hides, are MT's, below.
    for (const { path, def } of entries.filter(({ path }) => path !== 'mold.type' && MOLD_TYPES['one-piece'].applies(path as ParamPath))) {
      const params = defaultParams();
      const value = def.kind === 'flag' ? !def.default : def.kind === 'choice' ? def.options.find((o) => o !== def.default) : def.kind === 'auto' ? sliderRange(path as ParamPath, def)[1] : def.default + stepOf(path as ParamPath, def) <= (def.max ?? Infinity) ? def.default + stepOf(path as ParamPath, def) : def.default - stepOf(path as ParamPath, def);
      setParamValue(params, path as ParamPath, value);
      expect(changedPaths(params), path).toEqual([path]);
      // A section's own paths see only its own changes.
      expect(changedPaths(params, PARAM_PATHS.filter((other) => other !== path)), path).toEqual([]);
    }
    // A pocket typed equal to the layer no longer follows it: changed, though its depth is what the rule gives.
    const typed = defaultParams();
    typed.base.pocketDepth = 0.2;
    expect(typed.print.layerHeight).toBe(0.2);
    expect(changedPaths(typed)).toEqual(['base.pocketDepth']);
    // Negative control: judged by the value the rule resolves to, the same pocket would read as at its default.
    const BOUNDS100 = { min: [0, 0, 0] as [number, number, number], max: [100, 0, 0] as [number, number, number] };
    const resolved = (params: typeof typed, path: ParamPath): boolean => {
      const value = paramValue(params, path) ?? resolveAuto(params, BOUNDS100).pocketDepth;
      return value === resolveAuto(defaultParams(), BOUNDS100).pocketDepth;
    };
    expect(resolved(typed, 'base.pocketDepth')).toBe(true);
    expect(resolved(typed, 'base.pocketDepth')).not.toBe(isDefault('base.pocketDepth', typed.base.pocketDepth));
    // The layer itself is judged by its own default, so a layer of 0.3 is changed, and the pocket that follows it is not.
    const layer = defaultParams();
    layer.print.layerHeight = 0.3;
    expect(changedPaths(layer)).toEqual(['print.layerHeight']);
  });
});


const INPUTS: StageInputs = { file: 'f1', import: 'plain', plane: JSON.stringify(DEFAULT_PLANE), tier: 'preview', cellScale: 1, pins: [], removed: [], drag: null, outside: '' };

describe('MT: the marks, Reset and the keys by mold type', () => {
  it('a setting is at its default by the type the params are for: the two-part cover\'s base layer of 0 is, and automatic is changed, and the reverse in the one-piece', () => {
    const one = defaultParams(), two = defaultParams('clamshell');
    expect(two.mold.type).toBe('clamshell');
    expect(two.silicone.baseLayer).toBe(0);
    expect(one.silicone.baseLayer).toBeNull();
    expect(defaultOf('silicone.baseLayer', 'clamshell')).toBe(0);
    expect(defaultOf('silicone.baseLayer', 'one-piece')).toBeNull();
    expect(isDefaultAt('silicone.baseLayer', two)).toBe(true);
    expect(changedPaths(two)).toEqual([]);
    two.silicone.baseLayer = null;
    expect(isDefaultAt('silicone.baseLayer', two)).toBe(false);
    expect(changedPaths(two)).toEqual(['silicone.baseLayer']);
    one.silicone.baseLayer = 0;
    expect(changedPaths(one)).toEqual(['silicone.baseLayer']);
    // The two-part cover's flange is seam land + 2 mm wide, so it covers where the seam comes up beside the pour (G13.8 step 6).
    expect(defaultOf('funnel.flangeWidth', 'clamshell')).toBe(4);
    expect(defaultOf('funnel.flangeWidth', 'one-piece')).toBe(2);
    // Every other setting's default is the base's in both types.
    for (const path of PARAM_PATHS.filter((p) => p !== 'mold.type' && p !== 'silicone.baseLayer' && p !== 'funnel.flangeWidth')) expect(defaultOf(path, 'clamshell'), path).toBe(defaultOf(path, 'one-piece'));
  });

  it('the type itself is never changed, so Reset keeps it; settings the type hides or holds are not counted, and keep their values', () => {
    const two = defaultParams('clamshell');
    expect(isDefaultAt('mold.type', two)).toBe(true);
    // A hidden grid of 2 and pry notches the type holds off: the user's own values, kept for switching back.
    two.grid.nx = 2;
    two.joint.pryNotches = false;
    two.bolts.enabled = true;
    expect(changedPaths(two)).toEqual([]);
    // In the one-piece cover the two-part settings are hidden, and a changed one is not counted either.
    const one = defaultParams();
    one.clamshell.ceilingDeg = 30;
    one.clips.rows = 3;
    expect(changedPaths(one)).toEqual([]);
    // Negative control: the same values in the type that shows them are counted.
    one.mold.type = 'clamshell';
    expect(changedPaths(one)).toEqual(['silicone.baseLayer', 'funnel.flangeWidth', 'clamshell.ceilingDeg', 'clips.rows']);
    // What a Reset sets, every changed setting to the type's default, leaves the type as it is.
    for (const path of changedPaths(one)) setParamValue(one, path, defaultOf(path, 'clamshell'));
    expect(one.mold.type).toBe('clamshell');
    expect(changedPaths(one)).toEqual([]);
  });

  it('a slider steps the same in every type, as the steps and ranges are the base\'s', () => {
    for (const id of MOLD_TYPE_IDS) {
      const params = defaultParams(id);
      for (const { path, def } of entries) {
        if (def.kind !== 'number' && def.kind !== 'auto') continue;
        expect(stepOf(path as ParamPath, paramDef(path as ParamPath)), `${id} ${path}`).toBe(stepOf(path as ParamPath, def));
        expect(sliderRange(path as ParamPath, paramDef(path as ParamPath)), `${id} ${path}`).toEqual(sliderRange(path as ParamPath, def));
      }
      expect(params.mold.type).toBe(id);
    }
  });

  it('a hidden grid of 2 in the two-part cover makes one tile and changes no stage key, and the one-piece cover reads its params as they are', () => {
    const two = defaultParams('clamshell');
    const hidden = structuredClone(two);
    hidden.grid.nx = 2;
    hidden.grid.ny = 3;
    const run = effectiveParams(hidden);
    expect([run.grid.nx, run.grid.ny]).toEqual([1, 1]);
    expect(hidden.grid.nx).toBe(2);
    expect(stageKeys(effectiveParams(hidden), INPUTS)).toEqual(stageKeys(effectiveParams(two), INPUTS));
    // Negative control: read as they are, the hidden grid would change the keys.
    expect(stageKeys(hidden, INPUTS).S3).not.toBe(stageKeys(two, INPUTS).S3);
    // The locks: one model, no corner bolts, no pry notches.
    expect([run.bolts.enabled, run.joint.pryNotches]).toEqual([false, false]);
    // The one-piece cover has no lock, so its params are the very object, and nothing it builds can differ.
    const one = defaultParams();
    one.grid.nx = 2;
    expect(effectiveParams(one)).toBe(one);
  });
});
