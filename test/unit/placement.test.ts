import type { ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { replicateOpenings, boreSilicone, type PlacedOpening } from '../../src/core/analysis/placement';
import { checkOpening, discMinimum, heightAt, type OpeningSpot } from '../../src/core/analysis/validate';
import type { Field } from '../../src/core/field/grid';
import { meshBounds, type WeldedMesh } from '../../src/core/mesh/weld';
import { defaultParams } from '../../src/core/params/defaults';
import type { Params } from '../../src/core/params/schema';
import { loadManifold } from '../fixtures/loadExamples';
import { planOpenings, type PlanOptions, type PlannedOpenings } from '../fixtures/openings';
import { box, join, ring, SPIKES, spikes, TOWERS, towers } from '../fixtures/synthetic';

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
  it('two bodies far apart get a pour and a vent each, in 2 cavities', () => {
    const p = plan(join(box([0, 0, 0], [30, 30, 15]), box([100, 0, 0], [130, 30, 15])));
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
    const p = plan(join(box([0, 0, 0], [30, 30, 15]), crumb(60, 15)));
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

  it('a piece under another\'s ceiling is no body, however large', () => {
    const inner = box([10, 10, 0], [20, 20, 5]);
    const p = plan(join(box([0, 0, 0], [30, 30, 15]), inner));
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
