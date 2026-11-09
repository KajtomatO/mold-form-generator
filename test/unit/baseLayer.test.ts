import { describe, expect, it } from 'vitest';
import { mergeTree, significantLeaves } from '../../src/core/analysis/peaks';
import { applyBaseLayer, baseLayerOf, layerNodes, withBaseLayer, type BaseLayer } from '../../src/core/field/baseLayer';
import { buildField } from '../../src/core/field/build';
import { countCavities } from '../../src/core/field/cavities';
import { planField } from '../../src/core/field/grid';
import { defaultParams } from '../../src/core/params/defaults';
import { fieldSettings } from '../../src/core/field/grid';
import { maskOverrun, moldBounds } from '../../src/core/parts/rim';
import { stageKeys } from '../../src/app/stages';
import type { Params } from '../../src/core/params/schema';
import { DEFAULT_PLANE, FieldStages, PLAIN_IMPORT } from '../../src/workers/fieldStages';
import { coneAt, fieldOf } from '../fixtures/fieldShapes';
import { orientedExample } from '../fixtures/fieldRuns';
import { exampleBytes } from '../fixtures/loadExamples';

const INPUTS = { file: 'f', import: 'plain', plane: JSON.stringify(DEFAULT_PLANE), tier: 'preview' as const, cellScale: 1, pins: [], removed: [], drag: null };
const staged = (params: Params, stages: FieldStages, ran: Record<string, number> = {}) =>
  stages.run(stageKeys(params, INPUTS), ['S6'], params, { file: exampleBytes('benchy').slice().buffer, import: PLAIN_IMPORT, plane: DEFAULT_PLANE, cellScale: 1, pins: [], removed: [] }, ran).S6!.field;
const total = (values: Float32Array) => values.reduce((a, b) => a + b, 0);

// Two cones 40 mm apart on a 60 x 30 mm field, whose jackets do not meet: the case the layer is for.
const CELL = 0.25;
const twoCones = () => fieldOf(60, 30, CELL, (x, y) => Math.max(coneAt(15, 15, 12, 1.5)(x, y), coneAt(45, 15, 9, 1.5)(x, y)));
const RECT = { x0: 1, y0: 1, x1: 59, y1: 29 };
const layer = (over: Partial<BaseLayer> = {}): BaseLayer => ({ depth: 3, slopeDeg: 2, draftDeg: 1, closeWidth: 0, rect: RECT, ...over });

describe('silicone base layer', () => {
  it('joins separate cavities into one and is at least its depth everywhere inside D, raising nothing outside', () => {
    const before = twoCones();
    expect(countCavities(before).count).toBe(2);
    const after = withBaseLayer(before, layer());
    expect(countCavities(after).count).toBe(1);
    const { i0, i1, j0, j1 } = layerNodes(after, RECT);
    for (let j = 0; j < after.ny; j++) {
      for (let i = 0; i < after.nx; i++) {
        const n = i + j * after.nx;
        expect(after.values[n]).toBeGreaterThanOrEqual(before.values[n]);
        const inside = i >= i0 && i <= i1 && j >= j0 && j <= j1;
        if (inside) expect(after.values[n]).toBeGreaterThanOrEqual(3 - 1e-6);
        else expect(after.values[n]).toBe(before.values[n]);
      }
    }
  });

  it('stays where the tool keeps it, one cell inside D', () => {
    const after = withBaseLayer(twoCones(), layer());
    expect(maskOverrun(after, RECT)).toBeLessThanOrEqual(1e-9);
  });

  it('slopes up towards the models, so it adds no peak for air to gather under, and is its depth at the farthest corner', () => {
    const before = twoCones();
    const after = withBaseLayer(before, layer());
    const leaves = (f: typeof before) => significantLeaves(mergeTree(f), 0.5).map((l) => Math.round(l.height * 100) / 100);
    expect(leaves(after)).toEqual(leaves(before));
    const { i0, j0 } = layerNodes(after, RECT);
    expect(after.values[i0 + j0 * after.nx]).toBeCloseTo(3, 1);
    // Between the cones, halfway, the layer is higher than at the corner, and rises towards each cone.
    const at = (x: number, y: number) => after.values[Math.round((x - after.x0) / CELL) + Math.round((y - after.y0) / CELL) * after.nx];
    expect(at(30, 15)).toBeGreaterThan(at(RECT.x0 + 1, RECT.y0 + 1));
    expect(at(28, 15)).toBeGreaterThan(at(30, 15) - 1e-6);
  });

  it('is flat at its depth with a slope of 0', () => {
    const before = twoCones();
    const after = withBaseLayer(before, layer({ slopeDeg: 0 }));
    const { i0, i1, j0, j1 } = layerNodes(after, RECT);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const n = i + j * after.nx;
        expect(after.values[n]).toBeCloseTo(Math.max(3, before.values[n]), 5);
      }
    }
  });

  it('keeps the wall draft at its outer edge, however deep', () => {
    const after = withBaseLayer(twoCones(), layer({ depth: 15, slopeDeg: 0, draftDeg: 5 }));
    const { i0, j0 } = layerNodes(after, RECT);
    const tan5 = Math.tan((5 * Math.PI) / 180);
    expect(after.values[i0 + (j0 + 20) * after.nx]).toBeCloseTo(CELL / tan5, 4);
    expect(after.values[i0 + 1 + (j0 + 20) * after.nx]).toBeCloseTo(Math.min(15, (2 * CELL) / tan5), 4);
    expect(after.values[i0 + 40 + (j0 + 40) * after.nx]).toBeGreaterThanOrEqual(15 - 1e-6);
  });

  it('is off at a depth of 0, and buildField then gives the field it gave before the layer', () => {
    expect(baseLayerOf({ baseLayer: 0, baseLayerSlopeDeg: 2, draftDeg: 1, closeWidth: 1.2 }, RECT)).toBeNull();
    const { mesh, bounds } = orientedExample('jersey');
    const params = defaultParams();
    params.silicone.baseLayer = 0;
    const settings = fieldSettings(params, bounds, 0.25);
    const plan = planField(bounds, settings);
    const D = moldBounds(mesh, bounds, settings).D;
    const withD = buildField(mesh, plan, settings, undefined, D);
    const without = buildField(mesh, plan, settings);
    expect(withD.field.values).toEqual(without.field.values);
    expect(withD.plain).toBe(withD.field);
  });

  it('follows the silicone thickness until set', () => {
    const params = defaultParams();
    const { bounds } = orientedExample('jersey');
    expect(fieldSettings(params, bounds).baseLayer).toBe(3);
    params.silicone.t = 5;
    expect(fieldSettings(params, bounds).baseLayer).toBe(5);
    params.silicone.baseLayer = 1.5;
    expect(fieldSettings(params, bounds).baseLayer).toBe(1.5);
  });

  it('makes the 8 jersey barriers one cavity at defaults, inside D, with the walls between them read as before', () => {
    const { mesh, bounds } = orientedExample('x8');
    const settings = fieldSettings(defaultParams(), bounds, 0.25);
    const plan = planField(bounds, settings);
    const D = moldBounds(mesh, bounds, settings).D;
    const built = buildField(mesh, plan, settings, undefined, D);
    const old = buildField(mesh, plan, settings);
    expect(old.cavities.count).toBe(2);
    expect(built.cavities.count).toBe(1);
    expect(maskOverrun(built.field, D)).toBeLessThanOrEqual(1e-9);
    expect(built.plain.values).toEqual(old.field.values);
  });

  it('joins the copies of a grid without a merged-tiles warning, keeping the wall check of the plastic above it', () => {
    const { mesh, bounds } = orientedExample('jersey');
    const params = defaultParams();
    params.grid.nx = 2;
    params.grid.ny = 2;
    const settings = fieldSettings(params, bounds, 0.25);
    const plan = planField(bounds, settings);
    const D = moldBounds(mesh, bounds, settings).D;
    const built = buildField(mesh, plan, settings, undefined, D);
    const old = buildField(mesh, plan, settings);
    expect(old.cavities.count).toBe(4);
    expect(built.cavities.count).toBe(1);
    expect(built.tilesMerged).toBe(false);
    expect(built.minWall).toBe(old.minWall);
    expect(built.diagnostics.map((d) => d.code)).toEqual(old.diagnostics.map((d) => d.code));
  });

  it('applies in place as withBaseLayer does on a copy', () => {
    const a = twoCones();
    const b = withBaseLayer(a, layer());
    applyBaseLayer(a, layer());
    expect(a.values).toEqual(b.values);
  });

  it('follows a change of its depth or slope in field.worker, which runs S6 again and nothing before it', () => {
    const stages = new FieldStages();
    const params = defaultParams();
    const fresh = (p: Params) => total(staged(p, new FieldStages()).values);
    const first = total(staged(params, stages).values);
    for (const change of [{ baseLayer: 0 }, { baseLayer: 8 }, { baseLayer: 8, baseLayerSlopeDeg: 0 }]) {
      const changed = { ...params, silicone: { ...params.silicone, ...change } };
      const ran: Record<string, number> = {};
      const sum = total(staged(changed, stages, ran).values);
      expect(Object.keys(ran)).toEqual(['S6']);
      expect(sum).toBe(fresh(changed));
    }
    expect(fresh({ ...params, silicone: { ...params.silicone, baseLayer: 0 } })).toBeLessThan(first);
  });
});
