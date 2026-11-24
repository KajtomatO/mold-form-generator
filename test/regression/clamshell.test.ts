import { createHash } from 'node:crypto';
import type { CrossSection, Manifold, ManifoldToplevel } from 'manifold-3d';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orientSolid } from '../../src/core/base/orient';
import { clamshellG4, G4_RAISE_EXTRA, gapSearch } from '../../src/core/parts/clamshell';
import { buildClamCommon, pryChamfers, trimHalf } from '../../src/core/parts/cover';
import { OPENING_SEGMENTS, openingCutters } from '../../src/core/parts/openings';
import { PIN_RADIUS, seamGroove, seamPins, seamSockets, seamTongue, SOCKET_CLEARANCE } from '../../src/core/parts/seam';
import { halfPose, inversePose, poseToStl } from '../../src/core/parts/poses';
import { grooveSolid, ridgeBars } from '../../src/core/parts/joint';
import { auditOverhang } from '../../src/core/report/overhang';
import { Arena } from '../../src/core/solid/arena';
import { clamCase, seamOpening, seamOpenings, siliconeSolid, type ClamCase } from '../fixtures/clamshell';
import { loadManifold, skipWithout } from '../fixtures/loadExamples';
import { CLAMSHELL_PARTS_GOLDEN } from './golden';

/**
 * MP2: G13.7 to G13.9 and G13.12 on real models, built with Seam fasteners None and the openings MP4 places on P (docs/PLAN.md,
 * MP2's and MP4's checks; seamOpenings in test/fixtures/clamshell.ts). The gallery's cube, sphere and cone and the Goddess
 * Statue always, VIS-35 where it is in this checkout.
 */
const SLOW = 900_000;
/** What a boolean of touching solids may leave as volume, in mm3: the plan's bound. */
const NONE = 1e-3;

let api: ManifoldToplevel;
let arena: Arena;
const cases = new Map<string, ClamCase>();
const IDS = ['sphere', 'cube', 'cone', 'goddess'] as const;

function caseOf(id: string): ClamCase {
  let found = cases.get(id);
  if (!found) {
    found = clamCase(arena, id);
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

/** The unit vector of a half's pull: +a for pos, -a for neg. */
function pull(c: ClamCase, sign: 1 | -1): [number, number, number] {
  return c.fine.axis === 'x' ? [sign, 0, 0] : [0, sign, 0];
}

/** The unit vector across the pull, along b. */
function across(c: ClamCase): [number, number, number] {
  return c.fine.axis === 'x' ? [0, 1, 0] : [1, 0, 0];
}

const scaled = (v: [number, number, number], d: number): [number, number, number] => [v[0] * d, v[1] * d, v[2] * d];

/** A half's section a hair off P on its own side, in the seam frame's (u, v). */
function faceOf(c: ClamCase, half: Manifold, sign: 1 | -1): CrossSection {
  return arena.track(orientSolid(arena, half, c.build.seal.frame).slice(sign * 0.01));
}

describe('MP2: the halves', () => {
  for (const id of IDS) {
    it(`${id}: each half a valid manifold of one shell, neg and pos apart, and the raw halves with the cavity the block`, () => {
      const c = caseOf(id);
      const [neg, pos] = c.build.halves;
      for (const half of [neg, pos]) {
        expect(half.status()).toBe('NoError');
        expect(vol(half)).toBeGreaterThan(0);
        expect(half.decompose().length).toBe(1);
      }
      expect(vol(track(neg.intersect(pos)))).toBeLessThanOrEqual(NONE);
      // Before the seal and the openings: the block less the rebate and groove, trimmed at P, is the two halves and the cavity.
      const { rim, tools } = c.build;
      const common = buildClamCommon(arena, rim);
      const raw = [track(trimHalf(arena, common, rim.axis, rim.xs, -1).subtract(tools[0])), track(trimHalf(arena, common, rim.axis, rim.xs, 1).subtract(tools[1]))];
      // The tools reach under z = 0 only inside D, where the rebate has taken the block away, so the cavity is the silicone's solid.
      const cavity = track(common.intersect(siliconeSolid(arena, c.build, null)));
      expect(vol(track(raw[0].intersect(raw[1])))).toBeLessThanOrEqual(NONE);
      const whole = track(api.Manifold.union([raw[0], raw[1], cavity]));
      expect(Math.abs(vol(whole) - vol(common))).toBeLessThanOrEqual(NONE * 10);
      expect(vol(track(common.subtract(whole)))).toBeLessThanOrEqual(NONE * 10);
      // The final halves: the block is the two, the cavity, the seam groove's void (on pos's side, with the ring under its
      // legs), the sockets' clearance, the openings' cutters and the pry chamfers, and only the tongue and the pins stand
      // past it. The groove's void holds nothing of either half but the tongue.
      const { seal, openings } = c.build;
      const groove = trimHalf(arena, seamGroove(arena, seal), rim.axis, rim.xs, 1);
      const sockets = seamSockets(arena, seal).map((socket) => trimHalf(arena, socket, rim.axis, rim.xs, 1));
      const cutters = openings.flatMap((opening) => openingCutters(arena, rim, opening));
      const added = track(api.Manifold.union([seamTongue(arena, seal, c.params), ...seamPins(arena, seal)]));
      const halves = track(neg.add(pos));
      const accounted = track(api.Manifold.union([halves, cavity, groove, ...sockets, ...cutters, ...pryChamfers(arena, rim, -1), ...pryChamfers(arena, rim, 1)]));
      expect(vol(track(common.subtract(accounted)))).toBeLessThanOrEqual(NONE * 10);
      expect(vol(track(api.Manifold.difference([halves, common, added])))).toBeLessThanOrEqual(NONE * 10);
      expect(vol(track(track(halves.intersect(groove)).subtract(added)))).toBeLessThanOrEqual(NONE * 10);
      expect(vol(track(halves.intersect(cavity)))).toBeLessThanOrEqual(NONE * 10);
    }, SLOW);

    it(`${id}: the seam faces coincide in P, but for the groove, the ring under its legs, the sockets and the cavity on either side`, () => {
      const c = caseOf(id);
      const [neg, pos] = c.build.halves;
      const fn = faceOf(c, neg, -1), fp = faceOf(c, pos, 1);
      const { seal } = c.build;
      const sockets = seal.pins.map(([u, v]) => track(api.CrossSection.circle(PIN_RADIUS + SOCKET_CLEARANCE + 0.01, OPENING_SEGMENTS).translate([u, v])));
      const room = track(api.CrossSection.union([track(seal.band.offset(0.01, 'Miter')), track(seal.legs.offset(0.01, 'Miter')), track(seal.S.offset(0.05, 'Miter')), ...sockets]));
      const xor = track(track(fn.subtract(fp)).add(track(fp.subtract(fn))));
      expect(track(xor.subtract(room)).area()).toBeLessThan(0.05);
      // Neg keeps its whole face over the band, which pos has cut: the groove is pos's, the tongue rises from neg's face.
      expect(track(fp.intersect(seal.band)).area()).toBeLessThan(0.05);
      expect(track(fn.intersect(seal.band)).area()).toBeGreaterThan(0.95 * track(seal.band.intersect(track(fn.add(fp)))).area());
    }, SLOW);

    it(`${id}: the map's silicone within 1% of the mesh`, () => {
      const c = caseOf(id);
      const mesh = vol(siliconeSolid(arena, c.build, c.model.solid)) / 1000;
      expect(Math.abs(mesh - c.fine.siliconeMl) / mesh).toBeLessThan(0.01);
    }, SLOW);
  }
});

describe('MP2: G4 for each half', () => {
  for (const id of [...IDS, 'vis35'] as const) {
    it(`${id}: minGap(model, half) - error >= t on each half, the axis and xs kept`, (ctx) => {
      if (id === 'vis35') skipWithout(ctx, 'vis35');
      const c = id === 'vis35' ? clamCase(arena, id) : caseOf(id);
      const search = gapSearch(c.params);
      for (const half of c.build.halves) expect(c.model.solid.minGap(half, search)).toBeGreaterThanOrEqual(c.params.silicone.t);
    }, SLOW);
  }

  it('a gap short of t raises rEff once, at the first build\'s axis and xs', () => {
    const c = caseOf('sphere');
    const split = { axis: c.fine.axis, xs: c.fine.xs };
    // The openings read again from each build's own fields, as their zb is the lowest ceiling at that build's margin.
    const plain = clamshellG4(arena, c.model.mesh, c.params, split, c.model.solid, { openingsFor: seamOpenings });
    expect(plain.raisedBy).toBe(0);
    expect(plain.first).toBeNull();
    expect(plain.diagnostics).toEqual([]);
    expect(plain.build.openings).toEqual(c.build.openings);
    // An error that leaves the least gap 0.2 mm short of t, as a decimated model's would: one rebuild, raised by the
    // shortfall and G4_RAISE_EXTRA, at the same split, the first build held meanwhile, and the one-piece export's line.
    const error = Math.min(...plain.gaps) - c.params.silicone.t + 0.2;
    const raised = clamshellG4(arena, c.model.mesh, c.params, split, c.model.solid, { openingsFor: seamOpenings, error });
    expect(raised.raisedBy).toBeCloseTo(0.2 + G4_RAISE_EXTRA, 9);
    expect(raised.first).not.toBeNull();
    expect([raised.fine.axis, raised.fine.xs]).toEqual([split.axis, split.xs]);
    expect(Math.min(...raised.gaps)).toBeGreaterThanOrEqual(c.params.silicone.t);
    expect(raised.diagnostics.map((d) => [d.code, d.severity])).toEqual([['margin-raised', 'warning']]);
    expect(raised.diagnostics[0].message).toContain(`raised by ${(0.2 + G4_RAISE_EXTRA).toFixed(2)} mm`);
  }, SLOW);
});

/** G13.4's pull test: what a half meets on its way off, the base and the model in place. */
function obstacle(c: ClamCase): Manifold {
  const cutters = c.build.openings.flatMap((opening) => openingCutters(arena, c.build.rim, opening));
  return track(api.Manifold.union([siliconeSolid(arena, c.build, c.model.solid), c.model.solid, c.build.base, ...cutters]));
}

function pullMeets(c: ClamCase, sign: 1 | -1, against: Manifold, b = 0): number[] {
  const half = c.build.halves[sign > 0 ? 1 : 0];
  const { O } = c.build.rim;
  const depth = c.fine.axis === 'x' ? (sign > 0 ? O.x1 - c.fine.xs : c.fine.xs - O.x0) : sign > 0 ? O.y1 - c.fine.xs : c.fine.xs - O.y0;
  return [0.25, 0.5, 1, 2, 5, 10, 20, depth].map((d) => {
    const moved = track(half.translate(scaled(pull(c, sign), d)).translate(scaled(across(c), b)));
    return vol(track(moved.intersect(against)));
  });
}

describe('MP2: the pull test', () => {
  for (const id of ['sphere', 'cube', 'cone', 'goddess'] as const) {
    it(`${id}: each half slides off along its pull through the silicone, the model, the base and the cutters, meeting at most 1e-3 mm3`, () => {
      const c = caseOf(id);
      const against = obstacle(c);
      for (const sign of [-1, 1] as const) for (const met of pullMeets(c, sign, against)) expect(met).toBeLessThanOrEqual(NONE);
      // The groove runs over the ridge bars with cG either side, so a half guided off by them anywhere in that play clears them.
      // The rebate's end walls hold it to cT, under cG, and the cavity to 0, so the offset is tried against the bars.
      const bars = ridgeBars(arena, c.build.rim, c.fine.axis);
      for (const sign of [-1, 1] as const) for (const b of [-c.params.joint.grooveClearance, c.params.joint.grooveClearance]) for (const met of pullMeets(c, sign, bars, b)) expect(met).toBeLessThanOrEqual(NONE);
      // Seated, the bars' ends keep cG to each half's teardrop fill: moved cG toward it along a, they still clear the half.
      for (const sign of [-1, 1] as const) {
        const moved = track(bars.translate(scaled(pull(c, sign), c.params.joint.grooveClearance)));
        expect(vol(track(moved.intersect(c.build.halves[sign > 0 ? 1 : 0])))).toBeLessThanOrEqual(NONE);
      }
    }, SLOW);
  }

  it('negative controls: a vent 3 mm off P, and a full ridge ring on the base, each stop a half', () => {
    const sphere = caseOf('sphere');
    const off = clamCase(arena, 'sphere', () => {}, {
      openings: (prep, fine) => {
        const vent = seamOpening(prep, fine, 'vent', 6);
        return fine.axis === 'x' ? [{ ...vent, x: vent.x + 3 }] : [{ ...vent, y: vent.y + 3 }];
      },
    });
    expect(Math.max(...pullMeets(off, 1, obstacle(off)))).toBeGreaterThan(1);
    const ring = clamCase(arena, 'sphere', () => {}, { ridgeRing: true });
    expect(Math.max(...pullMeets(ring, 1, obstacle(ring)))).toBeGreaterThan(1);
    expect(Math.max(...pullMeets(ring, -1, obstacle(ring)))).toBeGreaterThan(1);
    expect(sphere.fine.axis).toBe(ring.fine.axis);
  }, SLOW);
});

describe('MP2: print poses with no supports', () => {
  for (const id of ['sphere', 'cone', 'goddess'] as const) {
    it(`${id}: in each half's pose the steep area is the allowed set's, the top chamfer's faces`, () => {
      const c = caseOf(id);
      const { rim } = c.build;
      for (const sign of [-1, 1] as const) {
        const pose = halfPose(rim, rim.axis, sign);
        const back = inversePose(pose);
        const mesh = orientSolid(arena, c.build.halves[sign > 0 ? 1 : 0], pose).getMesh();
        const [a, b, cc, d, e, f, g, h, i] = back.rotation;
        const [tx, ty, tz] = back.translation;
        // Back in the mold: a face of the top chamfer lies within its width of Zt and of O's side.
        const chamfer = (x: number, y: number, z: number): boolean => {
          const mx = a * x + b * y + cc * z + tx, my = d * x + e * y + f * z + ty, mz = g * x + h * y + i * z + tz;
          const side = Math.min(mx - rim.O.x0, rim.O.x1 - mx, my - rim.O.y0, rim.O.y1 - my);
          return mz >= rim.Zt - rim.topChamfer - 1e-3 && side <= rim.topChamfer + 1e-3;
        };
        const audit = auditOverhang({ positions: mesh.vertProperties, indices: mesh.triVerts }, { allowed: chamfer });
        expect(audit.steepArea, `${id} ${sign > 0 ? 'pos' : 'neg'}: ${audit.steepCount} steep faces, worst ${audit.worstDeg.toFixed(1)} degrees`).toBeCloseTo(audit.allowedArea!, 6);
        expect(audit.ignoredArea).toBeLessThan(0.05);
        // Negative control: G9's groove, with no teardrop, leaves its inner wall past D as a ceiling in this pose.
        const plain = trimHalf(arena, buildClamCommon(arena, rim, grooveSolid(arena, rim)), rim.axis, rim.xs, sign);
        const bare = orientSolid(arena, plain, pose).getMesh();
        const without = auditOverhang({ positions: bare.vertProperties, indices: bare.triVerts }, { allowed: chamfer });
        expect(without.steepArea - without.allowedArea!).toBeGreaterThan(10);
      }
    }, SLOW);
  }
});

describe('MP2: the golden of Goddess with Seam fasteners None', () => {
  it('the halves\' and the base\'s volumes, and the STLs in their poses, which MP3 must keep', (ctx) => {
    skipWithout(ctx, 'goddess');
    const c = caseOf('goddess');
    const g = CLAMSHELL_PARTS_GOLDEN.goddess;
    const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
    const { rim } = c.build;
    const [neg, pos] = c.build.halves;
    expect([c.fine.axis, c.fine.xs]).toEqual([g.axis, g.xs]);
    for (const [got, want] of [[vol(neg), g.neg], [vol(pos), g.pos], [vol(c.build.base), g.base]] as const) expect(Math.abs(got - want) / want).toBeLessThan(0.01);
    const stls = { neg: sha(poseToStl(api, neg, halfPose(rim, rim.axis, -1))), pos: sha(poseToStl(api, pos, halfPose(rim, rim.axis, 1))) };
    expect(stls).toEqual(g.sha256);
  }, SLOW);
});
