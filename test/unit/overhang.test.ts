import { describe, expect, it } from 'vitest';
import { auditOverhang } from '../../src/core/report/overhang';
import { box } from '../fixtures/synthetic';

/** A frustum from a side of `low` at z=0 to a side of `high` at z=height, with its bed face at z=0. */
function frustum(low: number, high: number, height: number, z0 = 0): { positions: Float32Array; indices: Uint32Array } {
  const l = low / 2, h = high / 2;
  const positions = new Float32Array([-l, -l, z0, l, -l, z0, l, l, z0, -l, l, z0, -h, -h, z0 + height, h, -h, z0 + height, h, h, z0 + height, -h, h, z0 + height]);
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7]);
  return { positions, indices };
}

const widening = (degrees: number, height = 5): { positions: Float32Array; indices: Uint32Array } => frustum(10, 10 + 2 * height * Math.tan((degrees * Math.PI) / 180), height);

describe('the overhang audit', () => {
  it('passes a plain box standing on the bed: walls and a top', () => {
    expect(auditOverhang(box([0, 0, 0], [10, 10, 10]))).toEqual({ steepCount: 0, steepArea: 0, worstDeg: 0, ignoredArea: 0 });
  });

  it('flags a box hanging over the bed, with its full underside area', () => {
    const audit = auditOverhang(box([0, 0, 5], [10, 10, 10]), { bedZ: 0 });
    expect(audit.steepCount).toBe(2);
    expect(audit.steepArea).toBeCloseTo(100, 6);
    expect(audit.worstDeg).toBeCloseTo(90, 6);
  });

  it('passes an exact 45 degree chamfer and a shallower one', () => {
    for (const degrees of [10, 30, 44.9, 45]) {
      const audit = auditOverhang(widening(degrees));
      expect(audit.steepCount, `${degrees} degrees`).toBe(0);
      expect(audit.worstDeg).toBeCloseTo(degrees, 3);
    }
  });

  it('flags a degree past 45, so the tolerance is only for rounding', () => {
    const audit = auditOverhang(widening(46));
    expect(audit.steepCount).toBeGreaterThan(0);
    expect(audit.worstDeg).toBeCloseTo(46, 3);
    expect(auditOverhang(widening(45.2)).steepCount).toBeGreaterThan(0);
    expect(auditOverhang(widening(45.05)).steepCount).toBe(0);
  });

  it('leaves a shape narrowing upward alone, however steep', () => {
    expect(auditOverhang(frustum(20, 2, 1)).steepCount).toBe(0);
  });

  it('can take a limit of another size', () => {
    expect(auditOverhang(widening(35), { limitDeg: 30 }).steepCount).toBeGreaterThan(0);
  });

  it('counts only the faces asked about', () => {
    const hanging = box([0, 0, 5], [10, 10, 10]);
    expect(auditOverhang(hanging, { bedZ: 0, only: (x) => x > 100 }).steepCount).toBe(0);
    expect(auditOverhang(hanging, { bedZ: 0, only: (x) => x < 100 }).steepCount).toBe(2);
  });

  it('sets aside a crumb from a boolean, whose normal means nothing, and reports what it set aside', () => {
    const crumb = { positions: new Float32Array([0, 0, 5, 0.005, 0, 5, 0, 0.005, 5]), indices: new Uint32Array([0, 2, 1]) };
    const audit = auditOverhang(crumb, { bedZ: 0 });
    expect(audit.steepCount).toBe(0);
    expect(audit.ignoredArea).toBeCloseTo(0.0000125, 8);
  });

  it('sets aside a long sliver too, however much area it reaches, as rounding alone can flip one', () => {
    // As found on a plate top, wound upside down by float32: 100 mm long and a micron thin at most.
    const sliver = { positions: new Float32Array([0, 0, 5, 100, 0, 5, 50, 0.0005, 5]), indices: new Uint32Array([0, 2, 1]) };
    const audit = auditOverhang(sliver, { bedZ: 0 });
    expect(audit.steepCount).toBe(0);
    expect(audit.ignoredArea).toBeCloseTo(0.025, 3);
    // One a little wider is a real face and is reported.
    const face = { positions: new Float32Array([0, 0, 5, 100, 0, 5, 50, 0.01, 5]), indices: new Uint32Array([0, 2, 1]) };
    expect(auditOverhang(face, { bedZ: 0 }).steepCount).toBe(1);
  });
});
