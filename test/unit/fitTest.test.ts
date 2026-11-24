import { createHash } from 'node:crypto';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orientSolid } from '../../src/core/base/orient';
import { defaultParams } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';
import { buildClipCoupon, buildSeamBoltCoupon, clipTrio, fitTestFiles, type SeamBoltCoupon } from '../../src/core/parts/fitTest';
import { keySolid } from '../../src/core/parts/clips';
import { countHandles } from '../fixtures/handles';
import { halfPose, inversePose } from '../../src/core/parts/poses';
import { onSeamBoltBridge, seamBoltBridges } from '../../src/core/parts/seamBolts';
import { auditOverhang } from '../../src/core/report/overhang';
import { Arena } from '../../src/core/solid/arena';
import { parseStl } from '../../src/core/stl/parse';
import { loadManifold } from '../fixtures/loadExamples';
import { boxAW, cutsAsBuilt, cutWalls, readCuts, slotSection } from '../fixtures/seamBolts';
import { readPart, unpose } from '../fixtures/solidChecks';
import { CLAMSHELL_FIT_GOLDEN } from '../regression/golden';

/**
 * MP3: G13.10.12's seam bolt coupons, built from the halves' own functions, read as the halves are
 * (test/regression/seamBolts.test.ts), and the fit-test ZIP that holds them only for the two-part cover with seam bolts.
 * MP3b: G13.10.19's clip coupon, its block and its trio of keys, and the ZIP that holds it only with seam clips.
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

describe('MP3b: the clip coupon', () => {
  const clipped = (change: (p: Params) => void = () => {}): Params => clamParams((p) => {
    p.clamshell.fastener = 'clips';
    change(p);
  });
  const steep = (solid: Manifold, pose: Parameters<typeof orientSolid>[2] | null): number => {
    const mesh = (pose ? orientSolid(arena, solid, pose) : solid).getMesh();
    return auditOverhang({ positions: mesh.vertProperties, indices: mesh.triVerts }).steepArea;
  };

  it('the block: one valid shell, its ear and socket centred on its end face, its corbel on the bed, and turned over about b it is the other half\'s', () => {
    const coupon = buildClipCoupon(arena, clipped());
    const { block, negBlock, clips, spot, O } = coupon;
    for (const half of [block, negBlock]) {
      expect(half.status()).toBe('NoError');
      expect(half.decompose().length).toBe(1);
    }
    const box = block.boundingBox();
    expect([box.min[0], box.max[0]]).toEqual([0, clips.earDepth]);
    expect(box.min[1]).toBeCloseTo(O.y0, 9);
    expect(box.max[1]).toBeCloseTo(clips.earLength, 9);
    expect([box.min[2], box.max[2]]).toEqual([0, clips.height + 4]);
    expect(spot.z).toBeCloseTo((clips.height + 4) / 2, 12);
    // The corbel's foot meets the back face at the end face: its last 0.5 mm over the bed is a 45 degree wedge of the ear.
    const foot = arena.track(block.intersect(arena.track(arena.track(api.Manifold.cube([0.5, 30, 30])).translate([clips.earDepth - 0.5, 0, -1]))));
    expect(foot.volume()).toBeCloseTo((0.5 * 0.5 * clips.height) / 2, 4);
    // Turned 180 degrees about b, the line x = 0, z = the ear's middle: (x, y, z) to (-x, y, 2 zc - z).
    const turned = orientSolid(arena, block, { rotation: [-1, 0, 0, 0, 1, 0, 0, 0, -1], translation: [0, 0, 2 * spot.z] });
    const apart = arena.track(turned.subtract(negBlock)).volume() + arena.track(negBlock.subtract(turned)).volume();
    expect(apart).toBeLessThanOrEqual(1e-3);
    // The pair as printed, the second one turned over, stands seam to seam with its ears 2r apart and the key through both.
    expect(arena.track(block.intersect(negBlock)).volume()).toBeLessThanOrEqual(1e-3);
    expect(xSpan(arena.track(negBlock.intersect(arena.track(arena.track(api.Manifold.cube([40, 20, 40])).translate([-20, 0.01, -5])))))[1]).toBeCloseTo(-clips.relief, 6);
  });

  it('the keys: the trio of the set clearance and 0.1 either side, kept in 0 to 0.5, each the mold\'s keySolid with its notches, standing on its head', () => {
    expect(clipTrio(0.1)).toEqual([0, 0.1, 0.2]);
    expect(clipTrio(0.25)).toEqual([0.15, 0.25, 0.35]);
    expect(clipTrio(0.05)).toEqual([0, 0.1, 0.2]);
    expect(clipTrio(0)).toEqual([0, 0.1, 0.2]);
    expect(clipTrio(0.45)).toEqual([0.3, 0.4, 0.5]);
    expect(clipTrio(0.5)).toEqual([0.3, 0.4, 0.5]);
    const params = clipped((p) => (p.clips.clearance = 0.25));
    const coupon = buildClipCoupon(arena, params);
    const keys = coupon.keys.decompose();
    keys.forEach((key) => arena.track(key));
    expect(keys.length).toBe(3);
    keys.sort((p, q) => p.boundingBox().min[0] - q.boundingBox().min[0]);
    coupon.trio.forEach((clearance, k) => {
      const one = keySolid(arena, coupon.clips, { clearance, notches: k + 1 });
      expect(keys[k].volume()).toBeCloseTo(one.volume(), 6);
      expect(keys[k].boundingBox().min[2]).toBeCloseTo(0, 9);
    });
    // A looser key is a smaller one, and each notch takes a little off the head.
    expect(keys[0].volume()).toBeGreaterThan(keys[1].volume());
    expect(keys[1].volume()).toBeGreaterThan(keys[2].volume());
  });

  it('in their poses nothing is steeper than the limit, with no allowed set; a corbel at 50 degrees, a flare at 50 and a male dovetail each are', () => {
    const params = clipped();
    const coupon = buildClipCoupon(arena, params);
    expect(steep(coupon.block, halfPose(coupon, 'x', 1))).toBe(0);
    expect(steep(coupon.keys, null)).toBe(0);
    for (const ears of [{ corbelDeg: 50 }, { flareDeg: 50 }, { male: true }]) {
      const bad = buildClipCoupon(arena, params, ears);
      expect(steep(bad.block, halfPose(bad, 'x', 1)), JSON.stringify(ears)).toBeGreaterThan(10);
    }
  });

  it('the fit-test ZIP lists the two clip files only for the two-part cover with seam clips, and its README how to read them', () => {
    const clip = ['fit_test/clip_coupon_block.stl', 'fit_test/clip_coupon_keys.stl'];
    const names = (params: Params): string[] => Object.keys(fitTestFiles(api, params));
    const files = fitTestFiles(api, clipped());
    expect(Object.keys(files)).toEqual(expect.arrayContaining(clip));
    expect(Object.keys(files).filter((name) => name.includes('bolt_coupon'))).toEqual([]);
    for (const params of [clamParams(), clamParams((p) => (p.clamshell.fastener = 'none')), defaultParams(), (() => {
      const p = defaultParams();
      p.clamshell.fastener = 'clips';
      return p;
    })()]) expect(names(params).filter((name) => name.includes('clip_coupon'))).toEqual([]);
    for (const name of clip) {
      expect(readPart(files[name]).audit, name).toMatchObject({ openEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 });
      const p = parseStl(files[name]).positions;
      let min = Infinity;
      for (let k = 2; k < p.length; k += 3) min = Math.min(min, p[k]);
      expect(min).toBeCloseTo(0, 5);
    }
    // The block's pose undone is the block.
    const coupon = buildClipCoupon(arena, clipped());
    const back = unpose(arena, files['fit_test/clip_coupon_block.stl'], halfPose(coupon, 'x', 1));
    expect(arena.track(back.subtract(coupon.block)).volume() + arena.track(coupon.block.subtract(back)).volume()).toBeLessThan(1e-2);
    const readme = new TextDecoder().decode(files['fit_test/README.txt']).replace(/\r\n\s*/g, ' ');
    for (const line of [
      'clip_coupon_block.stl is a corner of a half with one clip ear and its socket',
      'and clip_coupon_keys.stl holds three clips',
      'Each clip has a double line across its sides, with single marks 1 mm apart on either side of it; the double line shows how far the clip went in.',
      'at a Clip clearance of 0.00, 0.10 and 0.20 mm per side, told apart by 1, 2 and 3 notches on the head.',
      'Print the block twice, like the halves, at 5 percent infill or less with at least 3 walls, and the clips at 100 percent infill, standing on their heads',
      'Push the clip with 2 notches into the socket, narrow end first, head out',
      'Its double line should end level with the tip of the ears, within one mark, and the seam faces should be closed.',
      'Set Clip clearance under Two-part cover, Seam clips to 0.10 mm, the value of the clip with 2 notches, plus 0.05 mm for each mark its double line stops outside the tip of the ears, or minus 0.05 mm for each mark it goes in past it.',
      'if that would be over 0.5 mm, your printer is printing well over size: check its flow and first-layer squish, then print the coupon again.',
      'Clip clearance never goes below 0 or above 0.5 mm.',
      'Try to pull the blocks apart by hand, with well over the 40 N each clip is counted at: they should not move.',
      '1 notch on the head: Clip clearance 0.00 mm',
      '3 notches on the head: Clip clearance 0.20 mm',
    ]) expect(readme).toContain(line);
    expect(readme).not.toContain('Seam bolt coupon');
    expect(new TextDecoder().decode(fitTestFiles(api, clamParams())['fit_test/README.txt'])).not.toContain('Clip coupon');
    expect(/[^\x20-\x7e\r\n]/.test(new TextDecoder().decode(files['fit_test/README.txt']))).toBe(false);
  });

  // The trio is held inside 0 to 0.5, so at either end the clip with 2 notches is not at the setting: step 3 reads from its own value.
  it('at Clip clearance 0 and 0.5 the README sets Clip clearance from the clip with 2 notches, not from the setting', () => {
    for (const [clearance, mid, trio] of [[0, '0.10', '0.00, 0.10 and 0.20'], [0.5, '0.40', '0.30, 0.40 and 0.50']] as const) {
      const readme = new TextDecoder().decode(fitTestFiles(api, clipped((p) => (p.clips.clearance = clearance)))['fit_test/README.txt']).replace(/\r\n\s*/g, ' ');
      expect(readme, String(clearance)).toContain(`at a Clip clearance of ${trio} mm per side`);
      expect(readme, String(clearance)).toContain(`Set Clip clearance under Two-part cover, Seam clips to ${mid} mm, the value of the clip with 2 notches, plus 0.05 mm for each mark`);
      expect(readme, String(clearance)).not.toContain('raise Clip clearance');
    }
  });

  // Off the usual settings the coupon still builds: the clearance at both ends, a 0.8 mm nozzle, 0.3 mm layers.
  for (const [name, change] of [
    ['Clip clearance 0', (p: Params) => (p.clips.clearance = 0)],
    ['Clip clearance 0.5', (p: Params) => (p.clips.clearance = 0.5)],
    ['a 0.8 mm nozzle', (p: Params) => (p.print.nozzle = 0.8)],
    ['0.3 mm layers', (p: Params) => (p.print.layerHeight = 0.3)],
  ] as const) {
    it(`${name}: the coupon builds, its block and keys valid and nothing steep`, () => {
      const coupon = buildClipCoupon(arena, clipped(change));
      for (const solid of [coupon.block, coupon.negBlock, coupon.keys]) expect(solid.status()).toBe('NoError');
      expect(coupon.block.decompose().length).toBe(1);
      expect(steep(coupon.block, halfPose(coupon, 'x', 1))).toBe(0);
      expect(steep(coupon.keys, null)).toBe(0);
    });
  }

  it('the fit test with seam clips frees every handle', async () => {
    const counted = await loadManifold();
    const ledger = countHandles(counted);
    fitTestFiles(counted, clipped());
    expect(ledger.created()).toBeGreaterThan(20);
    expect(ledger.live()).toEqual([]);
  });
});

// G13.10.20's Coupon check: Seam fasteners Clips leaves the Bolts and None fit tests as MP3 made them, byte for byte.
describe('MP3b keeps MP3\'s fit test', () => {
  const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
  it('with Bolts the seam bolt coupons and the README, and with None the file list and the README, are 2f28149\'s', () => {
    const bolted = fitTestFiles(api, clamParams((p) => (p.clamshell.fastener = 'bolts')));
    for (const [name, hash] of Object.entries(CLAMSHELL_FIT_GOLDEN.bolts)) expect(sha(bolted[name]), name).toBe(hash);
    const none = fitTestFiles(api, clamParams((p) => (p.clamshell.fastener = 'none')));
    expect(Object.keys(none)).toEqual(CLAMSHELL_FIT_GOLDEN.none.files);
    expect(sha(none['fit_test/README.txt'])).toBe(CLAMSHELL_FIT_GOLDEN.none['fit_test/README.txt']);
  });
});
