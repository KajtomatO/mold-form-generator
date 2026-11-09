import type { Manifold, ManifoldToplevel, Vec2 } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { emptyField, fieldSettings } from '../../src/core/field/grid';
import { meshBounds } from '../../src/core/mesh/weld';
import { defaultParams, resolveAuto } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';
import { boltCavityDiagnostics, boltCavityWall, boltCavityWallAnywhere, boltClearances, boltName, boltNeeds, boltRimDiagnostics, coverBoltCutters, slotOutline, type RimWalls } from '../../src/core/parts/bolts';
import { BOLT_HOLD_N, BOLT_LENGTHS, BRIDGE_LIMIT, FASTENERS, standardLength } from '../../src/core/parts/fasteners';
import { boltWalls, deriveRim, moldBounds, notchBoxes, type MoldBounds, type Rim } from '../../src/core/parts/rim';
import { boltAdvice, SEAL_SPACING_MM } from '../../src/core/report/clamp';
import { buildField } from '../../src/core/field/build';
import { planField } from '../../src/core/field/grid';
import { buildBoltCoupon, type BoltCoupon } from '../../src/core/parts/fitTest';
import { withArena, type Arena } from '../../src/core/solid/arena';
import { outset } from '../../src/core/solid/rect';
import { orientedExample } from '../fixtures/fieldRuns';
import { EXAMPLE_IDS, loadManifold, type ExampleId } from '../fixtures/loadExamples';
import { clipToBox, holeCentres } from '../fixtures/solidChecks';
import { box } from '../fixtures/synthetic';

let api: ManifoldToplevel;
beforeAll(async () => {
  api = await loadManifold();
});

const DEG = Math.PI / 180;

function bolted(change: (p: Params) => void = () => {}): Params {
  const params = defaultParams();
  params.bolts.enabled = true;
  change(params);
  return params;
}

function boundsOf(id: ExampleId, params: Params): MoldBounds {
  const { mesh, bounds } = orientedExample(id);
  return moldBounds(mesh, bounds, fieldSettings(params, bounds));
}

const codes = (rim: Rim): string[] => rim.diagnostics.map((d) => d.code);
const said = (rim: Rim, code: string): string => rim.diagnostics.find((d) => d.code === code)?.message ?? '';
const wallsOf = (rim: Rim): RimWalls => ({ ...rim, notches: notchBoxes(rim).map((n) => ({ x0: n.x0, y0: n.y0, x1: n.x1, y1: n.y1, z0: n.bottom - 1, z1: n.top })) });

describe('the fasteners, by their standards', () => {
  it('ISO 4032 nuts and 90 degree countersunk heads, ISO 10642 for M3 and M4 and ISO 14581 for M2.5', () => {
    expect(FASTENERS.M3).toMatchObject({ d: 3, pitch: 0.5, headDiameter: 6.72, headHeight: 1.86, screw: 'ISO 10642', nutFlats: 5.5, nutHeight: 2.4 });
    expect(FASTENERS.M4).toMatchObject({ d: 4, pitch: 0.7, headDiameter: 8.96, headHeight: 2.48, screw: 'ISO 10642', nutFlats: 7, nutHeight: 3.2 });
    expect(FASTENERS['M2.5']).toMatchObject({ d: 2.5, pitch: 0.45, headDiameter: 5.5, headHeight: 1.5, screw: 'ISO 14581', nutFlats: 5, nutHeight: 2 });
    // A 90 degree head's cone is as high as it is wide over the thread, on each side.
    for (const f of Object.values(FASTENERS)) expect(f.headHeight).toBeCloseTo((f.headDiameter - f.d) / 2, 9);
    expect(standardLength(10.3)).toBe(12);
    expect(standardLength(12)).toBe(12);
    expect(standardLength(41)).toBeNull();
    expect(BOLT_LENGTHS[0]).toBe(6);
  });
});

describe('what the bolts need, from the parameters', () => {
  it('M3 at defaults, by hand: hole 3.4, countersink 7.12 and 1.86 deep, slot 5.8 by 2.9, edge 4.095 and land 6.146', () => {
    const n = boltNeeds(bolted());
    expect(n.holeRadius).toBeCloseTo(1.7, 9);
    expect(n.sinkRadius).toBeCloseTo(3.56, 9);
    expect(n.sinkDepth).toBeCloseTo(1.86, 9);
    expect(n.slotWidth).toBeCloseTo(5.8, 9);
    // The nut, its clearance above and below, and a layer for the bridge to sag into.
    expect(n.slotHeight).toBeCloseTo(2.4 + 0.3 + 0.2, 9);
    // A wall over the groove's roof, which is the ridge and its extra depth.
    expect(n.slotFloorMin).toBeCloseTo(1.2 + 0.3 + 1.2, 9);
    // The countersink's wall at the underside sets the edge: the plate reaches (Tb - relief) tan 15 - run past B there.
    const foot = (4 - 0.4) * Math.tan(15 * DEG) - 0.3;
    expect(n.edge).toBeCloseTo(3.56 + 1.2 - foot, 9);
    expect(n.edge).toBeGreaterThan(1.7 + 1.2);
    // On the diagonal the hole keeps its wall to the groove's sharp corner.
    expect(n.land).toBeCloseTo(n.edge + 2.9 / Math.SQRT2, 9);
    expect(n.land).toBeCloseTo(6.146, 3);
    // Base, slot's floor moved up to a layer at most, the nut and two threads: 10.3, so 12 mm.
    expect(n.autoLength).toBe(12);
    expect(n.length).toBe(12);
  });

  it('M2.5 and M4 by hand: lands of 5.36 and 7.62, and 7.89 for M4 on a 3 mm base', () => {
    // edge = rk + w - ((Tb - 0.4) tan 15 - 0.3), land = edge + (d / 2 + 0.2 + w) / sqrt 2.
    const foot = (Tb: number): number => (Tb - 0.4) * Math.tan(15 * DEG) - 0.3;
    const small = boltNeeds(bolted((p) => (p.bolts.size = 'M2.5')));
    expect(small.edge).toBeCloseTo(2.95 + 1.2 - foot(4), 9);
    expect(small.land).toBeCloseTo(2.95 + 1.2 - foot(4) + 2.65 / Math.SQRT2, 9);
    expect(small.land).toBeCloseTo(5.359, 3);
    const big = boltNeeds(bolted((p) => (p.bolts.size = 'M4')));
    expect(big.land).toBeCloseTo(4.68 + 1.2 - foot(4) + 3.4 / Math.SQRT2, 9);
    expect(big.land).toBeCloseTo(7.620, 3);
    const thin = boltNeeds(bolted((p) => {
      p.bolts.size = 'M4';
      p.base.thickness = 3;
    }));
    expect(thin.land).toBeCloseTo(4.68 + 1.2 - foot(3) + 3.4 / Math.SQRT2, 9);
    expect(thin.land).toBeCloseTo(7.8875, 4);
  });

  it('at a steep taper and a wide wall, the edge keeps the wall square to the plate\'s leaning side, which a real rim then never clashes with', () => {
    // M3, Tb 4, taper 30, wall 5: square to the side the countersink's rim needs rk + w / cos 30 - Tb tan 30 = 7.024,
    // past the 6.782 the wall along the underside gives.
    const steep = bolted((p) => {
      p.joint.taperDeg = 30;
      p.bolts.minWall = 5;
    });
    const n = boltNeeds(steep);
    expect(n.edge).toBeCloseTo(3.56 + 5 / Math.cos(30 * DEG) - 4 * Math.tan(30 * DEG), 9);
    expect(n.edge).toBeGreaterThan(3.56 + 5 - ((4 - 0.4) * Math.tan(30 * DEG) - 0.3));
    for (const taperDeg of [5, 15, 25, 30]) {
      for (const minWall of [0.4, 1.2, 3, 5]) {
        for (const size of ['M2.5', 'M3', 'M4'] as const) {
          const params = bolted((p) => {
            p.joint.taperDeg = taperDeg;
            p.bolts.minWall = minWall;
            p.bolts.size = size;
          });
          const rim = deriveRim(boundsOf('jersey', params), params);
          const walls = boltWalls(rim)!;
          const at = `${size}, taper ${taperDeg}, wall ${minWall}`;
          expect(walls.plate.wall, at).toBeGreaterThanOrEqual(minWall - 1e-9);
          expect(codes(rim), at).not.toContain('bolt-collision');
        }
      }
    }
    // Where that term sets the edge, the wall is exactly the least wall.
    expect(boltWalls(deriveRim(boundsOf('jersey', steep), steep))!.plate.wall).toBeCloseTo(5, 9);
  });

  it('the auto length follows the size and the base, and an edited one is kept', () => {
    expect(boltNeeds(bolted((p) => (p.bolts.size = 'M2.5'))).autoLength).toBe(10);
    expect(boltNeeds(bolted((p) => (p.bolts.size = 'M4'))).autoLength).toBe(12);
    expect(boltNeeds(bolted((p) => (p.base.thickness = 6))).autoLength).toBe(16);
    expect(boltNeeds(bolted((p) => (p.bolts.length = 20))).length).toBe(20);
    expect(resolveAuto(bolted((p) => (p.base.thickness = 6)), meshBounds(box([0, 0, 0], [1, 1, 1]).positions)).boltLength).toBe(16);
  });
});

describe('the rim with bolts', () => {
  const off = deriveRim(boundsOf('jersey', defaultParams()), defaultParams());
  const on = deriveRim(boundsOf('jersey', bolted()), bolted());
  const b = on.bolts!;

  it('is the plain rim with the bolts off', () => {
    expect(off.bolts).toBeNull();
    expect(off.e5 - off.e4).toBe(2);
    expect(codes(off).filter((c) => c.startsWith('bolt'))).toEqual([]);
  });

  it('computes the edge distance the bolts need: the outer land grows to their land, and B, O and the edge minimum with it', () => {
    const grow = b.land - 2;
    expect(on.e5 - on.e4).toBeCloseTo(b.land, 9);
    for (const side of ['x0', 'y0'] as const) expect(off.B[side] - on.B[side]).toBeCloseTo(grow, 9);
    for (const side of ['x1', 'y1'] as const) expect(on.B[side] - off.B[side]).toBeCloseTo(grow, 9);
    expect(on.O.x1 - on.B.x1).toBeCloseTo(off.O.x1 - off.B.x1, 9);
    expect(on.edge.minimum - off.edge.minimum).toBeCloseTo(grow, 9);
    expect(on.D).toEqual(off.D);
    expect(on.Zt).toBe(off.Zt);
    expect(said(on, 'bolt-land')).toBe('The outer land grows from 2.0 to 6.1 mm to hold the M3 bolts with a wall of 1.2 mm round them, so the box is 8.3 mm wider each way.');
    // A wide edge already holds them: the land grows past the bolts' need, which places them as far out as the edge allows.
    const withEdge = (edge: number, bolts: boolean): Rim => {
      const params = bolts ? bolted((p) => (p.grid.edge = edge)) : (() => {
        const p = defaultParams();
        p.grid.edge = edge;
        return p;
      })();
      return deriveRim(boundsOf('jersey', params), params);
    };
    const wide = withEdge(30, true);
    expect(wide.O.x1 - wide.bolts!.spots[3].x).toBeCloseTo(on.O.x1 - b.spots[3].x, 9);
    expect(wide.O.x1 - boundsOf('jersey', defaultParams()).model.x1).toBeCloseTo(30, 9);
    // The box is the edge's, as with the bolts off, so no note says it grew.
    expect(wide.O).toEqual(withEdge(30, false).O);
    expect(codes(wide)).not.toContain('bolt-land');
    // An edge between the joint's minimum and the bolts' grows the box by less, and the note gives that growth.
    const off16 = withEdge(16, false), on16 = withEdge(16, true);
    expect(off16.edge.minimum).toBeLessThan(16);
    expect(on16.edge.minimum).toBeGreaterThan(16);
    const grows = [on16.O.x1 - on16.O.x0 - (off16.O.x1 - off16.O.x0), on16.O.y1 - on16.O.y0 - (off16.O.y1 - off16.O.y0)];
    // The cavity reaches past the model by a different amount on each side, so the two ways differ: 5.3 and 4.6 mm.
    expect(grows[0]).toBeCloseTo(5.3, 1);
    expect(grows[1]).toBeCloseTo(4.6, 1);
    expect(said(on16, 'bolt-land')).toBe(`The outer land grows from 2.0 to 6.1 mm to hold the M3 bolts with a wall of 1.2 mm round them, so the box grows by ${grows[0].toFixed(1)} mm from left to right and ${grows[1].toFixed(1)} mm from front to back.`);
    // Under both minimums the edge is raised, and the bolts are named as the reason with the joint.
    expect(said(withEdge(9, true), 'edge-raised')).toBe(`Edge raised from 9.0 to ${on.edge.minimum.toFixed(1)} mm, because the joint and the bolts in its corners need that much room around the cavity.`);
    expect(said(withEdge(9, false), 'edge-raised')).toBe(`Edge raised from 9.0 to ${off.edge.minimum.toFixed(1)} mm, because the joint needs that much room around the cavity.`);
  });

  it('puts one bolt in each corner, edge in from both of B\'s sides, with each slot out through the short side', () => {
    const { B } = on;
    expect(b.spots.map((s) => [s.x, s.y])).toEqual([[B.x0 + b.edge, B.y0 + b.edge], [B.x1 - b.edge, B.y0 + b.edge], [B.x0 + b.edge, B.y1 - b.edge], [B.x1 - b.edge, B.y1 - b.edge]]);
    expect(b.spots.map(boltName)).toEqual(['front left', 'front right', 'back left', 'back right']);
    // Jersey's box is wider than deep, so the pry notches are on the front and back, and the slots open at the sides.
    expect(on.O.x1 - on.O.x0).toBeGreaterThan(on.O.y1 - on.O.y0);
    expect(b.spots.map((s) => s.exit)).toEqual(['x0', 'x1', 'x0', 'x1']);
    // A box deeper than wide turns them the other way.
    const deep = deriveRim(boundsOf('vis35', bolted()), bolted());
    expect(deep.bolts!.spots.map((s) => s.exit)).toEqual(['y0', 'y0', 'y1', 'y1']);
    // Each slot runs from the hex round the axis out past its wall.
    const outline = slotOutline(b, b.spots[1]);
    expect(Math.max(...outline.map((p) => p[0]))).toBeCloseTo(on.O.x1 + 1, 9);
    expect(Math.min(...outline.map((p) => p[0]))).toBeCloseTo(b.spots[1].x - b.slotWidth / Math.sqrt(3), 9);
    expect(Math.max(...outline.map((p) => p[1])) - Math.min(...outline.map((p) => p[1]))).toBeCloseTo(b.slotWidth, 9);
  });

  it('puts the slot\'s floor on a layer boundary from the flat top, so the membrane is one layer, and nothing reaches Zt', () => {
    const layers = (on.Zt - b.slotFloor) / b.layer;
    expect(Math.abs(layers - Math.round(layers))).toBeLessThan(1e-9);
    expect(b.slotFloor - b.slotFloorMin).toBeGreaterThanOrEqual(-1e-9);
    expect(b.slotFloor - b.slotFloorMin).toBeLessThan(b.layer);
    expect(b.layer).toBe(0.2);
    expect(b.slotTop - b.slotFloor).toBeCloseTo(b.slotHeight, 9);
    // The hole over the nut: the screw's end, recessed by the head's clearance, and a mm.
    expect(b.holeTop).toBeCloseTo(12 - 4 + 0.2 + 1, 9);
    expect(on.Zt - b.holeTop).toBeGreaterThanOrEqual(b.minWall);
    expect(b.reach).toBeCloseTo(4 + b.slotFloor + 2.4 + 1, 9);
    expect(b.length).toBeGreaterThanOrEqual(b.reach);
    // At 0.3 mm layers too.
    const thick = deriveRim(boundsOf('jersey', bolted((p) => (p.print.layerHeight = 0.3))), bolted((p) => (p.print.layerHeight = 0.3)));
    const at = (thick.Zt - thick.bolts!.slotFloor) / 0.3;
    expect(Math.abs(at - Math.round(at))).toBeLessThan(1e-9);
  });

  it('raises Zt on a model too low for the shortest bolt and its slot, and only then', () => {
    const low = (p: Params): void => {
      p.cover.topCap = 3;
    };
    const mesh = box([-10, -5, 0], [10, 5, 1]);
    const bounds = meshBounds(mesh.positions);
    const mold = (params: Params): MoldBounds => moldBounds(mesh, bounds, fieldSettings(params, bounds));
    const plain = deriveRim(mold(defaultParams()), (() => {
      const p = defaultParams();
      low(p);
      return p;
    })());
    const rim = deriveRim(mold(bolted(low)), bolted(low));
    expect(plain.Zt).toBeLessThan(rim.bolts!.coverHeight);
    expect(rim.Zt).toBeCloseTo(rim.bolts!.coverHeight, 9);
    expect(rim.Zt - rim.bolts!.holeTop).toBeGreaterThanOrEqual(1.2 - 1e-9);
    expect(codes(rim)).not.toContain('bolt-long');
    // The maker is told, under Top cap and Bolt size: 12 - 4 + 0.2 + 1 for the hole and 1.2 over it is 10.4.
    expect(rim.Zt).toBeCloseTo(10.4, 9);
    expect(said(rim, 'bolt-cover-raised')).toBe(`The flat top is raised from ${plain.Zt.toFixed(1)} to 10.4 mm, ${(10.4 - plain.Zt).toFixed(1)} mm over what Top cap asks, so the M3 x 12 mm screws and their nut slots keep a wall of 1.2 mm under it. A smaller bolt size lowers it.`);
    expect(rim.diagnostics.find((d) => d.code === 'bolt-cover-raised')).toMatchObject({ severity: 'info', also: ['bolts.size'] });
    // Jersey's own top is far above, so it stays, and nothing is said.
    expect(on.Zt).toBeGreaterThan(b.coverHeight);
    expect(codes(on)).not.toContain('bolt-cover-raised');
  });

  it('gives way with the plate\'s corner radius, so a corner never comes nearer a bolt than its sides', () => {
    const round = bolted((p) => (p.base.cornerRadius = 10));
    const rim = deriveRim(boundsOf('jersey', round), round);
    expect(rim.cornerRadius).toBeCloseTo(rim.bolts!.edge, 9);
    expect(said(rim, 'corner-clamped')).toBe(`Corner radius lowered from 10.0 to ${rim.bolts!.edge.toFixed(1)} mm, as a rounder corner would cut into the bolt holes in the corners.`);
    expect(on.cornerRadius).toBe(3);
  });
});

describe('the warnings on the bolts', () => {
  const rimFor = (change: (p: Params) => void, id: ExampleId = 'jersey'): Rim => {
    const params = bolted(change);
    return deriveRim(boundsOf(id, params), params);
  };

  it('none at defaults on any size but the land, which is an info', () => {
    for (const size of ['M2.5', 'M3', 'M4'] as const) {
      const rim = rimFor((p) => (p.bolts.size = size));
      expect(rim.diagnostics.filter((d) => d.code.startsWith('bolt')).map((d) => [d.code, d.severity]), size).toEqual([['bolt-land', 'info']]);
    }
  });

  it('M4 at a 3 mm base: the countersink leaves too little plate, and the value to raise it to is given', () => {
    const rim = rimFor((p) => {
      p.bolts.size = 'M4';
      p.base.thickness = 3;
    });
    // 2.48 deep leaves 0.52; it needs 1 mm, so 3.48, which is 3.6 in whole layers.
    expect(rim.bolts!.sinkDepth).toBeCloseTo(2.48, 9);
    expect(said(rim, 'bolt-plate-thin')).toBe('The M4 countersinks are 2.48 mm deep, which leaves 0.52 mm of plate over them, under the 1.0 mm a printed plate needs so the heads do not pull through: raise Base thickness to at least 3.6 mm, or use a smaller bolt.');
    expect(rim.diagnostics.find((d) => d.code === 'bolt-plate-thin')).toMatchObject({ severity: 'warning', also: ['bolts.size'] });
    // M3 there is enough, and so is M4 at the default base.
    expect(codes(rimFor((p) => (p.base.thickness = 3)))).not.toContain('bolt-plate-thin');
    expect(codes(rimFor((p) => (p.bolts.size = 'M4')))).not.toContain('bolt-plate-thin');
    // At thick layers the 4 layers count: 0.3 mm layers want 1.2 mm.
    const thick = rimFor((p) => {
      p.print.layerHeight = 0.3;
      p.base.thickness = 3;
    });
    expect(said(thick, 'bolt-plate-thin')).toContain('under the 1.2 mm a printed plate needs');
  });

  it('a screw too short to pass the nut, and one too long for the cover, each with the length to use', () => {
    const short = rimFor((p) => (p.bolts.length = 10));
    expect(said(short, 'bolt-short')).toBe(`An M3 x 10 mm screw does not reach through the nut with 1.0 mm of thread past it, which takes ${short.bolts!.reach.toFixed(1)} mm from the base's underside: use 12 mm or longer.`);
    expect(codes(rimFor((p) => (p.bolts.length = 12)))).not.toContain('bolt-short');
    const long = rimFor((p) => (p.bolts.length = 40));
    expect(said(long, 'bolt-long')).toBe('An M3 x 40 mm screw is too long for this cover: its hole stops 1.2 mm under the flat top, so the screw would bottom out before it clamps. Use 30 mm or shorter.');
    // The hole stops a wall under the top all the same: nothing reaches Zt.
    expect(long.bolts!.holeTop).toBeCloseTo(long.Zt - 1.2, 9);
    expect(codes(rimFor((p) => (p.bolts.length = 30)))).not.toContain('bolt-long');
  });

  it('a bridge longer than prints flat, past 10 mm across the slot', () => {
    expect(BRIDGE_LIMIT).toBe(10);
    const wide = rimFor((p) => {
      p.bolts.size = 'M4';
      p.bolts.nutClearance = 1.6;
    });
    expect(wide.bolts!.slotWidth).toBeCloseTo(10.2, 9);
    expect(said(wide, 'bolt-bridge')).toBe("Each nut slot's ceiling bridges 10.2 mm in print pose, past the 10 mm that prints flat without supports on most printers: use a smaller nut clearance or bolt size.");
    expect(codes(rimFor((p) => (p.bolts.size = 'M4')))).not.toContain('bolt-bridge');
  });
});

describe('the walls the bolts leave', () => {
  const params = bolted();
  const mold = boundsOf('jersey', params);
  const rim = deriveRim(mold, params);
  const b = rim.bolts!;

  it('at least the least wall to everything at defaults, and exactly it where the land is set', () => {
    const walls = boltWalls(rim)!;
    expect(walls.groove.wall).toBeCloseTo(1.2, 9);
    expect(walls.plate.wall).toBeCloseTo(1.2, 9);
    // On the shelf, between the hole and the rebate's mouth: edge + cT - the hole.
    expect(walls.outside.wall).toBeCloseTo(b.edge + 0.1 - b.holeRadius, 9);
    // The slot sits over the notch's top by its floor and half a mm.
    expect(walls.notches.wall).toBeGreaterThan(b.slotFloor);
  });

  // The fixtures built to collide: each wall the check reads, brought under the least by hand.
  it('names a clash with the groove, the outside, the plate and a pry notch, and what to change', () => {
    const clash = (walls: RimWalls): string[] => boltRimDiagnostics(walls).filter((d) => d.code === 'bolt-collision').map((d) => d.message);
    const base = wallsOf(rim);
    expect(clash(base)).toEqual([]);
    expect(clash({ ...base, e4: base.e4 + 0.5 })[0]).toMatch(/^The front left bolt's hole in the cover comes within 0\.\d\d mm of the groove and ridge, under the least wall of 1\.2 mm: raise Outer land under Advanced, Joint, or use a smaller bolt\.$/);
    // Past the slot's wall to the side it does not open through: edge + toBox - half the slot, 4.095 + 4.118 - 2.9 = 5.31.
    expect(clash({ ...base, O: outset(base.O, -4) })).toEqual([]);
    expect(clash({ ...base, O: outset(base.O, -4.5) })).toEqual(["The front left nut slot comes within 0.81 mm of the cover's outside, under the least wall of 1.2 mm: raise Wall, or use a smaller bolt."]);
    // The plate shrunk under the bolts: the countersink's wall is 1 mm short, and only a smaller countersink helps, as the axes keep edge from B.
    const plate = boltRimDiagnostics({ ...base, B: outset(base.B, -1) }).find((d) => d.code === 'bolt-collision');
    expect(plate?.message).toMatch(/^The front left countersink comes within 0\.\d\d mm of the base's side, under the least wall of 1\.2 mm: use a smaller bolt, or a smaller Hole clearance per side\.$/);
    expect(plate?.also).toEqual(['bolts.size', 'bolts.holeClearance']);
    const spot = b.spots[0];
    // Under the hole, at the hole's own height: the hole is what comes nearest.
    const under = { x0: spot.x - 1, y0: spot.y - 1, x1: spot.x + 1, y1: spot.y + 1, z0: b.slotFloor - 1, z1: b.slotFloor - 0.5 };
    expect(clash({ ...base, notches: [under] })).toEqual([`The front left bolt's hole in the cover comes within 0.00 mm of a pry notch, under the least wall of 1.2 mm: turn Pry notches off, or narrow them under Advanced, Joint.`]);
    // Beside the slot's channel, 0.3 mm off its side at its own height and 3 mm or more from either hole: only the slot comes near.
    expect(spot.exit).toBe('x0');
    const beside = { x0: spot.x - 4, y0: spot.y + b.slotWidth / 2 + 0.3, x1: spot.x - 3.5, y1: spot.y + b.slotWidth / 2 + 0.7, z0: b.slotFloor + 0.5, z1: b.slotFloor + 1 };
    expect(clash({ ...base, notches: [beside] })).toEqual([`The front left nut slot comes within 0.30 mm of a pry notch, under the least wall of 1.2 mm: turn Pry notches off, or narrow them under Advanced, Joint.`]);
    // The clash names the control to change.
    expect(boltRimDiagnostics({ ...base, e4: base.e4 + 0.5 }).find((d) => d.code === 'bolt-collision')?.also).toEqual(['joint.landOuter']);
  });

  it('reads the cavity off the field in 3D: a column reaching the corner clashes, the real cavity does not', () => {
    const { mesh, bounds } = orientedExample('jersey');
    const settings = fieldSettings(params, bounds);
    const field = buildField(mesh, planField(bounds, settings), settings).field;
    expect(boltCavityDiagnostics(b, field, 0.05, rim.D)).toEqual([]);
    expect(boltCavityWall(b, field, 0.05, rim.D, 30).wall).toBeCloseTo(7.962, 2);
    // A field with one column of cavity under the front left nut slot, 4 mm tall: in plan it is right under
    // the slot, but the slot is over it, so the wall is the gap in height. Crop it to D and it is gone.
    const spot = b.spots[0];
    const cell = 0.5;
    const grid = { nx: 41, ny: 41, cell, x0: spot.x - 10, y0: spot.y - 10 };
    const fake = emptyField(grid, 0);
    fake.values[20 + 20 * 41] = 2;
    const wall = boltCavityWall(b, fake, 0, null, 30);
    expect(wall.wall).toBeCloseTo(0, 9);
    const [d] = boltCavityDiagnostics(b, fake, 0, null);
    expect(d).toMatchObject({ code: 'bolt-collision', severity: 'warning', also: ['grid.edge'] });
    expect(d.message).toBe("The front left bolt's hole in the cover comes within 0.00 mm of the cavity, under the least wall of 1.2 mm: raise Edge distance under Grid, or use a smaller bolt.");
    expect(boltCavityDiagnostics(b, fake, 0, rim.D)).toEqual([]);
    // Lower and 3.5 mm to the side, under the slot's edge but 1.3 mm from the hole in plan, less a cell: the slot
    // comes nearest, by its 0.1 mm in plan and the 0.5 mm the column stops under its floor.
    fake.values[20 + 20 * 41] = 0;
    fake.values[20 + 27 * 41] = b.slotFloor - 0.5;
    const near = boltCavityWall(b, fake, 0, null, 30);
    expect(near.by).toBe('the front left nut slot');
    // The field's nodes are float32, a hair off the axis.
    expect(near.wall).toBeCloseTo(Math.hypot(3.5 - b.slotWidth / 2 - cell, 0.5), 6);
    expect(boltCavityDiagnostics(b, fake, 0, null)[0].message).toBe("The front left nut slot comes within 0.51 mm of the cavity, under the least wall of 1.2 mm: raise Edge distance under Grid, or use a smaller bolt.");
  });

  it('report.json reads the cavity wall however far away it is, where a capped search would stop at its reach', () => {
    const spot = b.spots[0];
    const cell = 0.5;
    // One column 2 mm tall, 25 mm in x from the front left axis. That bolt's slot opens at x0, so its hex's far
    // corner points this way, slotWidth / sqrt 3 from the axis, and comes nearest over the column's top.
    const fake = emptyField({ nx: 81, ny: 11, cell, x0: spot.x - 5, y0: spot.y - 2.5 }, 0);
    fake.values[60 + 5 * 81] = 2;
    const far = Math.hypot(25 - b.slotWidth / Math.sqrt(3) - cell, b.slotFloor - 2);
    expect(boltCavityWall(b, fake, 0, null, 20)).toEqual({ wall: 20, by: null });
    const found = boltCavityWallAnywhere(b, fake, 0, null);
    expect(found.wall).toBeCloseTo(far, 6);
    expect(found.wall).toBeGreaterThan(20);
    expect(found.by).toBe('the front left nut slot');
    // With no cavity at all there is nothing to report.
    expect(boltCavityWallAnywhere(b, emptyField({ nx: 3, ny: 3, cell, x0: 0, y0: 0 }, 0), 0, null).by).toBeNull();
  });
});

describe('the bolts in place of the tape count', () => {
  const rim = (id: ExampleId): Rim => deriveRim(boundsOf(id, bolted()), bolted());

  it('jersey: four bolts are enough, as they hold the lift and stand under 100 mm apart', () => {
    const advice = boltAdvice(0.55, 10, rim('jersey').bolts!);
    expect(advice).toMatchObject({ count: 4, size: 'M3', length: 12, holdN: 10, boltsHoldN: 4 * BOLT_HOLD_N, middle: [0, 0], liftStrips: 0, strips: 0, enough: true });
    expect(advice.spans[0]).toBeCloseTo(2 * 34.805, 2);
  });

  it('VIS-35: tape across the middle where the bolts stand over 100 mm apart', () => {
    const advice = boltAdvice(4.26, 10, rim('vis35').bolts!);
    expect(advice.spans[1]).toBeGreaterThan(2 * SEAL_SPACING_MM);
    expect(advice.middle).toEqual([0, 2]);
    expect(advice).toMatchObject({ strips: 2, liftStrips: 0, enough: false });
  });

  it('a lift past what the bolts hold asks for the rest in tape', () => {
    const advice = boltAdvice(150, 10, rim('jersey').bolts!);
    // Twice 150 is 300, 100 more than 4 bolts hold, so 10 strips.
    expect(advice).toMatchObject({ holdN: 300, liftStrips: 10, strips: 10, enough: false });
  });

  it('all 8 at defaults: tape across the middle wherever bolts stand over 100 mm apart, VIS-35 2 left to right, x8 and wolf 1 each way', () => {
    const expected: Record<ExampleId, [number, number]> = { benchy: [0, 0], goddess: [0, 0], vis35: [0, 2], jersey: [0, 0], x8: [1, 1], barrel: [0, 0], wolf: [1, 1], chick: [0, 0] };
    for (const id of EXAMPLE_IDS) {
      const advice = boltAdvice(1, 10, rim(id).bolts!);
      expect(advice.middle, id).toEqual(expected[id]);
      // From the spans, by the 100 mm rule: one strip for each 100 mm past the first.
      expect(advice.middle, id).toEqual(advice.spans.map((s) => Math.max(0, Math.ceil(s / SEAL_SPACING_MM) - 1)));
      expect(advice.enough, id).toBe(expected[id][0] + expected[id][1] === 0);
    }
  });

  it('a screw length that does not fit is counted as holding nothing, so four are never enough with it', () => {
    const short = deriveRim(boundsOf('jersey', bolted((p) => (p.bolts.length = 10))), bolted((p) => (p.bolts.length = 10)));
    expect(boltAdvice(0.55, 10, short.bolts!)).toMatchObject({ lengthFits: false, strips: 0, enough: false });
    const long = deriveRim(boundsOf('jersey', bolted((p) => (p.bolts.length = 40))), bolted((p) => (p.bolts.length = 40)));
    expect(boltAdvice(0.55, 10, long.bolts!)).toMatchObject({ lengthFits: false, enough: false });
    expect(boltAdvice(0.55, 10, rim('jersey').bolts!)).toMatchObject({ lengthFits: true, enough: true });
  });
});

/**
 * The coupon's cuts, read off its solids as the mold's are: the hole and its membrane, the slot open
 * out through +x, the hole over the nut and plastic over its end, and the base's countersink and hole.
 */
function checkCoupon(arena: Arena, coupon: BoltCoupon): void {
  const { track } = arena;
  const { cover, base, bolts: b } = coupon;
  const [spot] = b.spots;
  const half = spot.slotRun - 1;
  const square = (x: number, y: number, side: number): Vec2[] => [[x - side / 2, y - side / 2], [x + side / 2, y - side / 2], [x + side / 2, y + side / 2], [x - side / 2, y + side / 2]];
  // How much of a 0.2 mm square round a point is plastic, at a height.
  const filled = (solid: Manifold, z: number, x: number, y: number, side = 0.2): number => track(track(solid.slice(z)).intersect(arena.crossSection([square(x, y, side)]))).area() / (side * side);
  const centre = (solid: Manifold, z: number, r: number, what: string): void => {
    const [found] = holeCentres(arena, solid, z, b.spots, r);
    expect(found, what).not.toBeNull();
    expect(Math.hypot(found![0] - spot.x, found![1] - spot.y), what).toBeLessThan(1e-6);
  };
  centre(cover, (b.slotFloor - b.layer) / 2, b.holeRadius, 'the hole under the membrane');
  centre(cover, (b.slotTop + b.holeTop) / 2, b.holeRadius, 'the hole over the nut');
  // One layer of membrane: plastic through it, the hole just under it and the slot just over it.
  expect(filled(cover, b.slotFloor - b.layer + 0.005, 0, 0)).toBeCloseTo(1, 6);
  expect(filled(cover, b.slotFloor - 0.005, 0, 0)).toBeCloseTo(1, 6);
  expect(filled(cover, b.slotFloor - b.layer - 0.005, 0, 0)).toBe(0);
  expect(filled(cover, b.slotFloor + 0.005, 0, 0)).toBe(0);
  // The hole runs up to its end, with plastic over it.
  expect(filled(cover, b.holeTop - 0.005, 0, 0)).toBe(0);
  expect(filled(cover, b.holeTop + 0.005, 0, 0)).toBeCloseTo(1, 6);
  // The slot, the whole of its outline inside the piece empty at mid height, out to the +x side.
  const outline = arena.crossSection([clipToBox(slotOutline(b, spot), { x0: -half, y0: -half, x1: half, y1: half })]);
  const mid = (b.slotFloor + b.slotTop) / 2;
  expect(track(track(cover.slice(mid)).intersect(outline)).area()).toBeLessThan(1e-6);
  expect(filled(cover, mid, half - 0.1, 0)).toBe(0);
  within(track(track(cover.slice(b.slotFloor - 0.005)).intersect(outline)).area(), outline.area(), 1e-4);
  // The base: the countersink at 45 degrees from the underside, then the hole.
  centre(base, b.bed + 0.01, b.sinkRadius - 0.01, 'the countersink at the underside');
  centre(base, b.bed + b.sinkDepth / 2, b.sinkRadius - b.sinkDepth / 2, 'the countersink half way up');
  centre(base, (b.bed + b.sinkDepth) / 2, b.holeRadius, 'the hole over the countersink');
}

const within = (actual: number, expected: number, fraction: number): void => {
  expect(Math.abs(actual - expected), `${actual} is not within ${fraction * 100}% of ${expected}`).toBeLessThanOrEqual(Math.abs(expected) * fraction);
};

describe('the bolts\' cuts on the solids', () => {
  it('a corner of the base and cover with one bolt each, as the fit test makes them, are closed solids with the mold\'s cuts', () => {
    withArena(api, (arena) => {
      const coupon = buildBoltCoupon(arena, bolted());
      expect(coupon.base.status()).toBe('NoError');
      expect(coupon.cover.status()).toBe('NoError');
      expect(coupon.base.decompose().length).toBe(1);
      const b = coupon.bolts;
      // The cover piece's top is whole layers over the slot's floor, as on the mold.
      const layers = (coupon.top - b.slotFloor) / b.layer;
      expect(Math.abs(layers - Math.round(layers))).toBeLessThan(1e-9);
      expect(coupon.top - b.holeTop).toBeGreaterThanOrEqual(b.minWall - 1e-9);
      expect(b.holeTop).toBeCloseTo(b.wantedTop, 9);
      // The slot's floor is the lowest the mold's takes, which the README says.
      expect(b.slotFloor).toBe(b.slotFloorMin);
      // Small: under 2 cm across.
      const size = coupon.cover.boundingBox();
      expect(size.max[0] - size.min[0]).toBeLessThan(20);
      checkCoupon(arena, coupon);
      // At the other sizes too, M4 on its 14 mm square.
      for (const size of ['M2.5', 'M4'] as const) checkCoupon(arena, buildBoltCoupon(arena, bolted((p) => (p.bolts.size = size))));
    });
  });

  it('negative controls: a coupon without its cuts, or with its slot stopped short of the side, fails the check', () => {
    withArena(api, (arena) => {
      const coupon = buildBoltCoupon(arena, bolted());
      const b = coupon.bolts;
      const box = (z0: number, z1: number): Manifold => {
        const half = b.spots[0].slotRun - 1;
        return arena.track(arena.track(api.Manifold.cube([2 * half, 2 * half, z1 - z0])).translate([-half, -half, z0]));
      };
      expect(() => checkCoupon(arena, { ...coupon, cover: box(0, coupon.top) })).toThrow();
      expect(() => checkCoupon(arena, { ...coupon, base: box(b.bed, 0) })).toThrow();
      // The slot run 2 mm short: the cut stops inside the piece, so the nut could not go in.
      const short = { ...b, spots: [{ ...b.spots[0], slotRun: b.spots[0].slotRun - 3 }] };
      const cover = arena.track(api.Manifold.difference([box(0, coupon.top), ...coverBoltCutters(arena, short)]));
      expect(() => checkCoupon(arena, { ...coupon, cover })).toThrow();
    });
  });
});

// Kept apart from boltClearances' own use, so a clash found there is not just the check agreeing with itself.
describe('boltClearances on the real rim', () => {
  it('matches boltWalls', () => {
    const params = bolted();
    const rim = deriveRim(boundsOf('barrel', params), params);
    expect(boltClearances(wallsOf(rim))).toEqual(boltWalls(rim));
  });
});
