import type { ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { autoPlaneTol, candidateAtLevel, candidateFromPick, examinedBins, findBaseCandidates, LEVEL_FLOOR, upperLevel, type BaseCandidate, type BaseOptions, type Vec3 } from '../../src/core/base/candidates';
import { heightBlockMesh, HEAVY_BLOCK } from '../fixtures/heavy';
import { weld } from '../../src/core/mesh/weld';
import { buildFootprint, classifyLevels } from '../../src/core/base/footprint';
import { assertRigid, determinant, orientSolid, orientToBase, planeTransform, transformPositions, trimToBase, type RigidTransform } from '../../src/core/base/orient';
import { importSolid } from '../../src/core/mesh/shells';
import { auditEdges } from '../../src/core/mesh/audit';
import type { WeldedMesh } from '../../src/core/mesh/weld';
import { withArena } from '../../src/core/solid/arena';
import { loadManifold } from '../fixtures/loadExamples';
import { arch, axisRotation, BOX_BOTTOM, BOX_BOTTOM_FIRST, BOX_TOP, box, boxWithTopHole, flatBesideSlope, flipTriangles, inverted, join, knobbedPlate, noisyPlate, notchedBlock, plateOnLegs, plateWithUnderside, recessedBlock, ridgedBlock, ring, rotated, signedVolume, sphere, sphereOnPad, spikedBlock, squareStack, stepped, twoLevelBlock, withoutTriangles } from '../fixtures/synthetic';

let api: ManifoldToplevel;
beforeAll(async () => {
  api = await loadManifold();
});

const OPTIONS = { planeTol: 0.05, minIsland: 5 };
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const facing = (candidates: BaseCandidate[], n: Vec3): BaseCandidate | undefined => candidates.find((c) => dot(c.normal, n) > 0.9999);
const DOWN: Vec3 = [0, 0, -1];

/** What the import stage hands on: the mesh with its winding settled, and how much to trust it. */
function imported(mesh: WeldedMesh) {
  const { mesh: settled, openLoops, report } = withArena(api, (arena) => importSolid(arena, mesh, auditEdges(mesh)));
  const soup = report.route === 'soup';
  return { mesh: settled, openLoops, report, soup, candidates: (options: BaseOptions = OPTIONS) => findBaseCandidates(settled, options, soup ? { openLoops } : undefined) };
}

/** A triangle whose corners all lie at this height, as a click on that face would hit. */
function triangleAtZ(mesh: WeldedMesh, z: number): number {
  const { positions, indices } = mesh;
  return Array.from({ length: indices.length / 3 }, (_, t) => t).find((t) => [0, 1, 2].every((c) => Math.abs(positions[indices[t * 3 + c] * 3 + 2] - z) < 1e-6))!;
}

/** Evenly spread random rotations from a fixed sequence, so a failure reproduces. */
function testRotations(count: number): number[][] {
  let seed = 2024;
  const next = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  return Array.from({ length: count }, () => {
    const z = next() * 2 - 1, phi = next() * 2 * Math.PI, r = Math.sqrt(1 - z * z);
    return axisRotation([r * Math.cos(phi), r * Math.sin(phi), z], next() * 360);
  });
}

describe('base candidates', () => {
  it('lists the six faces of a box, largest first', () => {
    const candidates = findBaseCandidates(box([0, 0, 0], [10, 20, 40]), OPTIONS);
    expect(candidates).toHaveLength(6);
    expect(candidates.map((c) => Math.round(c.area))).toEqual([800, 800, 400, 400, 200, 200]);
    expect(Math.abs(candidates[0].normal[0])).toBe(1);
  });

  it('never returns more than 8 candidates', () => {
    const faceted = withArena(api, ({ track }) => {
      const m = track(api.Manifold.cylinder(10, 20, 20, 24)).getMesh();
      return { positions: m.vertProperties, indices: m.triVerts };
    });
    expect(findBaseCandidates(faceted, OPTIONS).length).toBe(8);
  });

  it('uses exact axis normals on an axis-aligned model, so orienting adds no rotation noise', () => {
    const candidates = findBaseCandidates(box([0, 0, 0], [10, 20, 40]), OPTIONS);
    for (const c of candidates) expect(c.normal.map(Math.abs).sort()).toEqual([0, 0, 1]);
  });

  it('finds the true face normals of a tilted box', () => {
    const r = axisRotation([0.6, 0, 0.8], 37);
    const candidates = findBaseCandidates(rotated(box([0, 0, 0], [10, 20, 40]), r), OPTIONS);
    expect(candidates).toHaveLength(6);
    // The third column of r is where the original +z ended up: the normal of the 200 mm2 faces.
    const zAxis: Vec3 = [r[2], r[5], r[8]];
    const top = candidates.find((c) => Math.abs(c.area - 200) < 1);
    expect(top).toBeDefined();
    expect(Math.abs(dot(top!.normal, zAxis))).toBeGreaterThan(0.9999999);
  });

  it('counts both feet of an arch on one plane, because membership is by distance', () => {
    const c = facing(findBaseCandidates(arch(api), OPTIONS), DOWN);
    expect(c).toBeDefined();
    expect(c!.support).toBeCloseTo(0, 6);
    expect(c!.area).toBeCloseTo(200, 3);
    // The underside of the bridge is parallel but 20 mm up: a ledge, so not a member.
    expect(c!.levels.map((l) => l.offset)).toEqual([0]);
  });

  it('rejects a large ledge: only what the model can stand on counts', () => {
    const candidates = findBaseCandidates(stepped(api), OPTIONS);
    const up = facing(candidates, [0, 0, 1]);
    // Tower top is 200 mm2 at z=30. The 600 mm2 shelf at z=5 faces the same way but is a ledge.
    expect(up!.area).toBeCloseTo(200, 3);
    expect(up!.support).toBeCloseTo(30, 5);
    expect(up!.levels).toHaveLength(1);
  });

  it('rejects a direction whose only flat face lies above a real step, here a wide 3 mm cone', () => {
    const candidates = findBaseCandidates(spikedBlock(api, 3, 5), OPTIONS);
    expect(facing(candidates, DOWN)).toBeUndefined();
    expect(facing(candidates, [0, 0, 1])).toBeDefined();
  });

  it('keeps a direction whose flat face has only a thin 3 mm spike below it, at the face', () => {
    const c = facing(findBaseCandidates(spikedBlock(api, 3), OPTIONS), DOWN)!;
    expect(c.offset).toBeCloseTo(3, 3);
    expect(c.area).toBeGreaterThan(399);
  });

  it('lets a shallow level stand in over a low wide cone, trimming away a modest share', () => {
    // Nothing is flat on the support plane, and the cone's 8% of surface is no stray bit.
    const c = facing(findBaseCandidates(spikedBlock(api, 0.5, 9), OPTIONS), DOWN)!;
    expect(c.offset).toBeCloseTo(0.5, 3);
    expect(c.levels[0].beyond / c.area).toBeGreaterThan(0.02);
    expect(c.levels[0].beyond / c.area).toBeLessThan(0.25);
  });

  it('negative control: not when the trim would take away a large share of the model', () => {
    expect(facing(findBaseCandidates(spikedBlock(api, 0.5, 18), OPTIONS), DOWN)).toBeUndefined();
  });

  it('keeps a big face above a stray bit that is large enough to be a level itself', () => {
    const c = facing(findBaseCandidates(join(box([0, 0, 0], [100, 100, 10]), box([50, 50, -3], [53, 53, -1])), OPTIONS), DOWN)!;
    expect(c.offset).toBeCloseTo(3, 3);
    expect(c.area).toBeCloseTo(10000, 0);
    expect(c.levels.map((l) => Math.round(l.offset))).toEqual([0, 3]);
    const oriented = orientToBase(join(box([0, 0, 0], [100, 100, 10]), box([50, 50, -3], [53, 53, -1])), c, { planeTol: OPTIONS.planeTol, soup: false });
    expect(oriented.needsTrim).toBe(true);
  });

  it('finds a noisy flat face using the mean normal, since no two facets agree', () => {
    const c = facing(findBaseCandidates(noisyPlate(20, 0.01), OPTIONS), DOWN);
    expect(c).toBeDefined();
    expect(c!.area).toBeGreaterThan(1500);
    expect(dot(c!.normal, DOWN)).toBeGreaterThan(Math.cos((0.5 * Math.PI) / 180));
  });

  it('ranks a whole plane above a slightly larger one that needs a trim', () => {
    const [first, second] = findBaseCandidates(knobbedPlate(api), OPTIONS);
    // The underside has lost 400 mm2 to its recess. The top lost only 4 mm2, but its knob must be cut.
    expect(first.normal).toEqual(DOWN);
    expect(first.area).toBeCloseTo(9600, 0);
    expect(second.normal).toEqual([0, 0, 1]);
    expect(second.area).toBeCloseTo(9996, 0);
    expect(second.offset).toBeCloseTo(15, 3);
  });

  it.each([
    [20, 0.01],
    [20, 0.02],
    [40, 0.02],
  ])('keeps a noisy flat face whole under any rotation (%i cells, jitter %f)', (cells, jitter) => {
    const plate = noisyPlate(cells, jitter);
    const axisAligned = facing(findBaseCandidates(plate, OPTIONS), DOWN)!.area;
    expect(axisAligned).toBeGreaterThan(1590);
    for (const r of testRotations(40)) {
      const down: Vec3 = [-r[2], -r[5], -r[8]];
      const c = findBaseCandidates(rotated(plate, r), OPTIONS).find((candidate) => dot(candidate.normal, down) > Math.cos((0.5 * Math.PI) / 180))!;
      expect(c, 'the face must still be found').toBeDefined();
      // Noise moves the fitted plane a little, and the tilt allowed here is 0.02 mm across 40 mm.
      expect(dot(c.normal, down)).toBeGreaterThan(Math.cos((0.03 * Math.PI) / 180));
      expect(c.area).toBeGreaterThan(0.99 * axisAligned);
    }
  });

  it('warns when a noisy face is rougher than the tolerance, and suggests raising it', () => {
    for (const jitter of [0.03, 0.05, 0.1]) {
      const plate = noisyPlate(20, jitter);
      const c = facing(findBaseCandidates(plate, OPTIONS), DOWN)!;
      expect(c.faceArea).toBeGreaterThan(1590);
      expect(c.area).toBeLessThan(1200);
      const { diagnostics } = orientToBase(plate, c, { planeTol: OPTIONS.planeTol, soup: false });
      expect(diagnostics.map((d) => [d.code, d.severity])).toEqual([['plane-rough', 'warning']]);
      expect(diagnostics[0].message).toContain('raise the tolerance');
    }
  });

  it('ranks a rough base by its whole face, not by the little of it inside the tolerance', () => {
    const [top] = findBaseCandidates(noisyPlate(20, 0.1), OPTIONS);
    expect(top.normal).toEqual(DOWN);
    expect(top.area).toBeLessThan(100);
  });

  it('negative control: no roughness warning once the tolerance covers the noise', () => {
    const plate = noisyPlate(20, 0.05);
    const options = { planeTol: 0.15, minIsland: 5 };
    const c = facing(findBaseCandidates(plate, options), DOWN)!;
    expect(c.area).toBeGreaterThan(1590);
    expect(orientToBase(plate, c, { planeTol: options.planeTol, soup: false }).diagnostics).toEqual([]);
  });

  it('negative control: no roughness warning on a face that is simply flat', () => {
    const plate = noisyPlate(20, 0.01);
    expect(orientToBase(plate, facing(findBaseCandidates(plate, OPTIONS), DOWN)!, { planeTol: OPTIONS.planeTol, soup: false }).diagnostics).toEqual([]);
  });

  it('takes the exact normal of a flat face that shares its bin with a gentle slope', () => {
    const c = facing(findBaseCandidates(flatBesideSlope(api), OPTIONS), DOWN);
    expect(c).toBeDefined();
    expect(c!.normal).toEqual(DOWN);
    expect(c!.area).toBeCloseTo(60 * 40, 1);
  });

  it('scores by area projected onto the plane, not by true triangle area', () => {
    // A 45 degree chamfer 0.04 tall sits inside the tolerance, so its ring of steep triangles are
    // members: their true area is 4.5 mm2, but they cover only 3.2 mm2 of the plane.
    const c = facing(findBaseCandidates(squareStack([[10, 0], [10.04, 0.04], [10.04, 15]]), OPTIONS), DOWN)!;
    expect(c.area).toBeCloseTo(20.08 * 20.08, 2);
  });

  it.each([
    [20, 96],
    [50, 256],
    [100, 512],
  ])('never ranks a mesh with no flat face, here a sphere of radius %i with %i segments', (radius, segments) => {
    const mesh = sphere(api, radius, segments);
    // Big and fine enough for the flatness rule to do the work: a cap inside the tolerance is 2 pi R tol.
    expect(findBaseCandidates(mesh, OPTIONS)).toEqual([]);
  });

  it('ranks the real pad under a sphere first, and alone', () => {
    const candidates = findBaseCandidates(sphereOnPad(api, 100, 512), OPTIONS);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].normal).toEqual(DOWN);
    expect(candidates[0].area).toBeCloseTo(64, 1);
  });

  it('lists a small base, because it goes by the fixed floor and not the footprint filter', () => {
    const candidates = findBaseCandidates(box([0, 0, 0], [2, 2, 5]), OPTIONS);
    expect(candidates).toHaveLength(6);
    expect(facing(candidates, DOWN)!.area).toBeCloseTo(4, 3);
  });

  it('negative control: a face under the floor is not listed', () => {
    const size = Math.sqrt(LEVEL_FLOOR) * 0.9;
    const candidates = findBaseCandidates(box([0, 0, 0], [size, size, 5]), OPTIONS);
    expect(facing(candidates, DOWN)).toBeUndefined();
    expect(candidates).toHaveLength(4);
  });

  it('gives the same candidates whatever the footprint filter is set to', () => {
    const mesh = twoLevelBlock(api, 0.41);
    const levelsAt = (minIsland: number) => findBaseCandidates(mesh, { planeTol: 0.05, minIsland }).map((c) => [c.normal, c.offset, c.area, c.levels]);
    expect(levelsAt(100)).toEqual(levelsAt(0));
  });

  it('tells flat faces 2 degrees apart from each other, since a bin is 1.5 degrees', () => {
    const candidates = findBaseCandidates(ridgedBlock(api, 2), OPTIONS).filter((c) => c.normal[2] < -0.99);
    expect(candidates).toHaveLength(2);
    expect(dot(candidates[0].normal, candidates[1].normal)).toBeCloseTo(Math.cos((2 * Math.PI) / 180), 8);
    for (const c of candidates) expect(c.area).toBeCloseTo(40 * 40, -1);
  });

  it('negative control: faces 1 degree apart share a bin, so they count as one direction', () => {
    expect(findBaseCandidates(ridgedBlock(api, 1), OPTIONS).filter((c) => c.normal[2] < -0.99)).toHaveLength(1);
  });

  it('does not count a strip tilted 2 degrees as part of the flat face around a click', () => {
    // The strip is 1 mm wide, so it rises only 0.035 mm and lies inside the tolerance band.
    const mesh = flatBesideSlope(api, 2, 1);
    const clicked = candidateFromPick(mesh, triangleAtZ(mesh, 0), OPTIONS);
    expect(clicked.normal).toEqual(DOWN);
    // By distance it is still a member, and only the normal average leaves it out.
    expect(clicked.area).toBeCloseTo(61 * 40, 0);
  });

  it('skips collinear triangles without producing NaN normals', () => {
    const mesh = box([0, 0, 0], [10, 10, 10]);
    const positions = Float32Array.from([...mesh.positions, 5, 0, 0]);
    // The bottom's front edge splits at the new vertex 8, closed by a collinear triangle.
    const indices = Uint32Array.from([...mesh.indices, 0, 8, 1]);
    const candidates = findBaseCandidates({ positions, indices }, OPTIONS);
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) expect(c.normal.every(Number.isFinite)).toBe(true);
  });

  it('handles a minimum island of 0, the bottom of its range', () => {
    const candidates = findBaseCandidates(box([0, 0, 0], [10, 20, 40]), { planeTol: 0.05, minIsland: 0 });
    expect(candidates).toHaveLength(6);
    for (const c of candidates) expect(c.normal.every(Number.isFinite)).toBe(true);
  });

  it('finds a bottom tilted by 1 degree along its true normal', () => {
    const tilt = Math.tan((1 * Math.PI) / 180) * 100;
    const mesh = {
      positions: Float32Array.from([0, 0, 0, 100, 0, tilt, 100, 100, tilt, 0, 100, 0, 0, 0, 30, 100, 0, 30, 100, 100, 30, 0, 100, 30]),
      indices: box([0, 0, 0], [1, 1, 1]).indices,
    };
    const down = findBaseCandidates(mesh, OPTIONS).filter((c) => c.normal[2] < -0.99);
    expect(down).toHaveLength(1);
    expect(down[0].area).toBeCloseTo(100 * 100, -1);
    expect(down[0].normal[0]).toBeCloseTo(Math.sin((1 * Math.PI) / 180), 6);
  });

  it('rejects a shallow bowl underneath, which faces the normal but has nothing on any plane', () => {
    // Four faces falling 0.5 degrees to a centre point. Each holds a quarter of the bin, so the
    // mean normal -z is tried, and no triangle has all its corners within tolerance of a level.
    const dip = 20 * Math.tan((0.5 * Math.PI) / 180);
    const mesh = {
      positions: Float32Array.from([-20, -20, 0, 20, -20, 0, 20, 20, 0, -20, 20, 0, 0, 0, dip, -20, -20, 10, 20, -20, 10, 20, 20, 10, -20, 20, 10]),
      indices: Uint32Array.from([
        1, 0, 4, 2, 1, 4, 3, 2, 4, 0, 3, 4, // bowl
        0, 1, 6, 0, 6, 5, 1, 2, 7, 1, 7, 6, 2, 3, 8, 2, 8, 7, 3, 0, 5, 3, 5, 8, // walls
        5, 6, 7, 5, 7, 8, // top
      ]),
    };
    expect(findBaseCandidates(mesh, OPTIONS).filter((c) => c.normal[2] < -0.99)).toEqual([]);
  });

  it('scales the automatic tolerance with model size inside 0.05 to 0.2', () => {
    const bounds = (size: number) => ({ min: [0, 0, 0] as Vec3, max: [size, 0, 0] as Vec3 });
    expect(autoPlaneTol(bounds(10))).toBe(0.05);
    expect(autoPlaneTol(bounds(200))).toBeCloseTo(0.1, 9);
    expect(autoPlaneTol(bounds(5000))).toBe(0.2);
  });
});

describe('two-level bases', () => {
  it('selects the pad on the support plane and reports the level above it', () => {
    const c = facing(findBaseCandidates(twoLevelBlock(api, 0.41), OPTIONS), DOWN)!;
    expect(c.offset).toBe(0);
    expect(c.area).toBeCloseTo(100, 3);
    const upper = upperLevel(c, OPTIONS.planeTol);
    expect(upper).not.toBeNull();
    expect(upper!.offset).toBeCloseTo(0.41, 3);
    expect(upper!.area).toBeCloseTo(1500, 2);
  });

  function levelReport(mesh: WeldedMesh, minIsland = OPTIONS.minIsland) {
    const c = facing(findBaseCandidates(mesh, { ...OPTIONS, minIsland }), DOWN)!;
    const oriented = orientToBase(mesh, c, { planeTol: OPTIONS.planeTol, soup: false });
    const footprint = withArena(api, (arena) => buildFootprint(arena, oriented.mesh, c, minIsland));
    return { oriented, report: classifyLevels(oriented.mesh, c, footprint, OPTIONS.planeTol) };
  }

  it('warns about the silicone film when the lower plane is selected', () => {
    const { oriented, report } = levelReport(twoLevelBlock(api, 0.41));
    expect(report.diagnostics.map((d) => [d.code, d.severity])).toEqual([['upper-level', 'warning']]);
    expect(report.diagnostics[0].message).toContain('0.41 mm');
    expect(report.useUpper!.gap).toBeCloseTo(0.41, 3);
    expect(report.useUpper!.exposedArea).toBeCloseTo(1500, 0);
    expect(report.useUpper!.enclosedArea).toBeCloseTo(0, 3);
    expect(oriented.needsTrim).toBe(false);
  });

  it('keeps that warning when the footprint filter would drop the level', () => {
    expect(levelReport(twoLevelBlock(api, 0.41), 2000).report.diagnostics.map((d) => d.code)).toContain('upper-level');
  });

  it('calls a level inside a hole of the base outline a recess: no film and nothing to trim', () => {
    const { report } = levelReport(recessedBlock(api, 0.41));
    expect(report.diagnostics.map((d) => [d.code, d.severity])).toEqual([['recess-level', 'info']]);
    expect(report.diagnostics[0].message).toContain('0.41 mm');
    expect(report.useUpper).toBeNull();
    expect(report.levels).toHaveLength(1);
    expect(report.levels[0].enclosedArea).toBeCloseTo(100, 1);
    expect(report.levels[0].exposedArea).toBeCloseTo(0, 3);
  });

  it('negative control: the same cut running out through a side is open to the cavity, so it warns', () => {
    const { report } = levelReport(notchedBlock(api, 0.41));
    expect(report.diagnostics.map((d) => d.code)).toEqual(['upper-level']);
    expect(report.useUpper!.exposedArea).toBeGreaterThan(200);
  });

  it('does not call a shallow slope a level, though each of its facets faces the normal', () => {
    // A recess 0.2 mm deep whose floor then rises at 1 degree: flat facet by facet, but no plane.
    const mesh = plateWithUnderside(40, (x, y) => {
      const r = Math.hypot(x - 20, y - 20);
      return r < 15 ? 0.2 + (15 - r) * Math.tan((1 * Math.PI) / 180) : 0;
    });
    expect(facing(findBaseCandidates(mesh, OPTIONS), DOWN)!.levels.map((l) => l.offset)).toEqual([0]);
  });

  it('does not report a level beyond the slider reach of 1 mm', () => {
    const c = facing(findBaseCandidates(twoLevelBlock(api, 1.5), OPTIONS), DOWN)!;
    expect(c.levels.map((l) => l.offset)).toEqual([0]);
    expect(upperLevel(c, OPTIONS.planeTol)).toBeNull();
  });

  it('moves the plane up and trims the pad off, leaving a footprint the size of the section', () => {
    const mesh = twoLevelBlock(api, 0.41);
    const lower = facing(findBaseCandidates(mesh, OPTIONS), DOWN)!;
    const c = candidateAtLevel(mesh, lower, upperLevel(lower, OPTIONS.planeTol)!.offset, OPTIONS);
    expect(c.area).toBeCloseTo(1500, 2);
    expect(upperLevel(c, OPTIONS.planeTol)).toBeNull();

    const oriented = orientToBase(mesh, c, { planeTol: OPTIONS.planeTol, soup: false });
    expect(oriented.needsTrim).toBe(true);
    expect(oriented.below.depth).toBeCloseTo(0.41, 3);
    withArena(api, (arena) => {
      const solid = importSolid(arena, mesh, auditEdges(mesh)).solid!;
      const trimmed = trimToBase(arena, orientSolid(arena, solid, oriented.transform));
      expect(trimmed.boundingBox().min[2]).toBeGreaterThanOrEqual(0);
      // Removed pad: 10 x 10 x 0.41.
      expect(trimmed.volume()).toBeCloseTo(solid.volume() - 41, 1);
      const cap = arena.track(trimmed.slice(0.02));
      expect(cap.area()).toBeCloseTo(1600, 1);
      const footprint = buildFootprint(arena, oriented.mesh, c, OPTIONS.minIsland, cap);
      expect(footprint.area).toBeCloseTo(1600, 1);
      expect(footprint.components).toHaveLength(1);
    });
  });

  it('skips a support level too small to be a face and picks the real level above it', () => {
    const c = facing(findBaseCandidates(twoLevelBlock(api, 0.41, 1), OPTIONS), DOWN)!;
    expect(c.offset).toBeCloseTo(0.41, 3);
    expect(c.area).toBeCloseTo(1599, 1);
  });
});

describe('spike below the plane', () => {
  it('keeps a shallow spike in the direction, picks the face and warns', () => {
    const mesh = spikedBlock(api, 0.5);
    const c = facing(findBaseCandidates(mesh, OPTIONS), DOWN)!;
    expect(c.offset).toBeCloseTo(0.5, 3);
    expect(c.area).toBeGreaterThan(399);
    const oriented = orientToBase(mesh, c, { planeTol: OPTIONS.planeTol, soup: false });
    expect(oriented.diagnostics.map((d) => d.code)).toEqual(['below-plane']);
    expect(oriented.needsTrim).toBe(true);
    expect(oriented.usable).toBe(true);
    expect(oriented.below.depth).toBeCloseTo(0.5, 3);
  });

  it('gives the warning and the trim for a deep spike when the user picks the face', () => {
    const mesh = spikedBlock(api, 3);
    // Find a triangle on the block's underside, as a click would.
    const picked = Array.from({ length: mesh.indices.length / 3 }, (_, t) => t).find((t) => [0, 1, 2].every((c) => mesh.positions[mesh.indices[t * 3 + c] * 3 + 2] === 0))!;
    const c = candidateFromPick(mesh, picked, OPTIONS);
    expect(c.normal).toEqual(DOWN);
    expect(c.source).toBe('pick');
    expect(c.area).toBeGreaterThan(399);
    expect(c.area).toBeLessThan(400);

    const oriented = orientToBase(mesh, c, { planeTol: OPTIONS.planeTol, soup: false });
    expect(oriented.diagnostics.map((d) => d.code)).toEqual(['below-plane']);
    expect(oriented.below.depth).toBeCloseTo(3, 3);
    expect(oriented.below.vertexCount).toBeGreaterThan(0);

    withArena(api, (arena) => {
      const solid = importSolid(arena, mesh, auditEdges(mesh)).solid!;
      const moved = orientSolid(arena, solid, oriented.transform);
      expect(moved.boundingBox().min[2]).toBeCloseTo(-3, 3);
      const trimmed = trimToBase(arena, moved);
      expect(trimmed.boundingBox().min[2]).toBeGreaterThanOrEqual(0);
      expect(trimmed.volume()).toBeCloseTo(20 * 20 * 10, 1);
    });
  });

  it('negative control: without a spike there is nothing to warn about or trim', () => {
    const mesh = box([0, 0, 0], [20, 20, 10]);
    const c = facing(findBaseCandidates(mesh, OPTIONS), DOWN)!;
    const oriented = orientToBase(mesh, c, { planeTol: OPTIONS.planeTol, soup: false });
    expect(oriented.diagnostics).toEqual([]);
    expect(oriented.needsTrim).toBe(false);
  });

  it('asks for another plane in soup mode, since there is no solid to trim', () => {
    const spiked = spikedBlock(api, 0.5);
    const open = withoutTriangles(spiked, [0]);
    expect(importSolidRoute(open)).toBe('soup');
    const c = facing(findBaseCandidates(open, OPTIONS), DOWN)!;
    const oriented = orientToBase(open, c, { planeTol: OPTIONS.planeTol, soup: true });
    expect(oriented.usable).toBe(false);
    expect(oriented.diagnostics.map((d) => [d.code, d.severity])).toEqual([['below-plane-soup', 'error']]);
  });

  describe.each([
    ['a solid', false],
    ['soup mode', true],
  ])('the edge of the tolerance, in %s', (_, soup) => {
    const planeTol = OPTIONS.planeTol;
    const pickBase = (depth: number) => {
      const spiked = spikedBlock(api, depth);
      // Removing a top triangle opens the mesh and leaves the base and the spike alone.
      const mesh = soup ? withoutTriangles(spiked, [triangleAtZ(spiked, 10)]) : spiked;
      const c = candidateFromPick(mesh, triangleAtZ(mesh, 0), OPTIONS);
      return orientToBase(mesh, c, { planeTol, soup });
    };

    it('stays quiet about a vertex 0.8 of the tolerance below the plane', () => {
      const oriented = pickBase(0.8 * planeTol);
      expect(oriented.below.depth).toBeCloseTo(0.8 * planeTol, 5);
      expect(oriented.below.vertexCount).toBe(0);
      expect(oriented.needsTrim).toBe(false);
      expect(oriented.usable).toBe(true);
      expect(oriented.diagnostics).toEqual([]);
    });

    it('warns about a vertex 1.2 of the tolerance below the plane', () => {
      const oriented = pickBase(1.2 * planeTol);
      expect(oriented.below.depth).toBeCloseTo(1.2 * planeTol, 5);
      expect(oriented.below.vertexCount).toBe(1);
      expect(oriented.needsTrim).toBe(true);
      expect(oriented.usable).toBe(!soup);
      expect(oriented.diagnostics.map((d) => d.code)).toEqual([soup ? 'below-plane-soup' : 'below-plane']);
    });
  });
});

describe('soup mode with bad winding (G1.6)', () => {
  const open = (): WeldedMesh => withoutTriangles(box([0, 0, 0], [20, 30, 10]), BOX_TOP);
  const flippedBase = (): WeldedMesh => flipTriangles(box([0, 0, 0], [20, 30, 10]), BOX_BOTTOM);

  it.each([
    ['open and inside out', () => inverted(open())],
    ['open with its base wound inward', () => flipTriangles(open(), [0, 1])],
    ['closed with only its base wound inward', flippedBase],
    ['inside out with its base wound outward', () => inverted(flippedBase())],
  ])('%s: still offers the base, and it works through to the footprint', (_, make) => {
    const { mesh, soup, candidates, openLoops } = imported(make());
    expect(soup).toBe(true);
    const down = facing(candidates(), DOWN)!;
    expect(down).toBeDefined();
    expect(down.area).toBeCloseTo(600, 2);
    expect(down.offset).toBe(0);

    const oriented = orientToBase(mesh, down, { planeTol: OPTIONS.planeTol, soup, openLoops });
    expect(oriented.usable).toBe(true);
    expect(oriented.needsTrim).toBe(false);
    for (let p = 2; p < oriented.mesh.positions.length; p += 3) expect(oriented.mesh.positions[p]).toBeGreaterThanOrEqual(0);
    expect(withArena(api, (arena) => buildFootprint(arena, oriented.mesh, down, OPTIONS.minIsland)).area).toBeCloseTo(600, 2);
  });

  it.each([
    ['inside out', () => inverted(open()), 0],
    ['with its base wound inward', () => flipTriangles(open(), [0, 1]), 0],
  ])('a click on the base of an open mesh %s reverses onto the right side', (_, make, z) => {
    const { mesh, soup, openLoops } = imported(make());
    const c = candidateFromPick(mesh, triangleAtZ(mesh, z), OPTIONS);
    expect(c.normal).toEqual(DOWN);
    expect(c.offset).toBe(0);
    expect(c.area).toBeCloseTo(600, 2);
    expect(c.levels.map((l) => l.offset)).toEqual([0]);
    expect(orientToBase(mesh, c, { planeTol: OPTIONS.planeTol, soup, openLoops }).usable).toBe(true);
  });

  it.each([[0], [1]])('a click on either half of a base wound half and half gives the whole base (%i)', (t) => {
    const mesh = flipTriangles(box([0, 0, 0], [20, 30, 10]), [BOX_BOTTOM_FIRST]);
    const c = candidateFromPick(mesh, t, OPTIONS);
    expect(c.normal).toEqual(DOWN);
    expect(c.area).toBeCloseTo(600, 2);
  });

  it('negative control: a click on a shelf keeps its side, with the tower still in front of it', () => {
    const mesh = stepped(api);
    const c = candidateFromPick(mesh, triangleAtZ(mesh, 5), OPTIONS);
    expect(c.normal).toEqual([0, 0, 1]);
    expect(c.offset).toBeCloseTo(25, 3);
  });

  it('does not double the candidates of a correctly wound open mesh', () => {
    const list = imported(open()).candidates();
    expect(list.map((c) => c.normal.join())).toEqual(expect.arrayContaining(['0,0,-1', '1,0,0', '-1,0,0', '0,1,0', '0,-1,0']));
    expect(new Set(list.map((c) => c.normal.join())).size).toBe(list.length);
  });
});

describe('holes in soup mode', () => {
  it('offers an open underside as a base, marked as a missing face', () => {
    const { mesh, soup, openLoops, candidates } = imported(withoutTriangles(box([0, 0, 0], [20, 30, 10]), BOX_BOTTOM));
    const c = facing(candidates(), DOWN)!;
    expect(c.source).toBe('hole');
    expect(c.area).toBeCloseTo(600, 3);
    expect(c.support).toBeCloseTo(0, 5);
    expect(c.members).toHaveLength(0);
    expect(c.holes).toHaveLength(1);

    const oriented = orientToBase(mesh, c, { planeTol: OPTIONS.planeTol, soup, openLoops });
    expect(oriented.usable).toBe(true);
    expect(oriented.diagnostics.map((d) => [d.code, d.severity])).toEqual([['base-from-hole', 'info']]);
    const footprint = withArena(api, (arena) => buildFootprint(arena, oriented.mesh, c, OPTIONS.minIsland));
    expect(footprint.area).toBeCloseTo(600, 1);
    expect(footprint.components).toHaveLength(1);
  });

  it('still fills the footprint when the winding around a hole points its cap into the model', () => {
    const mesh = withoutTriangles(box([0, 0, 0], [20, 30, 10]), BOX_BOTTOM);
    const openLoops = auditEdges(mesh).openLoops.map((loop) => ({ ...loop, capNormal: [-loop.capNormal[0] || 0, -loop.capNormal[1] || 0, -loop.capNormal[2] || 0] as Vec3 }));
    const c = facing(findBaseCandidates(mesh, OPTIONS, { openLoops }), DOWN)!;
    expect(c.source).toBe('hole');
    const oriented = orientToBase(mesh, c, { planeTol: OPTIONS.planeTol, soup: true });
    expect(withArena(api, (arena) => buildFootprint(arena, oriented.mesh, c, OPTIONS.minIsland)).area).toBeCloseTo(600, 1);
  });

  it('adds a hole to the face around it, instead of offering the plane twice', () => {
    const { mesh, candidates } = imported(withoutTriangles(box([0, 0, 0], [20, 30, 10]), [BOX_BOTTOM_FIRST]));
    const downs = candidates().filter((c) => c.normal[2] === -1);
    expect(downs).toHaveLength(1);
    expect(downs[0].source).toBe('histogram');
    expect(downs[0].area).toBeCloseTo(600, 3);
    expect(downs[0].holes).toHaveLength(1);
    const oriented = orientToBase(mesh, downs[0], { planeTol: OPTIONS.planeTol, soup: true });
    expect(withArena(api, (arena) => buildFootprint(arena, oriented.mesh, downs[0], OPTIONS.minIsland)).area).toBeCloseTo(600, 1);
  });

  it('keeps the recess of a missing base face out of its area and footprint, and warns of nothing', () => {
    const solid = recessedBlock(api, 0.41);
    const base = Array.from({ length: solid.indices.length / 3 }, (_, t) => t).filter((t) => [0, 1, 2].every((c) => solid.positions[solid.indices[t * 3 + c] * 3 + 2] === 0));
    const { mesh, soup, openLoops, candidates } = imported(withoutTriangles(solid, base));
    expect(openLoops).toHaveLength(2);
    const c = facing(candidates(), DOWN)!;
    expect(c.holes).toHaveLength(2);
    expect(c.area).toBeCloseTo(1500, 1);
    // The audit lists holes in no useful order, and the result must not depend on it.
    expect(facing(findBaseCandidates(mesh, OPTIONS, { openLoops: [...openLoops].reverse() }), DOWN)!.area).toBeCloseTo(1500, 1);
    const oriented = orientToBase(mesh, c, { planeTol: OPTIONS.planeTol, soup, openLoops });
    expect(oriented.diagnostics.map((d) => d.code)).toEqual(['base-from-hole']);
    const footprint = withArena(api, (arena) => buildFootprint(arena, oriented.mesh, c, OPTIONS.minIsland));
    expect(footprint.area).toBeCloseTo(1500, 1);
    expect(footprint.components[0].holes).toBe(1);
  });

  it('ranks a plane soup mode can use above one it cannot trim, however large', () => {
    const solid = twoLevelBlock(api, 0.41);
    const pad = Array.from({ length: solid.indices.length / 3 }, (_, t) => t).filter((t) => [0, 1, 2].every((c) => solid.positions[solid.indices[t * 3 + c] * 3 + 2] === 0));
    const { mesh, soup, openLoops, candidates } = imported(withoutTriangles(solid, pad));
    const [usable, upper] = candidates().filter((c) => c.normal[2] === -1);
    expect(usable.source).toBe('hole');
    expect(usable.area).toBeCloseTo(100, 1);
    expect(orientToBase(mesh, usable, { planeTol: OPTIONS.planeTol, soup, openLoops }).usable).toBe(true);
    // The larger plane above it is still offered, but with the pad below it, it cannot be chosen.
    expect(upper.source).toBe('histogram');
    expect(upper.area).toBeCloseTo(1500, 1);
    expect(orientToBase(mesh, upper, { planeTol: OPTIONS.planeTol, soup, openLoops }).usable).toBe(false);
  });

  it('negative control: a hole with model on both sides of its plane is no base', () => {
    const solid = stepped(api);
    const shelf = Array.from({ length: solid.indices.length / 3 }, (_, t) => t).filter((t) => [0, 1, 2].every((c) => Math.abs(solid.positions[solid.indices[t * 3 + c] * 3 + 2] - 5) < 1e-6));
    expect(shelf.length).toBeGreaterThan(0);
    const { candidates } = imported(withoutTriangles(solid, shelf));
    for (const c of candidates()) {
      expect(c.source).toBe('histogram');
      expect(c.holes).toEqual([]);
    }
  });

  it('a closed solid has no holes to offer', () => {
    expect(findBaseCandidates(box([0, 0, 0], [20, 30, 10]), OPTIONS).every((c) => c.holes.length === 0)).toBe(true);
  });

  describe('missing top surface', () => {
    const codesOn = (mesh: WeldedMesh, normal: Vec3): string[] => {
      const { mesh: settled, soup, openLoops, candidates } = imported(mesh);
      return orientToBase(settled, facing(candidates(), normal)!, { planeTol: OPTIONS.planeTol, soup, openLoops }).diagnostics.map((d) => d.code);
    };

    it('warns when the plane leaves the hole facing up', () => {
      expect(codesOn(withoutTriangles(box([0, 0, 0], [20, 30, 10]), BOX_TOP), DOWN)).toContain('missing-top-surface');
    });

    it('negative control: not for a hole on the underside, where the base covers it', () => {
      expect(codesOn(withoutTriangles(box([0, 0, 0], [20, 30, 10]), BOX_BOTTOM), DOWN)).not.toContain('missing-top-surface');
    });

    it('goes by the chosen plane: the same hole faces up with the model turned over', () => {
      expect(codesOn(withoutTriangles(box([0, 0, 0], [20, 30, 10]), BOX_BOTTOM), [0, 0, 1])).toContain('missing-top-surface');
    });

    it('negative control: not for a hole in a side wall, which faces no way up', () => {
      const side = withoutTriangles(box([0, 0, 0], [20, 30, 10]), [8, 9]);
      expect(codesOn(side, DOWN)).not.toContain('missing-top-surface');
    });

    it.each([
      [Math.sqrt(1.8), false],
      [Math.sqrt(2.2), true],
    ])('is decided at 1 mm2: a triangular hole of leg %f warns: %s', (leg, warned) => {
      expect(codesOn(boxWithTopHole(leg), DOWN).includes('missing-top-surface')).toBe(warned);
    });
  });
});

function importSolidRoute(mesh: WeldedMesh): string {
  return withArena(api, (arena) => importSolid(arena, mesh, auditEdges(mesh)).report.route);
}

describe('rigid transforms', () => {
  const normals: Vec3[] = [
    [0, 0, -1],
    [0, 0, 1],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0.6, 0, 0.8],
    [0.48, -0.6, 0.64],
    [0, Math.sin(1e-4), Math.cos(1e-4)], // just off +z, where the textbook formula loses its digits
    [Math.sin(1e-6), 0, -Math.cos(1e-6)],
  ];

  it.each(normals.map((n) => [n]))('rotates %j to -z with determinant +1', (n) => {
    const t = planeTransform(n, 2.5);
    expect(determinant(t)).toBeCloseTo(1, 12);
    const out = transformPositions(new Float32Array([n[0] * 2.5, n[1] * 2.5, n[2] * 2.5]), t);
    // A point on the plane lands on z=0.
    expect(out[2]).toBeCloseTo(0, 5);
    const [, , , , , , g, h, i] = t.rotation;
    expect(g * n[0] + h * n[1] + i * n[2]).toBeCloseTo(-1, 12);
  });

  it('puts the model above the plane, with a box exactly on z=0', () => {
    const mesh = box([1, 2, 3], [11, 22, 33]);
    for (const c of findBaseCandidates(mesh, OPTIONS)) {
      const oriented = orientToBase(mesh, c, { planeTol: OPTIONS.planeTol, soup: false });
      let min = Infinity;
      for (let p = 2; p < oriented.mesh.positions.length; p += 3) min = Math.min(min, oriented.mesh.positions[p]);
      expect(min).toBeCloseTo(0, 4);
    }
  });

  it('keeps signed volume on every candidate of a tilted box, which a reflection would negate', () => {
    const mesh = rotated(box([0, 0, 0], [10, 20, 40]), axisRotation([0.48, -0.6, 0.64], 71));
    const before = signedVolume(mesh);
    expect(before).toBeCloseTo(8000, 0);
    for (const c of findBaseCandidates(mesh, OPTIONS)) {
      const oriented = orientToBase(mesh, c, { planeTol: OPTIONS.planeTol, soup: false });
      expect(signedVolume(oriented.mesh)).toBeCloseTo(before, 0);
    }
  });

  it('negative control: refuses a mirror, a scale and a shear', () => {
    const translation: Vec3 = [0, 0, 0];
    const bad: RigidTransform['rotation'][] = [
      [1, 0, 0, 0, 1, 0, 0, 0, -1],
      [-1, 0, 0, 0, 1, 0, 0, 0, 1],
      [2, 0, 0, 0, 2, 0, 0, 0, 2],
      [1, 0.1, 0, 0, 1, 0, 0, 0, 1],
    ];
    for (const rotation of bad) {
      expect(() => assertRigid({ rotation, translation })).toThrow(/not a pure rotation/);
      expect(() => transformPositions(new Float32Array(3), { rotation, translation })).toThrow(/not a pure rotation/);
    }
  });

  it('negative control: the print-pose rule catches the plain z flip the plan warns about', () => {
    expect(() => assertRigid({ rotation: [1, 0, 0, 0, 1, 0, 0, 0, -1], translation: [0, 0, 50] })).toThrow();
    // The rotation (x, -y, Zt - z) from G9 is legal.
    expect(() => assertRigid({ rotation: [1, 0, 0, 0, -1, 0, 0, 0, -1], translation: [0, 0, 50] })).not.toThrow();
  });

  it('applies the same transform to the solid as to the mesh', () => {
    const mesh = rotated(box([0, 0, 0], [10, 20, 40]), axisRotation([0.6, 0, 0.8], 25));
    withArena(api, (arena) => {
      const solid = importSolid(arena, mesh, auditEdges(mesh)).solid!;
      const c = findBaseCandidates(mesh, OPTIONS)[0];
      const oriented = orientToBase(mesh, c, { planeTol: OPTIONS.planeTol, soup: false });
      const moved = orientSolid(arena, solid, oriented.transform);
      expect(moved.volume()).toBeCloseTo(solid.volume(), 2);
      expect(moved.boundingBox().min[2]).toBeCloseTo(0, 3);
      expect(moved.boundingBox().max[2]).toBeCloseTo(10, 3);
    });
  });
});

describe('footprint', () => {
  function footprintOf(mesh: WeldedMesh, minIsland = OPTIONS.minIsland) {
    const c = facing(findBaseCandidates(mesh, OPTIONS), DOWN)!;
    const oriented = orientToBase(mesh, c, { planeTol: OPTIONS.planeTol, soup: false });
    return withArena(api, (arena) => buildFootprint(arena, oriented.mesh, c, minIsland));
  }

  it('warns when the filter leaves no footprint, since glue mode would get no pocket', () => {
    const footprint = footprintOf(plateOnLegs(2));
    expect(footprint.components).toEqual([]);
    expect(footprint.islands.map((c) => Math.round(c.area))).toEqual([4, 4, 4, 4]);
    expect(footprint.diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ['footprint-islands', 'info'],
      ['footprint-empty', 'warning'],
    ]);
  });

  it('negative control: the same feet are the footprint with the filter lowered', () => {
    const footprint = footprintOf(plateOnLegs(2), 3);
    expect(footprint.components).toHaveLength(4);
    expect(footprint.diagnostics).toEqual([]);
  });

  it('gives two components for two feet', () => {
    const footprint = footprintOf(arch(api));
    expect(footprint.components.map((c) => Math.round(c.area))).toEqual([100, 100]);
    expect(footprint.islands).toEqual([]);
  });

  it('keeps a real hole, in both the area and the contours', () => {
    const footprint = footprintOf(ring(api, 30, 10, 5));
    expect(footprint.components).toHaveLength(1);
    const [only] = footprint.components;
    expect(only.holes).toBe(1);
    expect(only.polygons).toHaveLength(2);
    expect(only.area).toBeCloseTo(900 - Math.PI * 25, 0);
    expect(footprint.rawArea).toBeCloseTo(footprint.projectedArea, 1);
  });

  it('drops an island under minIsland and lists it', () => {
    const mesh = join(box([0, 0, 0], [20, 20, 5]), box([30, 0, 0], [31, 2, 5]));
    const footprint = footprintOf(mesh);
    expect(footprint.components.map((c) => Math.round(c.area))).toEqual([400]);
    expect(footprint.islands.map((c) => Math.round(c.area))).toEqual([2]);
    expect(footprint.diagnostics.map((d) => d.code)).toEqual(['footprint-islands']);
    expect(footprint.area).toBeCloseTo(400, 2);
    expect(footprint.rawArea).toBeCloseTo(402, 2);
  });

  it('negative control: keeps that island when minIsland is 0', () => {
    const mesh = join(box([0, 0, 0], [20, 20, 5]), box([30, 0, 0], [31, 2, 5]));
    const footprint = footprintOf(mesh, 0);
    expect(footprint.components).toHaveLength(2);
    expect(footprint.islands).toEqual([]);
    expect(footprint.diagnostics).toEqual([]);
  });

  it('closes a T-junction gap narrower than the closing offset', () => {
    const gap = 0.005;
    const footprint = footprintOf(join(box([0, 0, 0], [10, 10, 5]), box([10 + gap, 0, 0], [20, 10, 5])));
    expect(footprint.components).toHaveLength(1);
    expect(footprint.components[0].area).toBeCloseTo(200, 0);
  });

  it('negative control: two feet 0.1 mm apart stay separate', () => {
    const footprint = footprintOf(join(box([0, 0, 0], [10, 10, 5]), box([10.1, 0, 0], [20, 10, 5])));
    expect(footprint.components).toHaveLength(2);
  });

  it('works from triangles alone, so an open mesh still has a footprint', () => {
    const mesh = withoutTriangles(box([0, 0, 0], [20, 20, 10]), BOX_TOP);
    expect(importSolidRoute(mesh)).toBe('soup');
    expect(footprintOf(mesh).area).toBeCloseTo(400, 2);
  });
});

describe('heavy meshes (M11)', () => {
  it('examine fewer bins past 300k triangles, as each is a pass over the mesh, and every example all 128', () => {
    expect(examinedBins(225_154)).toBe(128);
    expect(examinedBins(300_000)).toBe(128);
    expect(examinedBins(600_000)).toBe(64);
    expect(examinedBins(3_011_040)).toBe(16);
    expect(examinedBins(30_000_000)).toBe(16);
  });

  it('a rough top that fills hundreds of bins still gives its underside first, past the cap and below it', () => {
    // 400 x 400 cells is 324,800 triangles, past the cap; its ripple's normals spread over hundreds of bins.
    const mesh = heightBlockMesh({ ...HEAVY_BLOCK, n: 400 }, weld);
    const options: BaseOptions = { planeTol: 0.05, minIsland: 5 };
    const found = findBaseCandidates(mesh, options);
    expect(found[0].normal).toEqual([0, 0, -1]);
    expect(found[0].area).toBeCloseTo(10_000, 3);
    // The four sides tie on area, so their order is no matter.
    expect(found.map((c) => c.normal.join()).sort()).toEqual(['-1,0,0', '0,-1,0', '0,0,-1', '0,1,0', '1,0,0']);
  });

  it('at the floor of 16 bins, which 3 million triangles get, the same five candidates, and the underside first', () => {
    // The plan's 3 million triangle block examines 16; the same block at 400 x 400 cells, held to 16 here,
    // stands for it in the quick suite. CFG_SOAK checks the 3 million themselves (test/regression/heavy.test.ts).
    const mesh = heightBlockMesh({ ...HEAVY_BLOCK, n: 400 }, weld);
    const all = findBaseCandidates(mesh, { planeTol: 0.05, minIsland: 5 });
    const floor = findBaseCandidates(mesh, { planeTol: 0.05, minIsland: 5, bins: 16 });
    expect(floor[0].normal).toEqual([0, 0, -1]);
    expect(floor.map((c) => [c.normal.join(), c.area])).toEqual(all.map((c) => [c.normal.join(), c.area]));
    // Negative control: too few bins to reach the sides loses them, so the comparison above can fail.
    expect(findBaseCandidates(mesh, { planeTol: 0.05, minIsland: 5, bins: 1 }).length).toBeLessThan(all.length);
  });
});
