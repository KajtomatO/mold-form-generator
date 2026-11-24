import type { CrossSection, ManifoldToplevel } from 'manifold-3d';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIAGNOSTIC_PARAM } from '../../src/app/derived';
import { orientSolid } from '../../src/core/base/orient';
import { defaultParams } from '../../src/core/params/defaults';
import { crossParameterErrors, crossParameterWarnings, SEAM_FLANGE_LAP } from '../../src/core/params/rules';
import { BAND_ROOM, PRY_LEG } from '../../src/core/parts/rim';
import { bRange, openingTopRadius, PIN_HEIGHT, PIN_RADIUS, rectSection, seamPins, seamSockets, seamTongue, SOCKET_CLEARANCE, uOfB, uSpan } from '../../src/core/parts/seam';
import { PRY_RUN } from '../../src/core/parts/seamBolts';
import { Arena } from '../../src/core/solid/arena';
import { clamCase, seamOpening, type ClamCase } from '../fixtures/clamshell';
import { loadManifold } from '../fixtures/loadExamples';

/**
 * MP2: G13.8's seal on the gallery's sphere and cube, with the openings MP4 places on P (docs/PLAN.md, MP2's and MP4's
 * checks); a pour placed by hand where a case needs that spot.
 */

let api: ManifoldToplevel;
let arena: Arena;
const cases: ClamCase[] = [];

beforeAll(async () => {
  api = await loadManifold();
  arena = new Arena(api);
  // The openings MP4 places on P (clamCase's default, placeSeam's), with the placement's choice on the pins.
  for (const id of ['sphere', 'cube']) cases.push(clamCase(arena, id));
}, 120_000);
afterAll(() => arena.dispose());

const track = <T extends { delete(): void }>(handle: T): T => arena.track(handle);
const empty = (section: CrossSection): boolean => section.isEmpty() || section.area() < 1e-6;

describe('G13.8: the band', () => {
  it('lies inside O across the pull with PRY_LEG + BAND_ROOM to spare, and its legs land on the base groove\'s ring at z = rh + gx', () => {
    for (const { build, params } of cases) {
      const { seal, rim } = build;
      const [ou0, ou1] = uSpan(rim.axis, ...bRange(rim.axis, rim.O));
      const b = seal.band.bounds();
      expect(b.min[0]).toBeGreaterThanOrEqual(ou0 + PRY_LEG + BAND_ROOM - 1e-6);
      expect(b.max[0]).toBeLessThanOrEqual(ou1 - PRY_LEG - BAND_ROOM + 1e-6);
      // Only beside an opening does it run up through the top.
      const high = track(seal.band.intersect(rectSection(arena, ou0, ou1, rim.Zt - BAND_ROOM, rim.Zt + 3)));
      const exits = build.openings.map((o) => {
        const u0 = uOfB(rim.axis, rim.axis === 'x' ? o.y : o.x), r = openingTopRadius(o) + params.clamshell.seamLand + seal.gw + 0.01;
        return rectSection(arena, u0 - r, u0 + r, rim.Zt - BAND_ROOM - 1, rim.Zt + 3);
      });
      expect(empty(track(high.subtract(track(api.CrossSection.union(exits)))))).toBe(true);
      // The legs: a thin slice just over the base groove's roof, one piece each side, which ends at D + e4 and holds the
      // base groove's ring [D + e1, D + e4]. Inside the ring it runs on over J's top, the joint's land, as the loop turns up.
      const legs = track(seal.band.intersect(rectSection(arena, ou0 - 1, ou1 + 1, seal.zr, seal.zr + 0.001))).decompose().map((piece) => track(piece).bounds());
      const [d0, d1] = bRange(rim.axis, rim.D);
      const rings = [uSpan(rim.axis, d0 - rim.e4, d0 - rim.e1), uSpan(rim.axis, d1 + rim.e1, d1 + rim.e4)].sort((p, q) => p[0] - q[0]);
      const got = legs.map((leg) => [leg.min[0], leg.max[0]]).sort((p, q) => p[0] - q[0]);
      expect(got.length).toBe(2);
      expect(got[0][0]).toBeCloseTo(rings[0][0], 2);
      expect(got[1][1]).toBeCloseTo(rings[1][1], 2);
      expect(got[0][1]).toBeGreaterThanOrEqual(rings[0][1] - 1e-3);
      expect(got[1][0]).toBeLessThanOrEqual(rings[1][0] + 1e-3);
      // Under the legs, the ring at its full width up to rh + gx: the drafted groove's roof is narrower there, and pos's
      // plastic left under a leg would be a fin.
      const under = seal.legs.decompose().map((piece) => track(piece).bounds()).sort((p, q) => p.min[0] - q.min[0]);
      expect(under.map((u) => [u.min[0], u.max[0]])).toEqual(rings.map(([u0, u1]) => [expect.closeTo(u0, 6), expect.closeTo(u1, 6)]));
      for (const u of under) expect([u.min[1], u.max[1]]).toEqual([expect.closeTo(-1, 6), expect.closeTo(seal.zr, 6)]);
      expect(rim.e4 - rim.e1).toBeCloseTo(seal.gw, 9);
      expect(seal.band.bounds().min[1]).toBeCloseTo(seal.zr, 9);
    }
  });

  it('the tongue\'s tip stands at rh + gx + cG or above, inside the band, flush with the top', () => {
    for (const { build, params } of cases) {
      const { seal } = build;
      const tongue = orientSolid(arena, seamTongue(arena, seal, params), seal.frame);
      const box = tongue.boundingBox();
      expect(box.min[1]).toBeGreaterThanOrEqual(seal.zr + params.joint.grooveClearance - 1e-6);
      expect(box.max[1]).toBeLessThanOrEqual(seal.Zt + 1e-6);
      // Along h: from inside neg's face to rh, under the groove's depth of rh + gx.
      expect(box.max[2]).toBeCloseTo(params.joint.ridgeHeight, 6);
      for (const h of [0.1, 0.5, 1.1]) {
        const at = track(tongue.slice(h));
        expect(empty(track(at.subtract(track(seal.band.offset(-params.joint.grooveClearance + 1e-3, 'Round', 2, 32)))))).toBe(true);
      }
    }
  });

  it('the band and the pins keep clear of the bores and the pry chamfers, and the sockets are deeper than the pins', () => {
    for (const { build } of cases) {
      const { seal, rim } = build;
      expect(seal.pins.length).toBe(2);
      const [ob0, ob1] = bRange(rim.axis, rim.O);
      const pry = [ob0, ob1].map((b, k) => {
        const [u0, u1] = uSpan(rim.axis, k === 0 ? b : b - PRY_LEG, k === 0 ? b + PRY_LEG : b);
        return rectSection(arena, u0, u1, rim.Zt - PRY_RUN, rim.Zt + 1);
      });
      const bores = build.openings.map((o) => {
        const u0 = uOfB(rim.axis, rim.axis === 'x' ? o.y : o.x), r = openingTopRadius(o);
        return rectSection(arena, u0 - r, u0 + r, o.zb - 0.5, rim.Zt + 1);
      });
      const pins = seal.pins.map(([u, v]) => track(api.CrossSection.circle(PIN_RADIUS + SOCKET_CLEARANCE, 48).translate([u, v])));
      for (const keep of [...pry, ...bores]) {
        expect(empty(track(seal.band.intersect(keep)))).toBe(true);
        for (const pin of pins) expect(empty(track(pin.intersect(keep)))).toBe(true);
      }
      for (const pin of pins) expect(empty(track(pin.intersect(seal.outer)))).toBe(true);
      const height = (solids: ReturnType<typeof seamPins>): number[] => solids.map((s) => orientSolid(arena, s, seal.frame).boundingBox().max[2]);
      for (const [pin, socket] of height(seamPins(arena, seal)).map((h, k) => [h, height(seamSockets(arena, seal))[k]])) {
        expect(pin).toBeCloseTo(PIN_HEIGHT, 6);
        expect(socket).toBeGreaterThan(pin);
      }
    }
  });
});

describe('G13.8 step 7: pins with no room', () => {
  it('are dropped with one info line, and no sockets are cut', () => {
    // On the cube a pour near one end of the seam, as the fixture's first-node pour once stood: the band beside it runs
    // up past the top corner, where that end's pin would stand.
    const c = clamCase(arena, 'cube', () => {}, { openings: (prep, fine) => [seamOpening(prep, fine, 'pour', -17.6)] });
    const { seal } = c.build;
    expect(seal.pins).toEqual([]);
    const dropped = c.build.diagnostics.filter((d) => d.code === 'seam-pins-dropped');
    expect(dropped.length).toBe(1);
    expect(dropped[0].severity).toBe('info');
    expect(dropped[0].message).toBe('The registration pins were left out, as the seam\'s top corners have no room for them clear of its seal, so the tongue alone keeps the halves in line, to within 0.25 mm.');
    expect(seamPins(arena, seal)).toEqual([]);
    expect(seamSockets(arena, seal)).toEqual([]);
    // The same pour with the pins turned off: no line, as nothing was dropped.
    const off = clamCase(arena, 'cube', (p) => (p.clamshell.pins = false), { openings: (prep, fine) => [seamOpening(prep, fine, 'pour', -17.6)] });
    expect(off.build.diagnostics.some((d) => d.code === 'seam-pins-dropped')).toBe(false);
    // And with the openings placed on P the cube keeps both.
    expect(cases[1].build.seal.pins.length).toBe(2);
  });
});

describe('G13.14: the seam\'s rules', () => {
  it('fail at topCap 4 and at seamLand 3, and hold at the defaults', () => {
    const codes = (change: (p: ReturnType<typeof defaultParams>) => void): string[] => {
      const p = defaultParams('clamshell');
      change(p);
      return crossParameterErrors(p).map((d) => d.code);
    };
    expect(codes(() => {})).toEqual([]);
    expect(codes((p) => (p.cover.topCap = 4))).toContain('seam-cap');
    expect(codes((p) => (p.clamshell.seamLand = 3))).toContain('seam-land');
  });

  it('warn when the flange stops short of 2 mm past the seam beside the pour, and only in this type', () => {
    const p = defaultParams('clamshell');
    expect(p.funnel.flangeWidth).toBe(p.clamshell.seamLand + SEAM_FLANGE_LAP);
    expect(crossParameterWarnings(p)).toEqual([]);
    p.funnel.flangeWidth = 3;
    const found = crossParameterWarnings(p);
    expect(found).toEqual([{ code: 'seam-flange', severity: 'warning', message: 'A flange 3 mm wide does not reach 2 mm past where the seam comes up beside the pour, 2 mm out from the seat, so the seam reaches the flange\'s rim and the silicone can seep out under it: make Flange width at least 4 mm.' }]);
    // A warning: the set still builds, as crossParameterErrors holds only errors.
    expect(crossParameterErrors(p)).toEqual([]);
    expect(DIAGNOSTIC_PARAM['seam-flange']).toBe('funnel.flangeWidth');
    // A wider seam land asks for a wider flange; with no funnel, or no seat, there is no flange to ask of.
    const wide = defaultParams('clamshell');
    wide.clamshell.seamLand = 2.5;
    expect(crossParameterWarnings(wide).map((d) => d.message)).toEqual([expect.stringMatching(/2\.5 mm out from the seat.*at least 4\.5 mm\.$/)]);
    wide.funnel.flangeWidth = 4.5;
    expect(crossParameterWarnings(wide)).toEqual([]);
    p.funnel.generate = false;
    expect(crossParameterWarnings(p)).toEqual([]);
    p.funnel.generate = true;
    p.seat.enabled = false;
    expect(crossParameterWarnings(p)).toEqual([]);
    // The one-piece cover keeps its 2 mm flange, with no warning, and the same 3 mm flange there warns of nothing.
    const one = defaultParams();
    expect(one.funnel.flangeWidth).toBe(2);
    expect(crossParameterWarnings(one)).toEqual([]);
    one.funnel.flangeWidth = 3;
    expect(crossParameterWarnings(one)).toEqual([]);
  });
});
