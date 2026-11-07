import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { determinant, transformPositions } from '../../src/core/base/orient';
import { defaultParams } from '../../src/core/params/defaults';
import { crossParameterErrors } from '../../src/core/params/rules';
import type { Params } from '../../src/core/params/schema';
import { buildFunnel, funnelFile, funnelPose } from '../../src/core/parts/funnel';
import { funnelProfile } from '../../src/core/parts/funnelProfile';
import { pourCutters } from '../../src/core/parts/openings';
import { auditOverhang } from '../../src/core/report/overhang';
import { checked, withArena, type Arena } from '../../src/core/solid/arena';
import { parseStl } from '../../src/core/stl/parse';
import { countHandles } from '../fixtures/handles';
import { loadManifold } from '../fixtures/loadExamples';
import { boxSolid, readPart, splitShells } from '../fixtures/solidChecks';

let api: ManifoldToplevel;
beforeAll(async () => {
  api = await loadManifold();
});

const ZT = 40;

/** A plain block with one real pour bore and seat, for the funnel to sit in. */
function seatedBlock(arena: Arena, params: Params): Manifold {
  const cutters = pourCutters(arena, { Zt: ZT }, { x: 0, y: 0, zb: 10, diameter: params.pour.diameter, seatDepth: params.seat.depth, seatHalfAngleDeg: params.seat.halfAngleDeg });
  const half = params.pour.diameter + 30;
  return checked(arena.track(arena.api.Manifold.difference([boxSolid(arena, [-half, -half, 0], [half, half, ZT]), ...cutters])), 'the block');
}

/** The funnel where it sits in use. */
function seated(arena: Arena, params: Params): Manifold {
  return arena.track(buildFunnel(arena, params).translate([0, 0, ZT]));
}

function posedAudit(solid: Manifold, params: Params) {
  const mesh = solid.getMesh();
  return auditOverhang({ positions: transformPositions(mesh.vertProperties, funnelPose(params)), indices: mesh.triVerts }, { bedZ: 0 });
}

/** Radius of a section's outer contour and, if it has one, its inner. */
function radii(arena: Arena, solid: Manifold, z: number): { outer: number; inner: number } {
  const contours = arena.polygons(arena.track(solid.slice(z)));
  const extents = contours.map((contour) => Math.max(...contour.map((p) => Math.hypot((p as [number, number])[0], (p as [number, number])[1]))));
  return { outer: Math.max(...extents), inner: Math.min(...extents) };
}

const params = defaultParams();
const profile = funnelProfile(params);

describe('the funnel of G12, at defaults', () => {
  it('is closed, positive, one body with a hole through it', () => {
    withArena(api, (arena) => {
      const funnel = buildFunnel(arena, params);
      expect(funnel.status()).toBe('NoError');
      expect(funnel.volume()).toBeGreaterThan(0);
      const { bodies, voids } = splitShells(arena, funnel);
      expect(bodies).toHaveLength(1);
      expect(voids).toEqual([]);
      expect(funnel.genus()).toBe(1);
    });
  });

  it('sits in a real seat with no intersection and the gap set, measured between the solids', () => {
    withArena(api, (arena) => {
      const block = seatedBlock(arena, params);
      const funnel = seated(arena, params);
      expect(arena.track(funnel.intersect(block)).volume()).toBeLessThan(1e-6);
      const gap = funnel.minGap(block, 2);
      expect(Math.abs(gap - params.funnel.seatClearance)).toBeLessThanOrEqual(0.02);
      // Facets of the same polygon, so the gap is the set clearance or a very little under it.
      expect(gap).toBeLessThanOrEqual(params.funnel.seatClearance + 1e-6);
    });
  });

  it('negative control: without the seat\'s offset the two overlap', () => {
    withArena(api, (arena) => {
      const block = seatedBlock(arena, params);
      const sunk = arena.track(seated(arena, params).translate([0, 0, -1]));
      expect(arena.track(sunk.intersect(block)).volume()).toBeGreaterThan(1);
      expect(sunk.minGap(block, 2)).toBeLessThan(0.02);
    });
  });

  it('negative control: at a seat with another angle the gap is not the one set', () => {
    withArena(api, (arena) => {
      const other = structuredClone(params);
      other.seat.halfAngleDeg = 45;
      const block = seatedBlock(arena, other);
      const gap = seated(arena, params).minGap(block, 5);
      expect(Math.abs(gap - params.funnel.seatClearance)).toBeGreaterThan(0.02);
    });
  });

  it('has the spigot of the seat: its wall parallel to the cone, and the same axis', () => {
    withArena(api, (arena) => {
      const funnel = buildFunnel(arena, params);
      const half = (params.seat.halfAngleDeg * Math.PI) / 180;
      const a = radii(arena, funnel, -2).outer, b = radii(arena, funnel, -0.5).outer;
      expect((b - a) / 1.5).toBeCloseTo(Math.tan(half), 2);
      // Tip stands off the seat's floor by what the clearance asks for.
      expect(funnel.boundingBox().min[2]).toBeCloseTo(-params.seat.depth + params.funnel.seatClearance / Math.sin(half), 6);
      expect(funnel.boundingBox().min[0]).toBeCloseTo(-params.funnel.topDiameter / 2, 3);
    });
  });

  it('has its neck\'s outside exactly at the spigot\'s wide end, so no flat ledge', () => {
    withArena(api, (arena) => {
      const funnel = buildFunnel(arena, params);
      expect(radii(arena, funnel, 0.01).outer).toBeCloseTo(radii(arena, funnel, -0.01).outer, 1);
      expect(radii(arena, funnel, 0.01).outer).toBeCloseTo(profile.rNeck, 3);
      expect(radii(arena, funnel, params.funnel.neckHeight - 0.01).outer).toBeCloseTo(profile.rNeck, 3);
      // All flat faces, as area: only the tip's annulus and the rim's.
      const mesh = funnel.getMesh();
      const p = mesh.vertProperties, t = mesh.triVerts;
      let flat = 0;
      for (let k = 0; k < t.length; k += 3) {
        const a = t[k] * 3, b = t[k + 1] * 3, c = t[k + 2] * 3;
        const nz = (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a]);
        const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
        const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
        const n = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, nz);
        if (Math.abs(nz) > n * 0.999) flat += n / 2;
      }
      const polygon = (r: number): number => 24 * r * r * Math.sin((2 * Math.PI) / 48);
      const expected = polygon(profile.rTip) - polygon(profile.rThroat) + polygon(profile.rRim) - polygon(profile.rRimInner);
      expect(flat).toBeCloseTo(expected, 2);
    });
  });

  it('has a throat of pour diameter - 2 tipWall, narrower than the bore', () => {
    withArena(api, (arena) => {
      const funnel = buildFunnel(arena, params);
      const { inner, outer } = radii(arena, funnel, profile.zTip + 1e-3);
      expect(2 * inner).toBeCloseTo(params.pour.diameter - 2 * params.funnel.tipWall, 2);
      expect(2 * inner).toBeLessThan(params.pour.diameter);
      expect(2 * outer).toBeCloseTo(params.pour.diameter, 2);
      // Nothing narrower further up: the throat is the tightest place in it.
      for (const z of [-2, 0, 5, 10, 15, 25]) expect(radii(arena, funnel, z).inner).toBeGreaterThanOrEqual(inner - 1e-6);
    });
  });

  it('has a wall of the set thickness, measured square to it, on the cone and the neck', () => {
    withArena(api, (arena) => {
      const funnel = buildFunnel(arena, params);
      const neck = radii(arena, funnel, params.funnel.neckHeight / 2);
      expect(neck.outer - neck.inner).toBeCloseTo(params.funnel.wall, 3);
      const cone = radii(arena, funnel, 20);
      const across = cone.outer - cone.inner;
      const cos = Math.cos((profile.coneDeg * Math.PI) / 180);
      expect(across * cos).toBeCloseTo(params.funnel.wall, 2);
    });
  });

  it('prints wide rim down with every wall within 45 degrees of vertical', () => {
    withArena(api, (arena) => {
      const funnel = buildFunnel(arena, params);
      expect(determinant(funnelPose(params))).toBe(1);
      const posed = funnel.getMesh();
      const positions = transformPositions(posed.vertProperties, funnelPose(params));
      let bottom = Infinity;
      for (let i = 2; i < positions.length; i += 3) bottom = Math.min(bottom, positions[i]);
      expect(bottom).toBeCloseTo(0, 5);
      const audit = posedAudit(funnel, params);
      expect(audit).toMatchObject({ steepCount: 0, steepArea: 0 });
      // A facet of the 48-sided cone leans a little less than the cone itself.
      expect(audit.worstDeg).toBeLessThanOrEqual(profile.coneDeg);
      expect(audit.worstDeg).toBeGreaterThan(profile.coneDeg - 0.1);
      // The audit does read those faces: at a tighter limit they are what it reports.
      expect(auditOverhang({ positions, indices: posed.triVerts }, { bedZ: 0, limitDeg: profile.coneDeg - 1 }).steepCount).toBeGreaterThan(0);
    });
  });

  it('exports one closed STL in print pose, with the quantity for the README', () => {
    const { stl, quantity } = funnelFile(api, params, 24);
    expect(quantity).toBe(24);
    expect(String.fromCharCode(...stl.slice(0, 5))).not.toBe('solid');
    expect(parseStl(stl).format).toBe('binary');
    const { mesh, audit } = readPart(stl);
    expect(audit).toMatchObject({ openEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 });
    expect(auditOverhang(mesh, { bedZ: 0 })).toMatchObject({ steepCount: 0, steepArea: 0 });
    let top = -Infinity, bottom = Infinity;
    for (let i = 2; i < mesh.positions.length; i += 3) {
      top = Math.max(top, mesh.positions[i]);
      bottom = Math.min(bottom, mesh.positions[i]);
    }
    expect(bottom).toBeCloseTo(0, 5);
    expect(top).toBeCloseTo(params.funnel.height - profile.zTip, 4);
  });

  it('frees every handle', async () => {
    const counted = await loadManifold();
    const ledger = countHandles(counted);
    funnelFile(counted, params, 1);
    expect(ledger.created()).toBeGreaterThan(1);
    expect(ledger.live()).toEqual([]);
  });
});

/** All the checks of G12, for values that the rules let through. */
function checkFunnel(arena: Arena, values: Params, label: string): void {
  const funnel = buildFunnel(arena, values);
  expect(funnel.status(), label).toBe('NoError');
  expect(funnel.volume(), label).toBeGreaterThan(0);
  expect(splitShells(arena, funnel).bodies, label).toHaveLength(1);
  const block = seatedBlock(arena, values);
  const inUse = seated(arena, values);
  expect(arena.track(inUse.intersect(block)).volume(), label).toBeLessThan(1e-3);
  expect(Math.abs(inUse.minGap(block, 2) - values.funnel.seatClearance), label).toBeLessThanOrEqual(0.02);
  expect(posedAudit(funnel, values).steepCount, label).toBe(0);
  const p = funnelProfile(values);
  expect(p.rThroat, label).toBeLessThan(values.pour.diameter / 2);
  expect(p.rThroat, label).toBeGreaterThan(0);
}

describe('the funnel at other values', () => {
  it.each([
    ['pour 6', (p: Params) => (p.pour.diameter = 6)],
    ['pour 20', (p: Params) => (p.pour.diameter = 20)],
    ['pour 30', (p: Params) => (p.pour.diameter = 30)],
    ['pour 4', (p: Params) => (p.pour.diameter = 4)],
    ['seat 4, the limit under a 5 mm cap', (p: Params) => (p.seat.depth = 4)],
    ['seat half angle 10', (p: Params) => (p.seat.halfAngleDeg = 10)],
    ['seat half angle 45', (p: Params) => (p.seat.halfAngleDeg = 45)],
    ['clearance 0.3', (p: Params) => (p.funnel.seatClearance = 0.3)],
    ['tip wall thicker than the wall', (p: Params) => ((p.funnel.tipWall = 2), (p.funnel.wall = 0.8))],
    ['top 60, height 45', (p: Params) => ((p.funnel.topDiameter = 60), (p.funnel.height = 45))],
  ])('%s passes every check, with no error from the rules', (_, change) => {
    const values = defaultParams();
    change(values);
    expect(crossParameterErrors(values)).toEqual([]);
    withArena(api, (arena) => checkFunnel(arena, values, 'this case'));
  });

  it('negative control: a cone the rules refuse does fail the audit', () => {
    const flat = defaultParams();
    flat.funnel.topDiameter = 80;
    flat.funnel.height = 20;
    expect(crossParameterErrors(flat).map((d) => d.code)).toEqual(['funnel-too-flat']);
    withArena(api, (arena) => {
      expect(posedAudit(buildFunnel(arena, flat), flat).steepCount).toBeGreaterThan(0);
    });
  });

  it('whatever the rules let through builds a sound funnel, over random values in the schema\'s ranges', () => {
    let seed = 2026;
    const random = (a: number, b: number): number => a + ((seed = (seed * 16807) % 2147483647) / 2147483647) * (b - a);
    // Drawn until 300 sets pass the rules, as about half do not, and each of those 300 builds and is checked.
    let passed = 0, refused = 0;
    for (let run = 0; passed < 300 && run < 3000; run++) {
      const values = defaultParams();
      values.cover.topCap = random(3, 30);
      values.pour.diameter = random(4, 30);
      values.seat.depth = random(1, Math.min(10, values.cover.topCap - 1));
      values.seat.halfAngleDeg = random(10, 45);
      values.funnel.topDiameter = random(10, 90);
      values.funnel.height = random(8, 60);
      values.funnel.neckHeight = random(1, 25);
      values.funnel.wall = random(0.5, 2.5);
      values.funnel.tipWall = random(0.4, 1.6);
      values.funnel.seatClearance = random(0.02, 0.4);
      const errors = crossParameterErrors(values);
      if (errors.length > 0) {
        refused++;
        continue;
      }
      passed++;
      withArena(api, (arena) => checkFunnel(arena, values, `run ${run}: ${JSON.stringify(values.funnel)}, pour ${values.pour.diameter}, seat ${JSON.stringify(values.seat)}`));
    }
    expect(passed).toBe(300);
    // And the rules did turn sets away, so the sweep reaches past what they allow.
    expect(refused).toBeGreaterThan(50);
  });
});
