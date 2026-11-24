import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orientSolid } from '../../src/core/base/orient';
import { defaultParams } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';
import { buildSeamBoltCoupon, fitTestFiles, type SeamBoltCoupon } from '../../src/core/parts/fitTest';
import { halfPose, inversePose } from '../../src/core/parts/poses';
import { onSeamBoltBridge, seamBoltBridges } from '../../src/core/parts/seamBolts';
import { auditOverhang } from '../../src/core/report/overhang';
import { Arena } from '../../src/core/solid/arena';
import { parseStl } from '../../src/core/stl/parse';
import { loadManifold } from '../fixtures/loadExamples';
import { boxAW, cutsAsBuilt, cutWalls, readCuts, slotSection } from '../fixtures/seamBolts';
import { readPart } from '../fixtures/solidChecks';

/**
 * MP3: G13.10.12's seam bolt coupons, built from the halves' own functions, read as the halves are
 * (test/regression/seamBolts.test.ts), and the fit-test ZIP that holds them only for the two-part cover with seam bolts.
 */

let api: ManifoldToplevel;
let arena: Arena;
beforeAll(async () => {
  api = await loadManifold();
  arena = new Arena(api);
});
afterAll(() => arena.dispose());

const SIZES = ['M2.5', 'M3', 'M4'] as const;

function clamParams(change: (p: Params) => void = () => {}): Params {
  const p = defaultParams('clamshell');
  change(p);
  return p;
}

/** Along x, the coupon's a, the least and the most of a solid. */
const xSpan = (m: Manifold): [number, number] => {
  const box = m.boundingBox();
  return [box.min[0], box.max[0]];
};

describe('MP3: the seam bolt coupon', () => {
  for (const size of SIZES) {
    it(`${size}: two valid pieces, the cuts as the halves have them, every cut minWall inside the lug, the lug faces 2r apart while the stub faces meet`, () => {
      const coupon = buildSeamBoltCoupon(arena, clamParams((p) => (p.bolts.size = size)));
      const { bolts, halves } = coupon;
      const [spot] = bolts.spots;
      for (const half of halves) {
        expect(half.status()).toBe('NoError');
        expect(half.decompose().length).toBe(1);
      }
      expect(arena.track(halves[0].intersect(halves[1])).volume()).toBeLessThanOrEqual(1e-3);
      const n = readCuts(arena, halves[0], bolts, -1, spot), p = readCuts(arena, halves[1], bolts, 1, spot);
      expect(cutsAsBuilt(n), JSON.stringify(n)).toBe(true);
      expect(cutsAsBuilt(p), JSON.stringify(p)).toBe(true);
      for (const sign of [-1, 1] as const) expect(cutWalls(arena, bolts, sign, spot)).toEqual({ face: 0, tip: 0, bottom: 0, top: 0 });
      if (size === 'M3') expect(slotSection(arena, halves[1], bolts, spot)).toBeGreaterThanOrEqual(70);
      // The stub faces meet in P, x = 0; outside the wall the lug faces keep 2r between them.
      const lug = boxAW(arena, bolts, spot, [-100, 100], [0.01, bolts.p + 1], [-100, 100]);
      expect(xSpan(halves[0])[1]).toBeCloseTo(0, 6);
      expect(xSpan(halves[1])[0]).toBeCloseTo(0, 6);
      expect(xSpan(arena.track(halves[0].intersect(lug)))[1]).toBeCloseTo(-bolts.relief, 6);
      expect(xSpan(arena.track(halves[1].intersect(lug)))[0]).toBeCloseTo(bolts.relief, 6);
      // Each piece as deep as its flat thickness, its gusset and the overlap, in whole layers, and f whole layers from the back.
      for (const [k, t] of [[0, bolts.tn], [1, bolts.tp]] as const) {
        const depth = bolts.depths[k];
        expect(depth).toBeGreaterThanOrEqual(t + bolts.p + 1 - 1e-9);
        expect(Math.abs(depth / bolts.layer - Math.round(depth / bolts.layer))).toBeLessThan(1e-6);
      }
      const back = (bolts.depths[1] - bolts.f) / bolts.layer;
      expect(Math.abs(back - Math.round(back))).toBeLessThan(1e-6);
      expect(bolts.f).toBeGreaterThanOrEqual(bolts.fMin - 1e-9);
      expect(bolts.f).toBeLessThan(bolts.fMin + bolts.layer);
    });
  }

  it('in their poses, on their backs: the nut slot\'s face the only steep face, in the nut side', () => {
    const coupon = buildSeamBoltCoupon(arena, clamParams());
    const bridges = seamBoltBridges(coupon.bolts);
    for (const sign of [-1, 1] as const) {
      const pose = halfPose(coupon, 'x', sign);
      const { rotation: [a, b, c, d, e, f, g, h, i], translation: [tx, ty, tz] } = inversePose(pose);
      const allowed = (x: number, y: number, z: number): boolean => onSeamBoltBridge(sign > 0 ? bridges : [], 'x', a * x + b * y + c * z + tx, d * x + e * y + f * z + ty, g * x + h * y + i * z + tz);
      const mesh = orientSolid(arena, coupon.halves[sign > 0 ? 1 : 0], pose).getMesh();
      const audit = auditOverhang({ positions: mesh.vertProperties, indices: mesh.triVerts }, { allowed });
      expect(audit.steepArea).toBeCloseTo(audit.allowedArea!, 6);
      if (sign > 0) expect(audit.allowedArea).toBeGreaterThan(45);
      else expect(audit.steepArea).toBe(0);
    }
  });

  it('negative controls: no membrane, a slot 1 mm short, a bore short of the gusset and no relief each read wrong', () => {
    const params = clamParams();
    const read = (options: Parameters<typeof buildSeamBoltCoupon>[2], sign: 1 | -1): ReturnType<typeof readCuts> => {
      const coupon: SeamBoltCoupon = buildSeamBoltCoupon(arena, params, options);
      return readCuts(arena, coupon.halves[sign > 0 ? 1 : 0], coupon.bolts, sign, coupon.bolts.spots[0]);
    };
    expect(read({ cuts: { membrane: false } }, 1).membrane).toBeLessThan(0.01);
    expect(read({ cuts: { slotShort: 1 } }, 1).slot).toBeGreaterThan(1);
    expect(read({ cuts: { boreTo: 1 } }, -1).bore).toBeGreaterThan(1);
    for (const options of [{ cuts: { membrane: false } }, { cuts: { slotShort: 1 } }] as const) expect(cutsAsBuilt(read(options, 1))).toBe(false);
    expect(cutsAsBuilt(read({ cuts: { boreTo: 1 } }, -1))).toBe(false);
    const touching = buildSeamBoltCoupon(arena, params, { lugs: { relief: false } });
    const lug = boxAW(arena, touching.bolts, touching.bolts.spots[0], [-100, 100], [0.01, touching.bolts.p + 1], [-100, 100]);
    expect(xSpan(arena.track(touching.halves[1].intersect(lug)))[0] - xSpan(arena.track(touching.halves[0].intersect(lug)))[1]).toBeLessThan(1e-6);
  });

  // A length off its range moves Tn past either end: short at M3 x 6, M4 x 8 and M2.5 x 8, long at M3 x 40, for which the
  // coupon, sized to its lug, is deep enough. Each builds, and the ZIP holds both files, with a note when the screw is short.
  for (const [size, length] of [['M3', 6], ['M4', 8], ['M2.5', 8], ['M3', 40]] as const) {
    it(`${size} x ${length}: the coupon builds, its cuts open where they lie in the lug, and the fit-test ZIP holds it`, () => {
      const params = clamParams((p) => {
        p.bolts.size = size;
        p.bolts.length = length;
      });
      const { bolts, halves } = buildSeamBoltCoupon(arena, params);
      const [spot] = bolts.spots;
      for (const half of halves) {
        expect(half.status()).toBe('NoError');
        expect(half.decompose().length).toBe(1);
      }
      expect(arena.track(halves[0].intersect(halves[1])).volume()).toBeLessThanOrEqual(1e-3);
      const n = readCuts(arena, halves[0], bolts, -1, spot), p = readCuts(arena, halves[1], bolts, 1, spot);
      expect(cutsAsBuilt(p), JSON.stringify(p)).toBe(true);
      for (const open of [n.hole, n.sink, n.bore]) expect(open, JSON.stringify(n)).toBeLessThanOrEqual(1e-3);
      const short = bolts.tn < bolts.tnMin;
      expect(short).toBe(length < 10);
      if (bolts.tn - bolts.sinkDepth >= bolts.relief + 0.4) expect(cutsAsBuilt(n), JSON.stringify(n)).toBe(true);
      const files = fitTestFiles(api, params);
      for (const name of ['fit_test/seam_bolt_coupon_neg.stl', 'fit_test/seam_bolt_coupon_pos.stl']) expect(readPart(files[name]).audit, name).toMatchObject({ openEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 });
      const readme = new TextDecoder().decode(files['fit_test/README.txt']).replace(/\r\n\s*/g, ' ');
      if (short) expect(readme).toContain(`An ${size} x ${length} mm screw leaves the head side's lug ${bolts.tn.toFixed(2)} mm thick, under the ${bolts.tnMin.toFixed(2)} mm that keeps plastic over its countersink: use ${bolts.autoLength} mm or longer`);
      else expect(readme).not.toContain('keeps plastic over its countersink');
    });
  }

  it('the fit-test ZIP lists the two coupons only for the two-part cover with seam bolts, never M10\'s there, and its README how to read them', () => {
    const seam = ['fit_test/seam_bolt_coupon_neg.stl', 'fit_test/seam_bolt_coupon_pos.stl'];
    const m10 = ['fit_test/bolt_coupon_base.stl', 'fit_test/bolt_coupon_cover.stl'];
    const names = (params: Params): string[] => Object.keys(fitTestFiles(api, params));
    const bolted = fitTestFiles(api, clamParams());
    expect(Object.keys(bolted)).toEqual(expect.arrayContaining(seam));
    expect(Object.keys(bolted).filter((name) => name.includes('bolt_coupon') && !seam.includes(name))).toEqual([]);
    // The user's corner bolts, kept in params under this type's lock, still bring no M10 coupon in this type.
    expect(names(clamParams((p) => (p.bolts.enabled = true))).filter((name) => m10.includes(name))).toEqual([]);
    for (const fastener of ['clips', 'none'] as const) expect(names(clamParams((p) => (p.clamshell.fastener = fastener))).filter((name) => name.includes('bolt_coupon'))).toEqual([]);
    const one = names(defaultParams());
    expect(one.filter((name) => name.includes('bolt_coupon'))).toEqual([]);
    const corner = defaultParams();
    corner.bolts.enabled = true;
    expect(names(corner).filter((name) => name.includes('bolt_coupon')).sort()).toEqual(m10);
    // Each file reads back as a closed solid on the bed.
    for (const name of seam) {
      expect(readPart(bolted[name]).audit, name).toMatchObject({ openEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 });
      const p = parseStl(bolted[name]).positions;
      let min = Infinity;
      for (let k = 2; k < p.length; k += 3) min = Math.min(min, p[k]);
      expect(min).toBeCloseTo(0, 5);
    }
    const readme = new TextDecoder().decode(bolted['fit_test/README.txt']).replace(/\r\n\s*/g, ' ');
    for (const line of [
      'seam_bolt_coupon_neg.stl and seam_bolt_coupon_pos.stl are a stub of each half\'s end wall with one pair of seam bolt lugs',
      'with an M3 x 10 mm countersunk screw, an M3 hex nut and a 2 mm hex key:',
      'Assemble the two coupons on a flat table',
      'Stop at snug, when the stub faces close, then give it a quarter turn more. The lug faces must keep a visible gap while the stub faces close, and no lug may crack.',
      'raise Nut clearance per side under Two-part cover, Seam bolts, by 0.05 mm.',
      'the thin layer of plastic between the hole and the nut slot, which is meant to be pierced',
    ]) expect(readme).toContain(line);
    expect(readme).not.toContain('keeps plastic over its countersink');
    expect(new TextDecoder().decode(fitTestFiles(api, defaultParams())['fit_test/README.txt'])).not.toContain('Seam bolt coupon');
  });
});
