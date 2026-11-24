import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orientSolid } from '../../src/core/base/orient';
import { frameInverse, halfFrame } from '../../src/core/field/frames';
import { bedFootprint, fastenerGrowth } from '../../src/core/field/side';
import { column } from '../../src/core/parts/bolts';
import { buildHalves, type ClamshellBuildOptions } from '../../src/core/parts/clamshell';
import { coverBottom, trimHalf } from '../../src/core/parts/cover';
import { openingCutters } from '../../src/core/parts/openings';
import { seamPins, seamTongue } from '../../src/core/parts/seam';
import { halfPose, inversePose, poseToStl } from '../../src/core/parts/poses';
import { LUG_OVERLAP, lugAxis, lugBedGrowth, lugSolid, onSeamBoltBridge, seamBoltBridges, type SeamBoltLayout, type SeamBoltSpot } from '../../src/core/parts/seamBolts';
import { auditOverhang } from '../../src/core/report/overhang';
import { Arena } from '../../src/core/solid/arena';
import { parseStl } from '../../src/core/stl/parse';
import { clamCase, siliconeSolid, type ClamCase } from '../fixtures/clamshell';
import { loadManifold, skipWithout } from '../fixtures/loadExamples';
import { boxAW, cutsAsBuilt, cutWalls, readCuts, slotSection } from '../fixtures/seamBolts';

/**
 * MP3: G13.10's seam bolts built (docs/PLAN.md, MP3's checks): the lugs in the shared block, their relief and cuts in
 * each half, read off the solids and the exported STLs, the audit with the nut slots' bridges, and the pull test with the
 * lugs. On the gallery's sphere and the Goddess Statue always, VIS-35 where it is in this checkout; the negative controls
 * on the sphere, whose halves build in about a second. The coupon's are test/unit/fitTest.test.ts's.
 */
const SLOW = 900_000;
/** What a boolean of touching solids may leave as volume, in mm3: the plan's bound. */
const NONE = 1e-3;

let api: ManifoldToplevel;
let arena: Arena;
const cases = new Map<string, ClamCase>();
const IDS = ['sphere', 'goddess', 'vis35'] as const;
/** G13.10.6's table at beta 20: lug pairs on each end face. */
const PER_END: Record<(typeof IDS)[number], number> = { sphere: 2, goddess: 2, vis35: 3 };

function caseOf(id: string): ClamCase {
  let found = cases.get(id);
  if (!found) {
    found = clamCase(arena, id, (p) => (p.clamshell.fastener = 'bolts'));
    cases.set(id, found);
  }
  return found;
}

beforeAll(async () => {
  api = await loadManifold();
  arena = new Arena(api);
});
afterAll(() => arena.dispose());

const track = <T extends { delete(): void }>(handle: T): T => arena.track(handle);
const vol = (m: Manifold): number => m.volume();
const boltsOf = (c: ClamCase): SeamBoltLayout => c.build.bolts!;

/** The halves again from the case's tools and seal, with the lugs or cuts changed: the negative controls. */
function rebuilt(c: ClamCase, options: Pick<ClamshellBuildOptions, 'lugs' | 'cuts'>, bolts = boltsOf(c)): [Manifold, Manifold] {
  const { rim, tools, seal, openings } = c.build;
  return buildHalves(arena, rim, tools, seal, c.params, openings, bolts, null, options).halves;
}

/** O's box over the cover's height, a hair past it each way, its end faces moved in by `inset` along b. */
function boxO(c: ClamCase, inset = 0): Manifold {
  const { O, Zt } = c.build.rim;
  const [ix, iy] = c.fine.axis === 'x' ? [0, inset] : [inset, 0];
  const x0 = O.x0 + ix, x1 = O.x1 - ix, y0 = O.y0 + iy, y1 = O.y1 - iy;
  const bottom = coverBottom(c.build.rim) - 1;
  return track(track(api.Manifold.cube([x1 - x0, y1 - y0, Zt + 1 - bottom])).translate([x0, y0, bottom]));
}

/** Along a, the least and the most of a solid. */
function aSpan(c: ClamCase, m: Manifold): [number, number] {
  const box = m.boundingBox();
  const k = c.fine.axis === 'x' ? 0 : 1;
  return [box.min[k], box.max[k]];
}

describe('MP3: the lugs', () => {
  for (const id of IDS) {
    it(`${id}: valid halves of one shell, neg and pos apart, and outside O only the lugs, at w > 0 or in their overlap, none under the cover's bottom edge`, (ctx) => {
      if (id === 'vis35') skipWithout(ctx, 'vis35');
      const c = caseOf(id);
      const bolts = boltsOf(c);
      expect(bolts.perEnd).toBe(PER_END[id]);
      expect(c.build.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
      const [neg, pos] = c.build.halves;
      for (const half of [neg, pos]) {
        expect(half.status()).toBe('NoError');
        expect(half.decompose().length).toBe(1);
      }
      expect(vol(track(neg.intersect(pos)))).toBeLessThanOrEqual(NONE);
      const lugs = track(api.Manifold.union(lugSolid(arena, bolts)));
      for (const half of [neg, pos]) {
        const outside = track(half.subtract(boxO(c)));
        // Each lug pair outside O, less its cuts and the relief, about 2 cm3 at M3.
        expect(vol(outside) / bolts.count).toBeGreaterThan(500);
        expect(outside.boundingBox().min[2]).toBeGreaterThanOrEqual(coverBottom(c.build.rim) - 1e-6);
        expect(vol(track(outside.subtract(lugs)))).toBeLessThanOrEqual(NONE);
      }
      // Inside O, a lug reaches no further than its overlap into the end wall.
      expect(vol(track(lugs.intersect(boxO(c, LUG_OVERLAP + 1e-3))))).toBeLessThanOrEqual(NONE);
    }, SLOW);

    it(`${id}: each lug's tip at w = p as built, so each half's extent along b is O's and the bed filter's 2p, and its height the footprint's`, (ctx) => {
      if (id === 'vis35') skipWithout(ctx, 'vis35');
      const c = caseOf(id);
      const bolts = boltsOf(c);
      const { rim } = c.build;
      const kb = c.fine.axis === 'x' ? 1 : 0;
      const [b0, b1] = c.fine.axis === 'x' ? [rim.O.y0, rim.O.y1] : [rim.O.x0, rim.O.x1];
      const bed = bedFootprint(rim, c.fine.axis, c.fine.xs, fastenerGrowth(c.params));
      expect(fastenerGrowth(c.params)).toBeCloseTo(lugBedGrowth(bolts), 9);
      for (const half of c.build.halves) {
        const box = half.boundingBox();
        expect(box.min[kb]).toBeCloseTo(b0 - bolts.p, 6);
        expect(box.max[kb]).toBeCloseTo(b1 + bolts.p, 6);
        expect(box.max[kb] - box.min[kb]).toBeCloseTo(bed.width, 6);
        expect(box.max[2] - box.min[2]).toBeCloseTo(bed.length, 6);
        for (const spot of bolts.spots) {
          const zone = boxAW(arena, bolts, spot, [c.fine.xs - 500, c.fine.xs + 500], [0.01, bolts.p + 1], [spot.z - bolts.height / 2 - 0.5, spot.z + bolts.height / 2 + 0.5]);
          const lug = track(half.intersect(zone)).boundingBox();
          const tip = spot.end === 'b0' ? b0 - lug.min[kb] : lug.max[kb] - b1;
          expect(tip).toBeCloseTo(bolts.p, 6);
        }
      }
    }, SLOW);

    it(`${id}: each pair's lug faces 2r apart, while the halves' seam faces meet in P`, (ctx) => {
      if (id === 'vis35') skipWithout(ctx, 'vis35');
      const c = caseOf(id);
      const bolts = boltsOf(c);
      const { xs } = c.fine;
      const [neg, pos] = c.build.halves;
      for (const spot of bolts.spots) {
        const zone = boxAW(arena, bolts, spot, [xs - 100, xs + 100], [0.01, bolts.p + 1], [spot.z - bolts.height / 2 - 1, spot.z + bolts.height / 2 + 1]);
        const [n, p] = [aSpan(c, track(neg.intersect(zone)))[1], aSpan(c, track(pos.intersect(zone)))[0]];
        expect(n).toBeCloseTo(xs - bolts.relief, 4);
        expect(p).toBeCloseTo(xs + bolts.relief, 4);
      }
      // Inside O the halves meet in P: neither passes it but for neg's tongue and pins, which stand into pos's groove and
      // sockets, and their faces there are MP2's, the relief lying outside O.
      const added = track(api.Manifold.union([seamTongue(arena, c.build.seal, c.params), ...seamPins(arena, c.build.seal)]));
      const past = (sign: 1 | -1): Manifold => track(trimHalf(arena, boxO(c), c.fine.axis, xs, sign));
      expect(vol(track(api.Manifold.difference([track(neg.intersect(past(1))), added])))).toBeLessThanOrEqual(NONE);
      expect(vol(track(pos.intersect(past(-1))))).toBeLessThanOrEqual(NONE);
    }, SLOW);
  }

  it('negative control: with no relief the lug faces of a pair touch in P', () => {
    const c = caseOf('sphere');
    const bolts = boltsOf(c);
    const [neg, pos] = rebuilt(c, { lugs: { relief: false } });
    const spot = bolts.spots[0];
    const zone = boxAW(arena, bolts, spot, [c.fine.xs - 100, c.fine.xs + 100], [0.01, bolts.p + 1], [spot.z - bolts.height / 2 - 1, spot.z + bolts.height / 2 + 1]);
    const gap = aSpan(c, track(pos.intersect(zone)))[0] - aSpan(c, track(neg.intersect(zone)))[1];
    expect(gap).toBeLessThan(1e-6);
  }, SLOW);
});

describe('MP3: the cuts, read off the solids', () => {
  for (const id of IDS) {
    it(`${id}: the countersink and bore open along -a, the hole and a one-layer membrane, the slot out of the top face, the hole open beyond; every cut minWall inside the lug`, (ctx) => {
      if (id === 'vis35') skipWithout(ctx, 'vis35');
      const c = caseOf(id);
      const bolts = boltsOf(c);
      const [neg, pos] = c.build.halves;
      for (const spot of bolts.spots) {
        const n = readCuts(arena, neg, bolts, -1, spot), p = readCuts(arena, pos, bolts, 1, spot);
        expect(cutsAsBuilt(n), JSON.stringify(n)).toBe(true);
        expect(cutsAsBuilt(p), JSON.stringify(p)).toBe(true);
        for (const sign of [-1, 1] as const) expect(cutWalls(arena, bolts, sign, spot)).toEqual({ face: 0, tip: 0, bottom: 0, top: 0 });
        // About 78 mm2 at M3: the lug's 9.52 x 14 less the slot's outline.
        expect(slotSection(arena, pos, bolts, spot)).toBeGreaterThanOrEqual(70);
      }
    }, SLOW);
  }

  it('negative controls: no membrane, a slot 1 mm short of the top face, a bore short of the gusset and a counterbore each read wrong', () => {
    const c = caseOf('sphere');
    const bolts = boltsOf(c);
    const spot = bolts.spots[0];
    const pos = (cuts: ClamshellBuildOptions['cuts']): ReturnType<typeof readCuts> => readCuts(arena, rebuilt(c, { cuts })[1], bolts, 1, spot);
    const neg = (cuts: ClamshellBuildOptions['cuts']): ReturnType<typeof readCuts> => readCuts(arena, rebuilt(c, { cuts })[0], bolts, -1, spot);
    expect(pos({ membrane: false }).membrane).toBeLessThan(0.01);
    expect(pos({ slotShort: 1 }).slot).toBeGreaterThan(1);
    expect(neg({ boreTo: 1 }).bore).toBeGreaterThan(1);
    expect(neg({ counterbore: true }).sinkWall).toBeLessThan(0.01);
    for (const reading of [pos({ membrane: false }), pos({ slotShort: 1 }), neg({ boreTo: 1 }), neg({ counterbore: true })]) expect(cutsAsBuilt(reading)).toBe(false);
  }, SLOW);
});

/**
 * A length off its range moves Tn past either end of the - lug (G13.10.5): each case builds its halves with the warning,
 * not a throw. Short at M3 x 6 and M4 x 8, with no plate left over the countersink, and at M2.5 x 8, with one under
 * Tn,min; long at M3 x 40 on the cube, whose - half is shallower than Tn.
 */
const OFF_RANGE = [
  { id: 'sphere', size: 'M3', length: 6, code: 'seam-bolt-short' },
  { id: 'sphere', size: 'M4', length: 8, code: 'seam-bolt-short' },
  { id: 'sphere', size: 'M2.5', length: 8, code: 'seam-bolt-short' },
  { id: 'cube', size: 'M3', length: 40, code: 'seam-bolt-long' },
] as const;

describe('MP3: screw lengths off the range', () => {
  for (const { id, size, length, code } of OFF_RANGE) {
    it(`${id} at ${size} x ${length}: the halves build, valid and apart, with ${code}; every cut open where it lies in the lug, and as built wherever the plate over the countersink is there`, () => {
      const c = clamCase(arena, id, (p) => {
        p.clamshell.fastener = 'bolts';
        p.bolts.size = size;
        p.bolts.length = length;
      });
      const bolts = boltsOf(c);
      expect(bolts.spots.length).toBeGreaterThan(0);
      expect(bolts.lengthFits).toBe(false);
      expect(c.build.diagnostics.map((d) => d.code)).toContain(code);
      const [neg, pos] = c.build.halves;
      for (const half of [neg, pos]) {
        expect(half.status()).toBe('NoError');
        expect(half.decompose().length).toBe(1);
      }
      expect(vol(track(neg.intersect(pos)))).toBeLessThanOrEqual(NONE);
      const plate = bolts.tn - bolts.sinkDepth >= bolts.relief + 0.4 && bolts.tn <= bolts.depths[0];
      for (const spot of bolts.spots) {
        const n = readCuts(arena, neg, bolts, -1, spot), p = readCuts(arena, pos, bolts, 1, spot);
        expect(cutsAsBuilt(p), JSON.stringify(p)).toBe(true);
        for (const open of [n.hole, n.sink, n.bore]) expect(open, JSON.stringify(n)).toBeLessThanOrEqual(NONE);
        if (plate) {
          expect(cutsAsBuilt(n), JSON.stringify(n)).toBe(true);
          for (const sign of [-1, 1] as const) expect(cutWalls(arena, bolts, sign, spot)).toEqual({ face: 0, tip: 0, bottom: 0, top: 0 });
        }
      }
    }, SLOW);
  }
});

/** The points of an STL, its pose undone, back in the mold. */
function moldPoints(stl: Uint8Array, pose: ReturnType<typeof halfPose>): Float64Array {
  const p = parseStl(stl).positions;
  const { rotation: R, translation: t } = inversePose(pose);
  const out = new Float64Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) out[i + k] = R[3 * k] * p[i] + R[3 * k + 1] * p[i + 1] + R[3 * k + 2] * p[i + 2] + t[k];
  }
  return out;
}

/**
 * A hole's axis in (b, z), from the points of its plain stretch along a, [a0, a1], within 0.02 of its radius about the
 * planned axis: a least-squares circle (Kasa's), exact for points on a circle, which the hole's corners are, as each
 * plane that cuts it there is square to it.
 */
function holeAxis(points: Float64Array, axis: 'x' | 'y', spot: SeamBoltSpot, radius: number, a0: number, a1: number): [number, number] {
  const [ka, kb] = axis === 'x' ? [0, 1] : [1, 0];
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxr = 0, syr = 0, sr = 0;
  for (let i = 0; i < points.length; i += 3) {
    const a = points[i + ka];
    if (a < a0 - 1e-3 || a > a1 + 1e-3) continue;
    const x = points[i + kb] - spot.b, y = points[i + 2] - spot.z;
    const rr = x * x + y * y;
    if (Math.abs(Math.sqrt(rr) - radius) > 0.02) continue;
    n++;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxr += x * rr; syr += y * rr; sr += rr;
  }
  expect(n).toBeGreaterThan(20);
  // [sxx sxy sx; sxy syy sy; sx sy n] [D E F] = -[sxr syr sr], the centre (-D/2, -E/2).
  const m = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const rhs = [-sxr, -syr, -sr];
  const det = (q: number[][]): number => q[0][0] * (q[1][1] * q[2][2] - q[1][2] * q[2][1]) - q[0][1] * (q[1][0] * q[2][2] - q[1][2] * q[2][0]) + q[0][2] * (q[1][0] * q[2][1] - q[1][1] * q[2][0]);
  const d = det(m);
  const solve = (k: number): number => det(m.map((row, r) => row.map((v, j) => (j === k ? rhs[r] : v)))) / d;
  return [spot.b - solve(0) / 2, spot.z - solve(1) / 2];
}

/** Each pair's hole axes in neg and in pos, read from the halves' STLs in their poses. */
function exportedAxes(c: ClamCase, bolts: SeamBoltLayout, halves: readonly [Manifold, Manifold]): { neg: [number, number]; pos: [number, number] }[] {
  const { rim } = c.build;
  const { xs } = c.fine;
  const [negPose, posPose] = [halfPose(rim, rim.axis, -1), halfPose(rim, rim.axis, 1)];
  const negPoints = moldPoints(poseToStl(api, halves[0], negPose), negPose);
  const posPoints = moldPoints(poseToStl(api, halves[1], posPose), posPose);
  const { holeRadius: rh, relief: r, tn, sinkDepth, f, layer } = bolts;
  return bolts.spots.map((spot) => ({
    neg: holeAxis(negPoints, rim.axis, spot, rh, xs - (tn - sinkDepth), xs - r),
    pos: holeAxis(posPoints, rim.axis, spot, rh, xs + r, xs + f - layer),
  }));
}

describe('MP3: the axes, from the exported STLs', () => {
  for (const id of IDS) {
    it(`${id}: with the poses undone, the holes of each pair agree within 1e-3 mm, on the planned axis`, (ctx) => {
      if (id === 'vis35') skipWithout(ctx, 'vis35');
      const c = caseOf(id);
      const bolts = boltsOf(c);
      exportedAxes(c, bolts, c.build.halves).forEach(({ neg, pos }, k) => {
        const spot = bolts.spots[k];
        expect(Math.hypot(neg[0] - pos[0], neg[1] - pos[1])).toBeLessThanOrEqual(1e-3);
        expect(Math.hypot(neg[0] - spot.b, neg[1] - spot.z)).toBeLessThanOrEqual(1e-3);
      });
    }, SLOW);
  }

  it('negative control: a pos lug moved 0.01 mm up puts its hole off the neg one\'s', () => {
    const c = caseOf('sphere');
    const bolts = boltsOf(c);
    const moved: SeamBoltLayout = { ...bolts, spots: bolts.spots.map((spot, k) => (k === 0 ? { ...spot, z: spot.z + 0.01 } : spot)) };
    const pos = rebuilt(c, {}, moved)[1];
    const [first] = exportedAxes(c, bolts, [c.build.halves[0], pos]);
    // Read about the planned axis, so the moved hole reads 0.01 off it.
    expect(Math.hypot(first.neg[0] - first.pos[0], first.neg[1] - first.pos[1])).toBeGreaterThan(0.009);
  }, SLOW);
});

/** In a half's pose, the steep area and what of it the top chamfer and the listed bridges hold. */
function poseAudit(c: ClamCase, half: Manifold, sign: 1 | -1): { steep: number; allowed: number; ignored: number } {
  const { rim } = c.build;
  const pose = halfPose(rim, rim.axis, sign);
  const { rotation: [a, b, cc, d, e, f, g, h, i], translation: [tx, ty, tz] } = inversePose(pose);
  const bridges = sign > 0 ? seamBoltBridges(boltsOf(c)) : [];
  const allowed = (x: number, y: number, z: number): boolean => {
    const mx = a * x + b * y + cc * z + tx, my = d * x + e * y + f * z + ty, mz = g * x + h * y + i * z + tz;
    const side = Math.min(mx - rim.O.x0, rim.O.x1 - mx, my - rim.O.y0, rim.O.y1 - my);
    const chamfer = mz >= rim.Zt - rim.topChamfer - 1e-3 && side <= rim.topChamfer + 1e-3;
    return chamfer || onSeamBoltBridge(bridges, rim.axis, mx, my, mz);
  };
  const mesh = orientSolid(arena, half, pose).getMesh();
  const audit = auditOverhang({ positions: mesh.vertProperties, indices: mesh.triVerts }, { allowed });
  return { steep: audit.steepArea, allowed: audit.allowedArea!, ignored: audit.ignoredArea };
}

describe('MP3: print poses with no supports', () => {
  for (const id of IDS) {
    it(`${id}: in each half's pose the steep area is the top chamfer's and the nut slots' bridges, and only pos has bridges`, (ctx) => {
      if (id === 'vis35') skipWithout(ctx, 'vis35');
      const c = caseOf(id);
      const bolts = boltsOf(c);
      for (const sign of [-1, 1] as const) {
        const audit = poseAudit(c, c.build.halves[sign > 0 ? 1 : 0], sign);
        expect(audit.steep, `${sign > 0 ? 'pos' : 'neg'}`).toBeCloseTo(audit.allowed, 6);
        expect(audit.ignored).toBeLessThan(0.05);
      }
      // The bridges are there and listed: pos's allowed area holds each slot's face, about 50 mm2 at M3.
      const pos = poseAudit(c, c.build.halves[1], 1);
      expect(pos.allowed).toBeGreaterThan(bolts.count * 45);
    }, SLOW);
  }

  it('negative controls: a flat lug underside, a counterbore for the countersink and a slot leaving along -h each leave a steep face not allowed', () => {
    const c = caseOf('sphere');
    const over = (halves: [Manifold, Manifold], sign: 1 | -1): number => {
      const audit = poseAudit(c, halves[sign > 0 ? 1 : 0], sign);
      return audit.steep - audit.allowed;
    };
    expect(over(rebuilt(c, { lugs: { flat: true } }), -1)).toBeGreaterThan(10);
    expect(over(rebuilt(c, { lugs: { flat: true } }), 1)).toBeGreaterThan(10);
    expect(over(rebuilt(c, { cuts: { counterbore: true } }), -1)).toBeGreaterThan(10);
    expect(over(rebuilt(c, { cuts: { slotTowardSeam: true } }), 1)).toBeGreaterThan(10);
  }, SLOW);
});

/** The screws as fitted, snug: per pair a countersunk head on neg's cone, the shank across P, and the nut on pos's slot face. */
function screws(bolts: SeamBoltLayout): Manifold[] {
  const { fastener, holeClearance, tn, f, layer } = bolts;
  const head = fastener.headDiameter / 2, shank = fastener.d / 2;
  // A head a clearance smaller than the countersink sits that much deeper in its 45 degree cone, touching it.
  const top = tn - holeClearance, narrow = top - (head - shank);
  const out: Manifold[] = [];
  for (const spot of bolts.spots) {
    const [nu, nv] = lugAxis(bolts, spot, -1);
    const negBack = frameInverse(halfFrame(bolts.axis, bolts.xs, -1));
    // In neg's frame pos's h is -h: the shank stops at the membrane, which it has pierced, and goes on through the nut.
    for (const piece of [column(arena, nu, nv, narrow, top, shank, head), column(arena, nu, nv, -(f - layer), narrow, shank, shank), column(arena, nu, nv, -(f + fastener.nutHeight), -f, shank, shank)]) out.push(orientSolid(arena, piece, negBack));
    const [pu, pv] = lugAxis(bolts, spot, 1);
    const radius = fastener.nutFlats / Math.sqrt(3);
    // A hexagon's corner up and down, its flats against the slot's sides.
    const nut = track(track(track(api.Manifold.cylinder(fastener.nutHeight, radius, radius, 6)).rotate([0, 0, 30])).translate([pu, pv, f]));
    out.push(orientSolid(arena, nut, frameInverse(halfFrame(bolts.axis, bolts.xs, 1))));
  }
  return out;
}

describe('MP3: the pull test with the lugs', () => {
  /** MP2's obstacle, and the other half's lugs, which a half's own must clear as the two part. */
  function obstacle(c: ClamCase, sign: 1 | -1): Manifold {
    const bolts = boltsOf(c);
    const other = c.build.halves[sign > 0 ? 0 : 1];
    const ends = (['b0', 'b1'] as const).map((end) => bolts.spots.find((spot) => spot.end === end)!);
    const lugZones = ends.map((spot) => boxAW(arena, bolts, spot, [c.fine.xs - 500, c.fine.xs + 500], [1e-3, bolts.p + 2], [-500, 500]));
    const otherLugs = lugZones.map((zone) => track(other.intersect(zone)));
    const cutters = c.build.openings.flatMap((opening) => openingCutters(arena, c.build.rim, opening));
    return track(api.Manifold.union([siliconeSolid(arena, c.build, c.model.solid), c.model.solid, c.build.base, ...cutters, ...otherLugs]));
  }

  function meets(c: ClamCase, half: Manifold, sign: 1 | -1, against: Manifold, ds: number[]): number[] {
    const pull: [number, number, number] = c.fine.axis === 'x' ? [sign, 0, 0] : [0, sign, 0];
    return ds.map((d) => vol(track(track(half.translate([pull[0] * d, pull[1] * d, 0])).intersect(against))));
  }

  for (const id of IDS) {
    it(`${id}: each half with its lugs slides off along its pull past the silicone, the model, the base, the cutters and the other half's lugs, meeting at most 1e-3 mm3`, (ctx) => {
      if (id === 'vis35') skipWithout(ctx, 'vis35');
      const c = caseOf(id);
      const { O } = c.build.rim;
      for (const sign of [-1, 1] as const) {
        const depth = c.fine.axis === 'x' ? (sign > 0 ? O.x1 - c.fine.xs : c.fine.xs - O.x0) : sign > 0 ? O.y1 - c.fine.xs : c.fine.xs - O.y0;
        const ds = [0.25, 0.5, 1, 2, 5, 10, 20, depth];
        for (const met of meets(c, c.build.halves[sign > 0 ? 1 : 0], sign, obstacle(c, sign), ds)) expect(met).toBeLessThanOrEqual(NONE);
      }
    }, SLOW);
  }

  it('positive control: the screws in, heads and nuts, block each half at d = 0.25', () => {
    const c = caseOf('sphere');
    const bolts = boltsOf(c);
    const fitted = screws(bolts);
    // Snug, they touch the solids and do not enter them.
    for (const half of c.build.halves) for (const screw of fitted) expect(vol(track(half.intersect(screw)))).toBeLessThanOrEqual(NONE);
    for (const sign of [-1, 1] as const) {
      const against = track(api.Manifold.union([obstacle(c, sign), ...fitted]));
      expect(meets(c, c.build.halves[sign > 0 ? 1 : 0], sign, against, [0.25])[0]).toBeGreaterThan(0.1);
    }
  }, SLOW);

  it('negative control: a pos lug reaching 1 mm across P meets the neg lug, already at rest', () => {
    const c = caseOf('sphere');
    const bolts = boltsOf(c);
    const spot = bolts.spots[0];
    const [, pos] = c.build.halves;
    const reach = boxAW(arena, bolts, spot, [c.fine.xs - 1, c.fine.xs + bolts.relief + 0.01], [0.01, bolts.p], [spot.z - bolts.height / 2, spot.z + bolts.height / 2]);
    const across = track(pos.add(reach));
    // It overlaps the neg lug by about 0.8 mm at d = 0, so it is static interference, which neg and pos apart catches too.
    expect(meets(c, across, 1, obstacle(c, 1), [0])[0]).toBeGreaterThan(1);
    expect(Math.max(...meets(c, across, 1, obstacle(c, 1), [0.25, 0.5]))).toBeGreaterThan(1);
  }, SLOW);

  it('negative control: a pos hook behind the neg lug, clear of it at rest, meets it only as the halves part', () => {
    const c = caseOf('sphere');
    const bolts = boltsOf(c);
    const spot = bolts.spots[0];
    const [, pos] = c.build.halves;
    const { xs } = c.fine;
    const { tn, p } = bolts;
    const z: [number, number] = [spot.z - bolts.height / 2, spot.z + bolts.height / 2];
    // A bar over the neg lug's tip, from pos's lug across P, and a finger down from it behind the neg lug's gusset.
    const back = xs - tn - p - LUG_OVERLAP;
    const bar = boxAW(arena, bolts, spot, [back - 1, xs + bolts.relief + 0.01], [p + 0.01, p + 1], z);
    const finger = boxAW(arena, bolts, spot, [back - 1, back - 0.5], [0.01, p + 1], z);
    const hooked = track(api.Manifold.union([pos, bar, finger]));
    const against = obstacle(c, 1);
    expect(vol(track(hooked.intersect(c.build.halves[0])))).toBeLessThanOrEqual(NONE);
    expect(meets(c, hooked, 1, against, [0])[0]).toBeLessThanOrEqual(NONE);
    expect(Math.max(...meets(c, hooked, 1, against, [1, 2, 5]))).toBeGreaterThan(1);
  }, SLOW);
});
