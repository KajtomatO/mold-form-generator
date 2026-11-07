import type { ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { fieldSettings } from '../../src/core/field/grid';
import { meshBounds } from '../../src/core/mesh/weld';
import { defaultParams } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';
import { buildBaseBody } from '../../src/core/parts/base';
import { buildCoverBody, coverBottom, toolDiagnostics } from '../../src/core/parts/cover';
import { grooveResidualVolume, grooveSolid, ridgeSolid, ringArea, ringHull, ringPoints, wallRing } from '../../src/core/parts/joint';
import { deriveRim, maskOverrun, moldBounds, rebateOutset, type MoldBounds } from '../../src/core/parts/rim';
import { withArena } from '../../src/core/solid/arena';
import { outset } from '../../src/core/solid/rect';
import { TOOL_BOTTOM } from '../../src/core/solid/tool';
import { loadManifold } from '../fixtures/loadExamples';
import { boxSolid, contourDistance, splitShells } from '../fixtures/solidChecks';
import { box } from '../fixtures/synthetic';

let api: ManifoldToplevel;
beforeAll(async () => {
  api = await loadManifold();
});

const DEG = Math.PI / 180;
const tan1 = Math.tan(DEG);
const tan15 = Math.tan(15 * DEG);
/** r_eff at plan defaults. */
const R_EFF = 3 + 2.13 * 0.125 + 0.1;

function paramsWith(change: (p: Params) => void = () => {}): Params {
  const params = defaultParams();
  change(params);
  return params;
}

function boundsFor(params: Params, mesh = box([-10, -5, 0], [10, 5, 20])): MoldBounds {
  const bounds = meshBounds(mesh.positions);
  return moldBounds(mesh, bounds, fieldSettings(params, bounds));
}

describe('the rim of G8, at plan defaults', () => {
  const params = defaultParams();
  const bounds = boundsFor(params);
  const rim = deriveRim(bounds, params);

  it('has the offsets the plan tabulates', () => {
    expect(rim.e1).toBeCloseTo(2, 9);
    expect(rim.e2).toBeCloseTo(2.25, 9);
    expect(rim.e3).toBeCloseTo(3.85, 9);
    expect(rim.e4).toBeCloseTo(4.1, 9);
    expect(rim.e5).toBeCloseTo(6.1, 9);
  });

  it('derives D from the vertices alone, by hand on a box', () => {
    const reach = R_EFF + (20 + R_EFF) * tan1 + 0.5;
    expect(rim.D.x1).toBeCloseTo(10 + reach, 6);
    expect(rim.D.x0).toBeCloseTo(-10 - reach, 6);
    expect(rim.D.y1).toBeCloseTo(5 + reach, 6);
    expect(rim.D.y0).toBeCloseTo(-5 - reach, 6);
    expect(rim.hMax).toBeCloseTo(20 + R_EFF + 0.05, 6);
  });

  it('derives B, O and Zt, by hand', () => {
    const toBox = 0.1 + 3.8 * tan15 + 3;
    expect(rim.B.x1).toBeCloseTo(rim.D.x1 + 6.1, 9);
    expect(rim.O.x1).toBeCloseTo(rim.B.x1 + toBox, 9);
    expect(rim.O.y0).toBeCloseTo(rim.B.y0 - toBox, 9);
    expect(rim.Zt).toBeCloseTo(rim.hMax + 5, 9);
    expect(coverBottom(rim)).toBeCloseTo(-3.8, 9);
    // Rebate at the cover's bottom edge leaves exactly the wall.
    expect(rim.O.x1 - (rim.B.x1 + rebateOutset(rim, coverBottom(rim)))).toBeCloseTo(3, 9);
  });

  it('keeps the outer land at the set width and has the wall at its thinnest only at the bottom edge', () => {
    expect(rim.B.x1 - (rim.D.x1 + rim.e4)).toBeCloseTo(2, 9);
    expect(rebateOutset(rim, 0)).toBeCloseTo(0.1, 9);
    expect(rebateOutset(rim, -1)).toBeCloseTo(0.1 + tan15, 9);
  });

  it('reports no problem on sane values', () => {
    expect(rim.diagnostics).toEqual([]);
  });
});

describe('the rim per side', () => {
  it('a tall vertex near one side widens only that side', () => {
    const params = defaultParams();
    // A block with a tower at its +x end: draft pushes the +x side further out than the -x side.
    const mesh = { positions: new Float32Array([...box([-10, -5, 0], [10, 5, 5]).positions, ...box([8, -1, 0], [10, 1, 50]).positions]), indices: new Uint32Array([...box([-10, -5, 0], [10, 5, 5]).indices, ...Array.from(box([8, -1, 0], [10, 1, 50]).indices, (v) => v + 8)]) };
    const bounds = boundsFor(params, mesh);
    const short = R_EFF + (5 + R_EFF) * tan1 + 0.5;
    const tall = R_EFF + (50 + R_EFF) * tan1 + 0.5;
    expect(bounds.D.x0).toBeCloseTo(-10 - short, 6);
    expect(bounds.D.x1).toBeCloseTo(10 + tall, 6);
  });

  it('a vertex below the plane counts where its edges cross the plane, as the raster clips it there', () => {
    const params = defaultParams();
    // A straight stick leaning out, from (0, 0, 20) down to (10, 0, -20). It crosses the plane at x = 5.
    const mesh = {
      positions: new Float32Array([0, -1, 20, 0, 1, 20, 10, 0, -20]),
      indices: new Uint32Array([0, 1, 2]),
    };
    const bounds = boundsFor(params, mesh);
    const atPlane = R_EFF + R_EFF * tan1 + 0.5;
    const atTop = R_EFF + (20 + R_EFF) * tan1 + 0.5;
    expect(bounds.D.x1).toBeCloseTo(Math.max(5 + atPlane, 0 + atTop), 5);
    // Counting the vertex itself would give 10 + reach, well past the raster.
    expect(bounds.D.x1).toBeLessThan(9);
  });

  it('keeps the plan\'s 0.5 mm of slack up to the cell that needs more, and then follows the export cell', () => {
    const slackAt = (cellFinal: number): number => {
      const params = paramsWith((p) => (p.quality.cellFinal = cellFinal));
      const mesh = box([-10, -5, 0], [10, 5, 20]);
      const rEff = 3 + 2.13 * cellFinal + 0.1;
      return boundsFor(params, mesh).D.x1 - (10 + rEff + (20 + rEff) * tan1);
    };
    expect(slackAt(0.125)).toBeCloseTo(0.5, 6);
    expect(slackAt(0.25)).toBeCloseTo(0.5, 6);
    expect(slackAt(0.5)).toBeCloseTo(0.75, 6);
  });

  it('tiles widen the far sides by the pitch, from the export plan', () => {
    const params = paramsWith((p) => {
      p.grid.nx = 3;
      p.grid.ny = 2;
      p.grid.spacing = 7;
    });
    const single = boundsFor(defaultParams());
    const grid = boundsFor(params);
    expect(grid.offsets).toHaveLength(6);
    expect(grid.offsets[1]).toEqual([27, 0]);
    expect(grid.offsets[3]).toEqual([0, 17]);
    expect(grid.D.x1 - single.D.x1).toBeCloseTo(54, 6);
    expect(grid.D.y1 - single.D.y1).toBeCloseTo(17, 6);
    expect(grid.D.x0).toBeCloseTo(single.D.x0, 6);
    expect(grid.model).toEqual({ x0: -10, y0: -5, x1: 64, y1: 22 });
  });

  it('is the same at any preview cell', () => {
    const params = paramsWith((p) => {
      p.grid.nx = 2;
      p.grid.spacing = 4;
    });
    const mesh = box([-10.03, -5, 0], [10.04, 5, 20]);
    const bounds = meshBounds(mesh.positions);
    const final = moldBounds(mesh, bounds, fieldSettings(params, bounds));
    for (const cell of [0.25, 0.5, 1, 2]) {
      expect(moldBounds(mesh, bounds, fieldSettings(params, bounds, cell))).toEqual(final);
    }
  });
});

describe('the edge rule', () => {
  it('a wide edge gives exactly model + edge per side, with the extra on the outer land', () => {
    const params = paramsWith((p) => (p.grid.edge = 30));
    const bounds = boundsFor(params);
    const rim = deriveRim(bounds, params);
    expect(rim.O.x1).toBeCloseTo(10 + 30, 9);
    expect(rim.O.x0).toBeCloseTo(-10 - 30, 9);
    expect(rim.O.y1).toBeCloseTo(5 + 30, 9);
    expect(rim.O.y0).toBeCloseTo(-5 - 30, 9);
    expect(rim.diagnostics).toEqual([]);
    // The joint did not move with it, only its outer land grew.
    const auto = deriveRim(bounds, defaultParams());
    expect(rim.e4).toBe(auto.e4);
    expect(rim.D).toEqual(auto.D);
    expect(rim.B.x1 - (rim.D.x1 + rim.e4)).toBeGreaterThan(2);
  });

  it('an edge below what fits is raised, and says so with both numbers', () => {
    const params = paramsWith((p) => (p.grid.edge = 1));
    const rim = deriveRim(boundsFor(params), params);
    const auto = deriveRim(boundsFor(defaultParams()), defaultParams());
    expect(rim.O).toEqual(auto.O);
    expect(rim.diagnostics).toHaveLength(1);
    expect(rim.diagnostics[0].code).toBe('edge-raised');
    expect(rim.diagnostics[0].message).toBe(`Edge raised from 1.0 to ${rim.edge.minimum.toFixed(1)} mm, because the joint needs that much room around the cavity.`);
    expect(rim.edge.minimum).toBeCloseTo(auto.O.x1 - 10, 6);
  });

  it('an edge that fits on one side only is raised on the other only', () => {
    const params = defaultParams();
    const mesh = { positions: new Float32Array([...box([-10, -5, 0], [10, 5, 5]).positions, ...box([8, -1, 0], [10, 1, 150]).positions]), indices: new Uint32Array([...box([-10, -5, 0], [10, 5, 5]).indices, ...Array.from(box([8, -1, 0], [10, 1, 150]).indices, (v) => v + 8)]) };
    const bounds = boundsFor(params, mesh);
    const auto = deriveRim(bounds, params);
    const between = (auto.O.x1 - 10 + (-10 - auto.O.x0)) / 2;
    const rim = deriveRim(bounds, paramsWith((p) => (p.grid.edge = between)));
    expect(rim.O.x0).toBeCloseTo(-10 - between, 6);
    expect(rim.O.x1).toBeCloseTo(auto.O.x1, 6);
    expect(rim.diagnostics.map((d) => d.code)).toEqual(['edge-raised']);
  });
});

describe('cross-parameter rules', () => {
  it('Zt keeps the cap over the groove on a model too low to set it', () => {
    const params = paramsWith((p) => (p.joint.ridgeHeight = 10));
    const rim = deriveRim({ ...boundsFor(params), hMax: 2 }, params);
    expect(rim.Zt).toBeCloseTo(10 + 0.3 + 5, 9);
  });

  it('a ridge narrowed away at its top is an error, as it could not be built', () => {
    const params = paramsWith((p) => {
      p.joint.ridgeWidth = 0.8;
      p.joint.ridgeHeight = 3;
    });
    expect(deriveRim(boundsFor(params), params).diagnostics.map((d) => [d.code, d.severity])).toEqual([['ridge-too-thin', 'error']]);
  });

  it('warns when the ridge could touch before the taper', () => {
    const params = paramsWith((p) => (p.joint.grooveClearance = 0.1));
    expect(deriveRim(boundsFor(params), params).diagnostics.map((d) => [d.code, d.severity])).toEqual([['joint-clearance', 'warning']]);
  });

  it('keeps pry notches below the shelf on a thin base', () => {
    const params = paramsWith((p) => {
      p.base.thickness = 3;
      p.joint.pryHeight = 5;
    });
    const rim = deriveRim(boundsFor(params), params);
    expect(rim.pryHeight).toBeCloseTo(3 - 0.2 - 0.5, 9);
    expect(rim.diagnostics.map((d) => d.code)).toEqual(['pry-clamped']);
    expect(coverBottom(rim) + rim.pryHeight).toBeLessThan(0);
  });

  it('turning the notches off removes them, from the solid too', () => {
    const wallPieces = (params: Params): { pieces: number; area: number } => {
      const rim = deriveRim(boundsFor(params), params);
      return withArena(api, (arena) => {
        const cover = buildCoverBody(arena, rim, boxSolid(arena, [-13, -8, TOOL_BOTTOM], [13, 8, rim.hMax]));
        const section = arena.track(cover.slice(coverBottom(rim) + 0.6));
        return { pieces: arena.trackAll(section.decompose()).length, area: section.area() };
      });
    };
    const off = paramsWith((p) => (p.joint.pryNotches = false));
    expect(deriveRim(boundsFor(off), off).pryHeight).toBe(0);
    const without = wallPieces(off);
    const withNotches = wallPieces(defaultParams());
    expect(without.pieces).toBe(1);
    expect(withNotches.pieces).toBe(2);
    // Two notches 12 wide, through a wall 3 mm thick at the bottom edge and a little more 0.6 higher.
    const rim = deriveRim(boundsFor(off), off);
    expect(without.area - withNotches.area).toBeCloseTo(2 * 12 * (3 + 0.6 * rim.tanTaper), 3);
  });

  it('a groove no deeper than the ridge is an error: the ridge meets its roof and holds the base off the shelf', () => {
    for (const depth of [0, -0.1]) {
      const params = paramsWith((p) => (p.joint.grooveExtraDepth = depth));
      expect(deriveRim(boundsFor(params), params).diagnostics.map((d) => [d.code, d.severity])).toEqual([['groove-too-shallow', 'error']]);
    }
    const params = paramsWith((p) => (p.joint.grooveExtraDepth = 0.05));
    expect(deriveRim(boundsFor(params), params).diagnostics).toEqual([]);
  });

  describe('a corner radius past the room around the cavity', () => {
    // At defaults D to B is e5, 6.1 mm on every side.
    const ROOM = 6.1;

    it('below the room it stands, and the rings follow it inside the land', () => {
      const params = paramsWith((p) => (p.base.cornerRadius = 5));
      const rim = deriveRim(boundsFor(params), params);
      expect(rim.cornerRadius).toBe(5);
      expect(rim.diagnostics).toEqual([]);
      // 4.1 from the inner ring out to the plate leaves it 0.9 of the 5.
      expect(wallRing(rim, rim.e1, rim.tanRidge, 0).radius).toBeCloseTo(0.9, 9);
      expect(wallRing(rim, rim.e4, -rim.tanRidge, 0).radius).toBeCloseTo(3, 9);
    });

    it.each([ROOM + 0.1, 12, 30])('%f is lowered to it, and says so', (radius) => {
      const params = paramsWith((p) => (p.base.cornerRadius = radius));
      const rim = deriveRim(boundsFor(params), params);
      expect(rim.cornerRadius).toBeCloseTo(ROOM, 9);
      expect(rim.diagnostics.map((d) => [d.code, d.severity])).toEqual([['corner-clamped', 'info']]);
      expect(rim.diagnostics[0].message).toContain(`from ${radius.toFixed(1)} to 6.1`);
    });

    it('a wide edge makes more room, so more of the radius stands', () => {
      const params = paramsWith((p) => {
        p.base.cornerRadius = 12;
        p.grid.edge = 40;
      });
      const rim = deriveRim(boundsFor(params), params);
      expect(rim.cornerRadius).toBe(12);
      expect(rim.diagnostics).toEqual([]);
    });

    it.each([ROOM, 12, 30])('at %f the land holds at D\'s very corner, with the cavity filling D, and the cavity stays closed', (radius) => {
      const params = paramsWith((p) => (p.base.cornerRadius = radius));
      const rim = deriveRim(boundsFor(params), params);
      withArena(api, (arena) => {
        const { track } = arena;
        const { D } = rim;
        // The worst a cavity can do: run right out to D's corners.
        const tool = boxSolid(arena, [D.x0, D.y0, TOOL_BOTTOM], [D.x1, D.y1, rim.hMax]);
        const cover = buildCoverBody(arena, rim, tool);
        const hole = [[D.x0, D.y0], [D.x1, D.y0], [D.x1, D.y1], [D.x0, D.y1]] as [number, number][];
        const flat = (r: { rect: Parameters<typeof ringPoints>[0]; radius: number; z: number }): [number, number][] => ringPoints(r.rect, r.radius, r.z).map((p) => [(p as number[])[0], (p as number[])[1]]);
        // A ring's corner is chords on a circle, with 16 to the quarter, which is all the land gives up: 2.4 microns here.
        const chord = Math.cos(Math.PI / 4 / 16);
        expect(contourDistance(flat(wallRing(rim, rim.e1, rim.tanRidge, 0)), hole)).toBeGreaterThanOrEqual(rim.e1 * chord - 1e-9);
        // And out from the groove to the plate's edge.
        const plate = flat({ rect: rim.B, radius: rim.cornerRadius, z: 0 });
        expect(contourDistance(flat(wallRing(rim, rim.e4, -rim.tanRidge, 0)), plate)).toBeGreaterThanOrEqual(params.joint.landOuter * chord - 1e-9);
        const base = buildBaseBody(arena, rim, { plateTop: 0.01 });
        const { voids } = splitShells(arena, track(cover.add(base)));
        // Cavity and groove, apart: open them into one and this is the list that changes.
        expect(voids.filter((v) => v.volume >= 1e-3)).toHaveLength(2);
      });
    });

    it('negative control: with the radius forced past the room, the groove does open into a cavity that fills D', () => {
      const params = paramsWith((p) => (p.base.cornerRadius = 30));
      const rim = { ...deriveRim(boundsFor(params), params), cornerRadius: 30 };
      withArena(api, (arena) => {
        const { D } = rim;
        const cover = buildCoverBody(arena, rim, boxSolid(arena, [D.x0, D.y0, TOOL_BOTTOM], [D.x1, D.y1, rim.hMax]));
        const { voids } = splitShells(arena, arena.track(cover.add(buildBaseBody(arena, rim, { plateTop: 0.01 }))));
        expect(voids.filter((v) => v.volume >= 1e-3).length).toBeLessThan(2);
      });
    });
  });

  it('a tool past the rebate at z=-2 is an error', () => {
    const params = defaultParams();
    const rim = deriveRim(boundsFor(params), params);
    const inside = outset(rim.B, rebateOutset(rim, -2) - 0.01);
    expect(toolDiagnostics(rim, { domain: inside, clippedNodes: 0 })).toEqual([]);
    const outside = outset(rim.B, rebateOutset(rim, -2) + 0.01);
    expect(toolDiagnostics(rim, { domain: outside, clippedNodes: 0 }).map((d) => [d.code, d.severity])).toEqual([['tool-outside-rebate', 'error']]);
  });

  // The rule that ring radii are clamped to be non-negative, over values that would otherwise break it.
  it.each([
    ['sharp corners', (p: Params) => (p.base.cornerRadius = 0)],
    ['rounder corners than the land', (p: Params) => (p.base.cornerRadius = 12)],
    ['a narrow land', (p: Params) => ((p.joint.landOuter = 0.8), (p.joint.landInner = 0.8))],
    ['a wide edge', (p: Params) => (p.grid.edge = 40)],
    ['a steep taper', (p: Params) => (p.joint.taperDeg = 30)],
    ['a shallow taper', (p: Params) => (p.joint.taperDeg = 5)],
    ['the thinnest base', (p: Params) => (p.base.thickness = 3)],
    ['the thickest base', (p: Params) => (p.base.thickness = 20)],
    ['no top chamfer', (p: Params) => (p.cover.topChamfer = 0)],
    ['no notches', (p: Params) => (p.joint.pryNotches = false)],
    ['a tall ridge', (p: Params) => ((p.joint.ridgeHeight = 2.5), (p.joint.ridgeDraftDeg = 5))],
    ['a wide clearance', (p: Params) => ((p.joint.taperClearance = 0.4), (p.joint.grooveClearance = 0.6))],
  ])('%s still gives one closed cover and base that do not touch but at the shelf', (_, change) => {
    const params = paramsWith(change);
    const rim = deriveRim(boundsFor(params), params);
    expect(rim.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    withArena(api, (arena) => {
      const tool = boxSolid(arena, [-13, -8, TOOL_BOTTOM], [13, 8, rim.hMax]);
      const cover = buildCoverBody(arena, rim, tool);
      const base = buildBaseBody(arena, rim);
      expect(splitShells(arena, cover).bodies).toHaveLength(1);
      expect(splitShells(arena, base).bodies).toHaveLength(1);
      expect(arena.track(cover.intersect(base)).volume()).toBeLessThan(0.01);
      const flank = arena.track(base.trimByPlane([0, 0, -1], 1));
      expect(flank.minGap(cover, 1)).toBeCloseTo(rim.cT * rim.cosTaper, 2);
      expect(arena.track(base.trimByPlane([0, 0, 1], 0.02)).minGap(cover, 1)).toBeGreaterThanOrEqual(Math.min(rim.cG * rim.cosRidge, rim.grooveExtra) - 0.005);
    });
  });
});

describe('rings', () => {
  it('have the points and the area they say', () => {
    const rect = { x0: -7, y0: -3, x1: 9, y1: 4 };
    expect(ringPoints(rect, 0, 1.5)).toEqual([[-7, -3, 1.5], [9, -3, 1.5], [9, 4, 1.5], [-7, 4, 1.5]]);
    withArena(api, (arena) => {
      const { track } = arena;
      for (const radius of [0, 0.5, 3]) {
        const solid = ringHull(arena, [{ rect, radius, z: 0 }, { rect, radius, z: 2 }]);
        expect(track(solid.slice(1)).area()).toBeCloseTo(ringArea(rect, radius), 6);
        expect(solid.volume()).toBeCloseTo(2 * ringArea(rect, radius), 6);
      }
    });
  });

  it('never get a radius wider than half the rectangle', () => {
    const points = ringPoints({ x0: 0, y0: 0, x1: 2, y1: 10 }, 5, 0);
    expect(Math.max(...points.map((p) => (p as number[])[0]))).toBeLessThanOrEqual(2);
    expect(Math.min(...points.map((p) => (p as number[])[0]))).toBeGreaterThanOrEqual(0);
  });
});

describe('the joint', () => {
  const params = defaultParams();
  const rim = deriveRim(boundsFor(params), params);

  it('the groove residual computed from the rim equals the same from the solids', () => {
    withArena(api, (arena) => {
      const { track } = arena;
      const groove = grooveSolid(arena, rim);
      const ridge = ridgeSolid(arena, rim);
      const plate = 0.01;
      const above = (solid: typeof groove): number => track(solid.trimByPlane([0, 0, 1], plate)).volume();
      expect(grooveResidualVolume(rim, plate)).toBeCloseTo(above(groove) - above(ridge), 6);
    });
  });

  it('narrows upward at the draft, so the ridge never binds as it seats', () => {
    withArena(api, (arena) => {
      const { track } = arena;
      const ridge = ridgeSolid(arena, rim);
      const width = (z: number): number => {
        const section = track(ridge.slice(z));
        const outer = section.bounds();
        return outer.max[0] - outer.min[0];
      };
      expect(width(0.1) - width(1.1)).toBeCloseTo(2 * rim.tanRidge, 6);
    });
  });

  it('groove clearance beats taper clearance at defaults, by at least 0.15', () => {
    expect(rim.cG - rim.cT).toBeGreaterThanOrEqual(0.15 - 1e-9);
  });
});

describe('the mask check', () => {
  it('passes a field inside D, and catches a node past it by the cell it pulls the surface on', () => {
    const D = { x0: 0, y0: 0, x1: 10, y1: 10 };
    const field = { nx: 4, ny: 1, cell: 2, x0: 2, y0: 4, values: new Float32Array([0, 1, 1, 0]) };
    // Nodes above 0 at x = 4 and 6, with their surface reaching on to 2 and 8.
    expect(maskOverrun(field, D)).toBe(0);
    field.values[3] = 1;
    // A node at x = 8 reaches 10, right on D.
    expect(maskOverrun(field, D)).toBe(0);
    expect(maskOverrun(field, { ...D, x1: 9.5 })).toBeCloseTo(0.5, 9);
  });
});
