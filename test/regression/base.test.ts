import type { ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { candidateAtLevel, candidateFromPick, findBaseCandidates, upperLevel } from '../../src/core/base/candidates';
import { buildFootprint, classifyLevels, type Footprint, type LevelReport } from '../../src/core/base/footprint';
import { determinant, orientSolid, orientToBase, planeTransform, trimToBase } from '../../src/core/base/orient';
import { importSolid } from '../../src/core/mesh/shells';
import { withArena } from '../../src/core/solid/arena';
import { countHandles } from '../fixtures/handles';
import { EXAMPLE_IDS, loadExample, loadManifold, type ExampleId } from '../fixtures/loadExamples';
import { box, join, signedVolume } from '../fixtures/synthetic';
import { GOLDEN } from './golden';

let api: ManifoldToplevel;
beforeAll(async () => {
  api = await loadManifold();
});

const within = (actual: number, expected: number, fraction: number): void => {
  expect(Math.abs(actual - expected), `${actual} is not within ${fraction * 100}% of ${expected}`).toBeLessThanOrEqual(Math.abs(expected) * fraction);
};

function footprintOf(id: ExampleId): Footprint {
  const { welded, options } = loadExample(id);
  const top = findBaseCandidates(welded, options)[0];
  const oriented = orientToBase(welded, top, { planeTol: options.planeTol, soup: false });
  return withArena(api, (arena) => buildFootprint(arena, oriented.mesh, top, options.minIsland));
}

/** The plane the base faces cover, each spot once, sampled on a 0.05 mm lattice: no polygon involved. */
function coveredArea(id: ExampleId, cell = 0.05): number {
  const { welded, options } = loadExample(id);
  const top = findBaseCandidates(welded, options)[0];
  const { mesh } = orientToBase(welded, top, { planeTol: options.planeTol, soup: false });
  const { positions: p, indices } = mesh;
  const faces: number[] = [];
  for (let t = 0; t < indices.length / 3; t++) if ([0, 1, 2].every((k) => p[indices[t * 3 + k] * 3 + 2] <= options.planeTol)) faces.push(t);
  const xs = faces.flatMap((t) => [0, 1, 2].map((k) => p[indices[t * 3 + k] * 3]));
  const ys = faces.flatMap((t) => [0, 1, 2].map((k) => p[indices[t * 3 + k] * 3 + 1]));
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const nx = Math.ceil((Math.max(...xs) - x0) / cell) + 1, ny = Math.ceil((Math.max(...ys) - y0) / cell) + 1;
  const covered = new Uint8Array(nx * ny);
  for (const t of faces) {
    const [ax, ay, bx, by, cx, cy] = [0, 1, 2].flatMap((k) => [p[indices[t * 3 + k] * 3], p[indices[t * 3 + k] * 3 + 1]]);
    // Sample points at cell centres, half a cell in from the lattice's corner.
    for (let j = Math.floor((Math.min(ay, by, cy) - y0) / cell); j <= Math.ceil((Math.max(ay, by, cy) - y0) / cell) && j < ny; j++) {
      for (let i = Math.floor((Math.min(ax, bx, cx) - x0) / cell); i <= Math.ceil((Math.max(ax, bx, cx) - x0) / cell) && i < nx; i++) {
        const x = x0 + (i + 0.5) * cell, y = y0 + (j + 0.5) * cell;
        const w0 = (bx - ax) * (y - ay) - (by - ay) * (x - ax), w1 = (cx - bx) * (y - by) - (cy - by) * (x - bx), w2 = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
        if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) covered[i + j * nx] = 1;
      }
    }
  }
  return covered.reduce((sum, c) => sum + c, 0) * cell * cell;
}

function levelsOf(id: ExampleId): LevelReport {
  const { welded, options } = loadExample(id);
  const [top] = findBaseCandidates(welded, options);
  const oriented = orientToBase(welded, top, { planeTol: options.planeTol, soup: false });
  const footprint = withArena(api, (arena) => buildFootprint(arena, oriented.mesh, top, options.minIsland));
  return classifyLevels(oriented.mesh, top, footprint, options.planeTol);
}

describe.each(EXAMPLE_IDS)('base of %s', (id) => {
  const golden = GOLDEN[id];

  it('ranks -z first, on the support plane, at the measured height and area', () => {
    const { welded, options } = loadExample(id);
    within(options.planeTol, golden.planeTol, 0.01);
    const candidates = findBaseCandidates(welded, options);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(8);
    const [top] = candidates;
    expect(top.normal).toEqual([0, 0, -1]);
    expect(top.offset).toBe(0);
    expect(-top.support).toBeCloseTo(golden.planeZ, 3);
    within(top.area, golden.baseArea, 0.01);
    for (let i = 1; i < candidates.length; i++) expect(candidates[i].area).toBeLessThanOrEqual(candidates[i - 1].area);
  });

  it('matches the measured upper level', () => {
    const { welded, options } = loadExample(id);
    const [top] = findBaseCandidates(welded, options);
    const upper = upperLevel(top, options.planeTol);
    const oriented = orientToBase(welded, top, { planeTol: options.planeTol, soup: false });
    expect(oriented.diagnostics).toEqual([]);
    expect(oriented.needsTrim).toBe(false);
    const report = levelsOf(id);
    if (golden.upper === null) {
      expect(upper).toBeNull();
      expect(report.diagnostics).toEqual([]);
    } else {
      expect(upper!.offset).toBeCloseTo(golden.upper.offset, 2);
      within(upper!.area, golden.upper.area, 0.01);
      expect(report.diagnostics.map((d) => d.code)).toEqual([golden.upper.exposed ? 'upper-level' : 'recess-level']);
      expect(report.useUpper !== null).toBe(golden.upper.exposed);
    }
  });

  it('lists only real faces: most of every candidate faces its normal within a bin', () => {
    const { welded, options } = loadExample(id);
    const { positions: p, indices } = welded;
    const flatFacing = Math.cos((1.5 * Math.PI) / 180);
    for (const c of findBaseCandidates(welded, options)) {
      let flat = 0;
      for (const t of c.members) {
        const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, e = indices[t * 3 + 2] * 3;
        const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
        const vx = p[e] - p[a], vy = p[e + 1] - p[a + 1], vz = p[e + 2] - p[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const length = Math.hypot(nx, ny, nz);
        if (length === 0) continue;
        const facing = (c.normal[0] * nx + c.normal[1] * ny + c.normal[2] * nz) / length;
        if (facing >= flatFacing) flat += (length / 2) * facing;
      }
      expect(flat / c.area, `share of ${c.normal} at ${c.area} mm2`).toBeGreaterThan(0.5);
      expect(c.source).toBe('histogram');
      expect(c.holes).toEqual([]);
      // The real faces here are not rough, and only a rough face has more area than its members.
      expect(c.faceArea).toBeCloseTo(c.area, 6);
    }
  });

  it('matches the measured footprint, with polygon area within 2% of projected', () => {
    const footprint = footprintOf(id);
    expect(footprint.components).toHaveLength(golden.footprints.length);
    footprint.components.forEach((c, i) => within(c.area, golden.footprints[i], 0.01));
    expect(footprint.islands).toHaveLength(golden.islands.length);
    footprint.islands.forEach((c, i) => within(c.area, golden.islands[i], 0.02));
    // Where parts overlap, as the chick's do, their soles can lie over each other and the summed triangles
    // count that twice, so the union of the faces, sampled on a lattice, is the reference everywhere.
    within(footprint.rawArea, coveredArea(id), 0.02);
    if (golden.overlapVolume === 0) within(footprint.rawArea, footprint.projectedArea, 0.02);
    within(footprint.projectedArea, golden.baseArea, 0.01);
  });

  it('keeps determinant +1 and signed volume on every candidate transform', () => {
    const { welded, options } = loadExample(id);
    const before = signedVolume(welded);
    for (const c of findBaseCandidates(welded, options)) {
      expect(determinant(planeTransform(c.normal, c.support - c.offset))).toBeCloseTo(1, 10);
      const oriented = orientToBase(welded, c, { planeTol: options.planeTol, soup: false });
      // float32 rounding of the rotated positions is the only allowed change. A reflection would
      // negate the volume even if every other number here held.
      within(signedVolume(oriented.mesh), before, 1e-3);
    }
  });

  it('a click on any base triangle selects the same plane', () => {
    const { welded, options } = loadExample(id);
    const candidates = findBaseCandidates(welded, options);
    const [top] = candidates;
    for (const t of top.members) {
      const clicked = candidateFromPick(welded, t, options, candidates);
      expect(clicked.normal).toEqual(top.normal);
      expect(clicked.source).toBe('pick');
      expect(clicked.offset).toBe(top.offset);
      expect(clicked.area).toBe(top.area);
    }
  });

  it('a click on the largest base triangle finds the same plane with no ranked list to go by', () => {
    const { welded, options } = loadExample(id);
    const [top] = findBaseCandidates(welded, options);
    const { positions: p, indices } = welded;
    // The largest member is a stable, realistic click target.
    let picked = -1, best = -1;
    for (const t of top.members) {
      const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
      const area = Math.abs((p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a]));
      if (area > best) [picked, best] = [t, area];
    }
    const clicked = candidateFromPick(welded, picked, options);
    expect(clicked.normal).toEqual(top.normal);
    expect(clicked.source).toBe('pick');
    expect(clicked.offset).toBeLessThan(options.planeTol);
    within(clicked.area, top.area, 0.005);
  });

  it('creates and frees every Manifold and CrossSection handle over the whole M1 build', async () => {
    const counted = await loadManifold();
    const ledger = countHandles(counted);
    const { welded, audit, options } = loadExample(id);
    withArena(counted, (arena) => {
      const imported = importSolid(arena, welded, audit);
      const [top] = findBaseCandidates(imported.mesh, options);
      const oriented = orientToBase(imported.mesh, top, { planeTol: options.planeTol, soup: false });
      const trimmed = trimToBase(arena, orientSolid(arena, imported.solid!, oriented.transform));
      const footprint = buildFootprint(arena, oriented.mesh, top, options.minIsland, arena.track(trimmed.slice(0.02)));
      classifyLevels(oriented.mesh, top, footprint, options.planeTol);
    });
    expect(ledger.created()).toBeGreaterThan(6);
    expect(ledger.live()).toEqual([]);
    expect(ledger.deleted()).toBe(ledger.created());
  });
});

describe('plan facts on the base', () => {
  it('Goddess: plane z=-1.98, 1183 mm2', () => {
    const { welded, options } = loadExample('goddess');
    const [top] = findBaseCandidates(welded, options);
    expect(-top.support).toBeCloseTo(-1.98, 2);
    within(top.area, 1183, 0.01);
    expect(top.levels).toHaveLength(1);
  });

  it('VIS-35: selects z=0 at 361 mm2 and reports the 764 mm2 level at z=0.41', () => {
    const { welded, options } = loadExample('vis35');
    const [top] = findBaseCandidates(welded, options);
    expect(-top.support).toBeCloseTo(0, 2);
    within(top.area, 361, 0.01);
    const upper = upperLevel(top, options.planeTol)!;
    // Height of the level in file coordinates.
    expect(-top.support + upper.offset).toBeCloseTo(0.41, 2);
    within(upper.area, 764, 0.01);
    const { diagnostics, useUpper } = levelsOf('vis35');
    expect(diagnostics.map((d) => d.severity)).toEqual(['warning']);
    expect(diagnostics[0].message).toContain('0.41 mm');
    within(useUpper!.exposedArea, 769.4, 0.01);
    expect(useUpper!.enclosedArea).toBe(0);
  });

  // G2.6 asks for the film warning here, but the level lies entirely inside 8 holes of the base
  // outline (it is the lettering cut into the hull), and no silicone reaches it with the base
  // seated. So this is the one plan statement the code departs from, pending the user's decision.
  it('Benchy: reports the level at z=0.30, as a recess rather than a silicone film', () => {
    const { diagnostics, useUpper, levels } = levelsOf('benchy');
    expect(diagnostics.map((d) => [d.code, d.severity])).toEqual([['recess-level', 'info']]);
    expect(diagnostics[0].message).toContain('0.30 mm');
    expect(useUpper).toBeNull();
    within(levels[0].enclosedArea, 78.1, 0.01);
    expect(levels[0].exposedArea).toBe(0);
  });

  it('wolf: its upper level is a recess too, so there is no one-click trim across the whole base', () => {
    const { diagnostics, useUpper, levels } = levelsOf('wolf');
    expect(diagnostics.map((d) => d.code)).toEqual(['recess-level']);
    expect(useUpper).toBeNull();
    within(levels[0].enclosedArea, 108.5, 0.01);
    expect(levels[0].exposedArea).toBe(0);
  });

  it('a stray bit far below the base does not take the base away from the top rank', () => {
    const { welded, options } = loadExample('goddess');
    const planeZ = GOLDEN.goddess.planeZ;
    for (const depth of [0.5, 1.5, 3]) {
      const z = planeZ - depth;
      const mesh = join(welded, box([0, 0, z], [0.2, 0.2, z + 0.2]));
      const [top] = findBaseCandidates(mesh, options);
      expect(top.normal).toEqual([0, 0, -1]);
      expect(top.offset).toBeCloseTo(depth, 3);
      within(top.area, GOLDEN.goddess.baseArea, 0.01);
      const oriented = orientToBase(mesh, top, { planeTol: options.planeTol, soup: false });
      expect(oriented.diagnostics.map((d) => d.code)).toEqual(['below-plane']);
      expect(oriented.needsTrim).toBe(true);
      expect(oriented.below.depth).toBeCloseTo(depth, 3);
    }
  });

  it('VIS-35 upper level: moves the plane to z=0.41 and trims the pad', () => {
    const { welded, audit, options } = loadExample('vis35');
    const [lower] = findBaseCandidates(welded, options);
    const c = candidateAtLevel(welded, lower, upperLevel(lower, options.planeTol)!.offset, options);
    within(c.area, 764, 0.01);
    expect(upperLevel(c, options.planeTol)).toBeNull();
    const oriented = orientToBase(welded, c, { planeTol: options.planeTol, soup: false });
    expect(oriented.needsTrim).toBe(true);
    expect(oriented.below.depth).toBeCloseTo(0.41, 2);
    expect(oriented.diagnostics.map((d) => d.code)).toEqual(['below-plane']);

    withArena(api, (arena) => {
      const solid = importSolid(arena, welded, audit).solid!;
      const moved = orientSolid(arena, solid, oriented.transform);
      expect(moved.boundingBox().min[2]).toBeCloseTo(-0.41, 2);
      const trimmed = trimToBase(arena, moved);
      expect(trimmed.boundingBox().min[2]).toBeGreaterThanOrEqual(0);
      // The pad removed is about 361 x 0.41, and at most the whole footprint times that.
      const removed = solid.volume() - trimmed.volume();
      within(removed, 361 * 0.405, 0.02);
      // M3 checks this slice at about 1128 mm2 once Mode B exists. Measured here as a cross-check.
      const cap = arena.track(trimmed.slice(0.02));
      within(cap.area(), 1128, 0.01);
      const footprint = buildFootprint(arena, oriented.mesh, c, options.minIsland, cap);
      expect(footprint.components).toHaveLength(1);
      within(footprint.area, 1128, 0.015);
    });
  });

  it('wolf: 3 footprints above the filter (2497, 160, 152 within 3%), the 6 others listed', () => {
    const footprint = footprintOf('wolf');
    expect(footprint.components).toHaveLength(3);
    within(footprint.components[0].area, 2497, 0.03);
    within(footprint.components[1].area, 160, 0.03);
    within(footprint.components[2].area, 152, 0.03);
    expect(footprint.components.length + footprint.islands.length).toBe(9);
    expect(footprint.islands.every((c) => c.area < 5)).toBe(true);
    expect(footprint.diagnostics.map((d) => d.code)).toEqual(['footprint-islands']);
    for (const island of footprint.islands) expect(footprint.diagnostics[0].message).toContain(island.area.toFixed(2));
  });

  it('x8 has 8 footprints and Benchy has 2', () => {
    expect(footprintOf('x8').components).toHaveLength(8);
    expect(footprintOf('benchy').components).toHaveLength(2);
  });

  it('wolf keeps its real footprint holes', () => {
    const footprint = footprintOf('wolf');
    expect(footprint.components[0].holes).toBeGreaterThan(0);
  });

  it('rejects the sloped flanks of the jersey barrier, 714 mm2 ledges that are no use as a base', () => {
    const { welded, options } = loadExample('jersey');
    const candidates = findBaseCandidates(welded, options);
    const flank = candidates.filter((c) => Math.abs(c.normal[1]) > 0.99 && Math.abs(c.normal[2]) > 0.05);
    expect(flank).toEqual([]);
  });

  it('the base of a small model stays listed with a higher island limit, as the filter is for footprints', () => {
    const { welded, options } = loadExample('benchy');
    const raised = findBaseCandidates(welded, { ...options, minIsland: 79 })[0];
    expect(raised.levels.map((l) => Math.round(l.area))).toEqual([448, 78]);
  });

  it('lists the barrier top as a real but lower ranked candidate: the user still confirms', () => {
    const { welded, options } = loadExample('jersey');
    const up = findBaseCandidates(welded, options).find((c) => c.normal[2] === 1);
    expect(up).toBeDefined();
    within(up!.area, 263.9, 0.01);
  });
});
