import type { ManifoldToplevel } from 'manifold-3d';
import { MeshoptSimplifier } from 'meshoptimizer';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditEdges } from '../../src/core/mesh/audit';
import { DEVIATION_CELL_MM, SurfaceIndex } from '../../src/core/mesh/deviation';
import { windingFolds } from '../../src/core/mesh/folds';
import { fromRuns } from '../../src/core/mesh/outside';
import { repairMesh } from '../../src/core/mesh/repairImport';
import { importSolid } from '../../src/core/mesh/shells';
import { withArena } from '../../src/core/solid/arena';
import { loadExample, loadManifold, type ExampleId } from '../fixtures/loadExamples';
import { bruteInside } from '../fixtures/repairChecks';

/** Each rebuild takes 5 to 10 s at the automatic grid, so these run with CFG_FULL. */
const FULL = process.env.CFG_FULL === '1';
const SLOW = 600_000;

let api: ManifoldToplevel;
beforeAll(async () => {
  api = await loadManifold();
  await MeshoptSimplifier.ready;
});

/**
 * RM: rung B forced on closed examples, which the app never offers it for, as the one way to know what it should give:
 * the union of the file's parts, which Manifold measures. The spike measured all 15 (docs/PLAN.md, RM); these four
 * are a CAD part, a printed boat, a figure of 6 overlapping parts and 8 bodies apart.
 */
const CASES: [ExampleId, number][] = [
  ['jersey', 0.1],
  ['x8', 0.3],
  ['benchy', 0.2],
  ['chick', 0.15],
];

describe('RM: a rebuild at the automatic grid gives back a closed model as it was', () => {
  for (const [id, cell] of CASES) {
    it(`${id}: closed, no fold, its volume within 0.2% of its parts' union, and every vertex of the file within e_near of the copy or inside it`, (ctx) => {
      ctx.skip(!FULL, 'a rebuild takes 5 to 10 s: CFG_FULL=1 runs it');
      const { welded, audit } = loadExample(id);
      const union = withArena(api, (arena) => {
        const report = importSolid(arena, welded, audit).report;
        return report.solidVolume - report.voidVolume - report.overlapVolume;
      });
      const r = repairMesh(api, MeshoptSimplifier, welded, audit, { name: id, cell: null, rung: 'rebuild' });
      expect(r.figures.cell).toBe(cell);
      expect(r.stats.checkedBy).toBe('manifold');
      expect(auditEdges(r.mesh)).toMatchObject({ openEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 });
      expect(windingFolds(r.mesh).columns).toBe(0);
      expect(r.figures.triangles).toBeLessThan(200_000);
      expect(Math.abs(r.figures.volume - union) / union).toBeLessThan(0.002);
      expect(r.figures.nearMm).toBeLessThanOrEqual(cell + 1e-9);
      // Every vertex of the file but the far part's: within e_near of the copy, or, where farther, inside it.
      const far = new Set(r.figures.outside ? Array.from(fromRuns(r.figures.outside.runs)) : []);
      const farVertex = new Uint8Array(welded.positions.length / 3);
      for (const t of far) for (let c = 0; c < 3; c++) farVertex[welded.indices[t * 3 + c]] = 1;
      const index = new SurfaceIndex(r.mesh, cell, Math.max(DEVIATION_CELL_MM, cell));
      const past = index.check(welded.positions, r.figures.nearMm).past;
      let tried = 0;
      for (const v of past) {
        if (farVertex[v] || tried >= 200) continue;
        tried++;
        const [x, y, z] = welded.positions.subarray(v * 3, v * 3 + 3);
        expect(bruteInside(r.mesh, x, y, z), `${id} vertex ${v}`).toBe(true);
      }
    }, SLOW);
  }

  it('control: a vote by parity loses the chick\'s overlaps, which the positive vote keeps', (ctx) => {
    ctx.skip(!FULL, 'a rebuild takes 5 to 10 s: CFG_FULL=1 runs it');
    const { welded, audit } = loadExample('chick');
    const union = withArena(api, (arena) => {
      const report = importSolid(arena, welded, audit).report;
      return report.solidVolume - report.voidVolume - report.overlapVolume;
    });
    const r = repairMesh(api, MeshoptSimplifier, welded, audit, { name: 'chick', cell: null, rung: 'rebuild', rule: 'parity' });
    expect((union - r.figures.volume) / union).toBeGreaterThan(0.03);
  }, SLOW);
});
