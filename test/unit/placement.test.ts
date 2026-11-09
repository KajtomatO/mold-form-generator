import type { ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { replicateOpenings, boreSilicone, type PlacedOpening } from '../../src/core/analysis/placement';
import { checkOpening, discMinimum, heightAt, type OpeningSpot } from '../../src/core/analysis/validate';
import { countBodies } from '../../src/core/field/sealed';
import type { Field } from '../../src/core/field/grid';
import { auditEdges } from '../../src/core/mesh/audit';
import { connectedPieces, importSolid, partsNote } from '../../src/core/mesh/shells';
import { TOUCH_MM, touchingGroups } from '../../src/core/mesh/touching';
import { meshBounds, weld, type WeldedMesh } from '../../src/core/mesh/weld';
import { defaultParams } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';
import { withArena } from '../../src/core/solid/arena';
import { loadManifold } from '../fixtures/loadExamples';
import { planOpenings, type PlanOptions, type PlannedOpenings } from '../fixtures/openings';
import { arch, box, channel, inverted, join, ring, sphere as sphereMesh, SPIKES, spikes, toSoup, TOWERS, towers } from '../fixtures/synthetic';

type V3 = [number, number, number];

/** join() for many meshes, which spreads no array as an argument list. */
function joinMany(meshes: WeldedMesh[]): WeldedMesh {
  const positions = new Float32Array(meshes.reduce((sum, m) => sum + m.positions.length, 0));
  const indices = new Uint32Array(meshes.reduce((sum, m) => sum + m.indices.length, 0));
  let p = 0, i = 0;
  for (const m of meshes) {
    positions.set(m.positions, p);
    for (let k = 0; k < m.indices.length; k++) indices[i + k] = m.indices[k] + p / 3;
    p += m.positions.length;
    i += m.indices.length;
  }
  return { positions, indices };
}

let api: ManifoldToplevel;
beforeAll(async () => {
  api = await loadManifold();
});

function plan(mesh: WeldedMesh, change: (p: Params) => void = () => {}, options: PlanOptions = {}): PlannedOpenings {
  const params = defaultParams();
  change(params);
  return planOpenings(mesh, meshBounds(mesh.positions), params, options);
}
const pours = (p: PlannedOpenings): PlacedOpening[] => p.placement.openings.filter((o) => o.kind === 'pour');
const vents = (p: PlannedOpenings): PlacedOpening[] => p.placement.openings.filter((o) => o.kind === 'vent');
const codes = (p: PlannedOpenings): string[] => p.placement.diagnostics.map((d) => d.code);

/** Every opening of a placement really passes, each against all the others. */
function expectAllValid(p: PlannedOpenings): void {
  for (const opening of p.placement.openings) {
    expect(opening.valid, opening.id).toBe(true);
    expect(checkOpening(p.space, opening, p.placement.openings).problems, opening.id).toEqual([]);
  }
}

const lowTower = { x: TOWERS.lowX + TOWERS.side / 2, y: TOWERS.width / 2 };

describe('the persistence threshold, on a fixture where it is known', () => {
  // A real leaf can sit right on the limit, as Benchy's does. Here it is what the model says it is.
  it.each([1.2, 1.4, 1.6, 1.8, 2.5])('a leaf with persistence %f is read as that from the mesh', (persistence) => {
    const { search } = plan(towers(api, persistence));
    const [body] = search.bodies;
    const leaf = body.tree.leaves.find((l) => Math.abs(l.x - lowTower.x) < 7);
    expect(leaf).toBeDefined();
    expect(Math.abs(leaf!.persistence - persistence)).toBeLessThanOrEqual(0.011);
  });

  it.each([[1.6, 1], [1.8, 1], [1.4, 0], [1.2, 0]])('at the default limit of t/2 = 1.5, persistence %f gets %i vents of its own', (persistence, count) => {
    const p = plan(towers(api, persistence));
    const atLeaf = vents(p).filter((o) => o.role === 'leaf');
    expect(atLeaf).toHaveLength(count);
    if (count > 0) {
      expect(Math.abs(atLeaf[0].x - lowTower.x)).toBeLessThanOrEqual(TOWERS.side / 2);
      expect(Math.abs(atLeaf[0].y - lowTower.y)).toBeLessThanOrEqual(TOWERS.side / 2);
    } else {
      // Below the limit it is no failure to have no vent there, and it is not reported either.
      expect(codes(p)).not.toContain('peak-uncovered');
    }
    expectAllValid(p);
  });

  it('follows the set limit, and t when the limit is on auto', () => {
    const mesh = towers(api, 2.5);
    expect(vents(plan(mesh)).filter((o) => o.role === 'leaf')).toHaveLength(1);
    expect(vents(plan(mesh, (p) => (p.vents.persistence = 3))).filter((o) => o.role === 'leaf')).toHaveLength(0);
    expect(vents(plan(mesh, (p) => (p.silicone.t = 6))).filter((o) => o.role === 'leaf')).toHaveLength(0);
    expect(vents(plan(mesh, (p) => (p.vents.persistence = 2))).filter((o) => o.role === 'leaf')).toHaveLength(1);
  });
});

describe('placement on one body', () => {
  it('puts the pour at the highest point, a vent beside it, and a vent at the other peak', () => {
    const p = plan(towers(api, 5));
    expect(pours(p)).toHaveLength(1);
    const [pour] = pours(p);
    // The top of the tall tower is a flat 144 mm2, so this is the plateau rule at work.
    expect(pour.role).toBe('plateau');
    expect(pour.x).toBeCloseTo(TOWERS.tallX + TOWERS.side / 2, 0);
    expect(pour.y).toBeCloseTo(TOWERS.width / 2, 0);
    const beside = vents(p).find((o) => o.role === 'beside')!;
    expect(Math.hypot(beside.x - pour.x, beside.y - pour.y)).toBeGreaterThan(5);
    expect(vents(p).filter((o) => o.role === 'leaf')).toHaveLength(1);
    expect(p.placement.bodies).toEqual([{ requested: 1, placed: 1, peak: expect.any(Array), plateau: true }]);
    expect(p.placement.uncovered).toEqual([]);
    expectAllValid(p);
  });

  it('never reads mesh genus: a plate with a hole through it is one body', () => {
    const p = plan(ring(api, 40, 10, 8));
    expect(p.search.bodies).toHaveLength(1);
    expect(pours(p)).toHaveLength(1);
    expectAllValid(p);
  });

  it('gives the same placement from the same input', () => {
    const mesh = towers(api, 5);
    expect(plan(mesh, (p) => (p.pour.perModel = 3)).placement).toEqual(plan(mesh, (p) => (p.pour.perModel = 3)).placement);
  });

  it('is all plain data, so a worker can post it', () => {
    const p = plan(towers(api, 5));
    expect(structuredClone(p.placement)).toEqual(p.placement);
    const body = p.search.bodies[0];
    expect(structuredClone(body).tree.basins).toEqual(body.tree.basins);
  });
});

describe('bodies, per A3: one pour per body, not per cavity', () => {
  it('two bodies far apart get a pour and a vent each, in 2 cavities without the base layer and in 1 with it', () => {
    const far = join(box([0, 0, 0], [30, 30, 15]), box([100, 0, 0], [130, 30, 15]));
    const layered = plan(far);
    expect(layered.built.cavities.count).toBe(1);
    expect(pours(layered).map((o) => o.body)).toEqual([0, 1]);
    expect(vents(layered)).toHaveLength(2);
    expectAllValid(layered);
    // Without the layer each body has a cavity of its own.
    const p = plan(far, (params) => (params.silicone.baseLayer = 0));
    expect(p.built.cavities.count).toBe(2);
    expect(p.search.bodies).toHaveLength(2);
    expect(pours(p)).toHaveLength(2);
    expect(vents(p)).toHaveLength(2);
    expect(pours(p).map((o) => o.body)).toEqual([0, 1]);
    expectAllValid(p);
  });

  it('two bodies close enough to share a cavity still get a pour each', () => {
    const p = plan(join(box([0, 0, 0], [30, 30, 15]), box([33, 0, 0], [63, 30, 15])));
    expect(p.built.cavities.count).toBe(1);
    expect(p.search.bodies).toHaveLength(2);
    expect(pours(p)).toHaveLength(2);
    // Each stands over its own body.
    expect(pours(p)[0].x).toBeLessThan(30);
    expect(pours(p)[1].x).toBeGreaterThan(33);
    expectAllValid(p);
  });

  it('a body gets the top of its own ceiling, though another stands higher', () => {
    const p = plan(join(box([0, 0, 0], [30, 30, 40]), box([33, 0, 0], [63, 30, 10])));
    const low = pours(p)[1];
    expect(low.x).toBeGreaterThan(33);
    expect(low.x).toBeLessThan(63);
    expectAllValid(p);
  });
});

/** A tetrahedron wound outward, whichever order its corners come in. */
function tetra(a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number]): WeldedMesh {
  const det = (b[0] - a[0]) * ((c[1] - a[1]) * (d[2] - a[2]) - (c[2] - a[2]) * (d[1] - a[1])) - (b[1] - a[1]) * ((c[0] - a[0]) * (d[2] - a[2]) - (c[2] - a[2]) * (d[0] - a[0])) + (b[2] - a[2]) * ((c[0] - a[0]) * (d[1] - a[1]) - (c[1] - a[1]) * (d[0] - a[0]));
  const faces = [0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2];
  return { positions: Float32Array.from([...a, ...b, ...c, ...d]), indices: Uint32Array.from(det > 0 ? faces : faces.map((v, k) => faces[k - (k % 3) + [0, 2, 1][k % 3]])) };
}

/**
 * A wedge whose edge from (15, -5, 5) to (15, 5, 15) crosses the 30 x 30 x 10 block's top front edge at
 * (15, 0, 10) and touches it nowhere else, moved `gap` mm straight away from that edge: only the distance
 * between two edges sees how close they come.
 */
const edgeOn = (gap: number): WeldedMesh => {
  const s = gap / Math.SQRT2;
  return join(box([0, 0, 0], [30, 30, 10]), tetra([15, -5 - s, 5 + s], [15, 5 - s, 15 + s], [5, -10 - s, 20 + s], [25, -10 - s, 20 + s]));
};

/**
 * A tetrahedron whose face x + y + z = 30 is slanted to every axis, and a second whose corner stands `gap` mm
 * off that face's middle, along its normal, with the rest of it further out: only the distance from that
 * corner to the face sees how close they come.
 */
const cornerOffSlant = (gap: number): WeldedMesh => {
  const n = 1 / Math.sqrt(3);
  const u = [Math.SQRT1_2, -Math.SQRT1_2, 0], v = [n / Math.SQRT2, n / Math.SQRT2, -2 * (n / Math.SQRT2)];
  const out = (d: number, a: number, b: number): [number, number, number] => [0, 1, 2].map((k) => 10 + n * d + a * u[k] + b * v[k]) as [number, number, number];
  return join(tetra([0, 0, 0], [30, 0, 0], [0, 30, 0], [0, 0, 30]), tetra(out(gap, 0, 0), out(gap + 5, 3, 0), out(gap + 5, -1.5, 2.6), out(gap + 5, -1.5, -2.6)));
};

/**
 * M11c: files of several parts, as multi-colour models are, with the bodies each gives, and of those the
 * bodies with a peak of their own at the ceiling, which get the pours. A 30 x 30 x 10 block and a part beside,
 * on, in or past it. Before M11c every part was a body of its own, so each row past the controls failed.
 */
const PARTS: [string, number, number, () => WeldedMesh][] = [
  ['two boxes overlapping', 1, 1, () => join(box([0, 0, 0], [30, 30, 10]), box([20, 5, 0], [50, 25, 14]))],
  ['two boxes sharing a face exactly', 1, 1, () => join(box([0, 0, 0], [30, 30, 10]), box([30, 5, 0], [60, 25, 14]))],
  ['two boxes 0.049 mm apart, within the tolerance', 1, 1, () => join(box([0, 0, 0], [30, 30, 10]), box([30.049, 5, 0], [60, 25, 14]))],
  ['negative control: two boxes 0.051 mm apart, past the tolerance, which their boxes already tell', 2, 2, () => join(box([0, 0, 0], [30, 30, 10]), box([30.051, 5, 0], [60, 25, 14]))],
  ['negative control: two boxes 0.5 mm apart', 2, 2, () => join(box([0, 0, 0], [30, 30, 10]), box([30.5, 5, 0], [60, 25, 14]))],
  ['a small part buried inside a big one', 1, 1, () => join(box([0, 0, 0], [30, 30, 15]), box([10, 10, 4], [20, 20, 8]))],
  ['two boxes crossing as a plus sign, no corner of either in the other', 1, 1, () => join(box([0, 0, 0], [30, 10, 10]), box([10, -10, 2], [20, 20, 8]))],
  ['a part with a corner 0.049 mm over the middle of another\'s top', 1, 1, () => join(box([0, 0, 0], [30, 30, 10]), tetra([20, 10, 10.049], [10, 0, 20], [30, 0, 20], [20, 20, 20]))],
  ['two parts whose edges cross 0.049 mm apart', 1, 1, () => edgeOn(0.049)],
  ['negative control: two parts whose edges cross 0.051 mm apart', 2, 2, () => edgeOn(0.051)],
  ['a part on top of another, as a hat', 1, 1, () => join(box([0, 0, 0], [30, 30, 10]), box([10, 10, 10], [20, 20, 16]))],
  ['negative control: a part in a sealed hollow of another, touching nothing', 2, 1, () => join(box([0, 0, 0], [30, 30, 30]), inverted(box([5, 5, 5], [25, 25, 25])), box([10, 10, 10], [20, 20, 20]))],
  // A hollow's wall is the outer part's surface too (M11c review). Its first corner in the hollow, this part
  // passes through the far wall into the material; another part rests on the hollow's floor.
  ['a part passing through the wall of another\'s sealed hollow, from inside it', 1, 1, () => join(box([0, 0, 0], [30, 30, 30]), inverted(box([5, 5, 5], [25, 25, 25])), box([22, 12, 12], [28, 18, 18]))],
  ['a part resting on the floor of another\'s sealed hollow', 1, 1, () => join(box([0, 0, 0], [30, 30, 30]), inverted(box([5, 5, 5], [25, 25, 25])), box([10, 10, 5], [20, 20, 12]))],
];

describe('bodies are physical objects: parts that overlap or touch are one (M11c)', () => {
  // Read as the app reads a file: welded from its triangles, so parts share no vertex unless the file says so.
  const parts = (make: () => WeldedMesh): WeldedMesh => weld(toSoup(make()));

  it.each(PARTS)('%s: %i bodies, %i with pours', (_name, physical, poured, make) => {
    const mesh = parts(make);
    expect(connectedPieces(mesh).filter((piece) => piece.kind !== 'void')).toHaveLength(2);
    expect(touchingGroups(mesh, connectedPieces(mesh))).toHaveLength(physical);
    // A closed mesh is read along a line through it, an open one by the winding number: the same groups.
    expect(touchingGroups(mesh, connectedPieces(mesh), { closed: true })).toHaveLength(physical);
    expect(countBodies(mesh)).toBe(physical);
    // The import counts them by the same rule, with Manifold at hand, so report.json says the same.
    expect(withArena(api, (arena) => importSolid(arena, mesh, auditEdges(mesh)).report.bodies)).toBe(physical);
    const p = plan(mesh);
    expect(p.search.bodies).toHaveLength(poured);
    expect(p.search.fragments).toHaveLength(physical - poured);
    expect(pours(p)).toHaveLength(poured);
    expect(p.placement.bodies.map((b) => b.placed)).toEqual(p.placement.bodies.map(() => 1));
    expect(codes(p)).not.toContain('pour-shortfall');
    expect(p.placement.uncovered).toEqual([]);
    expectAllValid(p);
  });

  it('the tolerance is 0.05 mm, the least plane tolerance the auto rule picks', () => {
    expect(TOUCH_MM).toBe(0.05);
  });

  // Parts whose boxes overlap, so only the test on the surfaces can tell them apart (M11c review): a part over
  // another's floor, between its walls, which the boxes of the facing triangles tell; and a corner over the
  // slanted face of another, where those boxes overlap and the corner's distance to the face decides. Each pair
  // 0.049 mm apart is one body and 0.051 mm apart two, so the tolerance is pinned at 0.05 within 0.001.
  const NEAR: [string, number, () => WeldedMesh][] = [
    ['a box 0.049 mm over the floor of a U channel, 1 mm from its walls', 1, () => join(channel(api), box([6, 5, 2.049], [24, 25, 9]))],
    ['negative control: the same box 0.051 mm over the floor', 2, () => join(channel(api), box([6, 5, 2.051], [24, 25, 9]))],
    ['a corner 0.049 mm off the middle of a slanted face', 1, () => cornerOffSlant(0.049)],
    ['negative control: the same corner 0.051 mm off it', 2, () => cornerOffSlant(0.051)],
  ];
  it.each(NEAR)('%s: %i bodies, as the surfaces decide', (_name, physical, make) => {
    const mesh = parts(make);
    const pieces = connectedPieces(mesh);
    expect(pieces).toHaveLength(2);
    // The boxes, grown by the tolerance, overlap on every axis, so no box test can have decided it.
    const [a, b] = pieces;
    for (let axis = 0; axis < 3; axis++) expect(a.min[axis] - TOUCH_MM <= b.max[axis] && b.min[axis] - TOUCH_MM <= a.max[axis]).toBe(true);
    expect(touchingGroups(mesh, pieces)).toHaveLength(physical);
    expect(touchingGroups(mesh, pieces, { closed: true })).toHaveLength(physical);
    expect(countBodies(mesh)).toBe(physical);
    expect(withArena(api, (arena) => importSolid(arena, mesh, auditEdges(mesh)).report.bodies)).toBe(physical);
    const p = plan(mesh);
    expect(p.search.bodies.length + p.search.fragments.length).toBe(physical);
  });

  it('a known limit: a small part 0.06 mm over another, past the tolerance, is a body of its own, and with no room for a pour of its own, it is short of one, an error that keeps Export ZIP off', () => {
    // As printed, a gap this thin under a layer fuses; S8's columns, a cell apart, see one shell. The rule is
    // the plan's: past TOUCH_MM, parts are separate bodies, and each needs its pour (M11c review).
    const off = plan(parts(() => join(box([0, 0, 0], [30, 30, 10]), box([12, 12, 10.06], [18, 18, 16]))));
    expect(off.search.bodies).toHaveLength(2);
    expect(pours(off)).toHaveLength(1);
    expect(off.placement.diagnostics.find((d) => d.code === 'pour-shortfall')?.severity).toBe('error');
    // 0.04 mm over, it is the block's, and the body's one pour stands on it.
    const on = plan(parts(() => join(box([0, 0, 0], [30, 30, 10]), box([12, 12, 10.04], [18, 18, 16]))));
    expect(on.search.bodies).toHaveLength(1);
    expect(codes(on)).not.toContain('pour-shortfall');
    expectAllValid(on);
  });

  it('a file of two figures 20 mm apart, each a box with a taller part passing into it: two bodies, each poured at its own part\'s top', () => {
    // The tall parts stand off their boxes' middles, so a body's field from its box alone would put the pour
    // on the box's flat top, away from the part.
    const hats: [V3, V3][] = [
      [[2, 2, 5], [12, 12, 20]],
      [[66, 16, 5], [76, 26, 22]],
    ];
    const mesh = parts(() => join(box([0, 0, 0], [30, 30, 10]), box(...hats[0]), box([50, 0, 0], [80, 30, 10]), box(...hats[1])));
    const pieces = connectedPieces(mesh);
    expect(touchingGroups(mesh, pieces)).toEqual([[0, 1], [2, 3]]);
    const p = plan(mesh);
    expect(p.search.bodies).toHaveLength(2);
    expect(p.search.fragments).toEqual([]);
    expect(pours(p)).toHaveLength(2);
    pours(p).forEach((pour, b) => {
      const [min, max] = hats[b];
      expect(pour.body).toBe(b);
      expect(pour.x).toBeGreaterThan(min[0]);
      expect(pour.x).toBeLessThan(max[0]);
      expect(pour.y).toBeGreaterThan(min[1]);
      expect(pour.y).toBeLessThan(max[1]);
      // At the top of the ceiling over that part, read off the tile.
      let peak = 0;
      for (let x = min[0]; x <= max[0]; x += 0.25) for (let y = min[1]; y <= max[1]; y += 0.25) peak = Math.max(peak, heightAt(p.tile, x, y));
      expect(heightAt(p.tile, pour.x, pour.y)).toBeCloseTo(peak, 1);
    });
    expect(p.placement.bodies.map((b) => b.placed)).toEqual([1, 1]);
    expect(codes(p)).not.toContain('pour-shortfall');
    expectAllValid(p);
    // The import counts 4 parts, which make 2 models, and says so; their union is 10,000 and 10,200 mm3.
    const report = withArena(api, (arena) => importSolid(arena, mesh, auditEdges(mesh)).report);
    expect(report.bodies).toBe(2);
    expect(report.overlapVolume).toBeCloseTo(1000, 3);
    expect(report.diagnostics).toEqual([
      {
        code: 'shell-overlap',
        severity: 'info',
        message: 'The file is made of 4 parts, some of which overlap by 1000.0 mm3, as models split for multi-colour printing often are. The mold treats parts that overlap or touch as one model, so it makes 2 models of them, 20200 mm3 in all.',
      },
    ]);
  });

  it('a sphere of 64,800 triangles with 500 small parts 0.5 mm off its surface is grouped in well under a second on a closed mesh (M11c review: 5.5 s)', () => {
    const ball = sphereMesh(api, 20, 360);
    expect(ball.indices.length / 3).toBe(64_800);
    let seed = 7;
    const random = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const cubes = Array.from({ length: 500 }, () => {
      const z = 2 * random() - 1, phi = 2 * Math.PI * random(), s = Math.sqrt(1 - z * z);
      // 0.5 mm off the surface past the cube's own half diagonal.
      const at = [s * Math.cos(phi), s * Math.sin(phi), z].map((d) => d * (20 + 0.5 + 0.25 * Math.sqrt(3))) as V3;
      return box([at[0] - 0.25, at[1] - 0.25, at[2] - 0.25], [at[0] + 0.25, at[1] + 0.25, at[2] + 0.25]);
    });
    const mesh = parts(() => joinMany([ball, ...cubes]));
    const pieces = connectedPieces(mesh);
    const t0 = performance.now();
    const groups = touchingGroups(mesh, pieces, { closed: true });
    const ms = performance.now() - t0;
    // No cube touches the sphere: its group is itself alone.
    expect(groups.find((group) => group.includes(0))).toEqual([0]);
    expect(ms).toBeLessThan(1000);
  });

  it('a joined body gets its other peaks vented: of two towers on a bridge, the lower has a vent and no pour', () => {
    // Three parts, each passing into the next. Apart, the towers took a pour each.
    const p = plan(parts(() => join(box([0, 0, 0], [20, 20, 14]), box([40, 0, 0], [60, 20, 12]), box([15, 5, 0], [45, 15, 4]))));
    expect(p.search.bodies).toHaveLength(1);
    expect(pours(p).map((o) => o.x < 20)).toEqual([true]);
    expect(vents(p).filter((o) => o.role === 'leaf').map((o) => o.x > 40)).toEqual([true]);
    expect(p.placement.uncovered).toEqual([]);
    expectAllValid(p);
  });

  it('a joined body stands where the union of its parts does, a shared patch counted once', () => {
    // On the plane the union is 40 x 20, centred at (20, 10). Summed, the 10 x 20 the parts share would
    // count twice and put the centre at x = 19.
    const p = plan(parts(() => join(box([0, 0, 0], [20, 20, 10]), box([10, 0, 0], [40, 20, 5]))));
    const [body] = p.search.bodies;
    expect(body.centroid[0]).toBeCloseTo(20, 1);
    expect(body.centroid[1]).toBeCloseTo(10, 1);
    expect(body.extent).toBeCloseTo(20, 4);
  });

  it('perModel 3 gives 3 pours on a joined body, spread round its centroid', () => {
    const p = plan(parts(() => join(box([0, 0, 0], [60, 60, 10]), box([20, 20, 10], [40, 40, 14]))), (q) => (q.pour.perModel = 3));
    expect(p.search.bodies).toHaveLength(1);
    expect(pours(p)).toHaveLength(3);
    expect(codes(p)).not.toContain('pour-shortfall');
    expectAllValid(p);
  });

  it('the note says how many parts overlap or touch, and the volume of their union, and says nothing for parts apart', () => {
    expect(partsNote(8, 8, 0, 59683)).toBeNull();
    expect(partsNote(6, 1, 964.37, 16813.2)).toEqual({
      code: 'shell-overlap',
      severity: 'info',
      message: 'The file is made of 6 parts that overlap by 964.4 mm3, as models split for multi-colour printing often are. The mold treats them as one model, of 16813 mm3.',
    });
    expect(partsNote(2, 1, 0, 4200)?.message).toBe('The file is made of 2 parts that touch, as models split for multi-colour printing often are. The mold treats them as one model, of 4200 mm3.');
    expect(partsNote(3, 2, 12.5, 1000)?.message).toBe('The file is made of 3 parts, some of which overlap by 12.5 mm3, as models split for multi-colour printing often are. The mold treats parts that overlap or touch as one model, so it makes 2 models of them, 1000 mm3 in all.');
    const hat = parts(PARTS.find(([name]) => name.includes('hat'))![3]);
    expect(withArena(api, (arena) => importSolid(arena, hat, auditEdges(hat)).report.diagnostics)).toEqual([{ code: 'shell-touch', severity: 'info', message: 'The file is made of 2 parts that touch, as models split for multi-colour printing often are. The mold treats them as one model, of 9600 mm3.' }]);
  });

  it('one piece is a group of its own, with no test at all, and a void belongs to none', () => {
    const hollow = join(box([0, 0, 0], [20, 20, 20]), inverted(box([5, 5, 5], [15, 15, 15])));
    const pieces = connectedPieces(hollow);
    expect(pieces.map((piece) => piece.kind)).toEqual(['unverified', 'void']);
    expect(touchingGroups(hollow, pieces)).toEqual([[0]]);
  });
});

describe('fragments, which are no bodies', () => {
  const crumb = (x: number, y: number, z = 0): WeldedMesh => box([x, y, z], [x + 0.5, y + 0.5, z + 0.5]);

  it('a crumb inside the cavity is no body, and opens nothing', () => {
    const p = plan(join(box([0, 0, 0], [30, 30, 15]), crumb(31, 15)));
    expect(p.search.bodies).toHaveLength(1);
    expect(p.search.fragments).toMatchObject([{ reason: 'tiny' }]);
    expect(pours(p)).toHaveLength(1);
    expect(p.placement.bodies).toHaveLength(1);
    expectAllValid(p);
  });

  it('a crumb far from everything is no body either, but its cavity must not stay sealed', () => {
    // The base layer joins the crumb's cavity to the body's, which the body's own pour then fills.
    const layered = plan(join(box([0, 0, 0], [30, 30, 15]), crumb(60, 15)));
    expect(layered.built.cavities.count).toBe(1);
    expect(layered.placement.openings.filter((o) => o.role === 'cavity')).toHaveLength(0);
    expect(codes(layered)).not.toContain('cavity-without-pour');
    expectAllValid(layered);
    // Without the layer the crumb's cavity stands alone.
    const p = plan(join(box([0, 0, 0], [30, 30, 15]), crumb(60, 15)), (params) => (params.silicone.baseLayer = 0));
    expect(p.built.cavities.count).toBe(2);
    expect(p.search.bodies).toHaveLength(1);
    expect(p.placement.bodies).toHaveLength(1);
    // A 10 mm disc does not fit around a crumb, so it is a vent, and it says so.
    const extra = p.placement.openings.filter((o) => o.role === 'cavity');
    expect(extra).toHaveLength(1);
    expect(extra[0].kind).toBe('vent');
    expect(extra[0].x).toBeGreaterThan(55);
    expect(codes(p)).toContain('cavity-without-pour');
    expectAllValid(p);
  });

  it('with the base layer, a thin pin far off fills through the layer and gets a vent for the air under its peak', () => {
    // 0.3 mm square and 3 mm tall: under 5 mm2 of surface, so no body, but its jacket stands well clear of the layer.
    const p = plan(join(box([0, 0, 0], [30, 30, 15]), box([60, 15, 0], [60.3, 15.3, 3])));
    expect(p.search.bodies).toHaveLength(1);
    const extra = p.placement.openings.filter((o) => o.role === 'cavity');
    expect(extra).toHaveLength(1);
    expect(extra[0].kind).toBe('vent');
    expect(Math.hypot(extra[0].x - 60.15, extra[0].y - 15.15)).toBeLessThan(1);
    expect(codes(p)).toContain('cavity-vent');
    expect(codes(p)).not.toContain('cavity-without-pour');
    expectAllValid(p);
  });

  it('a piece under another\'s ceiling is no body, however large', () => {
    // Between the arch's legs and under its top, 2 mm from each and touching neither. M11c: a piece inside
    // another, or touching it, is part of that body, as the hat and buried part below show.
    const inner = box([12, 1, 0], [28, 9, 10]);
    const p = plan(join(arch(api), inner));
    expect(p.search.bodies).toHaveLength(1);
    expect(p.search.fragments).toMatchObject([{ reason: 'buried' }]);
    expect(pours(p)).toHaveLength(1);
  });

  it('a small real body with its own top is still a body, even tiny by volume', () => {
    // 2 x 2 x 2: 24 mm2 of surface, so over the crumb limit, and away from the big one.
    const p = plan(join(box([0, 0, 0], [30, 30, 15]), box([50, 15, 0], [52, 17, 2])));
    expect(p.search.bodies).toHaveLength(2);
    expect(p.search.fragments).toEqual([]);
  });

  it('one small model on its own is always the body, however small', () => {
    const p = plan(box([0, 0, 0], [0.5, 0.5, 0.5]));
    expect(p.search.bodies).toHaveLength(1);
    expect(p.search.fragments).toEqual([]);
  });
});

describe('extra pours', () => {
  it('take the next-highest leaf first, replacing its vent', () => {
    const one = plan(towers(api, 5));
    const leaf = vents(one).find((o) => o.role === 'leaf')!;
    const p = plan(towers(api, 5), (x) => (x.pour.perModel = 2));
    expect(pours(p)).toHaveLength(2);
    const extra = pours(p)[1];
    expect(extra.role).toBe('leaf');
    expect([extra.x, extra.y]).toEqual([leaf.x, leaf.y]);
    expect(vents(p).filter((o) => o.role === 'leaf')).toEqual([]);
    expect(extra.id).toBe('b0:pour:1');
    expectAllValid(p);
  });

  it('then spread around where the body stands, and hold to its ceiling', () => {
    const p = plan(box([0, 0, 0], [80, 40, 20]), (x) => (x.pour.perModel = 4));
    expect(pours(p)).toHaveLength(4);
    expect(p.placement.bodies[0]).toMatchObject({ requested: 4, placed: 4 });
    for (const pour of pours(p)) {
      expect(pour.x).toBeGreaterThan(0);
      expect(pour.x).toBeLessThan(80);
      expect(pour.y).toBeGreaterThan(0);
      expect(pour.y).toBeLessThan(40);
    }
    // Around the middle, on all sides of it.
    const xs = pours(p).slice(1).map((o) => o.x - 40), ys = pours(p).slice(1).map((o) => o.y - 20);
    expect(Math.max(...xs)).toBeGreaterThan(5);
    expect(Math.min(...xs)).toBeLessThan(-5);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(5);
    expectAllValid(p);
  });

  it('come up short with a clear count when there is no room', () => {
    const p = plan(box([0, 0, 0], [20, 20, 15]), (x) => (x.pour.perModel = 8));
    const [body] = p.placement.bodies;
    expect(body.requested).toBe(8);
    expect(body.placed).toBeLessThan(8);
    expect(body.placed).toBeGreaterThanOrEqual(1);
    expect(pours(p)).toHaveLength(body.placed);
    const note = p.placement.diagnostics.find((d) => d.code === 'pour-shortfall')!;
    expect(note.severity).toBe('warning');
    expect(note.message).toContain(`Placed ${body.placed} of 8`);
    expectAllValid(p);
  });

  it('an error if a body gets none at all', () => {
    // A thin pin: its cavity is narrower than a pour's disc, wherever that goes.
    const p = plan(box([0, 0, 0], [0.8, 0.8, 30]));
    expect(p.placement.bodies[0].placed).toBe(0);
    expect(p.placement.diagnostics.find((d) => d.code === 'pour-shortfall')?.severity).toBe('error');
    // The peak still gets a vent, as that fits, and the cavity is not left sealed.
    expect(vents(p)).toHaveLength(1);
    expectAllValid(p);
  });
});

describe('vents and what they cover', () => {
  it('with vents off, no vent is placed, and a peak left open is reported', () => {
    const p = plan(towers(api, 5), (x) => (x.vents.enabled = false));
    expect(vents(p)).toEqual([]);
    expect(p.placement.uncovered).toHaveLength(1);
    expect(p.placement.uncovered[0].persistence).toBeCloseTo(5, 1);
    expect(codes(p)).toContain('peak-uncovered');
    expect(codes(plan(towers(api, 5)))).not.toContain('peak-uncovered');
  });

  it('a deleted vent stays gone, and the peak it was for is reported', () => {
    const before = plan(towers(api, 5));
    const leafVent = vents(before).find((o) => o.role === 'leaf')!;
    const p = plan(towers(api, 5), () => {}, { removed: [leafVent.id] });
    expect(vents(p).map((o) => o.id)).not.toContain(leafVent.id);
    expect(codes(p)).toContain('peak-uncovered');
    const beside = vents(before).find((o) => o.role === 'beside')!;
    expect(vents(plan(towers(api, 5), () => {}, { removed: [beside.id] })).map((o) => o.id)).not.toContain(beside.id);
  });

  it('a pour that stands over a leaf spares it a vent', () => {
    // A 20 mm pour: under a 10 mm one, no leaf over the vent limit fits, as the closing fills any dip
    // between two caps that close. And the vent beside the pour would cover the spike as well, so it
    // is taken away: only the pour is left to do it.
    const wide = (p: Params): void => void (p.pour.diameter = 20);
    const removed = ['b0:vent:beside'];
    const apart = 12;
    const near = plan(spikes(api, apart), wide, { removed });
    const [body] = near.search.bodies;
    const low = body.leaves.find((leaf) => Math.abs(leaf.x - (SPIKES.centre + apart)) < 1)!;
    expect(low).toBeDefined();
    expect(low.persistence).toBeGreaterThanOrEqual(1.5);
    const [pour] = pours(near);
    expect(Math.hypot(pour.x - SPIKES.centre, pour.y - SPIKES.centre)).toBeLessThan(1);
    // Its disc reaches onto the low spike's cap, where that is within t / 2 of its top.
    expect(heightAt(body.field, pour.x + 10, pour.y)).toBeGreaterThan(low.height - 1.5);
    expect(vents(near)).toEqual([]);
    expect(near.placement.uncovered).toEqual([]);
    expectAllValid(near);
    // Negative control: further away, out of the disc's reach, the same spike gets a vent of its own.
    const far = plan(spikes(api, 17), wide, { removed });
    expect(vents(far).filter((o) => o.role === 'leaf')).toHaveLength(1);
    expect(far.placement.uncovered).toEqual([]);
  });
});

describe('the plan\'s cover drop of t / 2', () => {
  /** Along +y from a point, where the ceiling of `field` first falls to `height`, by bisection. */
  function whereFallsTo(field: Field, x: number, y: number, height: number): number {
    let high = y, low = y + 20;
    for (let k = 0; k < 40; k++) {
      const middle = (high + low) / 2;
      if (heightAt(field, x, middle) > height) high = middle;
      else low = middle;
    }
    return high;
  }
  /** The highest node under a vent's disc, as the plan's rule reads it: air reaches it anywhere under the disc. */
  function highestUnder(field: Field, x: number, y: number, r: number): number {
    const { nx, ny, cell, x0, y0, values } = field;
    let best = -Infinity;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (Math.hypot(x0 + i * cell - x, y0 + j * cell - y) <= r) best = Math.max(best, values[i + j * nx]);
      }
    }
    return best;
  }
  const t = defaultParams().silicone.t;
  const mesh = (): WeldedMesh => towers(api, 5);
  const base = (): PlannedOpenings => plan(mesh());

  it.each([[0.4, 0], [0.7, 1]])('a vent whose disc reaches %f t under the low peak covers it if that is under half, else that leaf gets its own', (share, count) => {
    const p0 = base();
    const leaf = p0.search.bodies[0].leaves[1];
    const r = p0.space.sizes.ventDiameter / 2;
    // On the low tower's side, the highest node under the disc at `share` t under its top.
    const target = leaf.height - share * t;
    let y = whereFallsTo(p0.tile, leaf.x, leaf.y, target) + r;
    for (let k = 0; k < 40 && highestUnder(p0.tile, leaf.x, y, r) > target; k++) y += 0.01;
    expect(Math.abs(highestUnder(p0.tile, leaf.x, y, r) - target)).toBeLessThan(0.1 * t);
    // A pin of another id, so the leaf's own vent is still up to placement.
    const p = plan(mesh(), () => {}, { pins: [{ id: 'b0:vent:pinned', kind: 'vent', x: leaf.x, y }] });
    expectAllValid(p);
    expect(vents(p).filter((o) => o.role === 'leaf'), `drop ${share} t`).toHaveLength(count);
    expect(p.placement.uncovered).toEqual([]);
  });

  it.each([[0.45, false], [0.55, true]])('a first pour %f t under the peak is off it only past half', (share, warned) => {
    const p0 = base();
    const peak = p0.placement.bodies[0].peak;
    const y = whereFallsTo(p0.space.field, peak[0], peak[1], peak[2] - share * t);
    const p = plan(mesh(), () => {}, { pins: [{ id: 'b0:pour:0', kind: 'pour', x: peak[0], y }] });
    expect(p.placement.openings.find((o) => o.id === 'b0:pour:0')!.valid).toBe(true);
    expect(codes(p).includes('pour-off-peak')).toBe(warned);
  });
});

describe('pins', () => {
  const mesh = (): WeldedMesh => towers(api, 5);

  it('stay where they were put, take the place of the automatic one, and others keep their land', () => {
    const pin = { id: 'b0:pour:0', kind: 'pour' as const, x: 60, y: 15 };
    const p = plan(mesh(), () => {}, { pins: [pin] });
    const found = p.placement.openings.find((o) => o.id === pin.id)!;
    expect(found).toMatchObject({ x: 60, y: 15, pinned: true, role: 'pinned', valid: true });
    expect(pours(p)).toHaveLength(1);
    // It is well off the peak, and the tall peak is covered by its own vent instead.
    expect(p.placement.uncovered).toEqual([]);
    expect(codes(p)).toContain('pour-off-peak');
    expectAllValid(p);
  });

  it('a pinned vent keeps its id, so a pin survives a rebuild', () => {
    const before = plan(mesh());
    const leafVent = vents(before).find((o) => o.role === 'leaf')!;
    const pin = { id: leafVent.id, kind: 'vent' as const, x: leafVent.x + 2, y: leafVent.y };
    const p = plan(mesh(), () => {}, { pins: [pin] });
    expect(vents(p).filter((o) => o.id === leafVent.id)).toHaveLength(1);
    expect(vents(p).find((o) => o.id === leafVent.id)).toMatchObject({ x: pin.x, pinned: true });
  });

  it('survive a change of t, and are flagged, not moved, when it makes them invalid', () => {
    const pin = { id: 'b0:pour:0', kind: 'pour' as const, x: 60, y: 8 };
    const good = plan(mesh(), () => {}, { pins: [pin] });
    expect(good.placement.openings.find((o) => o.id === pin.id)!.valid).toBe(true);
    // At a large pour the same spot's disc runs off the side of the cavity.
    const bad = plan(mesh(), (p) => (p.pour.diameter = 30), { pins: [pin] });
    const flagged = bad.placement.openings.find((o) => o.id === pin.id)!;
    expect(flagged).toMatchObject({ x: 60, y: 8, valid: false });
    const note = bad.placement.diagnostics.find((d) => d.code === 'opening-invalid')!;
    expect(note.severity).toBe('error');
    expect(note.message).toContain('it runs off the cavity');
  });

  it('do not resize the box', () => {
    const p = plan(mesh());
    const pinned = plan(mesh(), () => {}, { pins: [{ id: 'b0:pour:0', kind: 'pour', x: 60, y: 15 }] });
    expect(pinned.rim).toEqual(p.rim);
  });
});

describe('a grid', () => {
  const grid = (change: (p: Params) => void = () => {}): PlannedOpenings =>
    plan(box([0, 0, 0], [30, 30, 15]), (p) => {
      p.grid.nx = 3;
      p.grid.ny = 2;
      change(p);
    });

  it('places on one tile, and replicates by the export plan', () => {
    const p = grid();
    const singles = p.placement.openings;
    expect(singles.filter((o) => o.kind === 'pour')).toHaveLength(1);
    const copies = replicateOpenings(singles, p.space);
    expect(copies).toHaveLength(singles.length * 6);
    const [pour] = copies;
    const pitch = p.built.field && p.mold.offsets[1][0];
    expect(copies[1].x - pour.x).toBeCloseTo(pitch, 9);
    expect(copies.every((copy) => copy.zb >= 1)).toBe(true);
  });

  it('reads each copy\'s own ceiling: with tiles merged, one copy\'s zb can differ', () => {
    const p = grid((x) => (x.grid.spacing = 0));
    expect(p.built.tilesMerged).toBe(true);
    const all = [...p.placement.openings, { kind: 'vent' as const, x: 29.5, y: 15 }];
    const copies = replicateOpenings(all, p.space);
    for (const copy of copies) expect(copy.zb).toBe(discMinimum(p.space.field, copy.x, copy.y, copy.diameter / 2));
    // That vent's disc is over the next block in all but the last column, and past the end of the row there.
    const edge = copies.slice(-6);
    expect(new Set(edge.map((copy) => copy.zb)).size).toBe(2);
    expect(Math.min(...edge.map((copy) => copy.zb))).toBe(edge[2].zb);
    expect(edge[2].zb).toBeLessThan(edge[0].zb);
  });

  it('validates on the composite: a pitch too small for two seats gives no pour and an error', () => {
    // 8 mm blocks at spacing 0: the seats overlap in every position, so nothing can fit.
    const p = plan(box([0, 0, 0], [8, 8, 15]), (x) => {
      x.grid.nx = 2;
      x.grid.spacing = 0;
    });
    expect(p.placement.bodies[0].placed).toBe(0);
    expect(codes(p)).toContain('pour-shortfall');
    // A vent still fits, as an opening of some kind has to.
    expect(p.placement.openings.every((o) => o.kind === 'vent')).toBe(true);
    expect(p.placement.openings).toHaveLength(1);
  });

  it('warns of funnels that collide across tiles, not within one', () => {
    const p = plan(box([0, 0, 0], [30, 30, 15]), (x) => (x.grid.nx = 2));
    const collision = p.placement.diagnostics.find((d) => d.code === 'funnel-collision')!;
    expect(collision.message).toContain(`${p.mold.offsets[1][0].toFixed(1)} mm apart`);
    expect(codes(plan(box([0, 0, 0], [30, 30, 15])))).not.toContain('funnel-collision');
  });
});

describe('the silicone in the bores', () => {
  it('on a flat ceiling, is each opening\'s area times its length from ceiling to the seat floor', () => {
    const p = plan(box([0, 0, 0], [60, 60, 20]));
    const copies = replicateOpenings(p.placement.openings, p.space);
    const { Zt } = p.rim;
    const sizes = p.space.sizes;
    const ceiling = 20 + p.tilePlan.rEff;
    const expected = (Math.PI / 4) * (sizes.pourDiameter ** 2 * (Zt - sizes.seatDepth - ceiling) + sizes.ventDiameter ** 2 * (Zt - ceiling));
    const found = boreSilicone(copies, p.built.field, Zt);
    expect(Math.abs(found - expected)).toBeLessThan(expected * 0.02);
  });

  it('with the seat off, runs a pour all the way to the top', () => {
    const p = plan(box([0, 0, 0], [60, 60, 20]), (x) => (x.seat.enabled = false));
    const copies = replicateOpenings(p.placement.openings, p.space);
    const ceiling = 20 + p.tilePlan.rEff;
    const { Zt } = p.rim;
    const expected = (Math.PI / 4) * (p.space.sizes.pourDiameter ** 2 + p.space.sizes.ventDiameter ** 2) * (Zt - ceiling);
    expect(Math.abs(boreSilicone(copies, p.built.field, Zt) - expected)).toBeLessThan(expected * 0.02);
    // The seat is out of the land's sums too: the vent stands closer.
    const seated = plan(box([0, 0, 0], [60, 60, 20]));
    const distance = (q: PlannedOpenings): number => {
      const [a, b] = q.placement.openings as OpeningSpot[];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    expect(distance(p)).toBeLessThan(distance(seated));
  });
});
