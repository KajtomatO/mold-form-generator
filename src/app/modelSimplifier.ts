import { INIT_TIMEOUT_MS, realTimers, type Timers } from './jobGate';
import type { MemoryLedger } from './memory';
import type { OriginalSource } from './simplified';
import type { Fault, FromWorker, PrepareJobMessage, WorkerLike } from '../workers/protocol';
import type { Prepared, PrepareStep } from '../workers/prepareJob';

/** Where a prepare job stands: its step, and the lock loop's round while it simplifies. */
export interface PrepareProgress {
  step: PrepareStep;
  round: number;
}

function cancelled(): Error {
  return Object.assign(new Error('Simplifying was cancelled.'), { name: 'Cancelled' });
}

/**
 * MM2: the simplified copy of a large model (R42), made in a fresh solid.worker per job, which is terminated as
 * it answers, fails or is cancelled. Its figures go to the memory meter's 'simplify' while it lives, as an
 * export's do. One job at a time: a new one cancels the one before. The mesh repair planned for 0.2.0 joins
 * the same job, which is why this is a solid worker, with Manifold and meshoptimizer both.
 */
export class ModelSimplifier {
  private running: { worker: WorkerLike; boot: unknown; stop: (error: Error) => void } | null = null;
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
  run(source: OriginalSource, name: string, simplify: PrepareJobMessage['simplify'], onProgress: (progress: PrepareProgress) => void = () => {}, fault?: Fault): Promise<Prepared> {
    this.cancel();
    return new Promise((resolve, reject) => {
      const worker = this.spawn();
      const id = ++this.jobs;
      const end = (): void => {
        if (this.running?.worker !== worker) return;
        this.timers.clear(this.running.boot);
        this.running = null;
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        // Its memory goes with it, whether it answered, failed or was cancelled.
        try {
          this.ledger.drop('simplify');
        } catch {
          // A meter that failed reads stale; the job's end goes on.
        }
      };
      const fail = (error: Error): void => {
        end();
        reject(error);
      };
      // The Workers rule: a worker that has not said ready within 20 s gets an inline error.
      const boot = this.timers.set(() => fail(Object.assign(new Error('The geometry engine did not start within 20 s, so the model was not simplified. Try again, or reload the page.'), { name: 'InitTimeout' })), INIT_TIMEOUT_MS);
      this.running = { worker, boot, stop: fail };
      worker.onmessage = ({ data }: { data: FromWorker }) => {
        if (this.running?.worker !== worker) return;
        if ((data.t === 'ready' || data.t === 'progress') && data.memory) {
          try {
            this.ledger.report('simplify', data.memory);
          } catch {
            // The next step's figure stands in for it.
          }
        }
        if (data.t === 'ready') this.timers.clear(boot);
        else if (data.t === 'progress') {
          this.timers.clear(boot);
          onProgress({ step: data.step as PrepareStep, round: data.step === 'simplify' || data.step === 'measure' ? data.done : 0 });
        } else if (data.t === 'prepared') {
          end();
          const { stl, from, record, rounds, timings } = data;
          resolve({ stl, from, record, rounds, timings });
        } else if (data.t === 'error') {
          fail(Object.assign(new Error(data.message), { name: data.name }));
        }
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        fail(Object.assign(new Error(event.message ?? 'The geometry worker failed.'), { name: 'WorkerError' }));
      };
      const message: PrepareJobMessage = { t: 'prepare', id, source, name, simplify, ...(fault ? { fault } : {}) };
      worker.postMessage(message);
    });
  }

  /** Ends the job that runs, if any, with no copy. */
  cancel(): void {
    this.running?.stop(cancelled());
  }
}
