import { createHash } from 'node:crypto';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { boreSilicone, replicateOpenings, type PlacedOpening } from '../../src/core/analysis/placement';
import { mergeTree, significantLeaves } from '../../src/core/analysis/peaks';
import { boreRadius, checkOpening, discMinimum, dropOpening, flangeReach, heightAt, isValid, openingSizes, placementSpace, topRadius, type OpeningKind, type OpeningSpot } from '../../src/core/analysis/validate';
import { connectedPieces } from '../../src/core/mesh/shells';
import { crossParameterErrors } from '../../src/core/params/rules';
import type { Params } from '../../src/core/params/schema';
import { buildBaseBody, buildGlueBase, buildMergedBase } from '../../src/core/parts/base';
import { boltBridges } from '../../src/core/parts/bolts';
import { buildCoverFinal, coverBottom } from '../../src/core/parts/cover';
import { buildFunnel, funnelFile } from '../../src/core/parts/funnel';
import { funnelProfile } from '../../src/core/parts/funnelProfile';
import { grooveResidualVolume } from '../../src/core/parts/joint';
import { VENT_CHAMFER, type CutOpening } from '../../src/core/parts/openings';
import { basePose, coverPose, poseToStl } from '../../src/core/parts/poses';
import { auditOverhang } from '../../src/core/report/overhang';
import { Arena, checked, withArena } from '../../src/core/solid/arena';
import { recordSection } from '../fixtures/benchmarks';
import { countHandles } from '../fixtures/handles';
import { orientedExample } from '../fixtures/fieldRuns';
import { EXAMPLE_IDS, hasExample, loadExample, loadManifold, skipWithout, type ExampleId } from '../fixtures/loadExamples';
import { buildMold, type Mold } from '../fixtures/mold';
import { openMold, planOpenings, type OpenedMold, type PlannedOpenings } from '../fixtures/openings';
import { boxSolid, clipToBox, compareVoids, CRUMB_MM3, insideOutline, outlineArea, readPart, splitShells, unpose, type ExpectedVoid } from '../fixtures/solidChecks';
import { boxWithTopHole, signedVolume, withoutTriangles } from '../fixtures/synthetic';
import { FIELD_GOLDEN, goldenParams, OPENING_GOLDEN } from './golden';

/** The solid checks are what take time, so the plain suite runs them on two models and the full one on all. */
const FULL = process.env.CFG_FULL === '1';
const SLOW = 600_000;
/** Plate top in the closed-volume check, as in M3's. */
const RAISED = 0.01;
/** Models and values the plan's M4 list names without a plateau, whose pour goes at the root peak. */
const PEAK_MODELS: ExampleId[] = ['benchy', 'goddess', 'vis35', 'wolf'];
const PLATEAU_MODELS: ExampleId[] = ['jersey', 'x8', 'barrel'];

let api: ManifoldToplevel;
beforeAll(async () => {
  api = await loadManifold();
});

const within = (actual: number, expected: number, fraction: number): void => {
  expect(Math.abs(actual - expected), `${actual} is not within ${fraction * 100}% of ${expected}`).toBeLessThanOrEqual(Math.abs(expected) * fraction);
};

function paramsWith(change: (p: Params) => void = () => {}): Params {
  const params = goldenParams();
  change(params);
  return params;
}

/** The pure run of S3 to S7, kept per model as many tests read the same one at defaults. */
const planned = new Map<ExampleId, PlannedOpenings>();
function plannedAtDefaults(id: ExampleId): PlannedOpenings {
  let found = planned.get(id);
  if (!found) {
    const { mesh, bounds } = orientedExample(id);
    planned.set(id, (found = planOpenings(mesh, bounds, goldenParams())));
  }
  return found;
}
function planWith(id: ExampleId, change: (p: Params) => void): PlannedOpenings {
  const { mesh, bounds } = orientedExample(id);
  return planOpenings(mesh, bounds, paramsWith(change));
}
const poursOf = (p: PlannedOpenings): PlacedOpening[] => p.placement.openings.filter((o) => o.kind === 'pour');
const ventsOf = (p: PlannedOpenings): PlacedOpening[] => p.placement.openings.filter((o) => o.kind === 'vent');
const codes = (p: PlannedOpenings): string[] => p.placement.diagnostics.map((d) => d.code);

function expectAllValid(p: PlannedOpenings): void {
  for (const opening of p.placement.openings) {
    expect(opening.valid, opening.id).toBe(true);
    expect(checkOpening(p.space, opening, p.placement.openings).problems, opening.id).toEqual([]);
    expect(opening.zb, opening.id).toBeGreaterThanOrEqual(1);
  }
}

/**
 * The highest point of a field, read straight off the array and owing nothing to the merge tree: its
 * height, and every node that holds it, as a flat face of the model dilates to many equal nodes.
 */
function highestOf(field: { values: Float32Array; nx: number; cell: number; x0: number; y0: number }): { height: number; nodes: [number, number][] } {
  let height = -Infinity;
  for (const v of field.values) if (v > height) height = v;
  const nodes: [number, number][] = [];
  for (let n = 0; n < field.values.length; n++) {
    if (field.values[n] !== height) continue;
    const i = n % field.nx, j = (n - i) / field.nx;
    nodes.push([field.x0 + i * field.cell, field.y0 + j * field.cell]);
  }
  return { height, nodes };
}

/**
 * A body's opening stands over that body: inside its extent, which owes nothing to the field, and on a
 * ceiling of its own with no other body's above it.
 */
function expectOverOwnBody(p: PlannedOpenings, opening: PlacedOpening): void {
  const body = p.search.bodies[opening.body];
  expect(opening.x, opening.id).toBeGreaterThanOrEqual(body.min[0]);
  expect(opening.x, opening.id).toBeLessThanOrEqual(body.max[0]);
  expect(opening.y, opening.id).toBeGreaterThanOrEqual(body.min[1]);
  expect(opening.y, opening.id).toBeLessThanOrEqual(body.max[1]);
  const own = heightAt(body.field, opening.x, opening.y);
  expect(own, opening.id).toBeGreaterThanOrEqual(1);
  expect(heightAt(p.tile, opening.x, opening.y) - own, opening.id).toBeLessThanOrEqual(0.05);
}

/** How far a spot is from the nearest node at the highest point. */
const fromPeak = (peak: ReturnType<typeof highestOf>, x: number, y: number): number => Math.min(...peak.nodes.map(([u, v]) => Math.hypot(u - x, v - y)));

describe('peaks and placement on the 8 examples', () => {
  it.each(EXAMPLE_IDS)('%s: every body has at least 1 valid pour, one opening is at each significant peak, and the golden numbers hold', (id) => {
    const p = plannedAtDefaults(id);
    const golden = OPENING_GOLDEN[id];
    expect(p.search.bodies).toHaveLength(golden.bodies);
    expect(p.search.fragments).toEqual([]);
    expect(p.built.cavities.count).toBe(golden.cavities);
    for (const [b, body] of p.placement.bodies.entries()) {
      expect(body.placed, `body ${b}`).toBeGreaterThanOrEqual(1);
      expect(body.placed, `body ${b}`).toBe(body.requested);
    }
    expectAllValid(p);
    expect(p.placement.uncovered).toEqual([]);
    expect(codes(p)).not.toContain('pour-shortfall');
    expect(poursOf(p)).toHaveLength(golden.pours);
    expect(ventsOf(p)).toHaveLength(golden.vents);
    const tree = mergeTree(p.tile);
    expect(tree.leaves).toHaveLength(golden.leaves);
    expect(significantLeaves(tree, 1.5)).toHaveLength(golden.significant);
    expect(p.placement.bodies.filter((b) => b.plateau)).toHaveLength(golden.plateauBodies);
    within(Math.max(...p.placement.openings.map((o) => o.boreLength)), golden.longestBore, 0.01);
    const ml = boreSilicone(replicateOpenings(p.placement.openings, p.space), p.built.field, p.rim.Zt) / 1000;
    within(ml, golden.boreMl, 0.01);
  });

  it('the persistence filter matters on real fields: leaves under the limit, on every model with more than a top', () => {
    for (const id of (['benchy', 'goddess', 'vis35', 'x8'] as ExampleId[]).filter(hasExample)) {
      const tree = mergeTree(plannedAtDefaults(id).tile);
      expect(tree.leaves.length, id).toBeGreaterThan(significantLeaves(tree, 1.5).length);
      // Births at a flat level fold away, so the sweep starts far more basins than it keeps leaves.
      expect(tree.basinParents.length, id).toBeGreaterThan(tree.leaves.length);
    }
  });

  describe('the plan\'s plateau flags', () => {
    it.for(PEAK_MODELS)('%s has none, so its pour goes within 1 mm of its root peak', (id, test) => {
      skipWithout(test, id);
      const p = plannedAtDefaults(id);
      expect(p.placement.bodies.map((b) => b.plateau)).toEqual([false]);
      const peak = highestOf(p.tile);
      const pour = poursOf(p)[0];
      expect(pour.role).toBe('peak');
      expect(fromPeak(peak, pour.x, pour.y), `pour at ${pour.x}, ${pour.y}`).toBeLessThanOrEqual(1);
      expect(p.placement.bodies[0].peak[2]).toBe(peak.height);
    });

    it('a peak that is a small flat gets its pour in the middle of that flat, not at its first corner', () => {
      // Benchy's top is its chimney's rim, about 28 mm2 of nodes at exactly one height: too small for a plateau.
      const p = plannedAtDefaults('benchy');
      const peak = highestOf(p.tile);
      expect(peak.nodes.length * p.tile.cell ** 2).toBeGreaterThan(20);
      const pour = poursOf(p)[0];
      expect(fromPeak(peak, pour.x, pour.y)).toBe(0);
      // The node a plain sweep would pick: lowest y, then lowest x.
      const [cornerX, cornerY] = peak.nodes[0];
      expect(Math.hypot(pour.x - cornerX, pour.y - cornerY)).toBeGreaterThan(1);
      const middle = [peak.nodes.reduce((s, [x]) => s + x, 0) / peak.nodes.length, peak.nodes.reduce((s, [, y]) => s + y, 0) / peak.nodes.length];
      expect(Math.hypot(pour.x - middle[0], pour.y - middle[1])).toBeLessThan(Math.hypot(cornerX - middle[0], cornerY - middle[1]));
    });

    it.for(PLATEAU_MODELS)('%s is flagged, and its pour is on the flat top, as far from the edge as it gets', (id, test) => {
      skipWithout(test, id);
      const p = plannedAtDefaults(id);
      expect(p.placement.bodies.some((b) => b.plateau)).toBe(true);
      for (const [b, body] of p.search.bodies.entries()) {
        const pour = poursOf(p).find((o) => o.body === b)!;
        if (!body.plateau) continue;
        expect(pour.role).toBe('plateau');
        expect([pour.x, pour.y]).toEqual([body.plateau.x, body.plateau.y]);
        expect(body.plateau.area).toBeGreaterThanOrEqual(50);
        expect(body.plateau.clearance).toBeGreaterThan(1);
        // On it, by the field itself, and within 0.2 of the peak: the top rounded to height steps.
        expect(Math.abs(heightAt(body.field, pour.x, pour.y) - body.leaves[0].height)).toBeLessThanOrEqual(0.21);
      }
    });

    it('jersey\'s is at the middle of its top, by symmetry, and barrel\'s at the middle of its lid', (test) => {
      skipWithout(test, 'barrel');
      const jersey = poursOf(plannedAtDefaults('jersey'))[0];
      expect(Math.hypot(jersey.x, jersey.y)).toBeLessThanOrEqual(0.25);
      const barrel = poursOf(plannedAtDefaults('barrel'))[0];
      expect(Math.hypot(barrel.x, barrel.y)).toBeLessThanOrEqual(0.25);
    });

    it('x8\'s 4 whole barriers each match the lone jersey, and they alone', () => {
      const x8 = plannedAtDefaults('x8');
      const { plateau } = plannedAtDefaults('jersey').search.bodies[0];
      const whole = x8.search.bodies.filter((b) => b.min[0] > 0);
      expect(whole).toHaveLength(4);
      for (const body of whole) within(body.plateau!.area, plateau!.area, 1e-9);
      // The other 4 are broken barriers, and one of them has no flat left: see the plan's M4 note.
      expect(x8.placement.bodies.map((b) => b.plateau)).toEqual([true, true, true, false, true, true, true, true]);
    });

    it('x8\'s broken barrier, the one body with no plateau, gets its pour within 1 mm of its peak, on the flat at its end', () => {
      const p = plannedAtDefaults('x8');
      const b = p.placement.bodies.findIndex((body) => !body.plateau);
      const body = p.search.bodies[b];
      const peak = highestOf(body.field);
      // The first node of its flat, where a plain sweep puts the peak, is the barrier's corner, and a disc there is off the cavity.
      const [cornerX, cornerY] = peak.nodes[0];
      expect(cornerX).toBeCloseTo(body.min[0], 0);
      expect(discMinimum(p.space.field, cornerX, cornerY, boreRadius(p.space.sizes, 'pour'))).toBeLessThan(1);
      const pour = poursOf(p).find((o) => o.body === b)!;
      expect(pour.role).toBe('peak');
      expect(fromPeak(peak, pour.x, pour.y)).toBeLessThanOrEqual(1);
      expect(heightAt(body.field, pour.x, pour.y)).toBe(peak.height);
      // So its bore stays over the top. Snapped from that corner it ran 20 mm down the flank, to 3.7.
      expect(pour.zb).toBeGreaterThanOrEqual(peak.height - p.settings.t);
      // Its other end stands as high, across a dip of 9 mm, so that gets a vent.
      expect(ventsOf(p).filter((o) => o.body === b && o.role === 'leaf')).toHaveLength(1);
    });
  });

  describe('vents', () => {
    it('wolf gets its long vent, about 147 mm, with a warning, at the leaf over the limit', () => {
      const p = plannedAtDefaults('wolf');
      const long = ventsOf(p).filter((o) => o.role === 'leaf');
      expect(long).toHaveLength(1);
      expect(Math.abs(long[0].boreLength - 147)).toBeLessThan(1);
      const warning = p.placement.diagnostics.find((d) => d.code === 'long-vent')!;
      expect(warning.severity).toBe('warning');
      expect(warning.message).toContain('147 mm');
      const leaf = p.search.bodies[0].leaves[1];
      expect([long[0].x, long[0].y]).toEqual([leaf.x, leaf.y]);
      expect(leaf.persistence).toBeGreaterThanOrEqual(1.5);
      // At a higher limit the same leaf is left alone, and then it says nothing about the length.
      const without = planWith('wolf', (x) => (x.vents.persistence = 4));
      expect(ventsOf(without).filter((o) => o.role === 'leaf')).toEqual([]);
      expect(codes(without)).not.toContain('long-vent');
    });

    it.each(EXAMPLE_IDS)('%s: each body has a vent beside its first pour, on a circle outside the seat', (id) => {
      const p = plannedAtDefaults(id);
      const { sizes } = p.space;
      // FL: and outside the funnel's flange, which at defaults is the further.
      const closest = Math.max(topRadius(sizes, 'pour') + topRadius(sizes, 'vent') + sizes.minLand, flangeReach(sizes));
      expect(closest).toBeGreaterThan(topRadius(sizes, 'pour') + topRadius(sizes, 'vent') + sizes.minLand + 2.9);
      for (const [b] of p.search.bodies.entries()) {
        const pour = poursOf(p).find((o) => o.body === b)!;
        const beside = ventsOf(p).find((o) => o.body === b && o.role === 'beside')!;
        expect(beside, `body ${b}`).toBeDefined();
        const apart = Math.hypot(beside.x - pour.x, beside.y - pour.y);
        expect(apart).toBeGreaterThanOrEqual(closest);
        expect(apart).toBeLessThanOrEqual(closest + 4.1);
      }
    });

    it.each(EXAMPLE_IDS)('%s: that vent is at the highest valid point of the nearest circle that has one, by a scan of its own', (id) => {
      const p = plannedAtDefaults(id);
      const { sizes, field } = p.space;
      const closest = Math.max(topRadius(sizes, 'pour') + topRadius(sizes, 'vent') + sizes.minLand, flangeReach(sizes));
      for (const beside of ventsOf(p).filter((o) => o.role === 'beside')) {
        const pour = poursOf(p).find((o) => o.body === beside.body)!;
        const others = p.placement.openings.filter((o) => o !== beside);
        const radius = Math.hypot(beside.x - pour.x, beside.y - pour.y);
        // At defaults nothing stands in the way of the closest circle, so the further ones are never needed.
        expect(radius - closest, beside.id).toBeLessThan(0.02);
        let best = -Infinity;
        for (let k = 0; k < 720; k++) {
          const spot: OpeningSpot = { kind: 'vent', x: pour.x + radius * Math.cos((k * Math.PI) / 360), y: pour.y + radius * Math.sin((k * Math.PI) / 360) };
          if (checkOpening(p.space, spot, others).valid) best = Math.max(best, heightAt(field, spot.x, spot.y));
        }
        // Against a scan 10 times as fine. Its own 72 angles leave half an angle's arc to the best point at
        // most, so it may stand that far times the steepest slope there under it, plus a height step.
        const halfArc = (Math.PI * radius) / 72;
        let slope = 0;
        for (let dx = -halfArc; dx <= halfArc; dx += field.cell) {
          for (let dy = -halfArc; dy <= halfArc; dy += field.cell) {
            const x = beside.x + dx, y = beside.y + dy, c = field.cell;
            slope = Math.max(slope, Math.hypot(heightAt(field, x + c, y) - heightAt(field, x - c, y), heightAt(field, x, y + c) - heightAt(field, x, y - c)) / (2 * c));
          }
        }
        expect(heightAt(field, beside.x, beside.y), beside.id).toBeGreaterThanOrEqual(best - 0.01 - slope * halfArc);
      }
    });
  });

  describe('the plan\'s counts', () => {
    it('x8 at perModel = 3 gives 24 valid pours, 3 per body, each over its own body', () => {
      const p = planWith('x8', (x) => (x.pour.perModel = 3));
      const pours = poursOf(p);
      expect(pours).toHaveLength(24);
      expectAllValid(p);
      expect(p.placement.bodies.every((b) => b.placed === 3 && b.requested === 3)).toBe(true);
      for (const pour of pours) expectOverOwnBody(p, pour);
      const copies = replicateOpenings(p.placement.openings, p.space);
      expect(copies.filter((c) => c.kind === 'pour')).toHaveLength(24);
      // FL: with the pours placed first, a vent beside a first pour stands on the barrier's top or not at all,
      // never down in the trench beside it, about 20 mm under the tops, where it would vent nothing.
      for (const beside of ventsOf(p).filter((o) => o.role === 'beside')) {
        const pour = poursOf(p).find((o) => o.body === beside.body)!;
        // The tops stand at 24 mm, the trenches at about 4.
        expect(heightAt(p.space.field, pour.x, pour.y) - heightAt(p.space.field, beside.x, beside.y), beside.id).toBeLessThan(10);
      }
      const crowded = p.placement.diagnostics.filter((d) => d.code === 'vent-refused');
      expect(crowded.map((d) => d.severity)).toEqual(['info']);
      expect(ventsOf(p).filter((o) => o.role === 'beside').length + (crowded[0].message.match(/\(/g) ?? []).length).toBe(8);
    });

    it.each([[10, false], [0, true]])('grid 2 x 3 Benchy at spacing %i, merged %s, gives 6 pours and at least 6 vents', (spacing, merged) => {
      const p = planWith('benchy', (x) => {
        x.grid.nx = 2;
        x.grid.ny = 3;
        x.grid.spacing = spacing;
      });
      expect(p.built.tilesMerged).toBe(merged);
      expect(p.placement.bodies).toHaveLength(1);
      expectAllValid(p);
      const copies = replicateOpenings(p.placement.openings, p.space);
      expect(copies.filter((c) => c.kind === 'pour')).toHaveLength(6);
      expect(copies.filter((c) => c.kind === 'vent').length).toBeGreaterThanOrEqual(6);
      expect(p.placement.uncovered).toEqual([]);
    });

    it('a jersey grid at pitch under two seats: tile-to-tile collision found, and no pour fits', () => {
      const p = planWith('jersey', (x) => {
        x.grid.ny = 2;
        x.grid.spacing = 0;
      });
      // 14.8 mm rows, and two 13.46 mm seats plus 1.5 of land do not go.
      expect(p.space.pitchY).toBeLessThan(2 * topRadius(p.space.sizes, 'pour') + p.space.sizes.minLand);
      expect(checkOpening(p.space, { kind: 'pour', x: 0, y: 0 }, []).problems).toContain('land');
      expect(p.placement.bodies[0].placed).toBe(0);
      expect(p.placement.diagnostics.find((d) => d.code === 'pour-shortfall')?.severity).toBe('error');
      expect(poursOf(p)).toEqual([]);
    });

    it('funnels collide on x8 at its 22 mm pitch, and a smaller one is suggested', () => {
      const p = plannedAtDefaults('x8');
      const warning = p.placement.diagnostics.find((d) => d.code === 'funnel-collision')!;
      expect(warning.severity).toBe('warning');
      expect(warning.message).toContain('22.0 mm apart');
      // FL: the 21 mm a top would need leaves no room for a 21.5 mm flange either, so the flange is sized too.
      expect(warning.message).toMatch(/top diameter of 21 mm with a flange width of at most 3\.7 mm would fit/);
      const fits = planWith('x8', (x) => (x.funnel.topDiameter = 21));
      expect(codes(fits)).not.toContain('funnel-collision');
      for (const id of ['benchy', 'wolf', 'jersey'] as ExampleId[]) expect(codes(plannedAtDefaults(id))).not.toContain('funnel-collision');
    });

    it('x8 at pour 20: seats too wide for its rows stagger along the barriers\' tops, so every barrier still gets its pour', () => {
      const p = planWith('x8', (x) => (x.pour.diameter = 20));
      // 23.5 mm seats on 22 mm rows.
      expect(2 * topRadius(p.space.sizes, 'pour')).toBeGreaterThan(22);
      expectAllValid(p);
      expect(p.placement.bodies.map((b) => b.placed)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
      for (const pour of poursOf(p)) {
        expectOverOwnBody(p, pour);
        // On its barrier's top to within a height step, not slid down a flank, which left the last one no room.
        const body = p.search.bodies[pour.body];
        expect(body.leaves[0].height - heightAt(body.field, pour.x, pour.y), pour.id).toBeLessThan(0.01);
      }
      // Neighbouring whole barriers' poles stand 22 mm apart, under the 25 two seats need, so some had to move.
      const atPole = poursOf(p).filter((o) => {
        const { plateau } = p.search.bodies[o.body];
        return plateau && o.x === plateau.x && o.y === plateau.y;
      });
      expect(atPole.length).toBeLessThan(8);
      expect(codes(p)).toEqual(['funnel-collision']);
      expect(p.placement.uncovered).toEqual([]);
    });

    it('never a shortfall unreported: on small models a high count says placed against requested', () => {
      const p = planWith('jersey', (x) => (x.pour.perModel = 16));
      const [body] = p.placement.bodies;
      expect(body.requested).toBe(16);
      expect(body.placed).toBeLessThan(16);
      expect(body.placed).toBeGreaterThanOrEqual(3);
      expect(p.placement.diagnostics.find((d) => d.code === 'pour-shortfall')?.message).toContain(`Placed ${body.placed} of 16`);
      expectAllValid(p);
    });
  });

  describe('at a preview cell', () => {
    it.for([['wolf', 2], ['goddess', 2], ['jersey', 1], ['barrel', 1]] as [ExampleId, number][])('%s places much as at the export cell, in the same box', ([id, slack], test) => {
      skipWithout(test, id);
      const { mesh, bounds } = orientedExample(id);
      const preview = planOpenings(mesh, bounds, goldenParams(), { cell: 0.5 });
      const final = plannedAtDefaults(id);
      expect(preview.rim).toEqual(final.rim);
      expectAllValid(preview);
      const a = poursOf(preview)[0], b = poursOf(final)[0];
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThanOrEqual(slack);
    });

    it('x8 2 x 1: copies sit on the export plan\'s pitch, as the preview\'s tiles do to within half a cell', () => {
      const params = paramsWith((p) => (p.grid.nx = 2));
      const { mesh, bounds } = orientedExample('x8');
      const preview = planOpenings(mesh, bounds, params, { cell: 0.5 });
      expect(preview.space.pitchX).toBe(124.75);
      expect(preview.built.field.nx).toBeGreaterThan(0);
      const copies = replicateOpenings(preview.placement.openings, preview.space);
      expect(copies[1].x - copies[0].x).toBe(124.75);
    });
  });

  // M11c: the user's file, 6 closed parts of one chick, 5 passing into the largest, which placement took
  // for 6 bodies: pours on 3 of them and errors on the other 3 ("Placed 0 of 1 pours on the body with its
  // peak at (125.0, 104.0)", at (118.5, 83.5) and at (131.5, 83.5)), which kept Export ZIP off.
  describe('the chick, a multi-colour model of 6 parts that overlap', () => {
    it('is one body, with one pour at its highest point, the top part\'s, a vent beside it, and no shortfall', () => {
      const p = plannedAtDefaults('chick');
      const { mesh } = orientedExample('chick');
      expect(connectedPieces(mesh)).toHaveLength(6);
      expect(p.search.bodies).toHaveLength(1);
      expect(p.search.fragments).toEqual([]);
      expect(p.placement.bodies).toMatchObject([{ requested: 1, placed: 1, plateau: false }]);
      const [pour] = poursOf(p);
      expect(poursOf(p)).toHaveLength(1);
      // The peak is the top part's, 23.61 mm up, which no other part reaches, and the field's highest point.
      const top = connectedPieces(mesh).reduce((a, b) => (a.max[2] > b.max[2] ? a : b));
      expect(top.triangleCount).toBe(10322);
      expect(top.max[2]).toBeCloseTo(23.61, 2);
      expect(pour.x).toBeGreaterThan(top.min[0]);
      expect(pour.x).toBeLessThan(top.max[0]);
      expect(pour.y).toBeGreaterThan(top.min[1]);
      expect(pour.y).toBeLessThan(top.max[1]);
      expect(fromPeak(highestOf(p.tile), pour.x, pour.y)).toBeLessThanOrEqual(1);
      expect(Math.hypot(pour.x - 124.9, pour.y - 104)).toBeLessThan(1);
      // G11 and D3: a vent beside it, and one at every other leaf past the persistence: there is none.
      expect(ventsOf(p).map((o) => o.role)).toEqual(['beside']);
      expect(significantLeaves(mergeTree(p.tile), 1.5)).toHaveLength(1);
      expect(p.placement.uncovered).toEqual([]);
      expect(p.placement.diagnostics).toEqual([]);
      expectAllValid(p);
    });

    it.each([2, 3])('perModel %i gives that many pours, all on the one body', (count) => {
      const p = planWith('chick', (q) => (q.pour.perModel = count));
      expect(p.search.bodies).toHaveLength(1);
      expect(poursOf(p)).toHaveLength(count);
      expect(poursOf(p).every((o) => o.body === 0)).toBe(true);
      expect(p.placement.bodies).toMatchObject([{ requested: count, placed: count }]);
      expect(codes(p)).not.toContain('pour-shortfall');
      // 40 mm funnels do not fit side by side on a 40 mm chick, which the soft rule says. FL: at 3 the pours
      // go first, and the vent beside the first then stands 1.7 mm lower than 9.8 mm out, past t / 2, which a note says.
      expect(codes(p)).toEqual(count === 3 ? ['vent-low', 'funnel-collision'] : ['funnel-collision']);
      expectAllValid(p);
    });
  });

  describe('detached fragments', () => {
    const baseFree = (id: ExampleId) => {
      const { mesh, bounds } = orientedExample(id);
      const drop: number[] = [];
      const { positions: q, indices } = mesh;
      for (let t = 0; t < indices.length / 3; t++) {
        if (q[indices[t * 3] * 3 + 2] <= 0.05 && q[indices[t * 3 + 1] * 3 + 2] <= 0.05 && q[indices[t * 3 + 2] * 3 + 2] <= 0.05) drop.push(t);
      }
      return { mesh: withoutTriangles(mesh, drop), bounds };
    };

    it('Benchy with its base removed comes apart into 9 pieces, and is still one body with one pour', () => {
      const { mesh, bounds } = baseFree('benchy');
      expect(connectedPieces(mesh)).toHaveLength(9);
      const p = planOpenings(mesh, bounds, goldenParams());
      expect(p.search.bodies).toHaveLength(1);
      expect(p.search.fragments).toHaveLength(8);
      expect(p.search.fragments.every((f) => f.reason === 'buried')).toBe(true);
      expect(poursOf(p)).toHaveLength(1);
      expect(p.placement.bodies).toHaveLength(1);
      // The same placement as the whole model has.
      const whole = poursOf(plannedAtDefaults('benchy'))[0];
      expect(Math.hypot(poursOf(p)[0].x - whole.x, poursOf(p)[0].y - whole.y)).toBeLessThanOrEqual(1);
    });

    it('negative control: x8 with its bases removed keeps all 8 bodies, as those are no fragments', () => {
      const { mesh, bounds } = baseFree('x8');
      const p = planOpenings(mesh, bounds, goldenParams());
      expect(p.search.bodies).toHaveLength(8);
      expect(p.search.fragments).toEqual([]);
    });
  });
});

/** Each model's drop times at the export cell. A preview's field is 16 times smaller. */
const dropRows: string[] = [];

/**
 * FL: no vent under a flange, by a check of its own: every copy of every vent against every copy of every
 * pour, by plain distance, with the flange's radius worked out by hand from the parameters.
 */
function expectNoVentUnderAFlange(p: PlannedOpenings, params: Params): void {
  const half = (params.seat.halfAngleDeg * Math.PI) / 180;
  const flange = params.pour.diameter / 2 + params.seat.depth * Math.tan(half) + params.funnel.flangeWidth;
  const mouth = params.vents.diameter / 2 + VENT_CHAMFER;
  const copies = replicateOpenings(p.placement.openings, p.space);
  const pours = copies.filter((c) => c.kind === 'pour'), vents = copies.filter((c) => c.kind === 'vent');
  expect(pours.length).toBeGreaterThan(0);
  expect(vents.length).toBeGreaterThan(0);
  let nearest = Infinity;
  for (const pour of pours) for (const vent of vents) nearest = Math.min(nearest, Math.hypot(pour.x - vent.x, pour.y - vent.y));
  expect(nearest).toBeGreaterThanOrEqual(flange + mouth + 0.5 - 1e-9);
}

describe('FL: no vent under a funnel\'s flange', () => {
  it.each(EXAMPLE_IDS)('%s: no vent\'s mouth within a flange\'s radius and 0.5 mm of any pour, and every body still gets its pours', (id) => {
    const p = plannedAtDefaults(id);
    expectNoVentUnderAFlange(p, goldenParams());
    expectAllValid(p);
    for (const body of p.placement.bodies) expect(body.placed).toBe(body.requested);
  });

  const GRIDS: [string, ExampleId, (x: Params) => void][] = [
    ['Benchy 2 x 3', 'benchy', (x) => ((x.grid.nx = 2), (x.grid.ny = 3))],
    ['jersey 3 x 3', 'jersey', (x) => ((x.grid.nx = 3), (x.grid.ny = 3))],
    ['x8 at perModel 3', 'x8', (x) => (x.pour.perModel = 3)],
    ['the wolf with the base layer', 'wolf', (x) => (x.silicone.baseLayer = null)],
  ];
  it.each(GRIDS)('%s: the same, on every copy', (_, id, change) => {
    const p = planWith(id, change);
    expectNoVentUnderAFlange(p, paramsWith(change));
    expectAllValid(p);
    for (const body of p.placement.bodies) expect(body.placed).toBe(body.requested);
    expect(p.placement.diagnostics.map((d) => d.code)).not.toContain('pour-shortfall');
    if (id === 'x8') expect(poursOf(p)).toHaveLength(24);
  });

  it('negative control: with no flange, the vent beside jersey\'s pour is under where a default flange would rest', () => {
    const p = planWith('jersey', (x) => (x.funnel.flangeWidth = 0));
    expect(() => expectNoVentUnderAFlange(p, goldenParams())).toThrow();
    expectNoVentUnderAFlange(p, paramsWith((x) => (x.funnel.flangeWidth = 0)));
  });

  it('a vent dragged under the flange on jersey is refused for the flange, and snaps out clear of it', () => {
    const p = plannedAtDefaults('jersey');
    const pour = poursOf(p)[0], vent = ventsOf(p)[0];
    const others = p.placement.openings.filter((o) => o !== vent);
    // Between the land and the flange's edge, towards the pour.
    const { sizes } = p.space;
    const land = topRadius(sizes, 'pour') + topRadius(sizes, 'vent') + sizes.minLand;
    const along = (land + flangeReach(sizes)) / 2;
    const unit = [(vent.x - pour.x) / Math.hypot(vent.x - pour.x, vent.y - pour.y), (vent.y - pour.y) / Math.hypot(vent.x - pour.x, vent.y - pour.y)];
    const spot: OpeningSpot = { kind: 'vent', x: pour.x + unit[0] * along, y: pour.y + unit[1] * along };
    expect(checkOpening(p.space, spot, others).problems).toEqual(['flange']);
    const drop = dropOpening(p.space, spot, others);
    expect(drop).toMatchObject({ snapped: true, valid: true, problems: [] });
    expect(Math.hypot(drop.x - pour.x, drop.y - pour.y)).toBeGreaterThanOrEqual(flangeReach(sizes));
  });

  it('barrel at t = 1: no room for the vent beside its pour clear of the flange, and the warning names the widest flange that makes room', (test) => {
    skipWithout(test, 'barrel');
    const p = planWith('barrel', (x) => (x.silicone.t = 1));
    expect(ventsOf(p)).toEqual([]);
    const refused = p.placement.diagnostics.find((d) => d.code === 'vent-refused')!;
    expect(refused.message).toBe("No room for a vent beside the pour at (0.0, 0.0) clear of its funnel's flange: a Flange width of at most 2.5 mm under Pour & funnel leaves room for one.");
    expect(p.placement.uncovered).toEqual([]);
    // And it is so: at 2.5 mm the vent stands beside the pour, and half a mm wider it does not.
    expect(ventsOf(planWith('barrel', (x) => ((x.silicone.t = 1), (x.funnel.flangeWidth = 2.5))))).toHaveLength(1);
    expect(ventsOf(planWith('barrel', (x) => ((x.silicone.t = 1), (x.funnel.flangeWidth = 3))))).toEqual([]);
    // With no flange the vent stands beside it, as before FL.
    const plain = planWith('barrel', (x) => ((x.silicone.t = 1), (x.funnel.flangeWidth = 0)));
    expect(ventsOf(plain)).toHaveLength(1);
    expect(codes(plain)).not.toContain('vent-refused');
  });

  it('no default pour moves for the flange\'s room on the top: at each, the top\'s edge is further than the flange and the chamfer', () => {
    for (const id of EXAMPLE_IDS) {
      const p = plannedAtDefaults(id);
      // Where they stand with no flange, which is before FL.
      const plain = planWith(id, (x) => (x.funnel.flangeWidth = 0));
      expect(poursOf(p).map(({ id: o, x, y }) => [o, x, y]), id).toEqual(poursOf(plain).map(({ id: o, x, y }) => [o, x, y]));
      const { O } = p.rim;
      const reach = p.space.sizes.flangeRadius + p.space.sizes.topChamfer;
      for (const copy of replicateOpenings(poursOf(p), p.space)) {
        const edge = Math.min(copy.x - O.x0, O.x1 - copy.x, copy.y - O.y0, O.y1 - copy.y);
        // The wall and the seat set the inset as before FL, which the flange's needs stay under by a margin.
        expect(edge, id).toBeGreaterThan(reach + 1);
        expect(edge, id).toBeGreaterThan(p.rim.wall + topRadius(p.space.sizes, 'pour'));
      }
    }
  });
});

/** SHA-256 of a placement's openings, ids and positions, in order: what S7 gives, to the last bit. */
const placementHash = (p: PlannedOpenings): string => createHash('sha256').update(JSON.stringify(p.placement.openings.map((o) => [o.id, o.x, o.y]))).digest('hex');

describe('FL: more than one pour per body', () => {
  /** At the goldens' settings, as 7a35b00 placed them, before any change of FL: its own code, run from a copy of that commit. */
  const BEFORE_FL: [string, ExampleId, (x: Params) => void, string][] = [
    ['jersey at 2 pours', 'jersey', (x) => (x.pour.perModel = 2), '7c82a37d4500df34ef29921b8a1aeb93ce4f0929a8334488639dc6c123949b3b'],
    ['Benchy at 2 pours', 'benchy', (x) => (x.pour.perModel = 2), '483e40e799625c4d4f72f987edb24145f43dd20874598fd8d669e982fdc05908'],
    ['x8 at 3 pours', 'x8', (x) => (x.pour.perModel = 3), '920abc9336809579e1d6cbd4eb7feea9cb69b75aca590e47c79490f007504386'],
  ];
  it.each(BEFORE_FL)('%s: with no flange, and with one the land keeps clear (1 mm), every opening stands where it did before FL', (_, id, change, hash) => {
    expect(placementHash(planWith(id, (x) => (change(x), (x.funnel.flangeWidth = 0))))).toBe(hash);
    expect(placementHash(planWith(id, (x) => (change(x), (x.funnel.flangeWidth = 1))))).toBe(hash);
    // And the default flange does move them, so the hash is no constant.
    expect(placementHash(planWith(id, change))).not.toBe(hash);
  });

  it.each([['jersey', 'jersey'], ['Benchy', 'benchy']] as [string, ExampleId][])('%s at 2 pours: the second pour keeps its flange off the first\'s seat, as there is room for it as high up', (_, id) => {
    const p = planWith(id, (x) => (x.pour.perModel = 2));
    const [first, second] = poursOf(p);
    // The flange's radius, the seat's 5 + 3 tan 30 and 4 more, then the other seat and the 0.5 mm gap, by hand.
    const seat = 5 + 3 * Math.tan(Math.PI / 6);
    expect(Math.hypot(second.x - first.x, second.y - first.y)).toBeGreaterThanOrEqual(seat + 4 + seat + 0.5);
    // As high as with no flange, give or take t / 2.
    const plain = poursOf(planWith(id, (x) => ((x.pour.perModel = 2), (x.funnel.flangeWidth = 0))))[1];
    expect(heightAt(p.space.field, second.x, second.y)).toBeGreaterThanOrEqual(heightAt(p.space.field, plain.x, plain.y) - 1.5);
    const collision = p.placement.diagnostics.find((d) => d.code === 'funnel-collision')!;
    expect(collision.message).not.toContain("other pour's seat");
    expectAllValid(p);
    expectNoVentUnderAFlange(p, paramsWith((x) => (x.pour.perModel = 2)));
    expect(ventsOf(p).filter((o) => o.role === 'beside')).toHaveLength(1);
  });

  it('jersey at 3 pours: clear of each other\'s seats, and the vent beside the first gives way to them, with a note', () => {
    const seat = 5 + 3 * Math.tan(Math.PI / 6);
    const p = planWith('jersey', (x) => (x.pour.perModel = 3));
    // Three pours on jersey's one top, spread along it clear of each other's seats too.
    const pours = poursOf(p);
    expect(pours).toHaveLength(3);
    for (const a of pours) for (const b of pours) if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(seat + 4 + seat + 0.5);
    // There is then no room for the vent beside the first on the top, and a note says why, as the pours open it.
    expect(ventsOf(p)).toEqual([]);
    expect(p.placement.diagnostics.find((d) => d.code === 'vent-refused')).toMatchObject({ severity: 'info' });
    expect(p.placement.uncovered).toEqual([]);
  });
});

describe('FL: the vent beside a pour on a peaked top', () => {
  it('the wolf: the flange keeps it 12.8 mm out, lower down its dome than 9.8 mm, and a note says so and what would let it stand nearer', () => {
    const p = plannedAtDefaults('wolf');
    const note = p.placement.diagnostics.find((d) => d.code === 'vent-low')!;
    expect(note.severity).toBe('info');
    const beside = ventsOf(p).find((o) => o.role === 'beside')!;
    const pour = poursOf(p)[0];
    expect(note.message).toContain(`The vent at (${beside.x.toFixed(1)}, ${beside.y.toFixed(1)}) beside the pour stands 12.8 mm from it`);
    expect(note.message).toContain('A Flange width of at most 1 mm under Pour & funnel lets the vent stand 9.8 mm out.');
    // The drop it gives is the drop to the vent with no flange, by a placement of its own.
    const plain = ventsOf(planWith('wolf', (x) => (x.funnel.flangeWidth = 0))).find((o) => o.role === 'beside')!;
    const drop = heightAt(p.space.field, plain.x, plain.y) - heightAt(p.space.field, beside.x, beside.y);
    expect(drop).toBeGreaterThan(goldenParams().silicone.t / 2);
    expect(note.message).toContain(`the ceiling is ${drop.toFixed(1)} mm lower than 9.8 mm out`);
    expect(Math.hypot(plain.x - pour.x, plain.y - pour.y)).toBeCloseTo(9.79, 2);
    // At 1 mm the vent is back where it stands with none, and nothing is said.
    const narrow = planWith('wolf', (x) => (x.funnel.flangeWidth = 1));
    expect(ventsOf(narrow).find((o) => o.role === 'beside')).toMatchObject({ x: plain.x, y: plain.y });
    expect(codes(narrow)).not.toContain('vent-low');
  });

  it('jersey, Benchy and the chick: no note where the flange costs the vent no height', () => {
    for (const id of ['jersey', 'benchy', 'chick'] as ExampleId[]) expect(codes(plannedAtDefaults(id)), id).not.toContain('vent-low');
  });
});

describe('drag validation on real fields', () => {
  /** The plan's random drops: anywhere over the box and a little past it. */
  function drops(p: PlannedOpenings, count: number, seed0: number): [number, number][] {
    let seed = seed0;
    const random = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const { O } = p.rim;
    return Array.from({ length: count }, () => [O.x0 - 20 + random() * (O.x1 - O.x0 + 40), O.y0 - 20 + random() * (O.y1 - O.y0 + 40)]);
  }

  describe.each(EXAMPLE_IDS)('%s', (id) => {
    it.each(['pour', 'vent'] as OpeningKind[])('a %s: 100 random drops all land valid', (kind) => {
      const p = plannedAtDefaults(id);
      const { openings } = p.placement;
      // The opening being dragged is one of those placed, and all the others stay in its way.
      const moving = openings.find((o) => o.kind === kind)!;
      const others = openings.filter((o) => o !== moving);
      // A space as the main thread has it after a rebuild: placement filled the distance map of its own.
      const space = placementSpace(p.space.field, p.rim, p.mold.offsets, p.space.sizes);
      expect(space.clearance).toBeNull();
      // A drop on the box's corner always snaps, so it is the one that builds the map.
      const t0 = performance.now();
      expect(dropOpening(space, { kind, x: p.rim.O.x0, y: p.rim.O.y0 }, others).valid).toBe(true);
      const first = performance.now() - t0;
      expect(space.clearance).not.toBeNull();
      let worst = 0, valid = 0;
      for (const [x, y] of drops(p, 100, id.length * 7919 + (kind === 'pour' ? 1 : 2))) {
        const started = performance.now();
        const result = dropOpening(space, { kind, x, y }, others);
        worst = Math.max(worst, performance.now() - started);
        expect(result.valid, `${kind} dropped at ${x}, ${y}`).toBe(true);
        const check = checkOpening(p.space, { kind, x: result.x, y: result.y }, others);
        expect(check.problems, `${kind} dropped at ${x}, ${y}`).toEqual([]);
        if (!result.snapped) {
          valid++;
          expect([result.x, result.y]).toEqual([x, y]);
        }
      }
      // Most of the box is not valid ground, so most of these did have to snap.
      expect(valid).toBeLessThan(100);
      dropRows.push(`| ${id} | ${kind} | ${p.built.field.values.length} | ${first.toFixed(1)} | ${worst.toFixed(1)} |`);
    });

    it('a snap is the nearest valid place to within its step, against a scan by the full check', () => {
      const p = plannedAtDefaults(id);
      const others = p.placement.openings.slice(1);
      const { O, wall } = p.rim;
      // The snap's own step, and a lattice from the drop at that step, read by checkOpening alone.
      const step = 0.25;
      const inset = wall + topRadius(p.space.sizes, 'pour');
      for (const [x, y] of drops(p, 12, 101)) {
        const result = dropOpening(p.space, { kind: 'pour', x, y }, others);
        const moved = Math.hypot(result.x - x, result.y - y);
        let nearest = Infinity;
        const reach = Math.ceil(moved / step) + 1;
        for (let j = -reach; j <= reach; j++) {
          for (let i = -reach; i <= reach; i++) {
            const u = x + i * step, v = y + j * step;
            const d = Math.hypot(u - x, v - y);
            // Past the top's edge rule there is nothing to read.
            if (d >= nearest || u < O.x0 + inset || u > O.x1 - inset || v < O.y0 + inset || v > O.y1 - inset) continue;
            if (checkOpening(p.space, { kind: 'pour', x: u, y: v }, others).valid) nearest = d;
          }
        }
        expect(moved, `dropped at ${x}, ${y}`).toBeLessThanOrEqual(nearest + step);
      }
    });

    it('the fast check says what the full one does, on its real and sloped ground', () => {
      const p = plannedAtDefaults(id);
      const { openings } = p.placement;
      let seed = 4242 + id.length;
      const random = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
      // Around the placed openings, where the ceiling slopes and the land rules bite as well.
      let goods = 0;
      for (let k = 0; k < 400; k++) {
        const near = openings[k % openings.length];
        const spot: OpeningSpot = { kind: k % 2 ? 'pour' : 'vent', x: near.x - 15 + 30 * random(), y: near.y - 15 + 30 * random() };
        const others = openings.filter((o) => o !== near);
        const full = checkOpening(p.space, spot, others).valid;
        expect(isValid(p.space, spot, others), `${spot.kind} at ${spot.x}, ${spot.y}`).toBe(full);
        if (full) goods++;
      }
      expect(goods).toBeGreaterThan(20);
      expect(goods).toBeLessThan(400);
    });
  });

  it('rejects a disc off the cavity, overlapping seats and a seat past the top\'s edge, on a real field', () => {
    const p = plannedAtDefaults('benchy');
    const { O } = p.rim;
    const pour = poursOf(p)[0];
    expect(checkOpening(p.space, { kind: 'pour', x: O.x0 + 8, y: 0 }, []).problems).toContain('off-cavity');
    expect(checkOpening(p.space, { kind: 'pour', x: pour.x + 3, y: pour.y }, [pour]).problems).toEqual(['land']);
    expect(checkOpening(p.space, { kind: 'vent', x: O.x0 + 1, y: 0 }, []).problems).toContain('top-edge');
  });
});

interface Ctx {
  arena: Arena;
  m: Mold;
  o: OpenedMold;
  params: Params;
}

/** G9 and G10 with the plate top raised, as M3's closed-volume check has it. */
function raisedBases(ctx: Ctx, mode: 'glue' | 'merged'): Manifold {
  const { arena, m } = ctx;
  const body = buildBaseBody(arena, m.rim, { plateTop: RAISED });
  if (mode === 'glue') return buildGlueBase(arena, body, m.outline, m.pocketDepth, m.mold.offsets).base;
  return buildMergedBase(arena, body, m.model, m.footprint, { planeTol: m.planeTol, offsets: m.mold.offsets }).base!;
}

function grooveVoid(m: Mold): ExpectedVoid {
  const { rim } = m;
  return {
    name: 'groove',
    volume: grooveResidualVolume(rim, RAISED),
    fraction: 0.01,
    probe: [rim.D.x1 + (rim.e2 + rim.e3) / 2, (rim.D.y0 + rim.D.y1) / 2, rim.ridgeHeight + rim.grooveExtra / 2],
  };
}

function voidProblems(ctx: Ctx, mode: 'glue' | 'merged', cover: Manifold = ctx.o.cover): string[] {
  const { voids, bodies } = splitShells(ctx.arena, ctx.arena.track(cover.add(raisedBases(ctx, mode))));
  expect(bodies, 'union bodies').toHaveLength(1);
  return compareVoids(voids, [grooveVoid(ctx.m)]);
}

/** After bores, only the groove residual may be left as a negative shell: the cavity is open to the top. */
function checkOpenedVoid(ctx: Ctx): void {
  expect(voidProblems(ctx, 'glue')).toEqual([]);
  if (ctx.m.merged?.base) expect(voidProblems(ctx, 'merged')).toEqual([]);
}

function checkClosedSolid({ arena, o, m }: Ctx): void {
  expect(o.cover.status()).toBe('NoError');
  expect(o.cover.volume()).toBeGreaterThan(0);
  const { bodies, voids } = splitShells(arena, o.cover);
  expect(bodies, 'cover bodies').toHaveLength(1);
  expect(voids.filter((shell) => shell.volume >= CRUMB_MM3), 'cover voids').toEqual([]);
  // Openings never feed the rim, and they never reach the box's outside.
  const before = m.cover.boundingBox(), after = o.cover.boundingBox();
  for (const axis of [0, 1, 2]) {
    expect(after.min[axis]).toBeCloseTo(before.min[axis], 4);
    expect(after.max[axis]).toBeCloseTo(before.max[axis], 4);
  }
  expect(after.min[2]).toBeCloseTo(coverBottom(m.rim), 4);
}

/** Area of a 48-sided opening at radius r, as the cutters make it. */
const polygonArea = (r: number): number => 24 * r * r * Math.sin((2 * Math.PI) / 48);

/** Radius of a copy at a height under the flat top, by the formulas of G11. */
function radiusUnder(copy: CutOpening, under: number): number {
  const r = copy.diameter / 2;
  if (copy.kind === 'vent') return under < VENT_CHAMFER ? r + VENT_CHAMFER - under : r;
  if (under >= copy.seatDepth) return r;
  return r + (copy.seatDepth - under) * Math.tan((copy.seatHalfAngleDeg * Math.PI) / 180);
}

/** The flat top's sections, from the box and the seats alone: nothing else may have reached up here. */
function checkTopSection({ arena, o, m }: Ctx): void {
  const { track } = arena;
  const { rim } = m;
  const w = rim.O.x1 - rim.O.x0, h = rim.O.y1 - rim.O.y0;
  const under = 0.01;
  const shy = rim.topChamfer - under;
  const taken = o.copies.reduce((sum, copy) => sum + polygonArea(radiusUnder(copy, under)), 0);
  within(track(o.cover.slice(rim.Zt - under)).area(), (w - 2 * shy) * (h - 2 * shy) - taken, 1e-6);
  // Right under the seats and the cavity's top, where only straight bores pass.
  const pour = o.copies.find((c) => c.kind === 'pour')!;
  const under2 = Math.max(pour.kind === 'pour' ? pour.seatDepth : 0, VENT_CHAMFER) + 0.1;
  if (rim.Zt - under2 > rim.hMax) {
    const bores = o.copies.reduce((sum, copy) => sum + polygonArea(copy.diameter / 2), 0);
    within(track(o.cover.slice(rim.Zt - under2)).area(), w * h - bores, 1e-6);
  }
  // And the top stays flat apart from them: the top face's own contour count is one per opening, plus the outline.
  expect(track(o.cover.slice(rim.Zt - under)).numContour()).toBe(o.copies.length + 1);
}

/**
 * Plastic left in a thin column at an opening, on the cover and before it was cut. FL put the wolf's vent on an
 * 88 degree cliff of its ceiling (10 mm across a quarter of a mm), where a column 0.02 mm wide averaged the TIN
 * across the crease at a node and read it 0.09 mm high; 0.002 mm reads it within 0.01 there, and within
 * 0.001 mm of the wider column at the wolf's other openings.
 */
function columnLength(arena: Arena, solid: Manifold, x: number, y: number, top: number): number {
  const side = 0.002;
  const column = boxSolid(arena, [x - side / 2, y - side / 2, 0], [x + side / 2, y + side / 2, top]);
  return arena.track(solid.intersect(column)).volume() / (side * side);
}

/**
 * Each bore is open all the way through, and its length is what it should be, measured on the solids.
 * H is the field's, so its length is read at the node nearest the centre: the TIN holds its tolerance at
 * the nodes, and between them on a steep slope it can sit lower than any interpolation of them (0.24 mm
 * at a vent on the barrel's rim at t = 1). At a node the ceiling is H plus the raise, give or take the
 * tolerance, so 0.1 at defaults.
 */
function checkBoreLengths({ arena, m, o }: Ctx): void {
  const { Zt } = m.rim;
  const { field } = o.planned.built;
  const { nx, cell, x0, y0, values } = field;
  // All of a one-tile mold, and for a grid the first copy and last copy of each opening.
  const n = o.planned.space.offsets.length;
  const count = o.copies.length / n;
  for (let k = 0; k < count; k++) {
    for (const tile of n === 1 ? [0] : [0, n - 1]) {
      const copy = o.copies[k * n + tile];
      const i = Math.round((copy.x - x0) / cell), j = Math.round((copy.y - y0) / cell);
      const x = x0 + i * cell, y = y0 + j * cell;
      const length = columnLength(arena, m.cover, x, y, Zt + 1);
      const expected = Zt - values[i + j * nx];
      expect(Math.abs(length - expected), `${copy.kind} at ${x.toFixed(2)}, ${y.toFixed(2)}: ${length} against ${expected}`).toBeLessThanOrEqual(0.1);
      expect(columnLength(arena, o.cover, copy.x, copy.y, Zt + 1), `${copy.kind} at ${copy.x.toFixed(2)}, ${copy.y.toFixed(2)} is still closed`).toBeLessThan(1e-6);
    }
  }
  // The length placement reports, which its warnings and goldens read, against the solid at each copy's
  // own centre, the longest of them. Between nodes on a slope the TIN may sit 0.24 lower than the field.
  // On a cell whose corners do not lie in a plane, a TIN through them, split along either diagonal, parts
  // from the field's bilinear surface by up to the larger of the two splits' gaps at that very point: on a
  // plane none, and 0.80 mm where FL's flange put the wolf's vent at the goldens' settings, on a cliff of
  // its ceiling (152.4 to 142.1 mm across a quarter of a mm), against 0.75 measured. Elsewhere 0.34 holds.
  const splitGap = (x: number, y: number): number => {
    const u = (x - x0) / cell, v = (y - y0) / cell;
    const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
    const a = values[i + j * nx], b = values[i + 1 + j * nx], c = values[i + 1 + (j + 1) * nx], d = values[i + (j + 1) * nx];
    const bilinear = a * (1 - fu) * (1 - fv) + b * fu * (1 - fv) + c * fu * fv + d * (1 - fu) * fv;
    const ac = fu >= fv ? a + (b - a) * fu + (c - b) * fv : a + (c - d) * fu + (d - a) * fv;
    const bd = fu + fv <= 1 ? a + (b - a) * fu + (d - a) * fv : c + (c - d) * (fu - 1) + (c - b) * (fv - 1);
    return Math.max(Math.abs(bilinear - ac), Math.abs(bilinear - bd));
  };
  o.planned.placement.openings.forEach((opening, k) => {
    let longest = 0, gap = 0;
    for (let tile = 0; tile < n; tile++) {
      const copy = o.copies[k * n + tile];
      longest = Math.max(longest, columnLength(arena, m.cover, copy.x, copy.y, Zt + 1));
      gap = Math.max(gap, splitGap(copy.x, copy.y));
    }
    expect(Math.abs(opening.boreLength - longest), `${opening.id}: ${opening.boreLength} against ${longest} on the solid, a split's gap ${gap}`).toBeLessThanOrEqual(0.1 + Math.max(0.24, gap));
  });
}

/**
 * The overhang audit in print pose, from the bytes: nothing steeper than 45, and in the plan's words only
 * the seat cone overhangs. Past a degree from vertical there is only the seat, the vents' mouths and the
 * top's chamfer, and the seat's own angle is what it was set to.
 */
function checkOverhang({ m, o, params }: Ctx): void {
  const { rim } = m;
  const { mesh } = readPart(poseToStl(api, o.cover, coverPose(rim)));
  // M10: the nut slots' ceilings are the bridges listed apart; the bolts' holes and slots are upright otherwise.
  const bridges = rim.bolts ? boltBridges(rim.bolts) : [];
  const onBridge = (x: number, y: number, z: number): boolean => bridges.some((b) => Math.abs(z - (rim.Zt - b.z)) < 1e-3 && insideOutline(x, -y, b.outline));
  const whole = auditOverhang(mesh, { bedZ: 0, only: (x, y, z) => !onBridge(x, y, z) });
  expect(whole).toMatchObject({ steepCount: 0, steepArea: 0 });
  expect(whole.ignoredArea).toBeLessThan(0.1);
  const isIn = (copy: CutOpening, x: number, y: number, z: number, slack: number): boolean => {
    const reach = copy.kind === 'pour' ? copy.seatDepth : VENT_CHAMFER;
    if (z > reach + slack) return false;
    return Math.hypot(x - copy.x, -y - copy.y) <= radiusUnder(copy, 0) + slack;
  };
  const chamfer = (x: number, y: number, z: number): boolean => {
    const ax = x, ay = -y;
    return z <= rim.topChamfer + 0.01 && (ax <= rim.O.x0 + rim.topChamfer + 0.01 || ax >= rim.O.x1 - rim.topChamfer - 0.01 || ay <= rim.O.y0 + rim.topChamfer + 0.01 || ay >= rim.O.y1 - rim.topChamfer - 0.01);
  };
  // Bores' walls are upright, up to float rounding, and so are the bolts' holes and slots.
  const rest = auditOverhang(mesh, { bedZ: 0, limitDeg: 1, only: (x, y, z) => !chamfer(x, y, z) && !onBridge(x, y, z) && !o.copies.some((copy) => isIn(copy, x, y, z, 0.01)) });
  expect(rest, 'overhang outside the seats and mouths').toMatchObject({ steepCount: 0, steepArea: 0 });
  if (rim.bolts) {
    const listed = auditOverhang(mesh, { bedZ: 0, only: onBridge });
    within(listed.steepArea, bridges.reduce((sum, b) => sum + outlineArea(clipToBox(b.outline, rim.O)), 0), 0.01);
  }
  const seats = o.copies.filter((copy) => copy.kind === 'pour');
  if (params.seat.enabled && seats.length > 0) {
    const inSeat = auditOverhang(mesh, { bedZ: 0, only: (x, y, z) => seats.some((copy) => isIn(copy, x, y, z, 0.01)) });
    expect(Math.abs(inSeat.worstDeg - params.seat.halfAngleDeg), `seat angle ${inSeat.worstDeg}`).toBeLessThan(0.1);
  }
}

/** G11's promise: a bore only removes plastic, so the silicone is at least as thick as before. */
function checkClearance({ arena, m, o, params }: Ctx): void {
  const { t } = params.silicone;
  const search = t + 0.7;
  let gap = Infinity;
  for (const [x, y] of m.mold.offsets) gap = Math.min(gap, withArena(api, (local) => local.track(m.model!.translate([x, y, 0])).minGap(o.cover, search)));
  expect(gap).toBeGreaterThanOrEqual(t);
  // Nothing here can touch the base either, and no bore reaches the plastic that seals it.
  expect(arena.track(o.cover.intersect(m.glue!.base)).volume()).toBeLessThan(0.01);
}

function checkRoundTrip({ arena, m, o }: Ctx): void {
  const bytes = poseToStl(api, o.cover, coverPose(m.rim));
  const { mesh, audit } = readPart(bytes);
  expect(audit).toMatchObject({ openEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 });
  within(signedVolume(mesh), o.cover.volume(), 1e-3);
  // Reassembled from the bytes, it still fits the base.
  const back = unpose(arena, bytes, coverPose(m.rim));
  const baseBack = unpose(arena, poseToStl(api, m.glue!.base, basePose(m.rim)), basePose(m.rim));
  expect(arena.track(back.intersect(baseBack)).volume()).toBeLessThan(0.1);
}

/** The volume cut away is the bores' silicone plus the seats and mouths, by hand, so nothing else went with them. */
function checkRemovedVolume({ m, o }: Ctx): void {
  const removed = m.cover.volume() - o.cover.volume();
  const frustum = (a: number, b: number, height: number): number => (height * (polygonArea(a) + polygonArea(b) + Math.sqrt(polygonArea(a) * polygonArea(b)))) / 3;
  const extra = o.copies.reduce((sum, copy) => {
    if (copy.kind === 'pour') return sum + (copy.seatDepth > 0 ? frustum(copy.diameter / 2, radiusUnder(copy, 0), copy.seatDepth) : 0);
    // The vent's silicone runs to the top already, so only the chamfer's ring is extra.
    return sum + frustum(copy.diameter / 2, copy.diameter / 2 + VENT_CHAMFER, VENT_CHAMFER) - polygonArea(copy.diameter / 2) * VENT_CHAMFER;
  }, 0);
  // Bores sum nodes under a circle and cut a 48-gon, and the TIN lies up to 0.1 above the nodes.
  within(removed, boreSilicone(o.copies, o.planned.built.field, m.rim.Zt) + extra, 0.03);
}

const CHECKS: [string, (ctx: Ctx) => void][] = [
  ['the cover with its openings is closed, one body, in the same box', checkClosedSolid],
  ['after bores, only the groove residual is left as a negative shell', checkOpenedVoid],
  ['the slice just below Zt is the box less the seats', checkTopSection],
  ['each bore is open, and its length is Zt - H(o) within 0.1', checkBoreLengths],
  ['only the seat cone overhangs in print pose', checkOverhang],
  ['bores remove plastic only: clearance is at least t, and no overlap with the base', checkClearance],
  ['the removed volume is the bores and seats', checkRemovedVolume],
  ['the STL round trip is closed and reassembles', checkRoundTrip],
];

function inOwnArena(ctx: Ctx, check: (ctx: Ctx) => void): void {
  withArena(api, (arena) => check({ ...ctx, arena }));
}

function checkAll(ctx: Ctx): void {
  for (const [, check] of CHECKS) inOwnArena(ctx, check);
}

function onOpened(id: ExampleId, params: Params, run: (ctx: Ctx) => void, modes: { glue?: boolean; merged?: boolean } = { glue: true, merged: true }): void {
  withArena(api, (arena) => {
    const m = buildMold(arena, loadExample(id).welded, params, { modes });
    run({ arena, m, o: openMold(arena, m, params), params });
  });
}

/** One cut mold across a describe's tests. Without the model's file nothing is built, and each test skips, naming it. */
function sharedOpened(id: ExampleId, params: Params = paramsWith()): () => Ctx {
  let ctx: Ctx | undefined;
  beforeAll(() => {
    if (!hasExample(id)) return;
    const arena = new Arena(api);
    const m = buildMold(arena, loadExample(id).welded, params);
    ctx = { arena, m, o: openMold(arena, m, params), params };
  });
  beforeEach((test) => skipWithout(test, id));
  afterAll(() => ctx?.arena.dispose());
  return () => ctx!;
}

describe.each(FULL ? EXAMPLE_IDS : (['jersey', 'barrel'] as ExampleId[]))('%s, cut, at defaults', (id) => {
  const ctx = sharedOpened(id);
  it.each(CHECKS)('%s', (_, check) => inOwnArena(ctx(), check), SLOW);

  it('matches its golden cover volume and stays under M2\'s silicone by its bores', () => {
    const { o, m } = ctx();
    within(o.cover.volume(), OPENING_GOLDEN[id].cover, 0.01);
    // Silicone grows by the bores only.
    const bore = boreSilicone(o.copies, o.planned.built.field, m.rim.Zt) / 1000;
    expect(bore).toBeLessThan(FIELD_GOLDEN[id].silicone * 0.25);
  }, SLOW);
});

// M10: the same checks with the bolts on: only the groove is left as a void, the top is the box less the
// seats (no bolt reaches it), and only the seat cone and the listed bridges overhang in print pose.
describe.each(FULL ? EXAMPLE_IDS : (['jersey'] as ExampleId[]))('%s, cut, with bolts on', (id) => {
  const ctx = sharedOpened(id, paramsWith((p) => (p.bolts.enabled = true)));
  it.each(CHECKS)('%s', (_, check) => inOwnArena(ctx(), check), SLOW);
});

// The plan's grid with bolts, as M3's list has it: 6 copies of every opening and the 4 bolts at the outer corners.
it.runIf(FULL)('jersey 2 x 3, cut, with bolts on, passes every check', () => {
  const params = paramsWith((p) => {
    p.bolts.enabled = true;
    p.grid.nx = 2;
    p.grid.ny = 3;
  });
  onOpened('jersey', params, (ctx) => {
    expect(ctx.m.mold.offsets).toHaveLength(6);
    expect(ctx.o.copies.length).toBe(6 * ctx.o.planned.placement.openings.length);
    checkAll(ctx);
  });
}, SLOW);

describe('negative controls: these checks can fail', () => {
  const ctx = sharedOpened('jersey');

  it('a mold with no bores at all still has its cavity as a void, so the list has more than the groove', () => {
    const c = ctx();
    const problems = voidProblems(c, 'glue', c.m.cover);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join()).toMatch(/unexpected void of \d/);
  });

  it('a bore that stops short of the ceiling leaves the cavity sealed', () => {
    const c = ctx();
    const { arena, m, o } = c;
    const short = o.copies.map((copy): CutOpening => ({ ...copy, zb: copy.zb + 3 }));
    const cover = buildCoverFinal(arena, m.cover, m.rim, short);
    expect(voidProblems(c, 'glue', cover).join()).toMatch(/unexpected void/);
    expect(() => checkBoreLengths({ ...c, o: { ...o, copies: o.copies, cover } })).toThrow(/still closed/);
  });

  it('a slot through the wall, as well as the bores, breaks the shell list by joining the groove', () => {
    const c = ctx();
    const { arena, m, o } = c;
    const { rim } = m;
    const midX = (rim.D.x0 + rim.D.x1) / 2;
    const slot = boxSolid(arena, [midX - 1, rim.D.y1 - 2, -0.5], [midX + 1, rim.D.y1 + rim.e1 + 0.3, 0.3]);
    const cut = checked(arena.track(o.cover.subtract(slot)), 'slotted cover');
    expect(voidProblems(c, 'glue', cut).length).toBeGreaterThan(0);
  });

  it('a counterbore in place of the cone fails the overhang audit, in print pose', () => {
    const c = ctx();
    const { arena, m, o } = c;
    const pour = o.copies.find((copy) => copy.kind === 'pour')!;
    const head = boxSolid(arena, [pour.x - 7, pour.y - 7, m.rim.Zt - 3], [pour.x + 7, pour.y + 7, m.rim.Zt + 1]);
    const cover = checked(arena.track(o.cover.subtract(head)), 'counterbored cover');
    expect(() => checkOverhang({ ...c, o: { ...o, cover } })).toThrow();
    const { mesh } = readPart(poseToStl(api, cover, coverPose(m.rim)));
    expect(auditOverhang(mesh, { bedZ: 0 }).steepCount).toBeGreaterThan(0);
  });

  it('an extra hole in the top changes the slice below it', () => {
    const c = ctx();
    const { arena, m, o } = c;
    const hole = boxSolid(arena, [m.rim.O.x1 - 8, 0, m.rim.Zt - 1], [m.rim.O.x1 - 6, 2, m.rim.Zt + 1]);
    const cover = checked(arena.track(o.cover.subtract(hole)), 'holed cover');
    expect(() => checkTopSection({ ...c, o: { ...o, cover } })).toThrow();
  });

  it('a bore cut somewhere else leaves its place closed', () => {
    const c = ctx();
    const { arena, m, o } = c;
    const moved = o.copies.map((copy): CutOpening => ({ ...copy, x: copy.x + 4 }));
    const cover = buildCoverFinal(arena, m.cover, m.rim, moved);
    expect(() => checkBoreLengths({ ...c, o: { ...o, cover } })).toThrow(/still closed/);
  });

  it('a seat cut into the box where a land was due fails validation before any cut', () => {
    const { o } = ctx();
    const pour = o.planned.placement.openings.find((p) => p.kind === 'pour')!;
    expect(checkOpening(o.planned.space, { kind: 'pour', x: pour.x + 2, y: pour.y }, [pour]).problems).toContain('land');
  });
});

describe('on x8, with cavities apart: each must be opened', () => {
  it('leaving out the pour and vents of the top row leaves that row\'s cavity sealed', () => {
    withArena(api, (arena) => {
      const params = paramsWith();
      const m = buildMold(arena, loadExample('x8').welded, params, { modes: { glue: true } });
      const o = openMold(arena, m, params);
      expect(m.built.cavities.count).toBe(2);
      const ctx = { arena, m, o, params };
      expect(voidProblems(ctx, 'glue')).toEqual([]);
      // Cavities here run in 2 columns, so all the openings of one column keep it sealed if left out.
      const leftOnly = o.copies.filter((copy) => copy.x < 0);
      const cover = buildCoverFinal(arena, m.cover, m.rim, leftOnly);
      expect(voidProblems(ctx, 'glue', cover).join()).toMatch(/unexpected void of \d{4,}/);
    });
  }, SLOW);
});

/**
 * What placement says on jersey, barrel and wolf at defaults: wolf's 147 mm vent, and (FL) on the barrel's
 * lid and the wolf's dome the note that the flange keeps the vent beside the pour lower down.
 */
const MATRIX_CODES: Partial<Record<ExampleId, string[]>> = { jersey: [], barrel: ['vent-low'], wolf: ['vent-low', 'long-vent'] };

describe('parameter matrix', () => {
  /** Each case, and where its diagnostics differ from MATRIX_CODES, what they are instead and why. */
  const MATRIX: [string, (p: Params) => void, Partial<Record<ExampleId, string[]>>][] = [
    // FL: a 6 mm pour's seat leaves the barrel's vent on its lid, within t / 2.
    ['pour 6', (p) => (p.pour.diameter = 6), { barrel: [] }],
    // The barrel's 14.8 mm cavity has no room for a vent beside an 11.73 mm seat, and the pour covers its leaf.
    ['pour 20', (p) => (p.pour.diameter = 20), { barrel: ['vent-refused'] }],
    // FL: at these the barrel's cavity, about 25 mm across, ends inside the reach of a default flange round its
    // middle pour (seat 30: 12.8 mm; seat 45: 14.1; vent 6: 14.5), so its vent beside is refused; the pour covers its leaf.
    ['t=1', (p) => (p.silicone.t = 1), { barrel: ['vent-refused'] }],
    // Vent persistence follows t / 2, so at 5 wolf's 3.8 mm leaf is no longer one that needs a vent, and the
    // vents beside the pours stand within that t / 2 of where they would with no flange.
    ['t=10', (p) => (p.silicone.t = 10), { wolf: [], barrel: [] }],
    ['seat depth 4, its limit under the 5 mm cap', (p) => (p.seat.depth = 4), {}],
    ['seat depth 2 at the thinnest cap, also its limit', (p) => ((p.cover.topCap = 3), (p.seat.depth = 2)), {}],
    ['seat half angle 45', (p) => (p.seat.halfAngleDeg = 45), { barrel: ['vent-refused'] }],
    // No funnel, no flange.
    ['no seat, so a plain bore', (p) => ((p.seat.enabled = false), (p.funnel.generate = false)), { barrel: [], wolf: ['long-vent'] }],
    // A 6 mm vent of 147 mm is under 40 diameters.
    ['vent 6', (p) => (p.vents.diameter = 6), { wolf: ['vent-low'], barrel: ['vent-refused'] }],
    // Two pours on jersey's one top are closer than two 40 mm funnels; the barrel fits only one; wolf's
    // second pour takes the leaf of its 147 mm vent, and a pour's limit is 60 mm.
    ['2 pours per body', (p) => (p.pour.perModel = 2), { jersey: ['funnel-collision'], barrel: ['vent-low', 'pour-shortfall'], wolf: ['vent-low', 'long-pour'] }],
  ];
  const models: ExampleId[] = FULL ? ['jersey', 'barrel', 'wolf'] : ['jersey'];
  describe.each(models)('%s', (id) => {
    beforeEach((test) => skipWithout(test, id));
    it.each(MATRIX)('%s has no parameter error and passes every check', (_, change, codesFor) => {
      const params = paramsWith(change);
      expect(crossParameterErrors(params)).toEqual([]);
      onOpened(id, params, (ctx) => {
        const { placement } = ctx.o.planned;
        expect(placement.openings.filter((o) => o.kind === 'pour').length).toBeGreaterThanOrEqual(1);
        expect(placement.openings.every((o) => o.valid)).toBe(true);
        // No peak is left without a way out, and nothing else is said than what the case explains.
        expect(placement.uncovered).toEqual([]);
        expect(codes(ctx.o.planned)).toEqual(codesFor[id] ?? MATRIX_CODES[id]);
        checkAll(ctx);
      });
    }, SLOW);
  });

  it('barrel at pour 20 refuses the vent beside it and says so once, as the pour covers its peak', (test) => {
    skipWithout(test, 'barrel');
    const p = planWith('barrel', (x) => (x.pour.diameter = 20));
    expect(poursOf(p)).toHaveLength(1);
    expect(ventsOf(p)).toEqual([]);
    expect(p.placement.diagnostics.map((d) => [d.code, d.severity])).toEqual([['vent-refused', 'warning']]);
    // FL: no flange would make room here, so the warning names none.
    expect(p.placement.diagnostics[0].message).toBe('No room for a vent beside the pour at (0.0, 0.0).');
    expect(ventsOf(planWith('barrel', (x) => ((x.pour.diameter = 20), (x.funnel.flangeWidth = 0))))).toEqual([]);
    expect(p.placement.uncovered).toEqual([]);
  });

  it('at the limit depth, a mm of plastic stays over the highest ceiling, even by the seat\'s floor', () => {
    const params = paramsWith((p) => (p.seat.depth = 4));
    onOpened('jersey', params, ({ arena, m, o }) => {
      const { track } = arena;
      const { rim } = m;
      expect(rim.Zt - params.seat.depth - rim.hMax).toBeCloseTo(1, 6);
      const w = rim.O.x1 - rim.O.x0, h = rim.O.y1 - rim.O.y0;
      // Under the seats and over any cavity: nothing but the box and the straight bores.
      const bores = o.copies.reduce((sum, copy) => sum + polygonArea(copy.diameter / 2), 0);
      within(track(o.cover.slice(rim.Zt - params.seat.depth - 0.5)).area(), w * h - bores, 1e-6);
    }, { glue: true });
  }, SLOW);

  it('a seat past the limit gets as far as an error, with nothing thrown, even if built', () => {
    const params = paramsWith((p) => (p.seat.depth = 8));
    expect(crossParameterErrors(params).map((d) => d.code)).toEqual(['seat-too-deep']);
    onOpened('jersey', params, ({ o }) => expect(o.cover.status()).toBe('NoError'), { glue: true });
  }, SLOW);

  it('values past the limits are refused by the rules, inline', () => {
    const tooDeep = crossParameterErrors(paramsWith((p) => (p.seat.depth = 4.5)));
    expect(tooDeep.map((d) => [d.code, d.severity])).toEqual([['seat-too-deep', 'error']]);
    expect(tooDeep[0].message).toContain('at most 4 mm');
    const narrow = crossParameterErrors(paramsWith((p) => (p.funnel.topDiameter = 10)));
    expect(narrow.map((d) => d.code)).toEqual(['funnel-top-small']);
    expect(narrow[0].message).toContain('12.4 mm');
  });
});

describe('the funnel on real seats', () => {
  it.each(FULL ? (['jersey', 'x8', 'wolf'] as ExampleId[]) : (['jersey'] as ExampleId[]))('%s: at each pour it sits with no intersection and the gap set', (id) => {
    const params = paramsWith();
    onOpened(id, params, ({ arena, m, o }) => {
      const funnel = buildFunnel(arena, params);
      const pours = o.copies.filter((copy) => copy.kind === 'pour');
      expect(pours.length).toBeGreaterThanOrEqual(1);
      for (const pour of pours) {
        const inPlace = arena.track(funnel.translate([pour.x, pour.y, m.rim.Zt]));
        expect(arena.track(inPlace.intersect(o.cover)).volume(), `at ${pour.x}, ${pour.y}`).toBeLessThan(1e-3);
        // FL: it stands on its flange, on the real top, and its spigot, cut a hair under the top, keeps the gap set.
        expect(inPlace.minGap(o.cover, 1), `at ${pour.x}, ${pour.y}`).toBeLessThan(1e-6);
        expect(inPlace.boundingBox().min[2]).toBeLessThan(m.rim.Zt - 1);
        const spigot = arena.track(inPlace.trimByPlane([0, 0, -1], -(m.rim.Zt - 1e-3)));
        expect(Math.abs(spigot.minGap(o.cover, 1) - params.funnel.seatClearance), `at ${pour.x}, ${pour.y}`).toBeLessThanOrEqual(0.02);
        const ring = arena.polygons(arena.track(inPlace.slice(m.rim.Zt + 1e-3))).flat() as [number, number][];
        expect(Math.max(...ring.map(([x, y]) => Math.hypot(x - pour.x, y - pour.y)))).toBeCloseTo(funnelProfile(params).rFlange, 3);
        // Lowered by a layer, the flange would cut into the top: it is down on it, not over it.
        expect(arena.track(arena.track(inPlace.translate([0, 0, -params.print.layerHeight])).intersect(o.cover)).volume()).toBeGreaterThan(10);
      }
      // Through it to the bore, with the throat the narrower.
      expect(funnelProfile(params).rThroat).toBeLessThan(params.pour.diameter / 2);
      const { quantity, stl } = funnelFile(api, params, pours.length);
      expect(quantity).toBe(pours.length);
      const { mesh, audit } = readPart(stl);
      expect(audit).toMatchObject({ openEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 });
      expect(auditOverhang(mesh, { bedZ: 0 }).steepCount).toBe(0);
    }, { glue: true });
  }, SLOW);
});

describe('other routes to a mold', () => {
  it('an open mesh in soup mode gets its openings, with only the groove left', () => {
    withArena(api, (arena) => {
      const params = paramsWith();
      const m = buildMold(arena, boxWithTopHole(6), params, { modes: { glue: true } });
      expect(m.imported.solid).toBeNull();
      const o = openMold(arena, m, params);
      const ctx = { arena, m, o, params };
      expect(poursOf(o.planned)).toHaveLength(1);
      expect(voidProblems(ctx, 'glue')).toEqual([]);
      checkClosedSolid(ctx);
      checkTopSection(ctx);
      checkOverhang(ctx);
    });
  }, SLOW);

  it('frees every handle of the cut and the funnel', async () => {
    const counted = await loadManifold();
    const ledger = countHandles(counted);
    const params = paramsWith();
    withArena(counted, (arena) => {
      const m = buildMold(arena, loadExample('jersey').welded, params, { modes: { glue: true } });
      const o = openMold(arena, m, params);
      expect(o.cover.volume()).toBeGreaterThan(0);
      arena.track(buildFunnel(arena, params).translate([0, 0, m.rim.Zt]));
    });
    expect(ledger.created()).toBeGreaterThan(30);
    expect(ledger.live()).toEqual([]);
  });

  it.runIf(FULL)('VIS-35 on its upper level, with the pad trimmed, passes every check', (test) => {
    skipWithout(test, 'vis35');
    withArena(api, (arena) => {
      const params = paramsWith();
      const m = buildMold(arena, loadExample('vis35').welded, params, { useUpper: true });
      expect(m.oriented.needsTrim).toBe(true);
      checkAll({ arena, m, o: openMold(arena, m, params), params });
    });
  }, SLOW);

  it.runIf(FULL)('x8 2 x 1: many bodies across more than one tile', () => {
    const params = paramsWith((p) => (p.grid.nx = 2));
    onOpened('x8', params, (ctx) => {
      expect(ctx.o.copies.filter((c) => c.kind === 'pour')).toHaveLength(16);
      checkAll(ctx);
    }, { glue: true });
  }, SLOW);
});

describe.runIf(FULL)('counts on the real solids', () => {
  it('x8 at perModel = 3: all 24 pours and their vents cut, with only the groove left', () => {
    const params = paramsWith((p) => (p.pour.perModel = 3));
    onOpened('x8', params, (ctx) => {
      expect(ctx.o.copies.filter((c) => c.kind === 'pour')).toHaveLength(24);
      checkAll(ctx);
    }, { glue: true });
  }, SLOW);

  it.each([[10, false], [0, true]])('grid 2 x 3 Benchy at spacing %i, merged %s: 6 pours, at least 6 vents, the void opened', (spacing, merged) => {
    const params = paramsWith((p) => {
      p.grid.nx = 2;
      p.grid.ny = 3;
      p.grid.spacing = spacing;
    });
    onOpened('benchy', params, (ctx) => {
      expect(ctx.m.built.tilesMerged).toBe(merged);
      expect(ctx.o.copies.filter((c) => c.kind === 'pour')).toHaveLength(6);
      expect(ctx.o.copies.filter((c) => c.kind === 'vent').length).toBeGreaterThanOrEqual(6);
      checkAll(ctx);
    }, { glue: true });
  }, SLOW);
});

const round = (ms: number): number => Math.round(ms * 10) / 10;

describe.runIf(FULL)('timing of the bores', () => {
  const rows: string[] = [];
  const header = '| Mold | Openings | Copies | Cover triangles | Field ms | Tile field ms | Placement ms | Cut, export ms | Cut, preview ms | Cut, one more opening ms |\n|---|---|---|---|---|---|---|---|---|---|';

  const CASES: [string, ExampleId, (p: Params) => void][] = [
    ...EXAMPLE_IDS.map((id): [string, ExampleId, (p: Params) => void] => [id, id, () => {}]),
    ['x8 at 3 pours per body', 'x8', (p) => (p.pour.perModel = 3)],
    ['benchy 2 x 3', 'benchy', (p) => ((p.grid.nx = 2), (p.grid.ny = 3))],
    ['x8 3 x 3', 'x8', (p) => ((p.grid.nx = 3), (p.grid.ny = 3))],
  ];

  it.each(CASES)('%s', (name, id, change) => {
    const params = paramsWith(change);
    const { mesh, bounds } = orientedExample(id);
    withArena(api, (arena) => {
      const m = buildMold(arena, loadExample(id).welded, params, { modes: {} });
      const plan = planOpenings(mesh, bounds, params);
      const copies = replicateOpenings(plan.placement.openings, plan.space);
      const t1 = performance.now();
      const cover = buildCoverFinal(arena, m.cover, m.rim, copies);
      const cutMs = performance.now() - t1;
      expect(cover.status()).toBe('NoError');
      // T2b: one opening moved on a cached body means cutting all of them again.
      const t2 = performance.now();
      const again = buildCoverFinal(arena, m.cover, m.rim, copies.map((copy, k): CutOpening => (k === 0 ? { ...copy, x: copy.x + 0.5 } : copy)));
      expect(again.status()).toBe('NoError');
      const moveMs = performance.now() - t2;

      const preview = buildMold(arena, loadExample(id).welded, params, { cell: 0.5, tinTol: params.quality.tinTolPreview, modes: {} });
      const previewSpace = placementSpace(preview.built.field, preview.rim, preview.mold.offsets, openingSizes(params));
      const previewCopies = replicateOpenings(plan.placement.openings, previewSpace);
      const t3 = performance.now();
      const previewCover = buildCoverFinal(arena, preview.cover, preview.rim, previewCopies);
      expect(previewCover.status()).toBe('NoError');
      const previewMs = performance.now() - t3;
      rows.push(`| ${name} | ${plan.placement.openings.length} | ${copies.length} | ${m.cover.numTri()} | ${round(plan.timings.field)} | ${round(plan.timings.tile)} | ${round(plan.timings.placement)} | ${round(cutMs)} | ${round(previewMs)} | ${round(moveMs)} |`);
    });
  }, SLOW);

  afterAll(() => {
    const text = [
      'Plan defaults on the server, in Node, with Manifold\'s lazy booleans forced to run by a status check. Field is S3 to S6 for the export field, as Solid stages has it. A grid also builds the field of one tile on its own, which S7 places on: that is Tile field, and 0 for one tile, whose field is the same. Placement is S7 alone: the bodies, their peaks and the placement, with the composite checked, at the export cell, which a preview would run faster. Cut is S13, on a cached cover body: the batch difference of every cutter. T2b, a dragged opening, repeats it, so its last column is that estimate of under 200 ms.',
      '',
      header,
      ...rows,
      '',
      'A drop of a dragged opening on the main thread. The first drop that snaps on a new placement space builds its distance map, which the main thread pays once after every rebuild: that is the first column, a drop on the box\'s corner. The second is the worst of 100 random drops over the box after it, on the same space.',
      '',
      '| Model | Kind | Nodes | First drop, with the map, ms | Worst of 100 after it, ms |',
      '|---|---|---|---|---|',
      ...dropRows,
    ].join('\n');
    console.log(text);
    if (process.env.CFG_RECORD === '1') recordSection('Openings', `Written by \`scripts/ci.sh --full --record\`, as it needs all 7 models.\n\n${text}`);
  });
});
