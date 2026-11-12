import { createHash } from 'node:crypto';
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

/**
 * FL: the part of the seated funnel below the top, the spigot, which the flange no longer lets touch the
 * seat. Cut a hair under the top, as a cut face in the top's plane reads as touching it to minGap.
 */
function spigotOf(arena: Arena, inUse: Manifold): Manifold {
  return arena.track(inUse.trimByPlane([0, 0, -1], -(ZT - 1e-3)));
}

/** The seat's radius at the flat top, by hand: the bore's, widened by the cone over the seat's depth. */
function seatTopOf(params: Params): number {
  return params.pour.diameter / 2 + params.seat.depth * Math.tan((params.seat.halfAngleDeg * Math.PI) / 180);
}

/** The lowest point of a solid outside a radius from its axis. */
function lowestOutside(solid: Manifold, radius: number): number {
  const p = solid.getMesh().vertProperties;
  let lowest = Infinity;
  for (let i = 0; i < p.length; i += 3) if (Math.hypot(p[i], p[i + 1]) > radius) lowest = Math.min(lowest, p[i + 2]);
  return lowest;
}

/** Area of the faces facing straight down, or up, within 1e-9 of a height. */
function flatArea(solid: Manifold, z: number, down: boolean): number {
  const mesh = solid.getMesh();
  const p = mesh.vertProperties, t = mesh.triVerts;
  let area = 0;
  for (let k = 0; k < t.length; k += 3) {
    const a = t[k] * 3, b = t[k + 1] * 3, c = t[k + 2] * 3;
    if (![a, b, c].every((v) => Math.abs(p[v + 2] - z) < 1e-9)) continue;
    const nz = (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a]);
    if (down ? nz < 0 : nz > 0) area += Math.abs(nz) / 2;
  }
  return area;
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
/** Area of a 48-gon on the circle of radius r, as the revolve makes it. */
const polygon = (r: number): number => 24 * r * r * Math.sin((2 * Math.PI) / 48);

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
/** The funnel as it was before FL, with no flange. */
const plain = defaultParams();
plain.funnel.flangeWidth = 0;
const plainProfile = funnelProfile(plain);
const HALF = (params.seat.halfAngleDeg * Math.PI) / 180;

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
      // FL: the flange rests on the top, so the gap is the spigot's, below it.
      const gap = spigotOf(arena, funnel).minGap(block, 2);
      expect(Math.abs(gap - params.funnel.seatClearance)).toBeLessThanOrEqual(0.02);
      // Facets of the same polygon, so the gap is the set clearance or a very little under it.
      expect(gap).toBeLessThanOrEqual(params.funnel.seatClearance + 1e-6);
      // Without a flange the whole funnel stands that far off, as before FL.
      const free = seated(arena, plain);
      expect(arena.track(free.intersect(block)).volume()).toBeLessThan(1e-6);
      expect(Math.abs(free.minGap(block, 2) - plain.funnel.seatClearance)).toBeLessThanOrEqual(0.02);
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
      const gap = spigotOf(arena, seated(arena, params)).minGap(block, 5);
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

  /** All flat faces, as area, up or down. */
  function allFlat(funnel: Manifold): number {
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
    return flat;
  }

  it('with a flange width of 0, has its neck\'s outside exactly at the spigot\'s wide end, so no flat ledge, as before FL', () => {
    withArena(api, (arena) => {
      const funnel = buildFunnel(arena, plain);
      expect(radii(arena, funnel, 0.01).outer).toBeCloseTo(radii(arena, funnel, -0.01).outer, 1);
      expect(radii(arena, funnel, 0.01).outer).toBeCloseTo(plainProfile.rNeck, 3);
      expect(radii(arena, funnel, plain.funnel.neckHeight - 0.01).outer).toBeCloseTo(plainProfile.rNeck, 3);
      // Only the tip's annulus and the rim's.
      const expected = polygon(plainProfile.rTip) - polygon(plainProfile.rThroat) + polygon(plainProfile.rRim) - polygon(plainProfile.rRimInner);
      expect(allFlat(funnel)).toBeCloseTo(expected, 2);
    });
  });

  it('FL: its flange lies flat at z = 0, the lowest point of the funnel outside the spigot, out to the seat\'s edge plus the flange width', () => {
    withArena(api, (arena) => {
      const funnel = buildFunnel(arena, params);
      const seatTop = seatTopOf(params);
      // Nothing outside the seat's mouth reaches below the top, and the flange is down on it.
      expect(lowestOutside(funnel, seatTop)).toBe(0);
      expect(radii(arena, funnel, 1e-3).outer).toBeCloseTo(seatTop + params.funnel.flangeWidth, 3);
      // The underside: one flat ring from the spigot out to the flange's edge, the spigot running straight up to it.
      const spigot = radii(arena, funnel, -1e-3).outer;
      expect(flatArea(funnel, 0, true)).toBeCloseTo(polygon(seatTop + params.funnel.flangeWidth) - polygon(spigot), 2);
      // The edge rises square to the flange's thickness, and the chamfer runs in at 45 degrees from there.
      const edge = params.funnel.flangeThickness;
      expect(radii(arena, funnel, edge - 0.01).outer).toBeCloseTo(seatTop + params.funnel.flangeWidth, 3);
      expect(radii(arena, funnel, edge + 1).outer).toBeCloseTo(seatTop + params.funnel.flangeWidth - 1, 3);
      // It meets the neck where the neck's outside is the spigot's wide end, as before.
      expect(radii(arena, funnel, params.funnel.neckHeight - 0.01).outer).toBeCloseTo(plainProfile.rNeck, 3);
      // All flat faces: the tip's annulus, the rim's and the flange's underside.
      const expected = polygon(profile.rTip) - polygon(profile.rThroat) + polygon(profile.rRim) - polygon(profile.rRimInner) + polygon(seatTop + params.funnel.flangeWidth) - polygon(spigot);
      expect(allFlat(funnel)).toBeCloseTo(expected, 2);
    });
  });

  it('FL: seated on a real cover at Zt, it meets it nowhere, its flange lies on the top, and the spigot keeps the seat clearance, wider at the mouth by the relief', () => {
    withArena(api, (arena) => {
      const block = seatedBlock(arena, params);
      const funnel = seated(arena, params);
      expect(arena.track(funnel.intersect(block)).volume()).toBeLessThan(1e-6);
      // The flange's underside is the top's plane: the lowest point outside the seat is Zt, and the two touch.
      expect(lowestOutside(funnel, seatTopOf(params))).toBe(ZT);
      expect(flatArea(funnel, ZT, true)).toBeGreaterThan(200);
      expect(funnel.minGap(block, 2)).toBeLessThan(1e-6);
      // Below the top, the spigot stands the seat clearance off the seat's cone.
      const spigot = spigotOf(arena, funnel);
      expect(spigot.boundingBox().max[2]).toBeCloseTo(ZT - 1e-3, 9);
      const gap = spigot.minGap(block, 2);
      expect(Math.abs(gap - params.funnel.seatClearance)).toBeLessThanOrEqual(0.02);
      // At the mouth, which prints in the cover's first layers, the gap across is wider by 2 layers' worth of the cone.
      const z = ZT - 1e-4;
      const across = radii(arena, block, z).inner - radii(arena, funnel, z).outer;
      const cone = params.funnel.seatClearance / Math.cos(HALF);
      expect(across - cone).toBeCloseTo(2 * params.print.layerHeight * Math.tan(HALF), 3);
      // Lower down, past the relief, the gap across is the cone's alone.
      const low = ZT - 1;
      expect(radii(arena, block, low).inner - radii(arena, funnel, low).outer).toBeCloseTo(cone, 3);
    });
  });

  it('FL: on a 10 degree seat the relief runs higher than 2 layers, so the gap across at the foot of the cover\'s first layer is still 0.2 mm', () => {
    withArena(api, (arena) => {
      const shallow = defaultParams();
      shallow.seat.halfAngleDeg = 10;
      const ten = (10 * Math.PI) / 180;
      const block = seatedBlock(arena, shallow);
      const funnel = seated(arena, shallow);
      expect(arena.track(funnel.intersect(block)).volume()).toBeLessThan(1e-6);
      expect(lowestOutside(funnel, seatTopOf(shallow))).toBe(ZT);
      // 2 layers alone would leave 0.1 / cos 10 + 0.2 tan 10 there, about 0.137 mm, under a 0.2 mm squash.
      expect(0.1 / Math.cos(ten) + shallow.print.layerHeight * Math.tan(ten)).toBeLessThan(0.14);
      const z = ZT - shallow.print.layerHeight;
      expect(radii(arena, block, z).inner - radii(arena, funnel, z).outer).toBeCloseTo(0.2, 3);
      // Below the relief, the cone's gap alone.
      expect(radii(arena, block, ZT - 1.5).inner - radii(arena, funnel, ZT - 1.5).outer).toBeCloseTo(0.1 / Math.cos(ten), 3);
    });
  });

  it('FL: negative control: lowered by a layer, the flange cuts into the top and the spigot into the seat', () => {
    withArena(api, (arena) => {
      const block = seatedBlock(arena, params);
      const low = arena.track(seated(arena, params).translate([0, 0, -params.print.layerHeight]));
      expect(arena.track(low.intersect(block)).volume()).toBeGreaterThan(10);
      expect(lowestOutside(low, seatTopOf(params))).toBeLessThan(ZT - 0.1);
    });
  });

  it('FL: under the flange the spigot\'s wall stays as thick as its tip wall, at a 30 and a 45 degree seat', () => {
    withArena(api, (arena) => {
      for (const angle of [30, 45]) {
        const values = defaultParams();
        values.seat.halfAngleDeg = angle;
        const funnel = buildFunnel(arena, values);
        const thinnest = Math.min(values.funnel.tipWall, values.funnel.wall);
        const under = radii(arena, funnel, -1e-4);
        expect(under.outer - under.inner, `${angle} degrees`).toBeGreaterThanOrEqual(thinnest - 1e-3);
        // Nowhere on the spigot thinner, down to its tip.
        for (const z of [-0.2, -0.4, -1, -2]) {
          const at = radii(arena, funnel, z);
          expect(at.outer - at.inner, `${angle} degrees at ${z}`).toBeGreaterThanOrEqual(thinnest - 1e-3);
        }
      }
      // Negative control: at 45 degrees a bore widening as it did before FL would leave it thinner, so it had to move.
      const steep = defaultParams();
      steep.seat.halfAngleDeg = 45;
      const p = funnelProfile(steep);
      expect(p.rRelief - p.rNeckInner).toBeLessThan(steep.funnel.tipWall - 0.05);
      expect(p.zNeckInner).toBeGreaterThan(0);
    });
  });

  it('FL: a flange width of 0 gives the funnel of before FL, byte for byte', () => {
    // SHA-256 of funnel.stl at 7a35b00, before any change of FL: at defaults, and at a 20 mm pour in a 45 degree seat.
    expect(sha(funnelFile(api, plain, 1).stl)).toBe('3f68f0be36daf991407375bd46ba0c289903d697a99ec206c396759449d4bcf3');
    const other = defaultParams();
    other.pour.diameter = 20;
    other.seat.halfAngleDeg = 45;
    other.funnel.flangeWidth = 0;
    expect(sha(funnelFile(api, other, 1).stl)).toBe('62eaf5aae1e16f9cdd407cd186e6370ba46317cc21c6455ed3ba4d82d9e92b82');
    // And the flange does change it, so the hash is no constant.
    expect(sha(funnelFile(api, params, 1).stl)).not.toBe('3f68f0be36daf991407375bd46ba0c289903d697a99ec206c396759449d4bcf3');
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
      // Between the flange's chamfer and the cone.
      const neck = radii(arena, funnel, (profile.zChamfer + params.funnel.neckHeight) / 2);
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
      // FL: the steepest is the flange's chamfer, at 45 degrees; a facet of the 48-sided cone leans a little less than the cone itself.
      expect(audit.worstDeg).toBeLessThanOrEqual(45);
      expect(audit.worstDeg).toBeGreaterThan(45 - 0.1);
      // The audit does read those faces: at a tighter limit they are what it reports, and the cone's at a limit under its own.
      expect(auditOverhang({ positions, indices: posed.triVerts }, { bedZ: 0, limitDeg: 44 }).steepCount).toBeGreaterThan(0);
      expect(auditOverhang({ positions, indices: posed.triVerts }, { bedZ: 0, limitDeg: profile.coneDeg - 1 }).steepArea).toBeGreaterThan(auditOverhang({ positions, indices: posed.triVerts }, { bedZ: 0, limitDeg: 44 }).steepArea);
      // With no flange the cone is the steepest, as before FL.
      const free = posedAudit(buildFunnel(arena, plain), plain);
      expect(free.steepCount).toBe(0);
      expect(free.worstDeg).toBeLessThanOrEqual(plainProfile.coneDeg);
      expect(free.worstDeg).toBeGreaterThan(plainProfile.coneDeg - 0.1);
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
  // The spigot below the top keeps the clearance, with a flange or without.
  expect(Math.abs(spigotOf(arena, inUse).minGap(block, 2) - values.funnel.seatClearance), label).toBeLessThanOrEqual(0.02);
  expect(posedAudit(funnel, values).steepCount, label).toBe(0);
  const p = funnelProfile(values);
  expect(p.rThroat, label).toBeLessThan(values.pour.diameter / 2);
  expect(p.rThroat, label).toBeGreaterThan(0);
  if (values.funnel.flangeWidth > 0) {
    // FL: the flange is down on the top, and nothing outside the seat's mouth below it.
    expect(lowestOutside(inUse, seatTopOf(values)), label).toBe(ZT);
    expect(radii(arena, funnel, 1e-3).outer, label).toBeCloseTo(seatTopOf(values) + values.funnel.flangeWidth, 3);
    const under = radii(arena, funnel, -1e-4);
    expect(under.outer - under.inner, label).toBeGreaterThanOrEqual(Math.min(values.funnel.tipWall, values.funnel.wall) - 1e-3);
  } else {
    expect(Math.abs(inUse.minGap(block, 2) - values.funnel.seatClearance), label).toBeLessThanOrEqual(0.02);
  }
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
    ['no flange', (p: Params) => (p.funnel.flangeWidth = 0)],
    ['no flange at a 45 degree seat', (p: Params) => ((p.funnel.flangeWidth = 0), (p.seat.halfAngleDeg = 45))],
    ['flange 0.5', (p: Params) => (p.funnel.flangeWidth = 0.5)],
    ['flange 10 over a neck of 16', (p: Params) => ((p.funnel.flangeWidth = 10), (p.funnel.neckHeight = 16))],
    ['flange 5 thick', (p: Params) => (p.funnel.flangeThickness = 5)],
    ['flange 0.6 thick', (p: Params) => (p.funnel.flangeThickness = 0.6)],
    ['flange at 0.3 mm layers', (p: Params) => (p.print.layerHeight = 0.3)],
    ['flange over a seat 1.5 deep', (p: Params) => (p.seat.depth = 1.5)],
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
    let passed = 0, refused = 0, flanged = 0, flangeRefused = 0;
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
      // FL: a sixth with no flange, and the rest across the schema's ranges, at layers a printer might use.
      values.funnel.flangeWidth = random(0, 1) < 1 / 6 ? 0 : random(0, 10);
      values.funnel.flangeThickness = random(0.6, 5);
      values.print.layerHeight = random(0.05, 0.4);
      const errors = crossParameterErrors(values);
      if (errors.length > 0) {
        refused++;
        if (errors.some((d) => d.code === 'funnel-flange' || d.message.includes('Under the flange'))) flangeRefused++;
        continue;
      }
      passed++;
      if (values.funnel.flangeWidth > 0) flanged++;
      withArena(api, (arena) => checkFunnel(arena, values, `run ${run}: ${JSON.stringify(values.funnel)}, pour ${values.pour.diameter}, seat ${JSON.stringify(values.seat)}, layer ${values.print.layerHeight}`));
    }
    expect(passed).toBe(300);
    // Both kinds were built, and the flange's own rules turned sets away too.
    expect(flanged).toBeGreaterThan(100);
    expect(passed - flanged).toBeGreaterThan(30);
    expect(flangeRefused).toBeGreaterThan(20);
    // And the rules did turn sets away, so the sweep reaches past what they allow.
    expect(refused).toBeGreaterThan(50);
  });
});
