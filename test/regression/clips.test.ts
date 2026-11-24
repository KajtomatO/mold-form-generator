import { createHash } from 'node:crypto';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertRigid, orientSolid } from '../../src/core/base/orient';
import { frameInverse, halfFrame } from '../../src/core/field/frames';
import { bedFootprint, fastenerGrowth } from '../../src/core/field/side';
import { buildHalves, type ClamshellBuildOptions } from '../../src/core/parts/clamshell';
import { clipPlate, clipSpots, earBedGrowth, earSolids, keyHeight, keyPose, keySection, keySolid, PRY_CLEAR, SOCKET_BACK, SPARES, socketCutters, type ClipLayout, type ClipSpot } from '../../src/core/parts/clips';
import { coverBottom, trimHalf } from '../../src/core/parts/cover';
import { ridgeBars } from '../../src/core/parts/joint';
import { openingCutters } from '../../src/core/parts/openings';
import { halfPose, inversePose, poseToStl } from '../../src/core/parts/poses';
import { seamPins, seamTongue } from '../../src/core/parts/seam';
import { PRY_RUN } from '../../src/core/parts/seamBolts';
import { auditOverhang } from '../../src/core/report/overhang';
import { Arena, withArena } from '../../src/core/solid/arena';
import { countHandles } from '../fixtures/handles';
import { clamCase, siliconeSolid, type ClamCase } from '../fixtures/clamshell';
import { loadManifold, skipWithout } from '../fixtures/loadExamples';
import { unpose } from '../fixtures/solidChecks';
import { box as boxMesh } from '../fixtures/synthetic';
import { CLAMSHELL_BOLTS_GOLDEN, CLAMSHELL_PARTS_GOLDEN } from './golden';

/**
 * MP3b: G13.10.16's seam clips built (docs/PLAN.md, MP3b's checks; G13.10.20): the ears and sockets on each half, read
 * off the solids and the exported STLs, the keys at home, seated and bottomed, the plate, the audit and the pull test with
 * the ears and with the keys in, and the bytes of the other fasteners kept. On the gallery's sphere and the Goddess
 * Statue always, VIS-35 where it is in this checkout; the negative controls on the sphere, whose halves build in about a
 * second. The coupon's are test/unit/fitTest.test.ts's, the rows' and the hold's test/unit/clips.test.ts's.
 */
const SLOW = 900_000;
/** What a boolean of touching solids may leave as volume, in mm3: the plan's bound. */
const NONE = 1e-3;

let api: ManifoldToplevel;
let arena: Arena;
const cases = new Map<string, ClamCase>();
const IDS = ['sphere', 'goddess', 'vis35'] as const;
/** G13.10.17's table at beta 20: rows on each end face. */
const ROWS: Record<(typeof IDS)[number], number> = { sphere: 2, goddess: 3, vis35: 4 };

function caseOf(id: string, fastener: 'clips' | 'none' | 'bolts' = 'clips'): ClamCase {
  const key = `${id} ${fastener}`;
  let found = cases.get(key);
  if (!found) {
    found = clamCase(arena, id, (p) => (p.clamshell.fastener = fastener));
    cases.set(key, found);
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
const clipsOf = (c: ClamCase): ClipLayout => c.build.clips!;
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The halves again from the case's tools and seal, with the ears changed or another layout: the negative controls. */
function rebuilt(c: ClamCase, options: Pick<ClamshellBuildOptions, 'ears'>, clips = clipsOf(c)): [Manifold, Manifold] {
  const { rim, tools, seal, openings } = c.build;
  return buildHalves(arena, rim, tools, seal, c.params, openings, null, clips, options).halves;
}

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Manifold {
  return track(track(api.Manifold.cube([x1 - x0, y1 - y0, z1 - z0])).translate([x0, y0, z0]));
}

/** O's box over the cover's height, a hair past it each way. */
function boxO(c: ClamCase): Manifold {
  const { O, Zt } = c.build.rim;
  return box(O.x0, O.y0, coverBottom(c.build.rim) - 1, O.x1, O.y1, Zt + 1);
}

/** A box in mold coordinates over a' = sign (a - xs) in [p0, p1] of one half, w out from a spot's end face in [w0, w1], z in [z0, z1]. */
function boxAW(c: ClamCase, spot: ClipSpot, sign: 1 | -1, ap: [number, number], w: [number, number], z: [number, number]): Manifold {
  const clips = clipsOf(c);
  const as = [clips.xs + sign * ap[0], clips.xs + sign * ap[1]].sort((p, q) => p - q);
  const bs = (spot.end === 'b1' ? [clips.ends[1] + w[0], clips.ends[1] + w[1]] : [clips.ends[0] - w[1], clips.ends[0] - w[0]]).sort((p, q) => p - q);
  return clips.axis === 'x' ? box(as[0], bs[0], z[0], as[1], bs[1], z[1]) : box(bs[0], as[0], z[0], bs[1], as[1], z[1]);
}

/** Along a, the least and the most of a solid. */
function aSpan(c: ClamCase, m: Manifold): [number, number] {
  const b = m.boundingBox();
  const k = c.fine.axis === 'x' ? 0 : 1;
  return [b.min[k], b.max[k]];
}

/** Every key at home, or `travel` past it, in the mold. */
function keysIn(c: ClamCase, travel = 0, clips = clipsOf(c)): Manifold[] {
  const key = keySolid(arena, clips);
  return clipSpots(clips).map((spot) => orientSolid(arena, key, keyPose(clips, spot, travel)));
}

describe('MP3b: the ears and sockets', () => {
  for (const id of IDS) {
    it(`${id}: valid halves of one shell, neg and pos apart, outside O only the ears, at z >= z_lo, and inside O the halves with no fasteners`, (ctx) => {
      if (id === 'vis35') skipWithout(ctx, 'vis35');
      const c = caseOf(id);
      const clips = clipsOf(c);
      expect(clips.placed.length).toBe(ROWS[id]);
      expect(c.build.bolts).toBe(null);
      expect(c.build.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
      const [neg, pos] = c.build.halves;
      for (const half of [neg, pos]) {
        expect(half.status()).toBe('NoError');
        expect(half.decompose().length).toBe(1);
      }
      expect(vol(track(neg.intersect(pos)))).toBeLessThanOrEqual(NONE);
      const bare = caseOf(id, 'none').build.halves;
      expect(caseOf(id, 'none').fine.xs).toBe(c.fine.xs);
      for (const [k, sign] of [[0, -1], [1, 1]] as const) {
        const half = c.build.halves[k];
        const ears = track(api.Manifold.union(earSolids(arena, clips, sign)));
        const outside = track(half.subtract(boxO(c)));
        // Each ear less its socket outside O, about 1.6 cm3 at the defaults.
        expect(vol(outside) / (clips.count)).toBeGreaterThan(1000);
        expect(outside.boundingBox().min[2]).toBeGreaterThanOrEqual(clips.zLow - 1e-6);
        expect(outside.boundingBox().max[2]).toBeLessThanOrEqual(clips.zHigh + 1e-6);
        expect(vol(track(outside.subtract(ears)))).toBeLessThanOrEqual(NONE);
        // Inside O, the half with clips is the half with None: their symmetric difference there is nothing.
        const inside = track(half.intersect(boxO(c))), none = track(bare[k].intersect(boxO(c)));
        expect(vol(track(inside.subtract(none))) + vol(track(none.subtract(inside)))).toBeLessThanOrEqual(NONE);
        // Every socket lies outside O, from SOCKET_BACK out, and above z_lo.
        for (const socket of socketCutters(arena, clips, sign)) {
          expect(vol(track(socket.intersect(boxO(c))))).toBeLessThanOrEqual(NONE);
          expect(socket.boundingBox().min[2]).toBeGreaterThanOrEqual(clips.zLow - 1e-6);
        }
      }
    }, SLOW);

    it(`${id}: each half's extent along b is O's and 2 Le, the bed filter's, its height the footprint's, and every ear's tip at Le`, (ctx) => {
      if (id === 'vis35') skipWithout(ctx, 'vis35');
      const c = caseOf(id);
      const clips = clipsOf(c);
      const { rim } = c.build;
      const kb = c.fine.axis === 'x' ? 1 : 0;
      const bed = bedFootprint(rim, c.fine.axis, c.fine.xs, fastenerGrowth(c.params));
      expect(fastenerGrowth(c.params)).toBe(earBedGrowth(clips));
      for (const [k, sign] of [[0, -1], [1, 1]] as const) {
        const half = c.build.halves[k];
        const b = half.boundingBox();
        expect(b.min[kb]).toBeCloseTo(clips.ends[0] - clips.earLength, 6);
        expect(b.max[kb]).toBeCloseTo(clips.ends[1] + clips.earLength, 6);
        expect(b.max[kb] - b.min[kb]).toBeCloseTo(bed.width, 6);
        expect(b.max[2] - b.min[2]).toBeCloseTo(bed.length, 6);
        for (const spot of clipSpots(clips)) {
          const ear = track(half.intersect(boxAW(c, spot, sign, [-1, 100], [0.01, 50], [spot.z - clips.height / 2 - 0.9, spot.z + clips.height / 2 + 0.9]))).boundingBox();
          expect(ear.max[2] - ear.min[2]).toBeCloseTo(clips.height, 6);
          expect((ear.max[2] + ear.min[2]) / 2).toBeCloseTo(spot.z, 6);
        }
      }
    }, SLOW);

    it(`${id}: each pair's ears 2r apart, while the halves' seam faces meet in P`, (ctx) => {
      if (id === 'vis35') skipWithout(ctx, 'vis35');
      const c = caseOf(id);
      const clips = clipsOf(c);
      const { xs } = c.fine;
      const [neg, pos] = c.build.halves;
      for (const spot of clipSpots(clips)) {
        const zone = (sign: 1 | -1): Manifold => boxAW(c, spot, sign, [-1, 100], [0.01, 50], [spot.z - clips.height / 2 - 0.9, spot.z + clips.height / 2 + 0.9]);
        expect(aSpan(c, track(neg.intersect(zone(-1))))[1]).toBeCloseTo(xs - clips.relief, 4);
        expect(aSpan(c, track(pos.intersect(zone(1))))[0]).toBeCloseTo(xs + clips.relief, 4);
      }
      const added = track(api.Manifold.union([seamTongue(arena, c.build.seal, c.params), ...seamPins(arena, c.build.seal)]));
      const past = (sign: 1 | -1): Manifold => track(trimHalf(arena, boxO(c), c.fine.axis, xs, sign));
      expect(vol(track(api.Manifold.difference([track(neg.intersect(past(1))), added])))).toBeLessThanOrEqual(NONE);
      expect(vol(track(pos.intersect(past(-1))))).toBeLessThanOrEqual(NONE);
    }, SLOW);
  }

  it('negative control: with no relief the ears of a pair touch in P', () => {
    const c = caseOf('sphere');
    const clips = clipsOf(c);
    const [neg, pos] = rebuilt(c, { ears: { relief: false } });
    const [spot] = clipSpots(clips);
    const zone = boxAW(c, spot, 1, [-100, 100], [0.01, 50], [spot.z - 20, spot.z + 20]);
    const gap = aSpan(c, track(pos.intersect(zone)))[0] - aSpan(c, track(neg.intersect(zone)))[1];
    expect(gap).toBeLessThan(1e-6);
  }, SLOW);
});

/**
 * A half's socket, read from its STL with the pose undone: the section at a' = r + d/2, from P, of the ear's zone less the
 * half, from inside the socket's bottom (w = SOCKET_BACK) out to the ear's tip, as (b, z) bounds and area. Read in the half's pull frame, where a layer of the pose is a plane of h.
 */
function socketRead(c: ClamCase, half: Manifold, sign: 1 | -1, spot: ClipSpot): { b: [number, number]; z: [number, number]; area: number } {
  const clips = clipsOf(c);
  const { rim } = c.build;
  const pose = halfPose(rim, rim.axis, sign);
  const back = unpose(arena, poseToStl(api, half, pose), pose);
  const zone = boxAW(c, spot, sign, [clips.relief - 0.5, clips.relief + clips.depth + 0.5], [0.1, clips.earLength - 0.1], [spot.z - clips.height / 2 + 0.2, spot.z + clips.height / 2 - 0.2]);
  const hole = track(zone.subtract(back));
  const frame = halfFrame(rim.axis, rim.xs, sign);
  const section = track(orientSolid(arena, hole, frame).slice(clips.relief + clips.depth / 2));
  const bounds = section.bounds();
  // The frame's u is b with an x seam on the + side and -b on the - side, and the reverse with a y seam.
  const flip = (rim.axis === 'x') === (sign > 0) ? 1 : -1;
  const us = [bounds.min[0] * flip, bounds.max[0] * flip].sort((p, q) => p - q) as [number, number];
  return { b: us, z: [bounds.min[1], bounds.max[1]], area: section.area() };
}

describe('MP3b: the sockets line up, from the exported STLs', () => {
  for (const id of IDS) {
    it(`${id}: with the poses undone, the neg and pos sockets' sections coincide in (b, z) within 1e-3 mm for every row`, (ctx) => {
      if (id === 'vis35') skipWithout(ctx, 'vis35');
      const c = caseOf(id);
      const clips = clipsOf(c);
      for (const spot of clipSpots(clips)) {
        const n = socketRead(c, c.build.halves[0], -1, spot), p = socketRead(c, c.build.halves[1], 1, spot);
        expect(n.area).toBeGreaterThan(30);
        for (const k of [0, 1]) {
          expect(Math.abs(n.b[k] - p.b[k])).toBeLessThanOrEqual(1e-3);
          expect(Math.abs(n.z[k] - p.z[k])).toBeLessThanOrEqual(1e-3);
        }
        expect(Math.abs(n.area - p.area)).toBeLessThanOrEqual(1e-2);
        expect((p.z[0] + p.z[1]) / 2).toBeCloseTo(spot.z, 3);
      }
    }, SLOW);
  }

  it('negative control: neg\'s ears and sockets 0.01 mm up put its sockets off pos\'s', () => {
    const c = caseOf('sphere');
    const clips = clipsOf(c);
    const moved: ClipLayout = { ...clips, zs: clips.zs.map((z) => z + 0.01) };
    const neg = rebuilt(c, {}, moved)[0];
    const [spot] = clipSpots(clips);
    const n = socketRead(c, neg, -1, spot), p = socketRead(c, c.build.halves[1], 1, spot);
    expect(Math.abs(n.z[0] - p.z[0])).toBeGreaterThan(0.009);
  }, SLOW);
});

describe('MP3b: the keys', () => {
  for (const id of IDS) {
    it(`${id}: at home every key is clear of both halves by the clearance; seated it touches both flares of each half at once, and not 0.05 mm before; bottomed its tip is at the socket's bottom and its head 2 mm off the ears`, (ctx) => {
      if (id === 'vis35') skipWithout(ctx, 'vis35');
      const c = caseOf(id);
      const clips = clipsOf(c);
      const [neg, pos] = c.build.halves;
      const home = keysIn(c, 0), seated = keysIn(c, clips.key.seatTravel), bottomed = keysIn(c, clips.key.travelIn);
      const short = keysIn(c, clips.key.seatTravel - 0.05);
      clipSpots(clips).forEach((spot, k) => {
        for (const [half, sign] of [[neg, -1], [pos, 1]] as const) {
          expect(vol(track(home[k].intersect(half))), 'home').toBeLessThanOrEqual(NONE);
          // The gap square to each flare is the clearance.
          expect(Math.abs(home[k].minGap(half, 1) - clips.clearance), 'home gap').toBeLessThanOrEqual(1e-3);
          expect(vol(track(seated[k].intersect(half))), 'seated').toBeLessThanOrEqual(NONE);
          // Seated, the key touches the upper and the lower flare of each half, read off the half with its mouth edges
          // (at r from P) and its socket floor (0.5 past the anchors) left out, so contact at the edges alone fails.
          for (const z of [[spot.z, spot.z + 20], [spot.z - 20, spot.z]] as [number, number][]) {
            const flare = track(half.intersect(boxAW(c, spot, sign, [clips.relief + 0.3, clips.key.anchor + 0.25], [0, clips.earLength + 1], z)));
            const which = `flare ${sign} ${z[0] < spot.z ? 'below' : 'above'}`;
            expect(seated[k].minGap(flare, 1), `seated, ${which}`).toBeLessThanOrEqual(1e-3);
            expect(Math.abs(short[k].minGap(flare, 1) - 0.05 * clips.key.perMmPerSide), `short, ${which}`).toBeLessThanOrEqual(5e-4);
          }
          // 0.05 mm short of the seat the gap is still open, by what 0.05 mm of push closes per side.
          expect(Math.abs(short[k].minGap(half, 1) - 0.05 * clips.key.perMmPerSide), 'short of the seat').toBeLessThanOrEqual(5e-4);
        }
        // The anchors stop KEY_FLOOR_GAP short of each floor: along a the key reaches r + d - 0.5 from P each way.
        const [a0, a1] = aSpan(c, track(home[k].intersect(boxAW(c, spot, 1, [-50, 50], [0, clips.earLength], [spot.z - 20, spot.z + 20]))));
        expect(c.fine.xs + clips.relief + clips.depth - a1, 'floor').toBeCloseTo(0.5, 6);
        expect(a0 - (c.fine.xs - clips.relief - clips.depth), 'floor').toBeCloseTo(0.5, 6);
        // Bottomed, the tip stands at the socket's bottom, SOCKET_BACK out from the end face, and nothing past the anchors
        // comes within 2 mm of the ears' tip.
        const kb = clips.axis === 'x' ? 1 : 0, kbox = bottomed[k].boundingBox();
        const tipW = spot.end === 'b1' ? kbox.min[kb] - clips.ends[1] : clips.ends[0] - kbox.max[kb];
        expect(tipW, 'bottomed').toBeCloseTo(SOCKET_BACK, 6);
        const head = boxAW(c, spot, 1, [clips.key.anchor + 0.05, 50], [-1, clips.earLength + 2 - 1e-3], [spot.z - 20, spot.z + 20]);
        const headNeg = boxAW(c, spot, -1, [clips.key.anchor + 0.05, 50], [-1, clips.earLength + 2 - 1e-3], [spot.z - 20, spot.z + 20]);
        expect(vol(track(bottomed[k].intersect(head))) + vol(track(bottomed[k].intersect(headNeg)))).toBeLessThanOrEqual(NONE);
      });
    }, SLOW);
  }

  it('the home line lies at u = 6.5 on both anchor faces, the double groove with single marks 1 mm apart either side', () => {
    const clips = clipsOf(caseOf('sphere'));
    const key = keySolid(arena, clips);
    const mesh = key.getMesh();
    const T = keyHeight(clips), A = clips.key.anchor;
    for (const side of [1, -1]) {
      // Each groove's floor ends at x = +-(A - MARK_SIZE): its z there is the groove's lower edge.
      const zs = new Set<number>();
      for (let v = 0; v < mesh.vertProperties.length; v += 3) {
        if (Math.abs(mesh.vertProperties[v] - side * (A - 0.4)) < 1e-4) zs.add(Math.round(mesh.vertProperties[v + 2] * 1e4) / 1e4);
      }
      const us = [...zs].map((z) => Number((T - z - 0.2).toFixed(4))).sort((p, q) => p - q);
      expect(us).toEqual([3.5, 4.5, 5.5, 6.2, 6.8, 7.5, 8.5, 9.5]);
      expect((us[3] + us[4]) / 2).toBeCloseTo(clips.key.homeLine, 9);
    }
  });

  it('the plate: count + 2 keys, each a closed solid standing on its head, nothing steeper than the 45 degree limit; the layers are the bowtie\'s sections; every key pose rigid', () => {
    const c = caseOf('sphere');
    const clips = clipsOf(c);
    const plate = clipPlate(arena, clips);
    const keys = plate.decompose();
    keys.forEach((key) => track(key));
    expect(keys.length).toBe(clips.count + SPARES);
    const one = keySolid(arena, clips);
    for (const key of keys) {
      expect(key.status()).toBe('NoError');
      expect(key.genus()).toBe(0);
      expect(key.boundingBox().min[2]).toBeCloseTo(0, 9);
      expect(key.volume()).toBeCloseTo(one.volume(), 6);
    }
    // About 0.8 cm3, 1 g of PLA.
    expect(one.volume()).toBeGreaterThan(700);
    expect(one.volume()).toBeLessThan(900);
    const mesh = plate.getMesh();
    const audit = auditOverhang({ positions: mesh.vertProperties, indices: mesh.triVerts });
    expect(audit.steepArea).toBe(0);
    expect(audit.ignoredArea).toBeLessThan(0.05);
    // The neck's section is in the layer plane: a slice of the key at a height away from the marks is the bowtie at that u.
    const T = keyHeight(clips);
    for (const u of [1, 2.9, 10.6]) {
      const s = keySection(clips, u);
      const t = Math.tan(clips.flareDeg * Math.PI / 180);
      // The bowtie's area: the neck across the 2r gap, and each anchor a trapezoid from the neck to the far width.
      const inner = clips.relief;
      const area = 2 * inner * 2 * s.neck + 2 * (s.x - inner) * (s.neck + s.y);
      expect(s.y - s.neck).toBeCloseTo((s.x - inner) * t, 9);
      expect(track(one.slice(T - u)).area()).toBeCloseTo(area, 3);
    }
    for (const spot of clipSpots(clips)) for (const travel of [0, clips.key.seatTravel, clips.key.travelIn]) expect(() => assertRigid(keyPose(clips, spot, travel))).not.toThrow();
  }, SLOW);
});

/** In a half's pose, the steep area and what of it the top chamfer holds. */
function poseAudit(c: ClamCase, half: Manifold, sign: 1 | -1): { steep: number; allowed: number; ignored: number; worst: number } {
  const { rim } = c.build;
  const pose = halfPose(rim, rim.axis, sign);
  const { rotation: [a, b, cc, d, e, f, g, h, i], translation: [tx, ty, tz] } = inversePose(pose);
  const allowed = (x: number, y: number, z: number): boolean => {
    const mx = a * x + b * y + cc * z + tx, my = d * x + e * y + f * z + ty, mz = g * x + h * y + i * z + tz;
    const side = Math.min(mx - rim.O.x0, rim.O.x1 - mx, my - rim.O.y0, rim.O.y1 - my);
    return mz >= rim.Zt - rim.topChamfer - 1e-3 && side <= rim.topChamfer + 1e-3;
  };
  const mesh = orientSolid(arena, half, pose).getMesh();
  const audit = auditOverhang({ positions: mesh.vertProperties, indices: mesh.triVerts }, { allowed });
  return { steep: audit.steepArea, allowed: audit.allowedArea!, ignored: audit.ignoredArea, worst: audit.worstDeg };
}

describe('MP3b: print poses with no supports', () => {
  for (const id of IDS) {
    it(`${id}: in each half's pose the steep area is the top chamfer's alone, as with no fasteners, and there are no bridges`, (ctx) => {
      if (id === 'vis35') skipWithout(ctx, 'vis35');
      const c = caseOf(id);
      const bare = caseOf(id, 'none');
      for (const [k, sign] of [[0, -1], [1, 1]] as const) {
        const audit = poseAudit(c, c.build.halves[k], sign);
        expect(audit.steep, `${sign > 0 ? 'pos' : 'neg'}`).toBeCloseTo(audit.allowed, 6);
        expect(audit.steep).toBeCloseTo(poseAudit(bare, bare.build.halves[k], sign).steep, 6);
        expect(audit.ignored).toBeLessThan(0.05);
      }
    }, SLOW);
  }

  it('negative controls: a corbel at 50 degrees from vertical, a flare at 50 and a male dovetail ear each leave a steep face not allowed', () => {
    const c = caseOf('sphere');
    const over = (halves: [Manifold, Manifold], sign: 1 | -1): number => {
      const audit = poseAudit(c, halves[sign > 0 ? 1 : 0], sign);
      return audit.steep - audit.allowed;
    };
    for (const ears of [{ corbelDeg: 50 }, { flareDeg: 50 }, { male: true }]) {
      const halves = rebuilt(c, { ears });
      for (const sign of [-1, 1] as const) expect(over(halves, sign), JSON.stringify(ears)).toBeGreaterThan(10);
    }
  }, SLOW);
});

describe('MP3b: the pull test with the ears', () => {
  /** The other half's ears: all of it past its end faces. */
  function otherEars(c: ClamCase, sign: 1 | -1): Manifold {
    const clips = clipsOf(c);
    const other = c.build.halves[sign > 0 ? 0 : 1];
    const ends = clipSpots(clips).filter((spot, k, all) => all.findIndex((s) => s.end === spot.end) === k);
    const zones = ends.map((spot) => boxAW(c, spot, (-sign) as 1 | -1, [-1, 100], [1e-3, 50], [-500, 500]));
    return track(api.Manifold.union(zones.map((zone) => track(other.intersect(zone)))));
  }

  /** MP2's obstacle, and the other half's ears, which a half's own must clear as the two part. */
  function obstacle(c: ClamCase, sign: 1 | -1): Manifold {
    const cutters = c.build.openings.flatMap((opening) => openingCutters(arena, c.build.rim, opening));
    return track(api.Manifold.union([siliconeSolid(arena, c.build, c.model.solid), c.model.solid, c.build.base, ...cutters, otherEars(c, sign)]));
  }

  function meets(c: ClamCase, half: Manifold, sign: 1 | -1, against: Manifold, ds: number[], b = 0): number[] {
    const pull: [number, number, number] = c.fine.axis === 'x' ? [sign, 0, 0] : [0, sign, 0];
    const across: [number, number, number] = c.fine.axis === 'x' ? [0, b, 0] : [b, 0, 0];
    return ds.map((d) => vol(track(track(half.translate([pull[0] * d + across[0], pull[1] * d + across[1], 0])).intersect(against))));
  }

  for (const id of IDS) {
    it(`${id}: each half with its ears slides off along its pull past the silicone, the model, the base, the cutters and the other half's ears, and at b -+ cG past the bars and those ears, meeting at most 1e-3 mm3`, (ctx) => {
      if (id === 'vis35') skipWithout(ctx, 'vis35');
      const c = caseOf(id);
      const { O } = c.build.rim;
      const cG = c.params.joint.grooveClearance;
      for (const sign of [-1, 1] as const) {
        const depth = c.fine.axis === 'x' ? (sign > 0 ? O.x1 - c.fine.xs : c.fine.xs - O.x0) : sign > 0 ? O.y1 - c.fine.xs : c.fine.xs - O.y0;
        const ds = [0.25, 0.5, 1, 2, 5, 10, 20, depth];
        const half = c.build.halves[sign > 0 ? 1 : 0];
        for (const met of meets(c, half, sign, obstacle(c, sign), ds)) expect(met).toBeLessThanOrEqual(NONE);
        // Guided by the ridge bars anywhere in the groove's play, as MP2's test has it, the ears still clear the other half's.
        const guides = track(api.Manifold.union([ridgeBars(arena, c.build.rim, c.fine.axis), otherEars(c, sign)]));
        for (const b of [-cG, cG]) for (const met of meets(c, half, sign, guides, ds, b)) expect(met).toBeLessThanOrEqual(NONE);
      }
    }, SLOW);
  }

  it('positive control: the keys at home block each half at d = 0.25', () => {
    const c = caseOf('sphere');
    const keys = keysIn(c);
    for (const sign of [-1, 1] as const) {
      const against = track(api.Manifold.union([obstacle(c, sign), ...keys]));
      expect(meets(c, c.build.halves[sign > 0 ? 1 : 0], sign, against, [0.25])[0]).toBeGreaterThan(0.1);
    }
  }, SLOW);

  it('negative control: a pos ear reaching 0.5 mm across P meets the neg ear at rest and as it slides', () => {
    const c = caseOf('sphere');
    const clips = clipsOf(c);
    const [spot] = clipSpots(clips);
    const reach = boxAW(c, spot, 1, [-0.5, clips.relief + 0.01], [0.01, clips.earLength], [spot.z - clips.height / 2, spot.z + clips.height / 2]);
    const across = track(c.build.halves[1].add(reach));
    expect(meets(c, across, 1, obstacle(c, 1), [0])[0]).toBeGreaterThan(1);
    expect(Math.max(...meets(c, across, 1, obstacle(c, 1), [0.25]))).toBeGreaterThan(1);
  }, SLOW);
});

describe('MP3b: what the clips leave as it was', () => {
  it('Seam fasteners None is MP2\'s golden of Goddess byte for byte, and Bolts MP3\'s halves of Goddess and the sphere', (ctx) => {
    skipWithout(ctx, 'goddess');
    const none = caseOf('goddess', 'none');
    const { rim } = none.build;
    const stl = (c: ClamCase): { neg: string; pos: string } => ({ neg: sha(poseToStl(api, c.build.halves[0], halfPose(c.build.rim, c.build.rim.axis, -1))), pos: sha(poseToStl(api, c.build.halves[1], halfPose(c.build.rim, c.build.rim.axis, 1))) });
    expect([rim.axis, rim.xs]).toEqual([CLAMSHELL_PARTS_GOLDEN.goddess.axis, CLAMSHELL_PARTS_GOLDEN.goddess.xs]);
    expect(stl(none)).toEqual(CLAMSHELL_PARTS_GOLDEN.goddess.sha256);
    for (const id of ['goddess', 'sphere'] as const) {
      const bolted = caseOf(id, 'bolts');
      const g = CLAMSHELL_BOLTS_GOLDEN[id];
      expect([bolted.fine.axis, bolted.fine.xs]).toEqual([g.axis, g.xs]);
      expect(bolted.build.clips).toBe(null);
      expect(stl(bolted)).toEqual(g.sha256);
    }
  }, SLOW);
});

/**
 * Settings off their usual values build with a line, never a throw (MP3's review found a throw on a screw off its range):
 * the clearance at both ends of its range, a 0.8 mm nozzle, 0.3 mm layers, more rows than fit, the Goddess at its
 * least Top cap, and a 10 mm cube, too low for a row of ears.
 */
const OFF_RANGE: { name: string; source: string | 'coupon'; change: (p: ClamCase['params']) => void; codes: string[] }[] = [
  { name: 'Clip clearance 0', source: 'sphere', change: (p) => (p.clips.clearance = 0), codes: [] },
  { name: 'Clip clearance 0.5', source: 'sphere', change: (p) => (p.clips.clearance = 0.5), codes: [] },
  { name: 'a 0.8 mm nozzle', source: 'sphere', change: (p) => (p.print.nozzle = 0.8), codes: ['clips-single'] },
  { name: '0.3 mm layers', source: 'sphere', change: (p) => (p.print.layerHeight = 0.3), codes: [] },
  { name: 'Clip rows 8', source: 'sphere', change: (p) => (p.clips.rows = 8), codes: ['clips-rows-lowered'] },
  { name: 'a 10 mm cube', source: 'coupon', change: () => {}, codes: ['clips-no-room'] },
];

describe('MP3b: settings off the usual range', () => {
  for (const { name, source, change, codes } of OFF_RANGE) {
    it(`${name}: the halves build, valid and apart, with ${codes.length > 0 ? codes.join(', ') : 'no line'}`, () => {
      const mesh = source === 'coupon' ? boxMesh([-5, -5, 0], [5, 5, 10]) : source;
      const c = clamCase(arena, mesh, (p) => {
        p.clamshell.fastener = 'clips';
        change(p);
      });
      const clips = clipsOf(c);
      expect(c.build.diagnostics.filter((d) => d.code.startsWith('clips-')).map((d) => d.code)).toEqual(codes);
      const [neg, pos] = c.build.halves;
      for (const half of [neg, pos]) {
        expect(half.status()).toBe('NoError');
        expect(half.decompose().length).toBe(1);
      }
      expect(vol(track(neg.intersect(pos)))).toBeLessThanOrEqual(NONE);
      if (clips.zs.length === 0) {
        // No row: the halves are the ones with no fasteners.
        const bare = clamCase(arena, mesh, () => {});
        expect(vol(neg)).toBeCloseTo(vol(bare.build.halves[0]), 6);
        return;
      }
      const keys = keysIn(c);
      for (const key of keys) {
        expect(key.status()).toBe('NoError');
        for (const half of [neg, pos]) {
          expect(vol(track(key.intersect(half)))).toBeLessThanOrEqual(NONE);
          expect(Math.abs(key.minGap(half, 1) - clips.clearance)).toBeLessThanOrEqual(1e-3);
        }
      }
      for (const [k, sign] of [[0, -1], [1, 1]] as const) {
        const audit = poseAudit(c, c.build.halves[k], sign);
        expect(audit.steep).toBeCloseTo(audit.allowed, 6);
      }
      // The top row keeps PRY_CLEAR under the pry chamfers.
      expect(Math.max(...clips.zs) + clips.height / 2).toBeLessThanOrEqual(c.build.rim.Zt - PRY_RUN - PRY_CLEAR + 1e-9);
    }, SLOW);
  }
});

describe('MP3b: handles', () => {
  it('a clipped mold, its keys and its plate free every Manifold and CrossSection', async () => {
    const counted = await loadManifold();
    const ledger = countHandles(counted);
    withArena(counted, (inner) => {
      const c = clamCase(inner, 'sphere', (p) => (p.clamshell.fastener = 'clips'));
      const clips = c.build.clips!;
      buildHalves(inner, c.build.rim, c.build.tools, c.build.seal, c.params, c.build.openings, null, clips);
      clipPlate(inner, clips);
      for (const spot of clipSpots(clips)) orientSolid(inner, keySolid(inner, clips), keyPose(clips, spot));
      for (const sign of [-1, 1] as const) {
        earSolids(inner, clips, sign, { male: true });
        socketCutters(inner, clips, sign, { flareDeg: 50 });
      }
      // The pull frame's inverse turns a section back, as the alignment check does.
      orientSolid(inner, c.build.halves[1], frameInverse(halfFrame(clips.axis, clips.xs, 1)));
    });
    expect(ledger.created()).toBeGreaterThan(100);
    expect(ledger.live()).toEqual([]);
  }, SLOW);
});
