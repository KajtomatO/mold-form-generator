import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ManifoldToplevel } from 'manifold-3d';
import { MeshoptSimplifier } from 'meshoptimizer';
import { beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../../src/app/hash';
import { SIMPLIFY_MAX_ERROR_MM } from '../../src/app/largeModel';
import { auditEdges } from '../../src/core/mesh/audit';
import { BOUND_SLACK_MM, maxDeviation, pointTriangleDistance2, surfaceSamples } from '../../src/core/mesh/deviation';
import { importSolid } from '../../src/core/mesh/shells';
import { simplifyModel, type MeshSimplifier } from '../../src/core/mesh/simplify';
import { weld, type WeldedMesh } from '../../src/core/mesh/weld';
import { withArena } from '../../src/core/solid/arena';
import { parseStl } from '../../src/core/stl/parse';
import { writeBinaryStl } from '../../src/core/stl/write';
import { runPrepareJob, type PrepareStep } from '../../src/workers/prepareJob';
import { HEAVY_BLOCK, heightBlockSoup, heightBlockStl } from '../fixtures/heavy';
import { exampleBytes, loadExample, loadManifold } from '../fixtures/loadExamples';

let api: ManifoldToplevel;
beforeAll(async () => {
  api = await loadManifold();
  await MeshoptSimplifier.ready;
});

/** What the copies come to, pinned: the same mesh, count and bound always give the same copy. */
const GODDESS_COPY = 15_548, BARRICADE_COPY = 42_442, BENCHY_PROVED = 0.0367075;

const stlSha = (mesh: WeldedMesh): string => createHash('sha256').update(writeBinaryStl(mesh.positions, mesh.indices)).digest('hex');

/** The largest distance from the model's every vertex, centroid and edge midpoint to the copy, by brute force. */
function bruteError(model: WeldedMesh, copy: WeldedMesh): { max: number; atMidpoints: number } {
  const { points, centroids } = surfaceSamples(model);
  const all = [model.positions, points];
  const P = copy.positions, I = copy.indices;
  let max = 0, atMidpoints = 0;
  all.forEach((list, k) => {
    for (let p = 0; p < list.length / 3; p++) {
      let best = Infinity;
      for (let t = 0; t < I.length / 3 && best > 0; t++) best = Math.min(best, pointTriangleDistance2(list[p * 3], list[p * 3 + 1], list[p * 3 + 2], P, I[t * 3] * 3, I[t * 3 + 1] * 3, I[t * 3 + 2] * 3));
      const d = Math.sqrt(best);
      max = Math.max(max, d);
      if (k === 1 && p >= centroids) atMidpoints = Math.max(atMidpoints, d);
    }
  });
  return { max, atMidpoints };
}

/**
 * The largest distance from a grid of `steps` x `steps` barycentric points on each of the model's triangles to the
 * copy: points of the surface, so never above what the copy proves, and within the grid's step of the truth.
 */
function denseError(model: WeldedMesh, copy: WeldedMesh, steps: number): number {
  const P = model.positions, I = model.indices, T = I.length / 3;
  const points = new Float32Array(T * (((steps + 1) * (steps + 2)) / 2) * 3);
  let o = 0;
  for (let t = 0; t < T; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; i + j <= steps; j++) {
        const u = i / steps, v = j / steps, w = 1 - u - v;
        for (let d = 0; d < 3; d++) points[o++] = u * P[a + d] + v * P[b + d] + w * P[c + d];
      }
    }
  }
  return maxDeviation(copy, [points], 0.25);
}

/** The 3 million triangle test block's ripple, at its own cell of 0.08 mm, on a small top: where meshoptimizer's figure falls short. */
const rippled = (n: number): WeldedMesh => weld(heightBlockSoup({ ...HEAVY_BLOCK, n, size: (n * HEAVY_BLOCK.size) / HEAVY_BLOCK.n }));

describe('MM2: the simplified copy of a large model (simplifyModel)', () => {
  it('Benchy to 50,000: under the target, proved within 0.05 mm, still a solid Manifold takes, its volume kept, and the same bytes every time', () => {
    const { welded } = loadExample('benchy');
    const first = simplifyModel(welded, MeshoptSimplifier, 50_000, SIMPLIFY_MAX_ERROR_MM);
    const triangles = first.mesh.indices.length / 3;
    expect(triangles).toBe(49_998);
    expect(first).toMatchObject({ stoppedBy: 'target', rounds: 1 });
    expect(first.errorMm).toBeLessThanOrEqual(SIMPLIFY_MAX_ERROR_MM);
    // meshoptimizer's own figure is 5 times under what the surface moved: it is not a bound (docs/PLAN.md, MM2).
    expect(first.reportedMm * 3).toBeLessThan(first.errorMm);
    // The copy's vertices are the model's own, unmoved.
    const own = new Set<string>();
    for (let v = 0; v < welded.positions.length; v += 3) own.add(`${welded.positions[v]},${welded.positions[v + 1]},${welded.positions[v + 2]}`);
    for (let v = 0; v < first.mesh.positions.length; v += 3) expect(own.has(`${first.mesh.positions[v]},${first.mesh.positions[v + 1]},${first.mesh.positions[v + 2]}`)).toBe(true);
    withArena(api, (arena) => {
      const model = importSolid(arena, welded, auditEdges(welded));
      const copy = importSolid(arena, first.mesh, auditEdges(first.mesh));
      expect(copy.report.route).toBe('manifold');
      expect(Math.abs(copy.solid!.volume() / model.solid!.volume() - 1)).toBeLessThan(0.005);
    });
    // MM2's design measured this hash in Node; the browsers give it too (e2e/large.spec.ts).
    expect(stlSha(first.mesh)).toBe('995c7b1010ce703f82660a64ccf8d3e6f10fbe2c4a3cc51b4a1ebf3748929b71');
    expect(stlSha(simplifyModel(welded, MeshoptSimplifier, 50_000, SIMPLIFY_MAX_ERROR_MM).mesh)).toBe(stlSha(first.mesh));
  });

  it('the bound holds where meshoptimizer\'s figure does not: on the test block\'s ripple, round 1 leaves points past 0.05 mm, and the rounds after it lock them in', () => {
    const model = rippled(40);
    const rounds: number[] = [];
    const copy = simplifyModel(model, MeshoptSimplifier, 552, SIMPLIFY_MAX_ERROR_MM, (round, step) => step === 'check' && rounds.push(round));
    expect(copy.rounds).toBeGreaterThan(1);
    expect(rounds).toEqual(Array.from({ length: copy.rounds }, (_, k) => k + 1));
    // The figure the copy records is a bound: never under the surface's points, dense or sampled, and close to them.
    const measured = bruteError(model, copy.mesh), dense = denseError(model, copy.mesh, 16);
    expect(copy.errorMm).toBeLessThanOrEqual(SIMPLIFY_MAX_ERROR_MM);
    expect(Math.max(measured.max, dense)).toBeLessThanOrEqual(copy.errorMm);
    expect(copy.errorMm - Math.max(measured.max, dense)).toBeLessThan(BOUND_SLACK_MM + 0.002);
    expect(copy.reportedMm).toBeLessThan(measured.max);
    // One round alone, as meshoptimizer would give it, leaves the surface past the bound.
    const once = MeshoptSimplifier.simplifyWithAttributes(model.indices, model.positions, 3, new Float32Array(0), 0, [], null, 552 * 3, SIMPLIFY_MAX_ERROR_MM, ['ErrorAbsolute', 'LockBorder']);
    const plain = { positions: model.positions, indices: once[0] };
    expect(bruteError(model, plain).max).toBeGreaterThan(SIMPLIFY_MAX_ERROR_MM);
    expect(once[1]).toBeLessThan(SIMPLIFY_MAX_ERROR_MM);
  });

  it('the surface between the samples is held too: Goddess Statue to 12,000, which at its vertices, centroids and edge midpoints alone lay 0.068 mm off between them, is proved within 0.05 mm everywhere', () => {
    const { welded } = loadExample('goddess');
    const copy = simplifyModel(welded, MeshoptSimplifier, 12_000, SIMPLIFY_MAX_ERROR_MM);
    const dense = denseError(welded, copy.mesh, 8);
    expect(copy.errorMm).toBeLessThanOrEqual(SIMPLIFY_MAX_ERROR_MM);
    expect(dense).toBeLessThanOrEqual(copy.errorMm);
    expect(copy.mesh.indices.length / 3).toBe(GODDESS_COPY);
    expect(copy).toMatchObject({ stoppedBy: 'error' });
  });

  it('war-barricade to 10,000: the sliver the samples could not lock is proved and locked, so the copy keeps to 0.05 mm, keeping more triangles to do so', () => {
    const bytes = new Uint8Array(readFileSync(join(import.meta.dirname, '..', '..', 'examples', 'war-barricade.stl')));
    const model = weld(parseStl(bytes).positions);
    const copy = simplifyModel(model, MeshoptSimplifier, 10_000, SIMPLIFY_MAX_ERROR_MM);
    expect(copy.mesh.indices.length / 3).toBe(BARRICADE_COPY);
    expect(copy.stoppedBy).toBe('error');
    expect(copy.errorMm).toBeLessThanOrEqual(SIMPLIFY_MAX_ERROR_MM);
    expect(denseError(model, copy.mesh, 6)).toBeLessThanOrEqual(copy.errorMm);
  });

  it('where the loop cannot keep to the bound, the copy records the figure proved, which is never under the surface\'s', () => {
    const model = rippled(40);
    // One round only: what it leaves past the bound is measured, not taken as the bound.
    const capped: MeshSimplifier = { ...MeshoptSimplifier, simplifyWithAttributes: (indices, positions, stride, attributes, attributeStride, weights, _lock, target, error, flags) => MeshoptSimplifier.simplifyWithAttributes(indices, positions, stride, attributes, attributeStride, weights, null, target, error, flags) };
    const copy = simplifyModel(model, capped, 552, SIMPLIFY_MAX_ERROR_MM);
    const dense = denseError(model, copy.mesh, 16);
    expect(copy.errorMm).toBeGreaterThan(SIMPLIFY_MAX_ERROR_MM);
    expect(dense).toBeLessThanOrEqual(copy.errorMm);
    expect(copy.errorMm - dense).toBeLessThan(BOUND_SLACK_MM + 0.002);
  });

  it('CFG_FULL: the 1 million triangle test block to 300,000 meets the bound at every edge midpoint too, keeping more triangles to do so', (ctx) => {
    ctx.skip(process.env.CFG_FULL !== '1', 'a 1 million triangle block takes about 20 s: CFG_FULL=1 runs it');
    const model = weld(parseStl(heightBlockStl({ ...HEAVY_BLOCK, n: 704 })).positions);
    const copy = simplifyModel(model, MeshoptSimplifier, 300_000, SIMPLIFY_MAX_ERROR_MM);
    expect(copy.errorMm).toBeLessThanOrEqual(SIMPLIFY_MAX_ERROR_MM);
    expect(copy.stoppedBy).toBe('error');
    expect(copy.mesh.indices.length / 3).toBeGreaterThan(300_000);
  }, 120_000);
});

describe('MM2: the prepare job (runPrepareJob)', () => {
  const read = (bytes: Uint8Array) => (): Uint8Array => bytes;

  it('reads, hashes, parses and welds the file, and answers with the copy\'s STL, the file\'s facts and the copy\'s record', () => {
    const bytes = exampleBytes('benchy');
    const steps: PrepareStep[] = [];
    const holding: unknown[] = [];
    const prepared = runPrepareJob(api, MeshoptSimplifier, { source: { kind: 'stl', blob: new Blob([bytes as BlobPart]) }, name: '3dbenchy.stl', simplify: { target: 50_000, maxErrorMm: 0.05 } }, read(bytes), (step) => steps.push(step), () => performance.now(), holding);
    expect(steps).toEqual(['read', 'parse', 'simplify', 'measure', 'check', 'write']);
    const parsed = parseStl(bytes);
    expect(prepared.from).toEqual({ name: '3dbenchy.stl', bytes: bytes.length, sha256: sha256(bytes), format: 'binary', trianglesInFile: parsed.rawTriangleCount, triangles: 225_154 });
    expect(prepared.record).toMatchObject({ triangles: 49_998, target: 50_000, maxErrorMm: 0.05, stoppedBy: 'target', sha256: sha256(prepared.stl) });
    // Proved within 0.0005 mm of the largest distance found, 0.0362 mm (MM2's review).
    expect(prepared.record!.errorMm).toBeCloseTo(BENCHY_PROVED, 6);
    expect(createHash('sha256').update(prepared.stl).digest('hex')).toBe('995c7b1010ce703f82660a64ccf8d3e6f10fbe2c4a3cc51b4a1ebf3748929b71');
    // The STL parses and welds back to the copy.
    expect(weld(parseStl(prepared.stl).positions).indices.length / 3).toBe(49_998);
    // Its one slot of `holding` holds the STL at the end, and nothing it let go.
    expect(holding).toEqual([prepared.stl]);
  });

  it('a .moldproj source takes its model.stl, and an STL that cannot be read gives readStl\'s words', async () => {
    const { packProject } = await import('../../src/app/projectArchive');
    const stl = exampleBytes('jersey');
    const pack = packProject('{}', stl);
    const prepared = runPrepareJob(api, MeshoptSimplifier, { source: { kind: 'moldproj', blob: new Blob([pack as BlobPart]) }, name: 'jersey-barrier.stl', simplify: { target: 500, maxErrorMm: 0.05 } }, read(pack), () => {}, () => performance.now());
    expect(prepared.from.sha256).toBe(sha256(stl));
    const junk = new TextEncoder().encode('solid x\n facet normal 0 0 1\n  outer loop\n   vertex 1 2\n');
    expect(() => runPrepareJob(api, MeshoptSimplifier, { source: { kind: 'stl', blob: new Blob([junk as BlobPart]) }, name: 'bad.stl', simplify: { target: 500, maxErrorMm: 0.05 } }, read(junk), () => {}, () => performance.now())).toThrow(/^bad\.stl cannot be opened: .*Export the STL again/);
    expect(() => runPrepareJob(api, MeshoptSimplifier, { source: { kind: 'stl', blob: new Blob([]) }, name: 'gone.stl', simplify: { target: 500, maxErrorMm: 0.05 } }, () => { throw new Error('NotFoundError'); }, () => {}, () => performance.now())).toThrow(/gone\.stl could not be read again/);
  });

  it('a copy that would open holes in a closed model is refused in words, where one with more non-manifold edges that Manifold still takes is not', () => {
    const bytes = exampleBytes('jersey');
    // A simplifier that drops one triangle of what it gives, as a broken one would.
    const holed: MeshSimplifier = { ...MeshoptSimplifier, simplifyWithAttributes: (...args) => {
      const [indices, error] = MeshoptSimplifier.simplifyWithAttributes(...args);
      return [indices.slice(3), error];
    } };
    expect(() => runPrepareJob(api, holed, { source: { kind: 'stl', blob: new Blob([bytes as BlobPart]) }, name: 'jersey-barrier.stl', simplify: { target: 500, maxErrorMm: 0.05 } }, read(bytes), () => {}, () => performance.now())).toThrow('Simplifying jersey-barrier.stl would open holes in it, so it was not simplified. Load it anyway, or simplify it in the program that made it.');
    // Benchy's copy has non-manifold edges its file has not, which Manifold pairs up: no reason to refuse it.
    const { welded, audit } = loadExample('benchy');
    const copy = simplifyModel(welded, MeshoptSimplifier, 50_000, 0.05).mesh;
    expect(audit.nonManifoldEdges).toBe(0);
    expect(auditEdges(copy).nonManifoldEdges).toBeGreaterThan(0);
    expect(withArena(api, (arena) => importSolid(arena, copy, auditEdges(copy)).report.route)).toBe('manifold');
  });

  it('a model at or under the count asked for has nothing to simplify, said in words', () => {
    const bytes = exampleBytes('jersey');
    const triangles = parseStl(bytes).triangleCount;
    const job = (target: number) => (): unknown => runPrepareJob(api, MeshoptSimplifier, { source: { kind: 'stl', blob: new Blob([bytes as BlobPart]) }, name: 'j.stl', simplify: { target, maxErrorMm: 0.05 } }, read(bytes), () => {}, () => performance.now());
    const n = triangles.toLocaleString('en-US');
    expect(job(triangles)).toThrow(`j.stl has ${n} triangles, no more than the ${n} asked for, so there is nothing to simplify.`);
    expect(job(triangles - 100)).not.toThrow();
  });
});
