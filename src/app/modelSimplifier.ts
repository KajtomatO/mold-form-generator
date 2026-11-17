import { INIT_TIMEOUT_MS, realTimers, type Timers } from './jobGate';
import type { MemoryLedger, MemorySource } from './memory';
import type { OriginalSource } from './simplified';
import type { Fault, FromWorker, PrepareJobMessage, WorkerLike } from '../workers/protocol';
import type { Prepared, PrepareStep } from '../workers/prepareJob';

/** Where a prepare job stands: its step, the lock loop's round while it simplifies, and RM's rebuild's slabs. */
export interface PrepareProgress {
  step: PrepareStep;
  round: number;
  /** The step's own count, as a rebuild gives its z-slabs: `done` of `total`. */
  done: number;
  total: number;
}

/** What a prepare job makes: MM2's copy, a repair (RM), or a repair kept to a simplified copy's count. */
export interface PrepareWork {
  simplify: PrepareJobMessage['simplify'];
  repair: PrepareJobMessage['repair'];
}

function cancelled(repair: boolean): Error {
  return Object.assign(new Error(repair ? 'Repairing was cancelled.' : 'Simplifying was cancelled.'), { name: 'Cancelled' });
}

/** RM: the meter's part for a step: a repair's own, or MM2's for its copy, a filled file's included (decision G). */
const sourceOf = (repair: boolean, step: string): MemorySource => (repair && step !== 'simplify' && step !== 'measure' ? 'repair' : 'simplify');

/**
 * MM2: the simplified copy of a large model (R42), made in a fresh solid.worker per job, which is terminated as
 * it answers, fails or is cancelled. Its figures go to the memory meter's 'simplify' while it lives, as an
 * export's do. One job at a time: a new one cancels the one before. RM: the mesh repair (R43) is the same job
 * with a step of its own, whose figures go to the meter's 'repair', which is why this is a solid worker, with
 * Manifold and meshoptimizer both. The class keeps MM2's name, as most of its jobs are still copies.
 */
export class ModelSimplifier {
  private running: { worker: WorkerLike; boot: unknown; stop: (error: Error) => void; repair: boolean } | null = null;
  private jobs = 0;

  constructor(
    private readonly spawn: () => WorkerLike,
    private readonly ledger: MemoryLedger,
    private readonly timers: Timers = realTimers,
  ) {}

  get busy(): boolean {
    return this.running !== null;
  }

  /** The copy of `source`, `name` being the STL's file name. Rejects with name 'Cancelled' when cancelled. */
  run(source: OriginalSource, name: string, simplify: NonNullable<PrepareJobMessage['simplify']>, onProgress: (progress: PrepareProgress) => void = () => {}, fault?: Fault): Promise<Prepared> {
    return this.prepare(source, name, { simplify, repair: null }, onProgress, fault);
  }

  /** MM2's copy, or RM's repair, of `source`. Rejects with name 'Cancelled' when cancelled. */
  prepare(source: OriginalSource, name: string, work: PrepareWork, onProgress: (progress: PrepareProgress) => void = () => {}, fault?: Fault): Promise<Prepared> {
    this.cancel();
    const repair = Boolean(work.repair);
    return new Promise((resolve, reject) => {
      const worker = this.spawn();
      const id = ++this.jobs;
      // The meter's part the job's figures go to now: a repair's moves to 'simplify' for a filled copy simplified.
      let part: MemorySource = repair ? 'repair' : 'simplify';
      const drop = (which: MemorySource): void => {
        try {
          this.ledger.drop(which);
        } catch {
          // A meter that failed reads stale; the job goes on.
        }
      };
      const end = (): void => {
        if (this.running?.worker !== worker) return;
        this.timers.clear(this.running.boot);
        this.running = null;
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        // Its memory goes with it, whether it answered, failed or was cancelled.
        drop(part);
      };
      const fail = (error: Error): void => {
        end();
        reject(error);
      };
      // The Workers rule: a worker that has not said ready within 20 s gets an inline error.
      const boot = this.timers.set(() => fail(Object.assign(new Error(`The geometry engine did not start within 20 s, so the model was not ${repair ? 'repaired' : 'simplified'}. Try again, or reload the page.`), { name: 'InitTimeout' })), INIT_TIMEOUT_MS);
      this.running = { worker, boot, stop: fail, repair };
      worker.onmessage = ({ data }: { data: FromWorker }) => {
        if (this.running?.worker !== worker) return;
        if (data.t === 'progress') {
          const now = sourceOf(repair, data.step);
          if (now !== part) {
            drop(part);
            part = now;
          }
        }
        if ((data.t === 'ready' || data.t === 'progress') && data.memory) {
          try {
            this.ledger.report(part, data.memory);
          } catch {
            // The next step's figure stands in for it.
          }
        }
        if (data.t === 'ready') this.timers.clear(boot);
        else if (data.t === 'progress') {
          this.timers.clear(boot);
          onProgress({ step: data.step as PrepareStep, round: data.step === 'simplify' || data.step === 'measure' ? data.done : 0, done: data.done, total: data.total });
        } else if (data.t === 'prepared') {
          end();
          const { stl, from, record, repair: repaired, outside, rounds, timings } = data;
          resolve({ stl, from, record, repair: repaired ?? null, outside: outside ?? null, rounds, timings });
        } else if (data.t === 'error') {
          fail(Object.assign(new Error(data.message), { name: data.name }));
        }
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        fail(Object.assign(new Error(event.message ?? 'The geometry worker failed.'), { name: 'WorkerError' }));
      };
      const message: PrepareJobMessage = { t: 'prepare', id, source, name, simplify: work.simplify, repair: work.repair ?? null, ...(fault ? { fault } : {}) };
      worker.postMessage(message);
    });
  }

  /** Ends the job that runs, if any, with no copy. */
  cancel(): void {
    this.running?.stop(cancelled(this.running.repair));
  }
}
