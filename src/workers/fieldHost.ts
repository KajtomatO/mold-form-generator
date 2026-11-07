import type { OrientedModel } from '../core/base/orient';
import { FieldStages, StageMiss, type CandidateSummary, type FieldOutput, type FieldOutputs, type ParsedModel, type PlacementOutput } from './fieldStages';
import { applyDelay, buffersOf, injectedCrash, isInlineError, type FromWorker, type ToWorker } from './protocol';
import type { BaseCandidate } from '../core/base/candidates';
import type { Bounds } from '../core/mesh/weld';
import type { Diagnostic } from '../core/report/diagnostics';
import { checkWalls } from './wallCheck';

export type Post = (message: FromWorker, transfer?: Transferable[]) => void;

/** S2 as main gets it: no oriented mesh, which main has no use for and which is the size of the model. */
export interface OrientedWire {
  candidates: CandidateSummary[];
  chosen: BaseCandidate;
  oriented: Omit<OrientedModel, 'mesh'>;
  bounds: Bounds;
  planeTol: number;
  modelVolume: number;
  diagnostics: Diagnostic[];
}

export interface FieldWire {
  S1?: ParsedModel;
  S2?: OrientedWire;
  S6?: FieldOutput;
  S7?: PlacementOutput;
}

/**
 * What field.worker sends. The arrays it keeps for later jobs are copied first, as a transfer detaches
 * what it sends, and nothing large is cloned: every big array goes in the transfer list.
 */
function wire(outputs: FieldOutputs): { outputs: FieldWire; transfer: ArrayBuffer[] } {
  const out: FieldWire = {};
  const arrays: ArrayBufferView[] = [];
  if (outputs.S1) {
    const welded = { positions: outputs.S1.welded.positions.slice(), indices: outputs.S1.welded.indices.slice() };
    out.S1 = { ...outputs.S1, welded };
    arrays.push(welded.positions, welded.indices);
  }
  if (outputs.S2) {
    const { oriented, chosen, candidates, ...rest } = outputs.S2;
    const { mesh: _mesh, ...orientedRest } = oriented;
    const members = chosen.members.slice();
    const listed = candidates.map((c) => ({ ...c, members: c.members.slice() }));
    out.S2 = { ...rest, candidates: listed, chosen: { ...chosen, members }, oriented: orientedRest };
    arrays.push(members, ...listed.map((c) => c.members));
  }
  if (outputs.S6) {
    const values = outputs.S6.field.values.slice();
    out.S6 = { ...outputs.S6, field: { ...outputs.S6.field, values } };
    arrays.push(values);
  }
  if (outputs.S7) {
    const clearance = outputs.S7.clearance.slice();
    out.S7 = { ...outputs.S7, clearance };
    arrays.push(clearance);
  }
  return { outputs: out, transfer: buffersOf(...arrays) };
}

/** field.worker's message handler, apart from `self`, so a Node test can drive the very same code. */
export function fieldHost(post: Post, now: () => number): (message: ToWorker) => void {
  const stages = new FieldStages(now);
  return (message) => {
    if (message.t === 'walls') {
      try {
        post({ t: 'walls-done', id: message.id, result: checkWalls(message.params, message.inputs, now) });
      } catch (error) {
        const e = error instanceof Error ? error : new Error(String(error));
        post({ t: 'error', id: message.id, name: e.name, message: e.message, inline: false, cached: {} });
      }
      return;
    }
    if (message.t !== 'field') return;
    const { id, keys, params, inputs } = message;
    const timings: Record<string, number> = {};
    let outputs: FieldOutputs = {};
    try {
      injectedCrash(message.fault);
      applyDelay(message.fault, now);
      // S1 on its own first, so a stage after it that fails on the user's input still leaves main the
      // parsed model. solid.worker's import needs it, and the import's mesh may be what the rest needs,
      // as with a mesh wound inside out, which has no face to stand on until it is flipped.
      if (message.want.includes('S1')) outputs = stages.run(keys, ['S1'], params, inputs, timings);
      outputs = { ...outputs, ...stages.run(keys, message.want.filter((w) => w !== 'S1' && w !== 'S7'), params, inputs, timings) };
      if (message.want.includes('S7')) {
        // T1 is over when the field reaches main, so it goes before placement starts.
        if (outputs.S6) {
          const early = wire(outputs);
          post({ t: 'stage', id, outputs: early.outputs as FieldOutputs }, early.transfer);
          outputs = {};
        }
        outputs = { ...outputs, ...stages.run(keys, ['S7'], params, inputs, timings) };
      }
      const sent = wire(outputs);
      post({ t: 'result', id, outputs: sent.outputs as FieldOutputs, cached: stages.cached(), heapBytes: null, timings }, sent.transfer);
    } catch (error) {
      if (error instanceof StageMiss) {
        post({ t: 'miss', id, stage: error.stage, cached: stages.cached() });
        return;
      }
      const e = error instanceof Error ? error : new Error(String(error));
      if (isInlineError(e) && outputs.S1) {
        const early = wire({ S1: outputs.S1 });
        post({ t: 'stage', id, outputs: early.outputs as FieldOutputs }, early.transfer);
      }
      post({ t: 'error', id, name: e.name, message: e.message, inline: isInlineError(e), cached: stages.cached() });
    }
  };
}
