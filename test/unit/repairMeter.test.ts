import { describe, expect, it } from 'vitest';
import { rebuildSurface } from '../../src/core/mesh/columns';
import { reduceRebuilt } from '../../src/core/mesh/reduce';
import { orientPieces } from '../../src/core/mesh/repair';
import { MESHOPT_BYTES_PER_TRIANGLE } from '../../src/core/mesh/repairImport';
import { finnedBox } from '../fixtures/synthetic';

/**
 * RM, decision G: the memory meter counts meshoptimizer's own heap while a repair reduces its rebuilt surface by an
 * estimate (MESHOPT_BYTES_PER_TRIANGLE a triangle extracted), as the library keeps it and shows it to no array. RM's
 * review found the estimate held to nothing but itself; here it is held to what meshoptimizer's WebAssembly memory
 * grows by in fact, which never shrinks, so its size after the reduction is its peak. The memory is caught as the
 * module makes it, so this file loads the simplifier itself, after the hook, and shares that instance with no other.
 */
const memories: WebAssembly.Memory[] = [];
const instantiate = WebAssembly.instantiate.bind(WebAssembly) as (bytes: BufferSource, imports?: WebAssembly.Imports) => Promise<WebAssembly.WebAssemblyInstantiatedSource>;
WebAssembly.instantiate = (async (bytes: BufferSource, imports?: WebAssembly.Imports) => {
  const result = await instantiate(bytes, imports);
  const memory = result.instance.exports.memory;
  if (memory instanceof WebAssembly.Memory) memories.push(memory);
  return result;
}) as typeof WebAssembly.instantiate;

describe('RM: meshoptimizer\'s heap, as the meter estimates it', () => {
  it('is within a fifth of what its WebAssembly memory grows by, reducing finnedBox rebuilt on a 0.25 mm grid', async () => {
    const { MeshoptSimplifier } = await import('meshoptimizer/simplifier');
    await MeshoptSimplifier.ready;
    expect(memories).toHaveLength(1);
    const memory = memories[0];
    const before = memory.buffer.byteLength;
    const h = 0.25;
    const extracted = rebuildSurface(orientPieces(finnedBox(), true).mesh, h).mesh;
    const triangles = extracted.indices.length / 3;
    // As repairMesh reduces it: an error of an eighth of the cell, vertices locked two cells round a bad triangle.
    const reduced = reduceRebuilt(extracted, MeshoptSimplifier, h / 8, 2 * h, 1_000_000);
    expect(reduced.clean).toBe(true);
    const grown = memory.buffer.byteLength - before;
    const estimate = MESHOPT_BYTES_PER_TRIANGLE * triangles;
    console.log(`meshoptimizer: ${triangles} triangles extracted, its memory grew by ${(grown / 1e6).toFixed(1)} MB (${(grown / triangles).toFixed(1)} B a triangle), estimated ${(estimate / 1e6).toFixed(1)} MB`);
    expect(triangles).toBeGreaterThan(200_000);
    expect(estimate).toBeGreaterThanOrEqual(0.8 * grown);
    expect(estimate).toBeLessThanOrEqual(1.25 * grown);
  }, 120_000);
});
