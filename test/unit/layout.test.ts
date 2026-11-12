import { describe, expect, it } from 'vitest';
import { PARAM_SCHEMA, type AutoDef, type NumberDef, type ParamDef } from '../../src/core/params/schema';
import { defOf, entryDef, HINTS, parseEntry, SECTION_PARAMS, sliderRange, stepOf } from '../../src/ui/layout';
import { formatNormal } from '../../src/ui/format';
import type { ParamPath } from '../../src/app/stages';

const PATHS = Object.entries(PARAM_SCHEMA).flatMap(([group, defs]) => Object.keys(defs as Record<string, ParamDef>).map((key) => `${group}.${key}` as ParamPath));

describe('the sidebar layout, driven by the schema', () => {
  it('places every parameter exactly once, and nothing the schema lacks', () => {
    const placed = Object.values(SECTION_PARAMS).flat();
    const counts = new Map<string, number>();
    for (const path of placed) counts.set(path, (counts.get(path) ?? 0) + 1);
    expect(PATHS.filter((path) => counts.get(path) !== 1)).toEqual([]);
    expect(placed.filter((path) => !PATHS.includes(path))).toEqual([]);
    expect(placed).toHaveLength(PATHS.length);
  });

  it('FL: puts Flange width in Pour & funnel\'s main list after Height and Flange thickness under Advanced, with the funnel\'s other sizes, each with a hint that says what it is for', () => {
    const pour = SECTION_PARAMS.pour;
    expect(pour[pour.indexOf('funnel.height') + 1]).toBe('funnel.flangeWidth');
    expect(SECTION_PARAMS.advanced).toContain('funnel.flangeThickness');
    const advanced = SECTION_PARAMS.advanced;
    expect(advanced.indexOf('funnel.flangeThickness') - advanced.indexOf('funnel.seatClearance')).toBe(1);
    expect(HINTS['funnel.flangeWidth']).toMatch(/rests flat on the cover's top, so the funnel stands steady/);
    expect(HINTS['funnel.flangeThickness']).toMatch(/prints without supports/);
    // A zero width is how a maker leaves it out, and the control takes it.
    expect(HINTS['funnel.flangeWidth']).toContain('0 leaves it out');
    expect(parseEntry('0', entryDef('funnel.flangeWidth') as NumberDef)).toEqual({ value: 0 });
  });

  it('gives every number a slider range that holds its default, and a step that divides into it sensibly', () => {
    for (const path of PATHS) {
      const def = defOf(path);
      if (def.kind !== 'number' && def.kind !== 'auto') continue;
      const [low, high] = sliderRange(path, def);
      expect(low, path).toBeLessThan(high);
      if (def.kind === 'number') {
        expect(def.default, path).toBeGreaterThanOrEqual(low);
        expect(def.default, path).toBeLessThanOrEqual(high);
      }
      const step = stepOf(path, def);
      expect(step, path).toBeGreaterThan(0);
      expect(step, path).toBeLessThanOrEqual((high - low) / 10);
    }
  });

  it('takes no 0 for a quantity that must be above it, by the schema\'s minimum or a floor of its own', () => {
    // Each of these, at 0, broke a stage or built a part that cannot exist (the M6a review).
    const positive: ParamPath[] = ['quality.cellPreview', 'quality.analysisCell', 'print.layerHeight', 'print.nozzle', 'cover.wall', 'quality.tinTolPreview', 'quality.tinTolFinal', 'quality.cellFinal'];
    for (const path of positive) {
      const def = entryDef(path) as NumberDef | AutoDef;
      expect(parseEntry('0', def), path).toHaveProperty('error');
      expect(def.min, path).toBeGreaterThan(0);
      // The default is still allowed, and so is the slider's whole travel.
      if (def.kind === 'number') expect(parseEntry(String(def.default), def), path).toEqual({ value: def.default });
      expect(sliderRange(path, defOf(path))[0], path).toBeGreaterThanOrEqual(def.min!);
    }
    // The pocket follows the layer, so the layer's floor is the pocket's own minimum.
    expect((entryDef('print.layerHeight') as NumberDef).min).toBe(PARAM_SCHEMA.base.pocketDepth.min);
    expect(parseEntry('0.05', entryDef('print.layerHeight') as NumberDef)).toEqual({ value: 0.05 });
    // Where the schema has a minimum, it stands as it is, and where 0 means something, it is kept.
    expect(entryDef('silicone.t')).toBe(defOf('silicone.t'));
    expect(parseEntry('0', entryDef('base.cornerRadius') as NumberDef)).toEqual({ value: 0 });
    expect(parseEntry('0', entryDef('grid.spacing') as AutoDef)).toEqual({ value: 0 });
  });

  it('names a base plane by its axis, or by its tilt from one', () => {
    expect(formatNormal([0, 0, -1])).toBe('−Z');
    expect(formatNormal([1, 0, 0])).toBe('+X');
    const tilted = [Math.sin(0.2), 0, -Math.cos(0.2)];
    expect(formatNormal(tilted)).toBe('−Z 11.5°');
  });
});
