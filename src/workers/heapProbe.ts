import type { ManifoldToplevel } from 'manifold-3d';

/** Size of each probe block: the smallest change in used memory the reading can show. */
export const PROBE_BYTES = 64 * 1024;

interface Probe {
  Vector_vec2: new () => { resize(count: number, value: { x: number; y: number }): void; delete(): void };
}

/**
 * Memory in use in the WASM heap: its capacity minus what can still be allocated before it has to
 * grow. Capacity alone only ever grows, in big steps, so it hides a leak until it is large. Each
 * reading grows the heap by one step, so a soak reads this once after its warm-up and once at the end.
 */
export function usedHeap(api: ManifoldToplevel, capacity: () => number | null): number | null {
  const before = capacity();
  if (before === null) return null;
  const { Vector_vec2 } = api as unknown as Probe;
  const blocks: { delete(): void }[] = [];
  while (capacity() === before) {
    const block = new Vector_vec2();
    block.resize(PROBE_BYTES / 16, { x: 0, y: 0 });
    blocks.push(block);
  }
  blocks.forEach((block) => block.delete());
  // The last block is the one that did not fit.
  return before - (blocks.length - 1) * PROBE_BYTES;
}
