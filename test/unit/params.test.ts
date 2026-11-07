import { describe, expect, it } from 'vitest';
import { baseOptions, defaultParams, resolveAuto } from '../../src/core/params/defaults';
import { PARAM_SCHEMA, type ParamDef } from '../../src/core/params/schema';

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
  'grid.nx': [1, 1, 20],
  'grid.ny': [1, 1, 20],
  'grid.spacing': [null, 0, 100],
  'grid.edge': [null, 0, 100],
  'print.layerHeight': [0.2],
  'print.nozzle': [0.4],
  'print.bedX': [220],
  'print.bedY': [220],
  'print.bedZ': [250],
  'print.infill': [0.35],
  'print.density': [1.24],
  'print.tapeStrip': [10],
  'quality.cellFinal': [0.125, 0.05, 0.5],
  'quality.cellPreview': [null],
  'quality.analysisCell': [0.25],
  'quality.tinTolFinal': [0.05],
  'quality.tinTolPreview': [0.1],
  'reports.minVolumeMl': [0.05],
  'reports.undersidePersistence': [0.3],
};

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

  it('has no bolt parameters, which arrive in M10', () => {
    expect(entries.filter(({ path }) => /bolt|nut|screw/i.test(path))).toEqual([]);
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
    expect(resolveAuto(p, BOUNDS)).toEqual({ pocketDepth: 0.2, printMargin: 0.1, ventPersistence: 1.5, planeTol: 0.05 });

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
  });

  it('supply the options base detection needs, and honour an edited tolerance', () => {
    const p = defaultParams();
    expect(baseOptions(p, BOUNDS)).toEqual({ planeTol: 0.05, minIsland: 5 });
    p.base.planeTol = 0.5;
    p.base.minIsland = 0;
    expect(baseOptions(p, BOUNDS)).toEqual({ planeTol: 0.5, minIsland: 0 });
  });
});
