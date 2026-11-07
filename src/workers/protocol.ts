import type { Params } from '../core/params/schema';
import type { StageId } from '../app/stages';
import type { FieldInputs, FieldOutputs, FieldWanted } from './fieldStages';
import type { SolidInputs, SolidOutputs, SolidWanted } from './solidStages';
import type { ExportInputs, ExportOutputs } from './exportJob';
import type { WallCheck, WallInputs } from './wallCheck';

/**
 * Messages between main and the workers. Every job names the full key of each stage it touches, and
 * every reply says what the worker now holds, which is all main ever knows about a worker's cache.
 */

/**
 * Test-only faults, armed through the ?test=1 hooks. A leak keeps one CrossSection of the given number
 * of points in solid.worker's heap for good, which the soak's negative control must see.
 */
export type Fault = { kind: 'oob' } | { kind: 'delay'; ms: number } | { kind: 'leak'; points: number };

export interface FieldJobMessage {
  t: 'field';
  id: number;
  keys: Record<StageId, string>;
  want: FieldWanted[];
  params: Params;
  inputs: FieldInputs;
  fault?: Fault;
}

export interface SolidJobMessage {
  t: 'solid';
  id: number;
  keys: Record<StageId, string>;
  want: SolidWanted[];
  params: Params;
  inputs: SolidInputs;
  fault?: Fault;
}

/** T3, sent to a fresh solid worker that is terminated when it answers. */
export interface ExportJobMessage {
  t: 'export';
  id: number;
  params: Params;
  inputs: ExportInputs;
  /** Above 1 on the retry after a crash. */
  cellScale: number;
  fault?: Fault;
}

/** Test-only: how much of the WASM heap is in use. */
export interface HeapProbeMessage {
  t: 'heap';
  id: number;
}

/**
 * The export field's wall check, sent to a field.worker of its own once the preview has settled, and
 * terminated by any newer change, so it never holds up the preview's worker or its cache.
 */
export interface WallsJobMessage {
  t: 'walls';
  id: number;
  params: Params;
  inputs: WallInputs;
}

export type ToWorker = FieldJobMessage | SolidJobMessage | ExportJobMessage | HeapProbeMessage | WallsJobMessage;

export type Cached = Partial<Record<StageId, string>>;

export interface ReadyMessage {
  t: 'ready';
  bootMs: number;
  cached: Cached;
  heapBytes: number | null;
}

/** Part of a job's outputs, sent ahead of the rest: the field, which T1 waits for, before placement runs. */
export interface StageMessage {
  t: 'stage';
  id: number;
  outputs: FieldOutputs;
}

export interface ResultMessage<O = FieldOutputs | SolidOutputs> {
  t: 'result';
  id: number;
  outputs: O;
  cached: Cached;
  heapBytes: number | null;
  /** In ms, per stage that ran. */
  timings: Record<string, number>;
}

export interface MissMessage {
  t: 'miss';
  id: number;
  stage: StageId;
  cached: Cached;
}

export interface ErrorMessage {
  t: 'error';
  id: number;
  name: string;
  message: string;
  /**
   * A problem with what the user gave, such as a file that is not an STL or a ManifoldError, shown as it
   * is. Anything else means the worker cannot be trusted any more.
   */
  inline: boolean;
  cached: Cached;
}

export interface ProgressMessage {
  t: 'progress';
  id: number;
  step: string;
  done: number;
  total: number;
}

export interface ExportResultMessage {
  t: 'exported';
  id: number;
  outputs: ExportOutputs;
  timings: Record<string, number>;
}

export interface HeapMessage {
  t: 'heap';
  id: number;
  capacity: number | null;
  used: number | null;
  held: number;
}

export interface WallsResultMessage {
  t: 'walls-done';
  id: number;
  result: WallCheck;
}

export type FromWorker = ReadyMessage | StageMessage | ResultMessage | MissMessage | ErrorMessage | ProgressMessage | ExportResultMessage | HeapMessage | WallsResultMessage;

/** The part of Worker the pipeline uses, so tests can stand an in-process worker in for it. */
export interface WorkerLike {
  postMessage(message: ToWorker, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { data: FromWorker }) => void) | null;
  onerror: ((event: { message?: string; preventDefault?: () => void }) => void) | null;
}

/** Errors the user can act on. Everything else marks the worker dead. */
export function isInlineError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'ManifoldError' || error.name === 'StlError' || error.name === 'InlineError';
}

/** Busy-waits, as a stuck job would, so a test can see the gate end it. */
export function applyDelay(fault: Fault | undefined, now: () => number): void {
  if (fault?.kind !== 'delay') return;
  const until = now() + fault.ms;
  while (now() < until) {
    // Spin: a timer would let the worker take the next message, which a stuck job does not.
  }
}

/** What a heap overrun looks like from inside WASM. */
export function injectedCrash(fault: Fault | undefined): void {
  if (fault?.kind === 'oob') throw new WebAssembly.RuntimeError('memory access out of bounds (injected by a test)');
}

/** The buffers of these arrays, once each, for a transfer list. */
export function buffersOf(...arrays: (ArrayBufferView | null | undefined)[]): ArrayBuffer[] {
  const seen = new Set<ArrayBuffer>();
  for (const array of arrays) if (array && array.buffer instanceof ArrayBuffer && array.buffer.byteLength > 0) seen.add(array.buffer);
  return [...seen];
}
