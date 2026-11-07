import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Module, { type ManifoldToplevel } from 'manifold-3d';

const wasmPath = join(import.meta.dirname, '..', '..', 'node_modules', 'manifold-3d', 'manifold.wasm');

/** Size of each probe block: the smallest change in used memory the reading can show. */
export const PROBE_BYTES = 64 * 1024;

interface Probe {
  Vector_vec2: new () => { resize(count: number, value: { x: number; y: number }): void; delete(): void };
}

export interface MeasuredManifold {
  api: ManifoldToplevel;
  /** What WASM has asked the system for. It only grows, and in big steps, so it hides small leaks. */
  capacity(): number;
  /**
   * Memory in use: the capacity minus the free memory found by allocating blocks until the
   * capacity has to grow. The blocks are freed again, but each reading grows the capacity by a
   * step, so call this before and after a run, not in a loop. Free holes smaller than a block
   * count as used, which puts the reading's noise at about one block.
   */
  used(): number;
}

/** A fresh WASM instance with its memory object in hand, loaded the way bootManifold does it. */
export async function loadMeasuredManifold(): Promise<MeasuredManifold> {
  let memory: WebAssembly.Memory | null = null;
  const config = {
    instantiateWasm(imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void): object {
      WebAssembly.instantiate(readFileSync(wasmPath), imports).then(({ instance, module }) => {
        memory = Object.values(instance.exports).find((v) => v instanceof WebAssembly.Memory) as WebAssembly.Memory;
        done(instance, module);
      });
      return {};
    },
  };
  const api = await Module(config as unknown as Parameters<typeof Module>[0]);
  api.setup();
  const capacity = (): number => memory!.buffer.byteLength;
  const used = (): number => {
    const { Vector_vec2 } = api as unknown as Probe;
    const before = capacity();
    const blocks: { delete(): void }[] = [];
    while (capacity() === before) {
      const block = new Vector_vec2();
      block.resize(PROBE_BYTES / 16, { x: 0, y: 0 });
      blocks.push(block);
    }
    blocks.forEach((block) => block.delete());
    // The last block is the one that did not fit.
    return before - (blocks.length - 1) * PROBE_BYTES;
  };
  return { api, capacity, used };
}
