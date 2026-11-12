import { describe, expect, it } from 'vitest';
import { defaultParams } from '../../src/core/params/defaults';
import { crossParameterErrors } from '../../src/core/params/rules';
import { PARAM_SCHEMA, type NumberDef, type Params } from '../../src/core/params/schema';
import { funnelProfile } from '../../src/core/parts/funnelProfile';

function codes(change: (p: Params) => void): string[] {
  const params = defaultParams();
  change(params);
  return crossParameterErrors(params).map((d) => d.code);
}

describe('the plan\'s hard rules between parameters', () => {
  it('find nothing wrong at the defaults', () => {
    expect(crossParameterErrors(defaultParams())).toEqual([]);
  });

  it('every one is an inline error: a severity, a code and a sentence, never a throw', () => {
    const params = defaultParams();
    params.seat.depth = 10;
    params.funnel.topDiameter = 5;
    const errors = crossParameterErrors(params);
    expect(errors.length).toBe(2);
    for (const error of errors) {
      expect(error.severity).toBe('error');
      expect(error.message).toMatch(/\.$/);
      expect(error.message).not.toMatch(/NaN|undefined|Infinity/);
    }
  });

  it('ds <= topCap - 1, with the limit itself allowed', () => {
    expect(codes((p) => (p.seat.depth = 4))).toEqual([]);
    expect(codes((p) => (p.seat.depth = 4.01))).toEqual(['seat-too-deep']);
    expect(codes((p) => ((p.seat.depth = 4.01), (p.cover.topCap = 6)))).toEqual([]);
    expect(codes((p) => ((p.seat.depth = 3), (p.cover.topCap = 3)))).toEqual(['seat-too-deep']);
    expect(codes((p) => ((p.seat.depth = 10), (p.seat.enabled = false), (p.funnel.generate = false)))).toEqual([]);
  });

  it('a pocket that follows the layer height stays within the pocket\'s own range, with its ends allowed', () => {
    expect(codes((p) => (p.print.layerHeight = 0.05))).toEqual([]);
    // FL: the flange's relief, 2 layers, shortens to what the spigot can spare at layers this thick, so no funnel rule speaks.
    expect(codes((p) => (p.print.layerHeight = 2))).toEqual([]);
    expect(codes((p) => (p.print.layerHeight = 0))).toEqual(['pocket-range']);
    expect(codes((p) => (p.print.layerHeight = 0.04))).toEqual(['pocket-range']);
    expect(codes((p) => (p.print.layerHeight = 2.5))).toEqual(['pocket-range']);
    expect(codes((p) => (p.print.layerHeight = Number.NaN))).toEqual(['pocket-range']);
    // A pocket set by hand is its own control's to check, whatever the layer.
    expect(codes((p) => ((p.print.layerHeight = 0), (p.base.pocketDepth = 0.2)))).toEqual([]);
    const params = defaultParams();
    params.print.layerHeight = 3;
    expect(crossParameterErrors(params)[0].message).toContain('0.05 to 2 mm');
  });

  it('says what would fit', () => {
    const params = defaultParams();
    params.seat.depth = 6;
    expect(crossParameterErrors(params)[0].message).toContain('at most 4 mm');
  });

  it('funnel top >= pour diameter + 2 x wall, with the limit itself allowed', () => {
    const edge = (p: Params): number => p.pour.diameter + 2 * p.funnel.wall;
    expect(edge(defaultParams())).toBeCloseTo(12.4, 9);
    // The neck is wider than that at this seat, so a shallow seat is what shows the rule's own limit.
    const shallow = (p: Params): void => {
      p.seat.depth = 1;
      p.seat.halfAngleDeg = 10;
      p.funnel.height = 12;
      p.funnel.neckHeight = 11.5;
    };
    expect(codes((p) => (shallow(p), (p.funnel.topDiameter = 12.4)))).not.toContain('funnel-top-small');
    expect(codes((p) => (shallow(p), (p.funnel.topDiameter = 12.39)))).toEqual(['funnel-top-small']);
    expect(codes((p) => (p.funnel.topDiameter = 8))).toEqual(['funnel-top-small']);
    expect(codes((p) => ((p.funnel.topDiameter = 8), (p.funnel.generate = false)))).toEqual([]);
  });

  it('a top that passes that rule and is still under the neck is refused too', () => {
    expect(codes((p) => ((p.pour.diameter = 30), (p.seat.halfAngleDeg = 45), (p.funnel.topDiameter = 33)))).toEqual(['funnel-under-neck']);
  });

  it('a cone past 45 degrees from vertical is refused, at the very limit it passes', () => {
    const p = defaultParams();
    const { rNeck } = funnelProfile(p);
    const rise = p.funnel.height - p.funnel.neckHeight;
    expect(codes((x) => (x.funnel.topDiameter = 2 * (rNeck + rise) - 0.01))).toEqual([]);
    expect(codes((x) => (x.funnel.topDiameter = 2 * (rNeck + rise) + 0.01))).toEqual(['funnel-too-flat']);
  });

  it('a top exactly at the neck is a straight tube, and that is no fault', () => {
    const p = defaultParams();
    expect(codes((x) => (x.funnel.topDiameter = 2 * funnelProfile(p).rNeck))).toEqual([]);
    p.funnel.topDiameter = 2 * funnelProfile(p).rNeck;
    expect(funnelProfile(p).zConeInner).toBe(p.funnel.neckHeight);
  });

  it('the funnel must have a throat, a spigot and a cone', () => {
    expect(codes((p) => (p.pour.diameter = 1.5))).toEqual(['funnel-no-throat']);
    expect(codes((p) => (p.funnel.seatClearance = 2))).toEqual(['funnel-no-spigot']);
    expect(codes((p) => (p.funnel.neckHeight = 30))).toEqual(['funnel-no-cone']);
  });

  it('FL: a flange whose chamfer would run past the neck\'s top is refused, and at the limit it passes, saying what would fit', () => {
    const p = defaultParams();
    // The chamfer starts at the flange's thickness and runs in at 45 degrees, from the flange's edge to the neck.
    const { rNeck } = funnelProfile(p);
    const seatTop = 5 + 3 * Math.tan(Math.PI / 6);
    const widest = p.funnel.neckHeight - p.funnel.flangeThickness + rNeck - seatTop;
    expect(widest).toBeGreaterThan(8.6);
    expect(codes((x) => (x.funnel.flangeWidth = widest - 0.01))).toEqual([]);
    expect(codes((x) => (x.funnel.flangeWidth = widest + 0.01))).toEqual(['funnel-flange']);
    const params = defaultParams();
    params.funnel.flangeWidth = 10;
    // The neck it needs, 11.32 mm, is rounded up, so the figure given is always enough.
    expect(1.2 + 10 + seatTop - rNeck).toBeCloseTo(11.3155, 4);
    expect(crossParameterErrors(params)[0].message).toBe(`A flange 10 mm wide and 1.2 mm thick needs a neck at least 11.4 mm high for the chamfer that lets it print without supports, over the 10 mm set: make Flange width at most ${Math.floor(widest * 10) / 10} mm, or raise Neck height, or make the flange thinner.`);
    // Just past the limit it needs 10.02 mm, which rounded to the nearest would read as the 10 mm set.
    params.funnel.flangeWidth = 8.7;
    expect(crossParameterErrors(params)[0].message).toContain('needs a neck at least 10.1 mm high');
    expect(codes((x) => ((x.funnel.flangeWidth = 10), (x.funnel.neckHeight = 12)))).toEqual([]);
    // No flange, no such rule, however short the neck.
    expect(codes((x) => ((x.funnel.flangeWidth = 0), (x.funnel.neckHeight = 1)))).toEqual([]);
    expect(codes((x) => (x.funnel.neckHeight = 1))).toEqual(['funnel-flange']);
  });

  it('FL: under a flange the spigot runs straight for 2 layers, or as many as clear a squashed mouth, and on a seat too shallow to spare them for less, which is no error', () => {
    // At defaults 2 layers of 0.2 mm, and the gap across at the foot of the cover's first layer is 0.1 / cos 30 + 0.2 tan 30.
    const half = Math.PI / 6;
    expect(funnelProfile(defaultParams()).relief).toBe(0.4);
    expect(0.1 / Math.cos(half) + 0.2 * Math.tan(half)).toBeGreaterThan(0.2);
    // At a 10 degree seat 2 layers would leave 0.1 / cos 10 + 0.2 tan 10 = 0.137 mm there, so it runs up to 0.2 mm.
    const shallow = defaultParams();
    shallow.seat.halfAngleDeg = 10;
    const ten = (10 * Math.PI) / 180;
    expect(0.1 / Math.cos(ten) + 0.2 * Math.tan(ten)).toBeLessThan(0.14);
    const { relief } = funnelProfile(shallow);
    expect(0.1 / Math.cos(ten) + (relief - 0.2) * Math.tan(ten)).toBeCloseTo(0.2, 9);
    expect(codes((x) => (x.seat.halfAngleDeg = 10))).toEqual([]);
    // A 1 mm seat leaves 0.8 mm of spigot, and 2 layers would leave 0.4 of cone, under the 0.5 a spigot needs:
    // the relief is 0.3 instead, and the funnel builds, as it did before FL.
    const low = defaultParams();
    low.seat.depth = 1;
    const p = funnelProfile(low);
    expect(-p.zTip).toBeCloseTo(1 - 0.1 / Math.sin(half), 9);
    expect(p.relief).toBeCloseTo(-p.zTip - 0.5, 9);
    expect(p.relief).toBeLessThan(0.4);
    expect(codes((x) => (x.seat.depth = 1))).toEqual([]);
    // No flange, no relief.
    expect(funnelProfile({ ...low, funnel: { ...low.funnel, flangeWidth: 0 } }).relief).toBe(0);
    // Still refused where the seat leaves too little spigot whatever the flange, as before FL.
    expect(codes((x) => ((x.seat.depth = 1), (x.funnel.seatClearance = 0.3)))).toEqual(['funnel-no-spigot']);
  });

  it('a funnel with no seat to sit in is an error, and nothing else is said about it', () => {
    expect(codes((p) => ((p.seat.enabled = false), (p.funnel.topDiameter = 5)))).toEqual(['funnel-no-seat']);
    expect(codes((p) => ((p.seat.enabled = false), (p.funnel.generate = false)))).toEqual([]);
  });
});

describe('fuzz over the parameter table', () => {
  /** Every number in the table, drawn from its range, or around its default where it has none. */
  function randomParams(random: (a: number, b: number) => number): Params {
    const params = defaultParams() as unknown as Record<string, Record<string, unknown>>;
    for (const [group, defs] of Object.entries(PARAM_SCHEMA)) {
      for (const [key, raw] of Object.entries(defs)) {
        const def = raw as NumberDef;
        if (def.kind === 'number') params[group][key] = random(def.min ?? def.default * 0.3, def.max ?? def.default * 3);
      }
    }
    return params as unknown as Params;
  }

  it('never throws, and each rule says exactly what it should', () => {
    let seed = 31337;
    const random = (a: number, b: number): number => a + ((seed = (seed * 16807) % 2147483647) / 2147483647) * (b - a);
    const seen = new Set<string>();
    for (let run = 0; run < 2000; run++) {
      const params = randomParams(random);
      params.seat.enabled = random(0, 1) > 0.2;
      params.funnel.generate = random(0, 1) > 0.2;
      const found = crossParameterErrors(params);
      found.forEach((d) => {
        seen.add(d.code);
        expect(d.severity).toBe('error');
        expect(d.message).not.toMatch(/NaN|undefined|Infinity/);
      });
      const list = found.map((d) => d.code);
      expect(list.includes('seat-too-deep')).toBe(params.seat.enabled && params.seat.depth > params.cover.topCap - 1);
      if (params.funnel.generate && params.seat.enabled) {
        expect(list.includes('funnel-top-small')).toBe(params.funnel.topDiameter < params.pour.diameter + 2 * params.funnel.wall);
      } else {
        expect(list.filter((code) => code.startsWith('funnel-') && code !== 'funnel-no-seat')).toEqual([]);
      }
    }
    // A fuzz that hits only one rule is not much of a fuzz.
    expect(seen).toContain('seat-too-deep');
    expect(seen).toContain('funnel-top-small');
    expect(seen).toContain('funnel-too-flat');
    expect(seen).toContain('funnel-no-seat');
  });
});
