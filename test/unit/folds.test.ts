import { existsSync, readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import type { ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditEdges } from '../../src/core/mesh/audit';
import { windingFolds } from '../../src/core/mesh/folds';
import { importSolid } from '../../src/core/mesh/shells';
import { weld, type WeldedMesh } from '../../src/core/mesh/weld';
import { withArena } from '../../src/core/solid/arena';
import { parseStl } from '../../src/core/stl/parse';
import { hasExample, loadManifold } from '../fixtures/loadExamples';
import { box, BOX_BOTTOM, boxWithSliver, cracked, finnedBox, foldedBox, join, openTopBox, weldedFixture, withoutTriangles } from '../fixtures/synthetic';

let api: ManifoldToplevel;
beforeAll(async () => {
  api = await loadManifold();
});

const examplesDir = joinPath(import.meta.dirname, '..', '..', 'examples');
/** All 15 examples, the two kept only on the maintainer's machine where they are here (examples/SOURCES.md). */
const EXAMPLES: [string, boolean][] = [
  ['3dbenchy.stl', true],
  ['barricate_type_2_straight.stl', true],
  ['charge-and-play-stand.stl', false],
  ['chick_mc.stl', true],
  ['Damaged 40ft Shipping Container.stl', false],
  ['doomedmarine.stl', true],
  ['Factorio gear.stl', false],
  ['Goddess Statue.stl', false],
  ['jersey-barrier.stl', false],
  ['jersey-barriers-x8.stl', false],
  ['N Scale Oil Barrel.stl', false],
  ['war-barricade.stl', false],
  ['wolfinal.stl', false],
  ['VIS-35-skan-skalowany.stl', false],
  ['l_medieval_barrel.stl', false],
];
const FULL = process.env.CFG_FULL === '1';

function example(name: string): WeldedMesh {
  const bytes = readFileSync(joinPath(examplesDir, name));
  return weld(parseStl(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length)).positions);
}

/** A closed sliver of `thickness` mm wound inside out: a body of negative volume, beside a box. */
function invertedSliver(thickness: number): WeldedMesh {
  const sliver: WeldedMesh = { positions: Float32Array.from([20, 0, 5, 30, 0, 5, 20, 10, 5, 23, 3, 5 + thickness]), indices: Uint32Array.from([0, 1, 2, 0, 3, 1, 1, 3, 2, 2, 3, 0]) };
  return weldedFixture(join(box([0, 0, 0], [10, 10, 10]), sliver));
}

describe('RM: where a closed mesh folds through itself', () => {
  it('finds foldedBox\'s fold, one place over many columns, and marks it in the fold', () => {
    const folds = windingFolds(foldedBox());
    expect(folds.columns).toBeGreaterThan(100);
    expect(folds.places).toBe(1);
    expect(folds.at).toHaveLength(1);
    // The mark is in the part pushed through: below the plane the top's x = 12.5 crossing, past it in x.
    const [x, , z] = folds.at[0];
    expect(x).toBeGreaterThan(12.5);
    expect(z).toBeLessThan(10);
    expect(folds.longest).toBeGreaterThan(1);
  });

  it('finds none on a box, a box beside a closed sliver of no volume, or a cracked box', () => {
    expect(windingFolds(box([0, 0, 0], [10, 10, 10])).columns).toBe(0);
    expect(windingFolds(boxWithSliver()).columns).toBe(0);
    expect(windingFolds(cracked(box([0, 0, 0], [10, 10, 10]), 0.05)).columns).toBe(0);
    // A column through a hole does not come back to 0, so it says nothing: one through a box with no bottom, under a
    // box 2 mm above it, would read -1 from the first's top to the second's bottom.
    const stacked = join(withoutTriangles(box([0, 0, 0], [10, 10, 10]), BOX_BOTTOM), box([0, 0, 12], [10, 10, 20]));
    expect(windingFolds(stacked).columns).toBe(0);
  });

  it('counts no run shorter than its minimum: a sliver 0.001 mm thick wound inside out', () => {
    expect(windingFolds(invertedSliver(0.001)).columns).toBe(0);
    // Control: with no minimum the same sliver is a fold, so the minimum is what keeps it out.
    expect(windingFolds(invertedSliver(0.001), 0.5, 0).columns).toBeGreaterThan(0);
  });

  it('the import reports folds on a closed mesh only, with a warning that names Repair mesh', () => {
    const report = (mesh: WeldedMesh) => withArena(api, (arena) => importSolid(arena, mesh, auditEdges(mesh)).report);
    const folded = report(foldedBox());
    expect(folded.route).toBe('manifold');
    expect(folded.folds).toBe(1);
    expect(folded.foldAt).toHaveLength(1);
    const warning = folded.diagnostics.find((d) => d.code === 'mesh-folds');
    expect(warning).toMatchObject({ severity: 'warning', message: 'The mesh folds through itself in 1 place, where its surface turns inside out, so its volume and a merged base may be wrong. Use Repair mesh in the Model section to rebuild it as one closed solid.' });
    for (const mesh of [weldedFixture(box([0, 0, 0], [10, 10, 10])), boxWithSliver()]) {
      const r = report(mesh);
      expect(r.folds).toBe(0);
      expect(r.diagnostics.some((d) => d.code === 'mesh-folds')).toBe(false);
    }
    // An open surface's winding says nothing, so a soup has none, whatever its shape.
    for (const mesh of [openTopBox(), finnedBox()]) {
      const r = report(mesh);
      expect(r.route).toBe('soup');
      expect(r.folds).toBe(0);
      expect(r.foldAt).toEqual([]);
    }
  });

  it('finds no fold on any of the 15 examples, each in well under a tenth of a second (CFG_FULL: the four over 100,000 triangles)', () => {
    let checked = 0;
    for (const [name, large] of EXAMPLES) {
      if (large && !FULL) continue;
      if (!existsSync(joinPath(examplesDir, name))) {
        // Only the two kept on the maintainer's machine may be missing.
        expect(['VIS-35-skan-skalowany.stl', 'l_medieval_barrel.stl']).toContain(name);
        expect(hasExample(name === 'l_medieval_barrel.stl' ? 'barrel' : 'vis35')).toBe(false);
        continue;
      }
      const mesh = example(name);
      const t0 = performance.now();
      const folds = windingFolds(mesh);
      const ms = performance.now() - t0;
      expect(folds.columns, name).toBe(0);
      // Warm, it measured at most 40 ms (doomedmarine); a cold first call compiles it.
      if (checked > 0) expect(ms, name).toBeLessThan(100);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(FULL ? 13 : 9);
  });
});
