import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import type { ManifoldToplevel } from 'manifold-3d';
import { MeshoptSimplifier } from 'meshoptimizer';
import { beforeAll, describe, expect, it } from 'vitest';
import { arrayBytes } from '../../src/app/memory';
import { auditEdges } from '../../src/core/mesh/audit';
import { rebuildSurface } from '../../src/core/mesh/columns';
import { DEVIATION_CELL_MM, SurfaceIndex } from '../../src/core/mesh/deviation';
import { windingFolds } from '../../src/core/mesh/folds';
import { fromRuns, SolidPoints, splitLong, SPLIT_CELLS } from '../../src/core/mesh/outside';
import { autoRepairCell, cellFacts, fillable, MAX_HOLE_EDGES, orientPieces, RepairError, repairCellProblem } from '../../src/core/mesh/repair';
import { MESHOPT_BYTES_PER_TRIANGLE, repairMesh, type RepairOptions, type Repaired, type RepairStep } from '../../src/core/mesh/repairImport';
import { importSolid } from '../../src/core/mesh/shells';
import { weld, type WeldedMesh } from '../../src/core/mesh/weld';
import { withArena } from '../../src/core/solid/arena';
import { parseStl } from '../../src/core/stl/parse';
import { writeBinaryStl } from '../../src/core/stl/write';
import { loadExample, loadManifold } from '../fixtures/loadExamples';
import { bruteDistance, bruteInside, denseSamples } from '../fixtures/repairChecks';
import { box, BOX_TOP, boxWithSliver, finnedBox, flatTetrahedron, flipTriangles, foldedBox, inverted, join, openOverlap, openTopBox, patchedL, thinWallBox, weldedFixture, withoutTriangles } from '../fixtures/synthetic';

let api: ManifoldToplevel;
beforeAll(async () => {
  api = await loadManifold();
  await MeshoptSimplifier.ready;
});

const sha = (mesh: WeldedMesh): string => createHash('sha256').update(writeBinaryStl(mesh.positions, mesh.indices)).digest('hex');
const closed = (mesh: WeldedMesh): number[] => {
  const audit = auditEdges(mesh);
  return [audit.openEdges, audit.nonManifoldEdges, audit.misorientedEdges];
};
const repair = (mesh: WeldedMesh, options: Partial<RepairOptions> = {}): Repaired => repairMesh(api, MeshoptSimplifier, mesh, auditEdges(mesh), { name: 'model.stl', cell: null, ...options });
const refused = (run: () => unknown): RepairError => {
  try {
    run();
  } catch (error) {
    if (error instanceof RepairError) return error;
    throw error;
  }
  throw new Error('not refused');
};
function oilBarrel(): WeldedMesh {
  const bytes = readFileSync(joinPath(import.meta.dirname, '..', '..', 'test-models', 'N Scale Oil Barrel.stl'));
  return weld(parseStl(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length)).positions);
}
/** The triangles of `mesh` as unordered corner positions, for comparing two meshes' triangles one by one. */
const corners = (mesh: WeldedMesh, t: number): string => [0, 1, 2].map((c) => Array.from(mesh.positions.subarray(mesh.indices[t * 3 + c] * 3, mesh.indices[t * 3 + c] * 3 + 3)).join(',')).sort().join('|');

describe('RM: the orientation fix', () => {
  it('turns the faces that run against their neighbours, and keeps the triangles where they were', () => {
    const turned = weldedFixture(flipTriangles(box([0, 0, 0], [10, 10, 10]), [1, 4, 9]));
    expect(closed(turned)[2]).toBeGreaterThan(0);
    const fixed = orientPieces(turned);
    expect(fixed.turned).toBe(3);
    expect(fixed.conflicts).toBe(0);
    expect(closed(fixed.mesh)).toEqual([0, 0, 0]);
    for (let t = 0; t < 12; t++) expect(corners(fixed.mesh, t)).toBe(corners(turned, t));
  });

  it('turns a piece wound inside out whole, but not a void inside another piece, and an open piece by its volume', () => {
    expect(orientPieces(weldedFixture(inverted(box([0, 0, 0], [10, 10, 10])))).turned).toBe(12);
    const hollow = weldedFixture(join(box([0, 0, 0], [10, 10, 10]), inverted(box([3, 3, 3], [7, 7, 7]))));
    expect(orientPieces(hollow).turned).toBe(0);
    expect(orientPieces(weldedFixture(inverted(withoutTriangles(box([0, 0, 0], [30, 20, 12]), BOX_TOP)))).turned).toBe(10);
  });

  it('skips the walk where no edge runs the same way in its two faces, and turns the same pieces', () => {
    const mesh = weldedFixture(join(inverted(box([0, 0, 0], [10, 10, 10])), box([20, 0, 0], [30, 10, 10]), inverted(withoutTriangles(box([40, 0, 0], [50, 10, 10]), BOX_TOP))));
    expect(closed(mesh)[2]).toBe(0);
    const walked = orientPieces(mesh), quick = orientPieces(mesh, true);
    expect(quick.turned).toBe(22);
    expect(Array.from(quick.mesh.indices)).toEqual(Array.from(walked.mesh.indices));
  });
});

describe('RM: rung A, holes closed and every triangle kept', () => {
  it('closes the open-top box: its 10 triangles in order and 2 caps, 7,200 mm3, nothing left out', () => {
    const O = openTopBox();
    const r = repair(O);
    expect(r.figures).toMatchObject({ method: 'filled', cell: null, holes: 1, holeArea: 600, turned: 0, triangles: 12, nearMm: 0, outside: null, volume: 7200 });
    // The caps' middle lies 10 mm from the long walls, proved.
    expect(r.figures.addedMm).toBeCloseTo(10, 6);
    expect(r.outside).toBeNull();
    expect(Array.from(r.mesh.indices.subarray(0, 30))).toEqual(Array.from(O.indices));
    expect(Array.from(r.mesh.positions)).toEqual(Array.from(O.positions));
    expect(closed(r.mesh)).toEqual([0, 0, 0]);
    expect(r.marks).toEqual([[15, 10, 12]]);
    expect(sha(r.mesh)).toBe('024ddc4889b18df7769556fded0f709399b62fec1b446abed4fd7d296f6fc6e6');
  });

  it('closes patchedL to the L\'s 14,500 mm3 exactly, and the oil barrel\'s one hole of 3.1 mm2', () => {
    expect(repair(weldedFixture(patchedL(api))).figures).toMatchObject({ method: 'filled', holes: 1, volume: 14500 });
    const O = oilBarrel();
    const r = repair(O);
    expect(r.figures).toMatchObject({ method: 'filled', holes: 1, triangles: O.indices.length / 3 + 22, nearMm: 0, outside: null });
    expect(r.figures.holeArea).toBeCloseTo(3.106, 3);
    expect(r.figures.volume).toBeCloseTo(5616.875, 2);
    expect(Array.from(r.mesh.indices.subarray(0, O.indices.length))).toEqual(Array.from(O.indices));
    expect(withArena(api, (arena) => importSolid(arena, r.mesh, auditEdges(r.mesh)).report)).toMatchObject({ route: 'manifold', folds: 0, flipped: false });
    expect(sha(r.mesh)).toBe('515954b7ccf670394f6f6620d7f5b7754267963db9e218333effd0667f91b9a7');
  });

  it('a closed box with faces turned the wrong way needs only the fix: filled with no hole', () => {
    const r = repair(weldedFixture(flipTriangles(box([0, 0, 0], [10, 10, 10]), [1, 4, 9])));
    expect(r.figures).toMatchObject({ method: 'filled', holes: 0, turned: 3, triangles: 12, volume: 1000, addedMm: 0 });
  });

  it('takes only simple holes of at most 512 edges, on a mesh no edge of which three faces share', () => {
    expect(fillable(auditEdges(openTopBox()))).toBe(true);
    expect(fillable(auditEdges(finnedBox()))).toBe(false);
    const audit = auditEdges(openTopBox());
    const long = { ...audit.openLoops[0], edgeCount: MAX_HOLE_EDGES + 1, vertices: Uint32Array.from({ length: MAX_HOLE_EDGES + 1 }, (_, k) => k) };
    expect(fillable({ ...audit, openLoops: [long] })).toBe(false);
  });
});

describe('RM: rung A\'s check, the only guard against keeping a fill that is no closed solid (RM\'s review)', () => {
  it('rebuilds foldedBox less a triangle of its wall, whose fill would keep the fold, to the box where its winding is positive', () => {
    const O = weldedFixture(withoutTriangles(foldedBox(), [10]));
    expect(fillable(auditEdges(O))).toBe(true);
    const r = repair(O, { cell: 0.5 });
    // The fill is a closed mesh of 800 mm3 that still folds; the check sends it to rung B.
    expect(r.figures.method).toBe('rebuilt');
    expect(r.figures.volume).toBeGreaterThan(1200);
    expect(r.figures.volume).toBeLessThan(1260);
    expect(windingFolds(r.mesh).places).toBe(0);
    expect(r.figures.outside?.triangles ?? 0).toBeGreaterThan(0);
    expect(closed(r.mesh)).toEqual([0, 0, 0]);
  });

  it('rebuilds a cone whose hole\'s least cap would reuse an edge a closed part beside it already has twice', () => {
    // The cone's rim a, b, c, d is a hole of four edges, its corners b and d high above a and c, so the least cap
    // takes the short diagonal a-c; a tetrahedron on a and c holds that edge already, so the fill shares it four times.
    const a: [number, number, number] = [0, 0, 0], c: [number, number, number] = [1, 0, 0];
    const positions = Float32Array.from([...a, 0.5, 5, 3, ...c, 0.5, -5, 3, 0.5, 0, -5, 0.5, 0.5, -1, 0.5, -0.5, -1]);
    // 0 a, 1 b, 2 c, 3 d, 4 the cone's apex, 5 and 6 the tetrahedron's.
    const cone = [4, 1, 0, 4, 2, 1, 4, 3, 2, 4, 0, 3];
    const tetra = [0, 2, 5, 2, 6, 5, 0, 6, 2, 0, 5, 6];
    const O = weldedFixture({ positions, indices: Uint32Array.from([...cone, ...tetra]) });
    const audit = auditEdges(O);
    expect([audit.openLoops.length, audit.nonManifoldEdges]).toEqual([1, 0]);
    expect(fillable(audit)).toBe(true);
    const r = repair(O, { cell: 0.1 });
    expect(r.figures.method).toBe('rebuilt');
    expect(closed(r.mesh)).toEqual([0, 0, 0]);
  });
});

describe('RM: rung B, the surface rebuilt on a grid', () => {
  it('rebuilds finnedBox at 0.5 mm as the box, and leaves its fin out, 5 mm from it', () => {
    const r = repair(finnedBox(), { cell: 0.5 });
    expect(r.figures).toMatchObject({ method: 'rebuilt', cell: 0.5, cellAsked: 0.5, turned: 0, triangles: 70 });
    expect(r.figures.outside?.runs).toEqual([[12, 2]]);
    expect(r.figures.outside?.farthestMm).toBeGreaterThanOrEqual(5);
    expect(r.figures.outside?.farthestMm).toBeLessThan(5.05);
    expect(r.figures.nearMm).toBeLessThanOrEqual(0.5);
    // A chamfer of at most the cell along the box's 248 mm of edges.
    expect(Math.abs(r.figures.volume - 7200)).toBeLessThan(248 * 0.5 * 0.5 / 2);
    expect(closed(r.mesh)).toEqual([0, 0, 0]);
    expect(r.outside?.indices.length).toBe(6);
    expect(r.marks).toHaveLength(1);
    expect(r.marks[0][2]).toBe(17);
    // The same file and grid give the same copy, as the browser test checks in Chromium and Firefox.
    expect(sha(r.mesh)).toBe('9dfa9a7f384eb8499af9bf9896c955e148dd36823836340bb8f11b2d840fecc1');
    expect(sha(repair(finnedBox(), { cell: 1 }).mesh)).toBe('eb9b60d1d0f86f30d849cac2d2ea02b3ea1b824d31d7af071fff53543fcfa07e');
  });

  it('leaves out a wall thinner than the grid with the fin, and keeps one thicker', () => {
    // The box is triangles 0 to 11, the wall 12 to 23 (its bottom two on the box's top), the fin 24 and 25.
    expect(repair(thinWallBox(10.05, 10.2), { cell: 0.5 }).figures.outside?.runs).toEqual([[14, 12]]);
    expect(repair(thinWallBox(10, 10.3), { cell: 0.5 }).figures.outside?.runs).toEqual([[14, 12]]);
    const kept = repair(thinWallBox(10, 11), { cell: 0.5 });
    expect(kept.figures.outside?.runs).toEqual([[24, 2]]);
    expect(kept.figures.volume).toBeGreaterThan(7200 + 0.5 * 40);
  });

  it('proves the inner walls of parts that overlap inside the copy, so none is left out; an odd vote would lose the overlap', () => {
    const r = repair(openOverlap(), { cell: 0.5, rung: 'rebuild' });
    expect(r.figures.outside).toBeNull();
    expect(r.stats.insideProved).toBeGreaterThan(0);
    expect(Math.abs(r.figures.volume - 8500) / 8500).toBeLessThan(0.01);
    // Control: counting crossings by parity takes the 1,500 mm3 the boxes share as outside.
    expect(repair(openOverlap(), { cell: 0.5, rung: 'rebuild', rule: 'parity' }).figures.volume).toBeLessThan(7500);
  });

  it('proves a part wholly inside another inside the copy, and keeps its points from raising e_near to the cell', () => {
    // A closed box with a second inside it: its walls lie 3 mm and more inside the copy.
    const r = repair(weldedFixture(join(box([0, 0, 0], [30, 20, 12]), box([10, 5, 3], [20, 15, 9]))), { cell: 0.5, rung: 'rebuild' });
    expect(r.figures.outside).toBeNull();
    expect(r.stats.insideProved).toBeGreaterThan(0);
    // The box's own corners, 0.36 mm out of the copy, bounded at 0.44: not the 0.5 the inner box's points would give.
    expect(r.figures.nearMm).toBeLessThan(0.47);
    expect(Math.abs(r.figures.volume - 7200)).toBeLessThan(248 * 0.5 * 0.5 / 2);
  });

  it('rebuilds foldedBox as the 1,250 mm3 where its winding is positive, folding no more', () => {
    const r = repair(foldedBox(), { cell: 0.5 });
    expect(r.figures.method).toBe('rebuilt');
    expect(Math.abs(r.figures.volume - 1250) / 1250).toBeLessThan(0.02);
    expect(windingFolds(r.mesh).columns).toBe(0);
    expect(r.figures.outside?.triangles).toBeGreaterThan(0);
  });

  it('refuses a closed solid that does not fold, and a surface that encloses nothing, with its own sentence', () => {
    expect(refused(() => repair(weldedFixture(box([0, 0, 0], [10, 10, 10]))))).toMatchObject({ code: 'repair-nothing', message: 'model.stl is a closed solid already, so there is nothing to repair.' });
    expect(refused(() => repair(boxWithSliver())).code).toBe('repair-nothing');
    expect(refused(() => repair(weldedFixture(flatTetrahedron())))).toMatchObject({ code: 'repair-empty', message: 'model.stl could not be repaired: the rebuild could not tell inside from outside, as its surface encloses no space or its holes face each other across it.' });
  });

  it('refuses a grid the model cannot take, naming the finest it can', () => {
    expect(refused(() => repair(finnedBox(), { cell: 0.05 })).message).toBe('A grid of 0.05 mm cannot be used: give it a value from 0.1 to 2 mm, or leave it empty for auto.');
    // About 20,000 mm2 of surface: 0.1 mm would extract about 16 million triangles.
    const facts = { area: 20_000, min: [0, 0, 0] as [number, number, number], max: [100, 100, 20] as [number, number, number] };
    expect(autoRepairCell(facts)).toBe(0.25);
    expect(repairCellProblem(facts, 0.1)).toBe('A 0.10 mm grid would make about 16.0 million triangles before they are reduced, past the 3 million this app takes: 0.25 mm is the finest for this model.');
    expect(repairCellProblem(facts, 0.25)).toBeNull();
    // A tall thin model: the lattice's nodes bind before the triangles do.
    const tall = { area: 2_000, min: [0, 0, 0] as [number, number, number], max: [400, 400, 400] as [number, number, number] };
    expect(autoRepairCell(tall)).toBe(1.05);
    expect(repairCellProblem(tall, 1)).toMatch(/^A 1\.00 mm grid would need \d+ million points round this model, past the 64 million this app takes: /);
  });

  it('refuses a model too large for any grid, the automatic one too, with its own sentence (RM\'s review)', () => {
    // finnedBox 40 times over, 1.2 x 0.8 x 0.68 m: even 2 mm would extract about 8 million triangles.
    const big: WeldedMesh = { positions: Float32Array.from(finnedBox().positions, (v) => v * 40), indices: finnedBox().indices };
    const facts = cellFacts(big);
    expect(autoRepairCell(facts)).toBe(2);
    expect(repairCellProblem(facts, 2)).toMatch(/^A 2\.00 mm grid would make about 8\.\d million triangles before they are reduced, past the 3 million this app takes, and no grid from 0\.1 to 2 mm suits this model, so it cannot be rebuilt\.$/);
    const error = refused(() => repair(big));
    expect(error.code).toBe('repair-cell');
    expect(error.message).toMatch(/^model\.stl cannot be rebuilt on any grid this app takes: the coarsest that suits it, 2\.00 mm, would make about 8\.\d million triangles before they are reduced, past the 3 million this app takes\.$/);
  });

  it('coarsens the grid for a model far from the origin, so no vertex leaves its edge, and refuses a finer one typed (RM\'s review)', () => {
    // finnedBox 100 m along x: a float32 step there is 0.0078 mm, and a cell must span 64 of them.
    const far: WeldedMesh = { positions: Float32Array.from(finnedBox().positions, (v, k) => (k % 3 === 0 ? v + 100_000 : v)), indices: finnedBox().indices };
    const facts = cellFacts(far);
    expect(autoRepairCell(facts)).toBe(0.5);
    expect(repairCellProblem(facts, 0.1)).toBe('A 0.10 mm grid would be too fine for a model this far from the origin, whose coordinates reach 100,030 mm: 0.50 mm is the finest for this model.');
    const r = repair(far);
    expect(r.figures.cell).toBe(0.5);
    expect(closed(r.mesh)).toEqual([0, 0, 0]);
    const report = withArena(api, (arena) => importSolid(arena, r.mesh, auditEdges(r.mesh)).report);
    expect(report).toMatchObject({ route: 'manifold', bodies: 1, folds: 0 });
    expect(report.diagnostics.filter((d) => d.code === 'shell-void')).toEqual([]);
    // The box, to within 1%: a float32 step there is 0.0078 mm, so its faces sit within that of where they were.
    expect(Math.abs(r.figures.volume - 7200)).toBeLessThan(72);
  });

  it('picks the automatic grid of the design\'s calibration on the examples', () => {
    expect(autoRepairCell(cellFacts(loadExample('jersey').welded))).toBe(0.1);
    expect(autoRepairCell(cellFacts(loadExample('x8').welded))).toBe(0.3);
    expect(autoRepairCell(cellFacts(loadExample('wolf').welded))).toBe(0.35);
    expect(autoRepairCell(cellFacts(loadExample('benchy').welded))).toBe(0.2);
  });
});

describe('RM: Show for the parts a rebuild left out (RM\'s review)', () => {
  it('marks the farthest part first, though it comes last in the file, then the others, at most 20', () => {
    // 25 fins 1.5 mm tall along the box's top, then one 5 mm tall: each a triangle of its own, so 26 pieces left out.
    const fin = (x: number, y: number, tall: number): WeldedMesh => ({ positions: Float32Array.from([x, y - 1, 12, x, y + 1, 12, x, y, 12 + tall]), indices: Uint32Array.from([0, 1, 2]) });
    const short = Array.from({ length: 25 }, (_, k) => fin(1 + k, 4, 1.5));
    const O = weldedFixture(join(box([0, 0, 0], [30, 20, 12]), ...short, fin(28, 14, 5)));
    const r = repair(O, { cell: 0.5, rung: 'rebuild' });
    expect(r.figures.outside!.triangles).toBe(26);
    expect(r.marks).toHaveLength(20);
    const [x, y, z] = r.marks[0];
    expect(Math.hypot(x - 28, y - 14, z - 17)).toBeLessThan(0.5);
    expect(r.figures.outside!.farthestMm).toBeGreaterThan(4.5);
    // The rest are the short fins' tips, each once.
    for (const [mx, , mz] of r.marks.slice(1)) {
      expect(mz).toBeGreaterThan(13);
      expect(mx).toBeLessThan(26);
    }
    expect(new Set(r.marks.slice(1).map(([mx]) => Math.round(mx))).size).toBe(19);
  });
});

describe('RM: the guarantee, every point of the file within e_near of the copy, inside it, or left out', () => {
  const fixtures: [string, () => WeldedMesh, Partial<RepairOptions>][] = [
    ['finnedBox', finnedBox, { cell: 0.5 }],
    ['a 0.15 mm wall and a fin', () => thinWallBox(10.05, 10.2), { cell: 0.5 }],
    ['a 1 mm wall and a fin', () => thinWallBox(10, 11), { cell: 0.5 }],
    ['two boxes that overlap, rebuilt', openOverlap, { cell: 0.5, rung: 'rebuild' }],
    ['foldedBox', foldedBox, { cell: 0.5 }],
    ['finnedBox at 1 mm', finnedBox, { cell: 1 }],
  ];
  for (const [name, make, options] of fixtures) {
    it(`${name}: by brute force at every point of a fine grid on each triangle`, () => {
      const O = make();
      const r = repair(O, options);
      const far = new Set(r.figures.outside ? Array.from(fromRuns(r.figures.outside.runs)) : []);
      const near = Array.from({ length: O.indices.length / 3 }, (_, t) => t).filter((t) => !far.has(t));
      let worst = 0, inside = 0;
      for (const [x, y, z] of denseSamples(O, near, 24)) {
        const d = bruteDistance(r.mesh, x, y, z);
        if (d <= r.figures.nearMm + 1e-9) {
          worst = Math.max(worst, d);
          continue;
        }
        // Past e_near: only a point inside the copy may be.
        expect(bruteInside(r.mesh, x, y, z), `${name} at ${x}, ${y}, ${z}: ${d} mm from the copy, past ${r.figures.nearMm}`).toBe(true);
        inside++;
      }
      // The figure is no more than the cell, and not far over the worst point found.
      expect(r.figures.nearMm).toBeLessThanOrEqual(r.figures.cell! + 1e-9);
      expect(r.figures.nearMm - worst).toBeLessThan(0.1);
      if (name.startsWith('two boxes')) expect(inside).toBeGreaterThan(0);
      // And every far triangle's farthest point is within the figure for the far part.
      if (r.outside) for (const [x, y, z] of denseSamples(r.outside, Array.from({ length: r.outside.indices.length / 3 }, (_, t) => t), 12)) expect(bruteDistance(r.mesh, x, y, z)).toBeLessThanOrEqual(r.figures.outside!.farthestMm + 1e-9);
    });
  }
});

describe('RM: what the repair holds, for the memory meter', () => {
  it('counts at least every large array of the rebuild and the comparison, and meshoptimizer\'s heap', () => {
    const O = finnedBox();
    let step: RepairStep = 'fill';
    const peak: Partial<Record<RepairStep, number>> = {};
    let meshopt = 0;
    const r = repair(O, {
      cell: 0.5,
      progress: (s) => void (step = s),
      hold: (arrays, bytes) => {
        peak[step] = Math.max(peak[step] ?? 0, arrayBytes([arrays]));
        meshopt = Math.max(meshopt, bytes);
      },
    });
    const { lattice, nodes } = r.stats.rebuild!;
    const slab = lattice.n[0] * lattice.n[1];
    // Held at once as the last slab is extracted: the vote's byte a node, two float64 field slabs, two slabs of seven
    // int32 vertex ids a node, and the surface extracted, at the least.
    const extracted = rebuildSurface(orientPieces(O, true).mesh, 0.5).mesh;
    expect(peak.rebuild).toBeGreaterThanOrEqual(nodes + 2 * slab * 8 + 2 * slab * 7 * 4 + arrayBytes([extracted]));
    // The copy's index for the bound, its 2D buckets for the inside test, and the file's triangles it did not leave
    // out cut to pieces of four cells, which the comparison's second pass bounds (RM's review: not counted, it passed).
    const index = new SurfaceIndex(r.mesh, 0.5, Math.max(DEVIATION_CELL_MM, 0.5));
    const far = new Set(fromRuns(r.figures.outside!.runs));
    const kept = Array.from({ length: O.indices.length / 3 }, (_, t) => t).filter((t) => !far.has(t));
    const pieces = splitLong(O, SPLIT_CELLS * 0.5, kept);
    expect(pieces.parent.length).toBeGreaterThan(100);
    expect(peak.compare).toBeGreaterThanOrEqual(arrayBytes([index.held(), new SolidPoints(r.mesh).held(), pieces]));
    // meshoptimizer's own heap, as estimated: test/unit/repairMeter.test.ts holds the estimate to its memory's growth.
    expect(meshopt).toBe((extracted.indices.length / 3) * MESHOPT_BYTES_PER_TRIANGLE);
  });

  it('says its steps as they come: a rebuild never says it is closing holes (RM\'s review)', () => {
    const steps = (mesh: WeldedMesh, options: Partial<RepairOptions>): RepairStep[] => {
      const said: RepairStep[] = [];
      repair(mesh, { ...options, progress: (s) => void (said.at(-1) === s || said.push(s)) });
      return said;
    };
    expect(steps(openTopBox(), {})).toEqual(['orient', 'fill', 'check']);
    expect(steps(finnedBox(), { cell: 0.5 })).toEqual(['orient', 'rebuild', 'reduce', 'check', 'compare']);
  });

  it('counts the soup a fill is checked through, as its STL loads again, beside the filled triangles', () => {
    let step: RepairStep = 'orient';
    const peak: Partial<Record<RepairStep, number>> = {};
    const r = repair(openTopBox(), { progress: (s) => void (step = s), hold: (arrays) => void (peak[step] = Math.max(peak[step] ?? 0, arrayBytes([arrays]))) });
    expect(r.figures.method).toBe('filled');
    const T = r.mesh.indices.length / 3;
    // The soup, nine float32 a triangle, and the filled mesh's indices, three uint32 a triangle.
    expect(peak.check).toBeGreaterThanOrEqual(T * 9 * 4 + T * 3 * 4);
  });
});
