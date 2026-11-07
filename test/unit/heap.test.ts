import type { CrossSection } from 'manifold-3d';
import { expect, it } from 'vitest';
import { findBaseCandidates } from '../../src/core/base/candidates';
import { buildFootprint } from '../../src/core/base/footprint';
import { orientSolid, orientToBase, trimToBase } from '../../src/core/base/orient';
import { auditEdges } from '../../src/core/mesh/audit';
import { importSolid } from '../../src/core/mesh/shells';
import { Arena, withArena } from '../../src/core/solid/arena';
import { loadMeasuredManifold, PROBE_BYTES, type MeasuredManifold } from '../fixtures/heap';
import { loadExample } from '../fixtures/loadExamples';
import { box, seamBox, withoutTriangles } from '../fixtures/synthetic';

const RUNS = 50;
const WARM_UP = 10;
const KB = 1024;
const MB = 1e6;
// Twice the reading's floor of one probe block. A clean build measures 0.
const FLAT_LIMIT = 2 * PROBE_BYTES;
// The repair routes each lose a failed `new Manifold` handle, about 600 bytes, where the arena
// cannot reach it. Measured over 50 runs: 256 KB, more than the bytes lost because they also
// fragment free blocks. It is the disposable worker that absorbs this.
const REPAIR_LIMIT = 384 * KB;

const goddess = loadExample('goddess');
const openMesh = withoutTriangles(box([0, 0, 0], [20, 20, 10]), [0]);
const openAudit = auditEdges(openMesh);
const seamMesh = seamBox();
const seamAudit = auditEdges(seamMesh);

/** One run of the M1 build: import, candidates, orient, trim and footprint. */
function build(arena: Arena): CrossSection {
  const imported = importSolid(arena, goddess.welded, goddess.audit);
  const [top] = findBaseCandidates(imported.mesh, goddess.options);
  const oriented = orientToBase(imported.mesh, top, { planeTol: goddess.options.planeTol, soup: false });
  const trimmed = trimToBase(arena, orientSolid(arena, imported.solid!, oriented.transform));
  const cap = arena.track(trimmed.slice(0.02));
  buildFootprint(arena, oriented.mesh, top, goddess.options.minIsland, cap);
  return cap;
}

/** Growth of used memory over the runs, after a warm-up lets the allocator reach its working size. */
function growth({ api, used }: MeasuredManifold, run: (arena: Arena) => void): number {
  for (let i = 0; i < WARM_UP; i++) withArena(api, run);
  const before = used();
  for (let i = 0; i < RUNS; i++) withArena(api, run);
  return used() - before;
}

// The capacity reading used before this one sees none of the small leaks below. It moves in steps
// of several MB, so a forgotten CrossSection reads as exactly 0. Used memory has a floor of one
// probe block, and the test below shows a real leak well above that floor.
it(`one builder run ${RUNS} times shows a flat heap, read to ${PROBE_BYTES / KB} KB`, async () => {
  const grown = growth(await loadMeasuredManifold(), build);
  console.log(`flat-heap: ${(grown / KB).toFixed(0)} KB growth over ${RUNS} runs, floor ${PROBE_BYTES / KB} KB`);
  expect(grown).toBeLessThan(FLAT_LIMIT);
});

it('the soup and merged repair routes grow only by what the library loses on each failed attempt', async () => {
  const grown = growth(await loadMeasuredManifold(), (arena) => {
    build(arena);
    importSolid(arena, openMesh, openAudit);
    importSolid(arena, seamMesh, seamAudit);
  });
  console.log(`repair routes: ${(grown / KB).toFixed(0)} KB growth over ${RUNS} runs`);
  expect(grown).toBeLessThan(REPAIR_LIMIT);
});

it('negative control: a leak of one small real CrossSection per run is above the limit', async () => {
  const grown = growth(await loadMeasuredManifold(), (arena) => {
    arena.release(build(arena));
  });
  console.log(`small leak control: ${(grown / KB).toFixed(0)} KB growth over ${RUNS} runs`);
  expect(grown).toBeGreaterThan(FLAT_LIMIT);
  // Near the floor, to show what the reading can resolve: this is no whole solid per run.
  expect(grown).toBeLessThan(1 * MB);
});

it('negative control: keeping one solid per run shows up clearly, in used memory and capacity', async () => {
  const measured = await loadMeasuredManifold();
  const { api, capacity } = measured;
  const before = capacity();
  const grown = growth(measured, (arena) => {
    build(arena);
    arena.release(arena.track(api.Manifold.sphere(20, 128)));
  });
  console.log(`leak control: ${(grown / MB).toFixed(2)} MB growth over ${RUNS} runs`);
  expect(grown).toBeGreaterThan(20 * MB);
  expect(capacity()).toBeGreaterThan(before + 20 * MB);
});

it('negative control: the footprint leaks without the arena plugging the polygon glue', async () => {
  const measured = await loadMeasuredManifold();
  const { api } = measured;
  const [top] = findBaseCandidates(goddess.welded, goddess.options);
  const oriented = orientToBase(goddess.welded, top, { planeTol: goddess.options.planeTol, soup: false });
  // One triangle per contour, read back: the same calls the footprint makes, but straight to the API.
  const { positions: p, indices } = oriented.mesh;
  const contours = Array.from(top.members, (t) => [0, 1, 2].map((c): [number, number] => [p[indices[t * 3 + c] * 3], p[indices[t * 3 + c] * 3 + 1]]));
  const grown = growth(measured, (arena) => {
    const section = arena.track(api.CrossSection.ofPolygons(contours, 'Positive'));
    section.toPolygons();
  });
  console.log(`glue control: ${(grown / KB).toFixed(0)} KB growth over ${RUNS} runs`);
  expect(grown).toBeGreaterThan(FLAT_LIMIT);
});
