import type { ManifoldToplevel } from 'manifold-3d';
import type { MeshSimplifier } from '../core/mesh/simplify';
import { runExport } from './exportJob';
import type { Post } from './fieldHost';
import { StageMiss } from './fieldStages';
import { usedHeap } from './heapProbe';
import { applyDelay, buffersOf, injectedCrash, isInlineError, type ToWorker } from './protocol';
import { SolidStages, type SolidOutputs } from './solidStages';
import { withArena } from '../core/solid/arena';

/** The meshes are fresh copies out of WASM, so they go as they are. Only the import's mesh is held here. */
function wire(outputs: SolidOutputs): { outputs: SolidOutputs; transfer: ArrayBuffer[] } {
  const out: SolidOutputs = { ...outputs };
  const arrays: (ArrayBufferView | undefined)[] = [];
  if (outputs.S1?.import.mesh) {
    const mesh = { positions: outputs.S1.import.mesh.positions.slice(), indices: outputs.S1.import.mesh.indices.slice() };
    out.S1 = { ...outputs.S1, import: { ...outputs.S1.import, mesh } };
    arrays.push(mesh.positions, mesh.indices);
  }
  for (const part of [outputs.S13, outputs.S15, outputs.S16]) arrays.push(part?.positions, part?.indices);
  return { outputs: out, transfer: buffersOf(...arrays) };
}

/** solid.worker's message handler, apart from `self` and the WASM boot, so a Node test can drive the same code. */
export function solidHost(api: ManifoldToplevel, simplifier: MeshSimplifier, heapBytes: () => number | null, post: Post, now: () => number): (message: ToWorker) => void {
  const stages = new SolidStages(api, now);
  return (message) => {
    if (message.t === 'heap') {
      post({ t: 'heap', id: message.id, capacity: heapBytes(), used: usedHeap(api, heapBytes), held: stages.heldEntries() });
      return;
    }
    if (message.t !== 'solid' && message.t !== 'export') return;
    const { id } = message;
    const timings: Record<string, number> = {};
    try {
      injectedCrash(message.fault);
      applyDelay(message.fault, now);
      if (message.t === 'export') {
        const progress = (step: string, done: number, total: number): void => post({ t: 'progress', id, step, done, total });
        const outputs = runExport(api, simplifier, message.params, message.inputs, progress, now, timings, message.cellScale);
        post({ t: 'exported', id, outputs, timings }, buffersOf(outputs.zip, ...Object.values(outputs.files)));
        return;
      }
      const sent = wire(stages.run(message.keys, message.want, message.params, message.inputs, timings));
      if (message.fault?.kind === 'leak') {
        const points = message.fault.points;
        // Released from its arena and never deleted: a forgotten handle, as a real leak would be.
        withArena(api, (arena) => arena.release(arena.crossSection([Array.from({ length: points }, (_, k): [number, number] => [10 * Math.cos((2 * Math.PI * k) / points), 10 * Math.sin((2 * Math.PI * k) / points)])])));
      }
      post({ t: 'result', id, outputs: sent.outputs, cached: stages.cached(), heapBytes: heapBytes(), timings }, sent.transfer);
    } catch (error) {
      if (error instanceof StageMiss) {
        post({ t: 'miss', id, stage: error.stage, cached: stages.cached() });
        return;
      }
      const e = error instanceof Error ? error : new Error(String(error));
      // A crash may have left the cache half replaced, so main must not trust it: this worker is about to go.
      post({ t: 'error', id, name: e.name, message: e.message, inline: isInlineError(e), cached: isInlineError(e) ? stages.cached() : {} });
    }
  };
}
