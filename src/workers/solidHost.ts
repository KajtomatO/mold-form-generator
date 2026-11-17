import type { ManifoldToplevel } from 'manifold-3d';
import { HEAVY_LIMITS, type HeavyLimits, type MeshSimplifier } from '../core/mesh/simplify';
import { runExport } from './exportJob';
import { runPrepareJob } from './prepareJob';
import type { Post } from './fieldHost';
import { StageMiss } from './fieldStages';
import { usedHeap } from './heapProbe';
import { applyDelay, buffersOf, injectedCrash, isInlineError, type ToWorker } from './protocol';
import { SolidStages, type SolidOutputs } from './solidStages';
import { Arena, withArena } from '../core/solid/arena';
import { arrayBytes, figureOrNone, type WorkerMemory } from '../app/memory';

/** The meshes are fresh copies out of WASM, so they go as they are. Only the import's mesh is held here. */
function wire(outputs: SolidOutputs): { outputs: SolidOutputs; transfer: ArrayBuffer[] } {
  const out: SolidOutputs = { ...outputs };
  const arrays: (ArrayBufferView | undefined)[] = [];
  if (outputs.S1?.import.mesh) {
    const mesh = { positions: outputs.S1.import.mesh.positions.slice(), indices: outputs.S1.import.mesh.indices.slice() };
    out.S1 = { ...outputs.S1, import: { ...outputs.S1.import, mesh } };
    arrays.push(mesh.positions, mesh.indices);
  }
  // The proxy is made for this message and kept nowhere, so it goes as it is.
  arrays.push(outputs.S1?.display?.positions, outputs.S1?.display?.indices);
  for (const part of [outputs.S13, outputs.S15, outputs.S16]) arrays.push(part?.positions, part?.indices);
  return { outputs: out, transfer: buffersOf(...arrays) };
}

/**
 * What a solid worker holds, for the memory meter (MM1): its WebAssembly heap, Manifold's, at its full size,
 * and the arrays it keeps outside it, with `extra`, such as an export's inputs while it runs. The heap's own
 * buffer is seeded as seen, so a view into it never counts twice. meshoptimizer keeps a small heap of its
 * own, which it does not expose, so that is not counted.
 */
export function solidMemory(heap: ArrayBuffer | null, held: unknown[]): WorkerMemory {
  return { wasm: heap?.byteLength ?? 0, arrays: arrayBytes(held, new Set<ArrayBufferLike>(heap ? [heap] : [])) };
}

/** A worker's own way to read a file it is handed, at once: FileReaderSync in a browser (MM2). */
export type ReadBlob = (blob: Blob) => Uint8Array;

const noReader: ReadBlob = () => {
  throw new Error('This worker cannot read files.');
};

/**
 * solid.worker's message handler, apart from `self` and the WASM boot, so a Node test can drive the same code.
 * `heap` is the WebAssembly memory's buffer as it stands, or null where the glue hides it. `readBlob` reads the
 * maker's own file, for a prepare job and for an export's model_oriented.stl of a simplified model (MM2).
 */
export function solidHost(api: ManifoldToplevel, simplifier: MeshSimplifier, heap: () => ArrayBuffer | null, post: Post, now: () => number, limits: HeavyLimits = HEAVY_LIMITS, readBlob: ReadBlob = noReader): (message: ToWorker) => void {
  const stages = new SolidStages(api, now, simplifier, limits);
  const heapBytes = (): number | null => heap()?.byteLength ?? null;
  const memory = (extra: unknown[] = []): WorkerMemory | undefined => figureOrNone(() => solidMemory(heap(), [...stages.heldArrays(), ...extra]));
  return (message) => {
    if (message.t === 'heap') {
      post({ t: 'heap', id: message.id, capacity: heapBytes(), used: usedHeap(api, heapBytes), held: stages.heldEntries(), handles: Arena.live });
      return;
    }
    if (message.t !== 'solid' && message.t !== 'export' && message.t !== 'prepare') return;
    const { id } = message;
    const timings: Record<string, number> = {};
    try {
      injectedCrash(message.fault);
      applyDelay(message.fault, now);
      if (message.t === 'prepare') {
        // MM2: what it holds as each step begins, for the memory meter's 'simplify', as an export's does. RM: a
        // repair's arrays grow inside its steps, so it asks for a reading each time they do, under the same step,
        // with meshoptimizer's own heap, which no array shows, as estimated.
        const holding: unknown[] = [];
        let last = { step: 'read', done: 0, total: 1 };
        let extra = 0;
        const figure = (): WorkerMemory | undefined => {
          const held = memory([holding]);
          return held ? { wasm: held.wasm, arrays: held.arrays + extra } : held;
        };
        const progress = (step: string, done: number, total: number): void => {
          last = { step, done, total };
          post({ t: 'progress', id, step, done, total, memory: figure() });
          applyDelay(message.fault, now, step);
        };
        const meter = { held: () => post({ t: 'progress', id, ...last, memory: figure() }), extra: (bytes: number) => void (extra = bytes) };
        const prepared = runPrepareJob(api, simplifier, message, readBlob, progress, now, holding, meter);
        post({ t: 'prepared', id, ...prepared }, buffersOf(prepared.stl, prepared.outside?.positions, prepared.outside?.indices));
        return;
      }
      if (message.t === 'export') {
        // MM1: its inputs, and what it has built so far, which it adds to as it goes.
        const holding: unknown[] = [];
        const progress = (step: string, done: number, total: number): void => {
          post({ t: 'progress', id, step, done, total, memory: memory([message, holding]) });
          applyDelay(message.fault, now, step);
        };
        const outputs = runExport(api, simplifier, message, progress, now, timings, limits, holding, readBlob);
        post({ t: 'exported', id, outputs, timings }, buffersOf(outputs.zip, ...Object.values(outputs.files)));
        return;
      }
      const sent = wire(stages.run(message.keys, message.want, message.params, message.inputs, timings));
      if (message.fault?.kind === 'leak') {
        const points = message.fault.points;
        // Released from its arena and never deleted: a forgotten handle, as a real leak would be.
        withArena(api, (arena) => arena.release(arena.crossSection([Array.from({ length: points }, (_, k): [number, number] => [10 * Math.cos((2 * Math.PI * k) / points), 10 * Math.sin((2 * Math.PI * k) / points)])])));
      }
      post({ t: 'result', id, outputs: sent.outputs, cached: stages.cached(), heapBytes: heapBytes(), timings, memory: memory() }, sent.transfer);
    } catch (error) {
      if (error instanceof StageMiss) {
        post({ t: 'miss', id, stage: error.stage, cached: stages.cached(), memory: memory() });
        return;
      }
      const e = error instanceof Error ? error : new Error(String(error));
      // A crash may have left the cache half replaced, so main must not trust it: this worker is about to go.
      post({ t: 'error', id, name: e.name, message: e.message, inline: isInlineError(e), cached: isInlineError(e) ? stages.cached() : {}, memory: memory() });
    }
  };
}
