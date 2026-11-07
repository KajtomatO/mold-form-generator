import type { Budgets, GateName } from './budgets';
import type { Cached, ErrorMessage, Fault, FromWorker, HeapMessage, ResultMessage, StageMessage, ToWorker, WorkerLike } from '../workers/protocol';

/** The plan's bootstrap rule: a worker that has not said ready by then gets an inline error. */
export const INIT_TIMEOUT_MS = 20_000;
/** The soonest an early overrun check looks again, so a timer that fires early cannot spin. */
const RECHECK_MS = 5;
/** One miss is normal after a respawn. Three in a row means the job never brings what is missing. */
const MAX_MISSES = 3;

export interface GateTarget {
  /** Two targets with one id ask for the same work. */
  id: string;
  /** The pipeline's revision when this was asked for: results are applied in this order. */
  rev: number;
  /** The model and plane it is for. A result for another is rejected. */
  modelKey: string;
}

export interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type GateEvent<T> =
  | { kind: 'stage'; target: T; message: StageMessage; ms: number }
  | { kind: 'result'; target: T; message: ResultMessage; ms: number }
  /** The job failed on something the user can act on. The worker lives on. */
  | { kind: 'failed'; target: T; error: { name: string; message: string } }
  /** The worker died, or had to be ended; it has been respawned. The pipeline decides what to try next. */
  | { kind: 'crashed'; target: T; error: { name: string; message: string } }
  | { kind: 'terminated'; target: T; ms: number };

export interface LogEntry {
  gate: GateName;
  event: 'dispatch' | 'stage' | 'result' | 'miss' | 'failed' | 'crashed' | 'terminated' | 'respawned' | 'ready' | 'timeout';
  job: number;
  rev: number;
  modelKey: string;
  at: number;
  ms?: number;
  detail?: string;
}

export interface JobGateOptions<T extends GateTarget> {
  name: GateName;
  spawn: () => WorkerLike;
  /** The job for a target, given what the worker last said it holds: big inputs ride along only for stages it lacks. */
  derive: (target: T, cached: Cached) => { message: ToWorker; transfer: Transferable[] };
  onEvent: (event: GateEvent<T>) => void;
  log: (entry: LogEntry) => void;
  budgets: Budgets;
  now: () => number;
  timers: Timers;
}

interface Running<T> {
  target: T;
  job: number;
  started: number;
}

/**
 * One per worker. It holds one desired target and runs one job at a time: a request while busy replaces
 * whatever was waiting, so a burst of changes runs the first and the last. What a worker holds is only
 * ever what it said in its last message, and a job is derived from that at dispatch. A worker that was
 * just respawned has said nothing yet, so a job sent before its ready message is derived from what the
 * old one said and can miss. The miss reply carries the true contents, and the job goes again with
 * the inputs it lacked, which is cheaper than holding every job back until ready.
 *
 * A worker that could not start, or not within 20 s, answers nothing. Its job fails with that error,
 * and the gate remembers it, so the next job goes to a fresh worker with a deadline of its own rather
 * than to one that will never reply.
 */
export class JobGate<T extends GateTarget> {
  private worker: WorkerLike;
  private running: Running<T> | null = null;
  private pending: T | null = null;
  private cachedView: Cached = {};
  private ready = false;
  /** Why the current worker could not start, until it says ready after all or is replaced. */
  private bootFailure: { name: string; message: string } | null = null;
  private jobCounter = 0;
  private killTimer: unknown = null;
  private initTimer: unknown = null;
  private recyclePending = false;
  /** Faults a test has armed for the next jobs, in order. */
  private faults: Fault[] = [];
  /** Misses in a row: a job that misses again after a re-send has a bug in what it attaches. */
  private misses = 0;
  private heapWaiters: ((message: HeapMessage) => void)[] = [];

  constructor(private readonly options: JobGateOptions<T>) {
    this.worker = this.start();
  }

  get busy(): boolean {
    return this.running !== null || this.pending !== null;
  }

  get cached(): Cached {
    return this.cachedView;
  }

  request(target: T): void {
    if (this.running?.target.id === target.id) {
      this.pending = null;
      return;
    }
    if (this.pending?.id === target.id) return;
    this.pending = target;
    if (!this.running) this.pump();
    else this.checkOverrun();
  }

  /** Forget the waiting target, as when the pipeline no longer wants it. */
  cancelPending(): void {
    this.pending = null;
  }

  /** Rule 6: a fresh worker, but only between jobs. */
  recycle(): void {
    if (this.running) {
      this.recyclePending = true;
      return;
    }
    this.respawn('recycled');
  }

  /** Test-only: the heap in use. The worker answers in order, so this reads it between jobs. */
  readHeap(): Promise<HeapMessage> {
    return new Promise((resolve) => {
      this.heapWaiters.push(resolve);
      this.worker.postMessage({ t: 'heap', id: -2 });
    });
  }

  armFault(fault: Fault): void {
    this.faults.push(fault);
  }

  dispose(): void {
    this.clearTimers();
    this.worker.terminate();
  }

  private start(): WorkerLike {
    const worker = this.options.spawn();
    this.ready = false;
    this.bootFailure = null;
    worker.onmessage = (event) => this.receive(worker, event.data);
    worker.onerror = (event) => {
      event.preventDefault?.();
      if (worker !== this.worker) return;
      const error = { name: 'WorkerError', message: event.message ?? 'The worker failed.' };
      // Before ready, as when its script cannot load, a respawn would only fail the same way, and at once.
      if (this.ready) this.crash(error);
      else this.bootFailed(error);
    };
    this.initTimer = this.options.timers.set(() => {
      this.initTimer = null;
      if (this.ready || worker !== this.worker) return;
      this.bootFailed({ name: 'InitTimeout', message: 'The geometry worker did not start within 20 s. Change something to try again, or reload the page.' });
    }, INIT_TIMEOUT_MS);
    return worker;
  }

  /** The worker could not start. Its job, if it had one, fails with the reason, and the next job gets a fresh worker. */
  private bootFailed(error: { name: string; message: string }): void {
    this.bootFailure = error;
    const running = this.running;
    this.finish();
    this.log(error.name === 'InitTimeout' ? 'timeout' : 'failed', running?.job ?? -1, running?.target, `${error.name}: ${error.message}`);
    if (running) this.options.onEvent({ kind: 'failed', target: running.target, error });
    this.pump();
  }

  private respawn(reason: 'respawned' | 'recycled' | 'terminated'): void {
    this.clearTimers();
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
    this.recyclePending = false;
    this.worker = this.start();
    this.log('respawned', -1, undefined, reason);
  }

  private clearTimers(): void {
    if (this.killTimer !== null) this.options.timers.clear(this.killTimer);
    if (this.initTimer !== null) this.options.timers.clear(this.initTimer);
    this.killTimer = this.initTimer = null;
  }

  private pump(): void {
    if (this.running || !this.pending) return;
    if (this.bootFailure) this.respawn('respawned');
    else if (this.recyclePending) this.respawn('recycled');
    const target = this.pending;
    this.pending = null;
    this.dispatch(target);
  }

  private dispatch(target: T): void {
    const job = ++this.jobCounter;
    const { message, transfer } = this.options.derive(target, this.cachedView);
    const fault = this.faults.shift();
    this.worker.postMessage({ ...message, id: job, ...(fault ? { fault } : {}) } as ToWorker, transfer);
    this.running = { target, job, started: this.options.now() };
    this.log('dispatch', job, target);
    this.armOverrun();
  }

  /**
   * A check for when the running job passes its budget. A timer can fire a millisecond early against
   * performance.now, which Firefox rounds to whole ms, so a check that comes early sets another.
   */
  private armOverrun(): void {
    if (this.killTimer !== null) this.options.timers.clear(this.killTimer);
    this.killTimer = null;
    const running = this.running;
    if (!running) return;
    const left = this.options.budgets.terminateAfterMs(this.options.name) - (this.options.now() - running.started);
    this.killTimer = this.options.timers.set(() => {
      this.killTimer = null;
      this.checkOverrun();
    }, Math.max(RECHECK_MS, left + 1));
  }

  /** Rule 4: only with a newer request waiting, and only past the budget. */
  private checkOverrun(): void {
    const running = this.running;
    if (!running) return;
    const ms = this.options.now() - running.started;
    if (ms <= this.options.budgets.terminateAfterMs(this.options.name)) {
      if (this.killTimer === null) this.armOverrun();
      return;
    }
    if (!this.pending || this.pending.id === running.target.id) return;
    this.running = null;
    this.log('terminated', running.job, running.target, `after ${Math.round(ms)} ms`);
    this.respawn('terminated');
    this.options.onEvent({ kind: 'terminated', target: running.target, ms });
    this.pump();
  }

  private receive(worker: WorkerLike, message: FromWorker): void {
    if (worker !== this.worker) return;
    if (message.t === 'ready') {
      // Late, perhaps, but it can work after all.
      this.ready = true;
      this.bootFailure = null;
      this.cachedView = message.cached;
      if (this.initTimer !== null) this.options.timers.clear(this.initTimer);
      this.initTimer = null;
      this.log('ready', -1, undefined, `${Math.round(message.bootMs)} ms`);
      return;
    }
    if (message.t === 'heap') {
      this.heapWaiters.shift()?.(message);
      return;
    }
    if (message.t === 'error' && message.id === -1) {
      this.ready = false;
      this.bootFailed(message);
      return;
    }
    const running = this.running;
    if (!running || !('id' in message) || message.id !== running.job) return;
    const ms = this.options.now() - running.started;
    switch (message.t) {
      case 'stage':
        this.log('stage', running.job, running.target, undefined, ms);
        this.options.onEvent({ kind: 'stage', target: running.target, message, ms });
        return;
      case 'result':
        this.finish();
        this.misses = 0;
        this.cachedView = message.cached;
        this.options.budgets.recordJob(this.options.name, ms);
        this.log('result', running.job, running.target, undefined, ms);
        this.options.onEvent({ kind: 'result', target: running.target, message, ms });
        this.pump();
        return;
      case 'miss':
        this.finish();
        this.cachedView = message.cached;
        this.log('miss', running.job, running.target, message.stage, ms);
        if (++this.misses > MAX_MISSES) {
          this.misses = 0;
          this.options.onEvent({ kind: 'failed', target: running.target, error: { name: 'Miss', message: `The worker kept lacking ${message.stage}.` } });
          this.pump();
          return;
        }
        // The newest target goes, which may be this one again, now with the inputs it lacked.
        this.pending = this.pending ?? running.target;
        this.pump();
        return;
      case 'error':
        if (message.inline) {
          this.finish();
          this.cachedView = message.cached;
          this.log('failed', running.job, running.target, message.message, ms);
          this.options.onEvent({ kind: 'failed', target: running.target, error: message });
          this.pump();
        } else {
          this.crash(message);
        }
        return;
      default:
        return;
    }
  }

  /** Rule 5: the worker cannot be trusted after this, so it goes, and the pipeline is told. */
  private crash(error: Pick<ErrorMessage, 'name' | 'message'>): void {
    const running = this.running;
    this.running = null;
    this.log('crashed', running?.job ?? -1, running?.target, `${error.name}: ${error.message}`);
    this.respawn('respawned');
    if (running) this.options.onEvent({ kind: 'crashed', target: running.target, error });
    this.pump();
  }

  private finish(): void {
    this.running = null;
    if (this.killTimer !== null) this.options.timers.clear(this.killTimer);
    this.killTimer = null;
  }

  private log(event: LogEntry['event'], job: number, target: T | undefined, detail?: string, ms?: number): void {
    this.options.log({ gate: this.options.name, event, job, rev: target?.rev ?? -1, modelKey: target?.modelKey ?? '', at: this.options.now(), ...(ms === undefined ? {} : { ms }), ...(detail === undefined ? {} : { detail }) });
  }
}
