import { readFileSync } from 'node:fs';
import type { ManifoldToplevel } from 'manifold-3d';
import { MeshoptSimplifier } from 'meshoptimizer';
import { beforeAll, describe, expect, it } from 'vitest';
import { examinedBins, findBaseCandidates } from '../../src/core/base/candidates';
import { orientToBase } from '../../src/core/base/orient';
import { auditEdges } from '../../src/core/mesh/audit';
import { importSolid } from '../../src/core/mesh/shells';
import { displayProxy, importFromCopy, MANIFOLD_TRIANGLE_TARGET, manifoldPathSolid } from '../../src/core/mesh/simplify';
import { weld } from '../../src/core/mesh/weld';
import { baseOptions, defaultParams } from '../../src/core/params/defaults';
import { withArena } from '../../src/core/solid/arena';
import { parseStl } from '../../src/core/stl/parse';
import { heightBlockMesh, heightBlockSoup, heightBlockStl, heightBlockTriangles, HEAVY_BLOCK, type HeightBlock } from '../fixtures/heavy';
import { loadManifold } from '../fixtures/loadExamples';
import { asciiStl, inverted, signedVolume } from '../fixtures/synthetic';

/** M11's heavy input. The 3 million triangles run with CFG_SOAK=1, as they take a minute and 1.5 GB. */
const SOAK = process.env.CFG_SOAK === '1';

let api: ManifoldToplevel;
beforeAll(async () => {
  api = await loadManifold();
  await MeshoptSimplifier.ready;
});

/** 60 cells of 5/3 mm: no step lands on the ripple's zeros, as 20 cells of 5 mm would, every one, leaving the top flat. */
const small: HeightBlock = { ...HEAVY_BLOCK, n: 60 };
/** This process's resident memory and its peak, in MB, from /proc as the browser test reads its own. */
const memory = (): { rss: number; peak: number } => {
  const status = readFileSync('/proc/self/status', 'utf8');
  const kb = (name: string): number => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(status)![1]);
  return { rss: Math.round(kb('VmRSS') / 1024), peak: Math.round(kb('VmHWM') / 1024) };
};

describe('the heavy block', () => {
  it('is a closed solid of the triangles its n says, with the volume of its mean height: its ripple has whole periods', () => {
    const mesh = heightBlockMesh(small, weld);
    expect(mesh.indices.length / 3).toBe(heightBlockTriangles(60));
    expect(auditEdges(mesh)).toMatchObject({ openEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 });
    // The top is rippled, so the volume below tests the ripple's periods and not a flat lid.
    let low = Infinity, high = -Infinity;
    for (let v = 2; v < mesh.positions.length; v += 3) {
      if (mesh.positions[v] === 0) continue;
      low = Math.min(low, mesh.positions[v]);
      high = Math.max(high, mesh.positions[v]);
    }
    expect(high - low).toBeGreaterThan(1.5);
    expect(Math.abs(signedVolume(mesh) - 100 * 100 * 20)).toBeLessThanOrEqual(200);
    withArena(api, (arena) => {
      const { report } = importSolid(arena, mesh, auditEdges(mesh));
      expect(report).toMatchObject({ route: 'manifold', bodies: 1, flipped: false });
    });
    // The same bytes every time, so a failing run can be made again.
    expect(Buffer.compare(Buffer.from(heightBlockStl(small)), Buffer.from(heightBlockStl(small)))).toBe(0);
    expect(heightBlockTriangles(HEAVY_BLOCK.n)).toBe(3_011_040);
  });

  it('a 5 MB ASCII STL of it reads back with every triangle', () => {
    const block = { ...HEAVY_BLOCK, n: 104 };
    const ascii = asciiStl(heightBlockSoup(block), 'five megabytes');
    expect(ascii.length).toBeGreaterThan(5_000_000);
    const parsed = parseStl(ascii);
    expect(parsed.format).toBe('ascii');
    expect(parsed.triangleCount).toBe(heightBlockTriangles(104));
    expect(parsed.degenerateCount).toBe(0);
  });

  it('above the Manifold limit, every Manifold step after the import uses a simplified copy, said with its error in mm; under it, the solid itself', () => {
    const mesh = heightBlockMesh(small, weld);
    withArena(api, (arena) => {
      const imported = importSolid(arena, mesh, auditEdges(mesh));
      expect(manifoldPathSolid(arena, imported, MeshoptSimplifier)).toEqual({ solid: imported.solid, heavy: false, diagnostics: [], errorMm: 0 });
      expect(manifoldPathSolid(arena, imported, null).solid).toBe(imported.solid);
      // A limit of 4000 and a copy of 2000, as 2 million and 1 million are for a real model.
      const heavy = manifoldPathSolid(arena, imported, MeshoptSimplifier, 4000, 2000);
      expect(heavy.heavy).toBe(true);
      expect(heavy.solid).not.toBe(imported.solid);
      expect(heavy.solid!.numTri()).toBeLessThanOrEqual(2000);
      expect(heavy.solid!.status()).toBe('NoError');
      expect(Math.abs(heavy.solid!.volume() - imported.solid!.volume())).toBeLessThan(imported.solid!.volume() * 0.01);
      expect(heavy.diagnostics).toHaveLength(1);
      expect(heavy.errorMm).toBeGreaterThan(0);
      expect(heavy.diagnostics[0].message).toContain(`with up to ${heavy.errorMm.toFixed(3)} mm of error`);
      expect(heavy.diagnostics[0]).toMatchObject({ code: 'mode-b-simplified', severity: 'warning' });
      expect(heavy.diagnostics[0].message).toMatch(/^This model has 7,920 triangles, too many for the geometry engine, so merged mode, and the pocket in glue mode, use a copy simplified to [\d,]+ triangles, with up to \d+\.\d+(e-\d+)? mm of error\. The cover and model_oriented\.stl come from the whole mesh\.$/);
      // An error under meshoptimizer's float32 resolution reads as exactly 0, which the warning says in words.
      const blind: typeof MeshoptSimplifier = { ...MeshoptSimplifier, simplify: (...args: Parameters<typeof MeshoptSimplifier.simplify>) => [MeshoptSimplifier.simplify(...args)[0], 0] };
      const plain = manifoldPathSolid(arena, imported, blind, 4000, 2000);
      expect(plain.diagnostics[0].message).toMatch(/simplified to [\d,]+ triangles, with less error than the simplifier can measure\./);
      // Soup mode has no solid to simplify.
      expect(manifoldPathSolid(arena, { solid: null, mesh }, MeshoptSimplifier, 4000, 2000)).toEqual({ solid: null, heavy: false, diagnostics: [], errorMm: 0 });
    });
  });
});

describe('a heavy mesh the preview checked, imported again from its copy alone', () => {
  it('stands in for the whole import with the same report, flipped as the import found it, and gives way where it cannot', () => {
    const mesh = heightBlockMesh(small, weld);
    withArena(api, (arena) => {
      const full = importSolid(arena, mesh, auditEdges(mesh));
      const copy = importFromCopy(arena, mesh, full.report, MeshoptSimplifier, 4000, 2000)!;
      expect(copy.report).toBe(full.report);
      expect(copy.mesh).toBe(mesh);
      expect(copy.solid!.numTri()).toBeLessThanOrEqual(2000);
      expect(Math.abs(copy.solid!.volume() - full.solid!.volume())).toBeLessThan(full.solid!.volume() * 0.01);
      expect(copy.simplified[0].code).toBe('mode-b-simplified');
      // Inside out: the import flipped it, so the copy is of the mesh turned the right way, and a solid.
      const outward = inverted(mesh);
      const flipped = importSolid(arena, outward, auditEdges(outward));
      expect(flipped.report.flipped).toBe(true);
      const again = importFromCopy(arena, outward, flipped.report, MeshoptSimplifier, 4000, 2000)!;
      expect(again.mesh.indices).toEqual(flipped.mesh.indices);
      expect(again.solid!.volume()).toBeGreaterThan(0);
      // Under the limit, and for an open mesh, the import runs in full.
      expect(importFromCopy(arena, mesh, full.report, MeshoptSimplifier)).toBeNull();
      expect(importFromCopy(arena, mesh, { ...full.report, route: 'soup' }, MeshoptSimplifier, 4000, 2000)).toBeNull();
      expect(importFromCopy(arena, mesh, { ...full.report, diagnostics: [{ code: 'shell-inverted', severity: 'warning', message: '' }] }, MeshoptSimplifier, 4000, 2000)).toBeNull();
    });
  });
});

describe('3 million triangles in Node', () => {
  it.skipIf(!SOAK)('parse, weld, audit, import, the display proxy and merged mode\'s simplified copy, timed', () => {
    const times: Record<string, number> = {};
    const timed = <T>(name: string, run: () => T): T => {
      const t0 = performance.now();
      const value = run();
      times[name] = Math.round(performance.now() - t0);
      return value;
    };
    const bytes = timed('generate', () => heightBlockStl());
    expect(bytes.length).toBe(84 + 50 * 3_011_040);
    const parsed = timed('parse', () => parseStl(bytes));
    expect(parsed.triangleCount).toBe(3_011_040);
    const welded = timed('weld', () => weld(parsed.positions));
    const audit = timed('audit', () => auditEdges(welded));
    expect(audit).toMatchObject({ openEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 });
    const params = defaultParams();
    const found = timed('candidates', () => findBaseCandidates(welded, baseOptions(params, { min: [0, 0, 0], max: [100, 100, 23] })));
    const [top] = found;
    expect(examinedBins(3_011_040)).toBe(16);
    expect(top.normal).toEqual([0, 0, -1]);
    // The same five candidates as at 400 x 400 cells and 118 bins: the underside, and the four sides tied on area.
    expect(found.map((c) => c.normal.join()).sort()).toEqual(['-1,0,0', '0,-1,0', '0,0,-1', '0,1,0', '1,0,0']);
    timed('orient', () => orientToBase(welded, top, { planeTol: 0.05, soup: false }));
    withArena(api, (arena) => {
      const imported = timed('import', () => importSolid(arena, welded, audit));
      expect(imported.report).toMatchObject({ route: 'manifold', bodies: 1 });
      expect(Math.abs(imported.report.solidVolume - 200_000)).toBeLessThan(200);
      const proxy = timed('display proxy', () => displayProxy(imported.mesh, MeshoptSimplifier));
      expect(proxy!.indices.length / 3).toBeLessThanOrEqual(300_000);
      const heavy = timed('merged copy', () => manifoldPathSolid(arena, imported, MeshoptSimplifier));
      expect(heavy.heavy).toBe(true);
      expect(heavy.solid!.numTri()).toBeLessThanOrEqual(MANIFOLD_TRIANGLE_TARGET);
      expect(heavy.diagnostics[0].code).toBe('mode-b-simplified');
      const error = Number(/up to (\d+\.\d+(e-\d+)?) mm/.exec(heavy.diagnostics[0].message)![1]);
      expect(error).toBeGreaterThan(0);
      // The ripple is 2 mm high over 2 mm, and a copy of a third of its triangles keeps it to hundredths of a mm.
      expect(error).toBeLessThan(0.05);
      const section = timed('pocket section', () => arena.track(imported.solid!.slice(0.2)));
      expect(Math.abs(section.area() - 100 * 100)).toBeLessThan(1);
      console.log(`3M triangles in Node, ms: ${JSON.stringify(times)}; merged copy ${heavy.solid!.numTri()} triangles, error ${error} mm; memory ${JSON.stringify(memory())} MB`);
    });
  }, 900_000);
});
