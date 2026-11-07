import { describe, expect, it } from 'vitest';
import { ADAPT_AFTER, Budgets, MAX_TUNE_SCALE } from '../../src/app/budgets';
import { INIT_TIMEOUT_MS, JobGate, type GateEvent, type GateTarget, type LogEntry, type Timers } from '../../src/app/jobGate';
import type { FromWorker, ToWorker, WorkerLike } from '../../src/workers/protocol';

/** Timers that move only when the test says, so the 20 s and 8 s rules take no time. */
class ManualClock implements Timers {
  now = 0;
  /** How much before its time each timer fires, as a real one can against a coarse clock. */
  constructor(private readonly early = 0) {}
  private timers: { at: number; run: () => void; id: number }[] = [];
  private next = 0;
  set(run: () => void, ms: number): unknown {
    const id = ++this.next;
    this.timers.push({ at: this.now + ms - this.early, run, id });
    return id;
  }
  clear(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.now = due.at;
      due.run();
    }
    this.now = end;
  }
}

/** A worker the test answers by hand. */
class FakeWorker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;
  received: ToWorker[] = [];
  terminated = false;
  postMessage(message: ToWorker): void {
    this.received.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(message: FromWorker): void {
    this.onmessage?.({ data: message });
  }
}

interface T extends GateTarget {
  name: string;
}

function setup(budgets = new Budgets(true), early = 0) {
  const clock = new ManualClock(early);
  const workers: FakeWorker[] = [];
  const events: GateEvent<T>[] = [];
  const log: LogEntry[] = [];
  const gate = new JobGate<T>({
    name: 'solid',
    spawn: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    // The job says which target it is for, and carries the big input only if the worker lacks S11.
    derive: (target, cached) => ({ message: { t: 'solid', id: 0, keys: {}, want: [target.name], cached, big: cached.S11 ? null : 'field' } as unknown as ToWorker, transfer: [] }),
    onEvent: (event) => events.push(event),
    log: (entry) => log.push(entry),
    budgets,
    now: () => clock.now,
    timers: clock,
  });
  const target = (name: string, rev: number): T => ({ id: name, rev, modelKey: 'm', name });
  const worker = (): FakeWorker => workers[workers.length - 1];
  const last = (): ToWorker & { id: number; want: string[]; big: string | null } => worker().received.at(-1) as never;
  return { clock, workers, worker, events, log, gate, target, last };
}

const result = (id: number, cached = {}): FromWorker => ({ t: 'result', id, outputs: {}, cached, heapBytes: 0, timings: {} });

describe('JobGate', () => {
  it('runs one job at a time, and a burst while busy runs only its last request next', () => {
    const { gate, target, worker, last } = setup();
    worker().reply({ t: 'ready', bootMs: 0, cached: {}, heapBytes: 0 });
    gate.request(target('a', 1));
    for (let k = 2; k <= 50; k++) gate.request(target(`b${k}`, k));
    expect(worker().received).toHaveLength(1);
    worker().reply(result(last().id));
    expect(worker().received).toHaveLength(2);
    expect(last().want).toEqual(['b50']);
    worker().reply(result(last().id));
    expect(gate.busy).toBe(false);
  });

  it('ends a job only past max(8 s, 4 x median), and only for a newer request', () => {
    const budgets = new Budgets(false);
    for (let k = 0; k < 5; k++) budgets.recordJob('solid', 3_000);
    const { gate, target, worker, last, clock, log } = setup(budgets);
    worker().reply({ t: 'ready', bootMs: 0, cached: {}, heapBytes: 0 });
    expect(budgets.terminateAfterMs('solid')).toBe(12_000);
    gate.request(target('slow', 1));
    // Nothing newer waits: it may run as long as it likes.
    clock.advance(30_000);
    expect(log.some((e) => e.event === 'terminated')).toBe(false);
    const first = worker();
    gate.request(target('newer', 2));
    expect(first.terminated).toBe(true);
    expect(log.filter((e) => e.event === 'terminated')).toHaveLength(1);
    expect(last().want).toEqual(['newer']);
  });

  it('a newer request does not end a job that is still within its budget', () => {
    const { gate, target, worker, clock, log } = setup(new Budgets(true, { terminateFloorMs: 8_000 }));
    worker().reply({ t: 'ready', bootMs: 0, cached: {}, heapBytes: 0 });
    gate.request(target('a', 1));
    clock.advance(7_000);
    gate.request(target('b', 2));
    expect(log.some((e) => e.event === 'terminated')).toBe(false);
    clock.advance(1_002);
    expect(log.filter((e) => e.event === 'terminated')).toHaveLength(1);
  });

  it('a check that fires early, as timers do against Firefox\'s rounded clock, checks again and still ends the job', () => {
    const { gate, target, worker, clock, log } = setup(new Budgets(true, { terminateFloorMs: 1_000 }), 2);
    worker().reply({ t: 'ready', bootMs: 0, cached: {}, heapBytes: 0 });
    gate.request(target('slow', 1));
    gate.request(target('newer', 2));
    clock.advance(1_000);
    expect(log.some((e) => e.event === 'terminated')).toBe(false);
    clock.advance(5);
    expect(log.filter((e) => e.event === 'terminated')).toHaveLength(1);
  });

  it('derives each job from what the worker last said, and a miss re-sends with the inputs it lacked', () => {
    const { gate, target, worker, last } = setup();
    worker().reply({ t: 'ready', bootMs: 0, cached: {}, heapBytes: 0 });
    gate.request(target('a', 1));
    expect(last().big).toBe('field');
    worker().reply(result(last().id, { S11: 'k' }));
    gate.request(target('b', 2));
    expect(last().big).toBeNull();
    // A recycled worker has said nothing yet, so the job goes as for the old one, misses, and goes again.
    gate.recycle();
    gate.request(target('c', 3));
    expect(last().big).toBeNull();
    worker().reply({ t: 'miss', id: last().id, stage: 'S11', cached: {} });
    expect(last().big).toBe('field');
    expect(last().want).toEqual(['c']);
  });

  it('a crash respawns the worker and reports it, and an inline error does not', () => {
    const { gate, target, worker, workers, last, events } = setup();
    worker().reply({ t: 'ready', bootMs: 0, cached: {}, heapBytes: 0 });
    gate.request(target('a', 1));
    worker().reply({ t: 'error', id: last().id, name: 'ManifoldError', message: 'Not manifold', inline: true, cached: {} });
    expect(workers).toHaveLength(1);
    expect(events.at(-1)!.kind).toBe('failed');
    gate.request(target('b', 2));
    worker().reply({ t: 'error', id: last().id, name: 'RuntimeError', message: 'memory access out of bounds', inline: false, cached: {} });
    expect(workers).toHaveLength(2);
    expect(workers[0].terminated).toBe(true);
    expect(events.at(-1)!.kind).toBe('crashed');
  });

  it('gives an inline error when a worker has not said ready within 20 s', () => {
    const { gate, target, clock, events } = setup();
    gate.request(target('a', 1));
    clock.advance(INIT_TIMEOUT_MS - 1);
    expect(events).toEqual([]);
    clock.advance(1);
    expect(events.at(-1)).toMatchObject({ kind: 'failed', error: { name: 'InitTimeout' } });
    expect(gate.busy).toBe(false);
  });

  it('a worker that stalls at page load, with the first job long after: that job goes to a fresh worker and gets its own 20 s', () => {
    const { gate, target, clock, events, workers, log } = setup();
    clock.advance(INIT_TIMEOUT_MS);
    // Nothing to fail yet, but the gate remembers.
    expect(events).toEqual([]);
    expect(log.filter((e) => e.event === 'timeout')).toHaveLength(1);
    clock.advance(5_000);
    gate.request(target('a', 1));
    expect(workers).toHaveLength(2);
    expect(workers[0].terminated).toBe(true);
    expect(workers[1].received).toHaveLength(1);
    clock.advance(INIT_TIMEOUT_MS - 1);
    expect(events).toEqual([]);
    clock.advance(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'failed', target: { name: 'a' }, error: { name: 'InitTimeout' } });
    expect(gate.busy).toBe(false);
  });

  it('after a start timeout the next request is not sent to the dead worker: it gets a fresh one, which can answer', () => {
    const { gate, target, clock, events, workers, worker, last } = setup();
    gate.request(target('a', 1));
    clock.advance(INIT_TIMEOUT_MS);
    expect(events.at(-1)).toMatchObject({ kind: 'failed', error: { name: 'InitTimeout' } });
    gate.request(target('b', 2));
    expect(workers).toHaveLength(2);
    expect(workers[0].received).toHaveLength(1);
    worker().reply({ t: 'ready', bootMs: 0, cached: {}, heapBytes: 0 });
    worker().reply(result(last().id));
    expect(events.at(-1)).toMatchObject({ kind: 'result', target: { name: 'b' } });
    expect(gate.busy).toBe(false);
  });

  it('a boot error with no job running is kept: the next job gets a fresh worker, and fails with that worker\'s own reason', () => {
    const { gate, target, clock, events, workers, worker } = setup();
    const bootError = { t: 'error', id: -1, name: 'BootError', message: 'The geometry engine could not start: no WebAssembly', inline: true, cached: {} } as const;
    worker().reply(bootError);
    expect(events).toEqual([]);
    clock.advance(1_000);
    gate.request(target('a', 1));
    expect(workers).toHaveLength(2);
    worker().reply(bootError);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'failed', target: { name: 'a' }, error: { name: 'BootError', message: bootError.message } });
    expect(gate.busy).toBe(false);
    // The worker that failed is not given the time-out as well.
    clock.advance(INIT_TIMEOUT_MS);
    expect(events).toHaveLength(1);
  });

  it('a worker whose script fails before ready fails its job and is not respawned until the next request', () => {
    const { gate, target, events, workers, worker } = setup();
    gate.request(target('a', 1));
    worker().onerror!({ message: 'SyntaxError in the worker script' });
    expect(events.at(-1)).toMatchObject({ kind: 'failed', error: { name: 'WorkerError' } });
    expect(workers).toHaveLength(1);
    gate.request(target('b', 2));
    expect(workers).toHaveLength(2);
  });

  it('a worker that says ready after its time-out is used after all', () => {
    const { gate, target, clock, workers, worker, last, events } = setup();
    clock.advance(INIT_TIMEOUT_MS + 1_000);
    worker().reply({ t: 'ready', bootMs: 21_000, cached: {}, heapBytes: 0 });
    gate.request(target('a', 1));
    expect(workers).toHaveLength(1);
    worker().reply(result(last().id));
    expect(events.at(-1)).toMatchObject({ kind: 'result' });
  });

  it('ends a job past the floor only once it is also past 4 x the median, with a newer request waiting', () => {
    const budgets = new Budgets(false);
    for (let k = 0; k < 5; k++) budgets.recordJob('solid', 3_000);
    const { gate, target, worker, clock, log } = setup(budgets);
    worker().reply({ t: 'ready', bootMs: 0, cached: {}, heapBytes: 0 });
    gate.request(target('slow', 1));
    clock.advance(10_000);
    // Past the 8 s floor, but within 12 s.
    gate.request(target('newer', 2));
    clock.advance(1_999);
    expect(log.some((e) => e.event === 'terminated')).toBe(false);
    clock.advance(2);
    expect(log.filter((e) => e.event === 'terminated')).toHaveLength(1);
  });

  it('a recycle asked for while a job runs waits for its result, and the next job goes to a fresh worker', () => {
    const { gate, target, worker, workers, last, log } = setup();
    worker().reply({ t: 'ready', bootMs: 0, cached: {}, heapBytes: 0 });
    gate.request(target('a', 1));
    gate.recycle();
    expect(workers).toHaveLength(1);
    expect(workers[0].terminated).toBe(false);
    gate.request(target('b', 2));
    worker().reply(result(last().id));
    expect(workers).toHaveLength(2);
    expect(workers[0].terminated).toBe(true);
    expect(log.filter((e) => e.event === 'respawned' && e.detail === 'recycled')).toHaveLength(1);
    expect(workers[1].received.map((m) => (m as unknown as { want: string[] }).want)).toEqual([['b']]);
  });
});

describe('Budgets', () => {
  it('move the preview cell one step per window of new samples, never twice on the same ones, and not at all when frozen', () => {
    const live = new Budgets(false), frozen = new Budgets(true);
    const record = (ms: number, n: number): void => {
      for (let k = 0; k < n; k++) {
        live.recordT1(ms);
        frozen.recordT1(ms);
      }
    };
    record(600, ADAPT_AFTER - 1);
    expect(live.previewCellScale(1)).toBe(1);
    record(600, 1);
    expect(live.previewCellScale(1)).toBe(1.5);
    // Asked again before any sample at the new cell exists, it stays.
    expect(live.previewCellScale(1.5)).toBe(1.5);
    record(600, ADAPT_AFTER - 1);
    expect(live.previewCellScale(1.5)).toBe(1.5);
    record(600, 1);
    expect(live.previewCellScale(1.5)).toBe(MAX_TUNE_SCALE);
    // Fast again: it comes down by one step per window too.
    record(10, ADAPT_AFTER);
    expect(live.previewCellScale(2)).toBe(1.6);
    expect(live.previewCellScale(1.6)).toBe(1.6);
    expect(frozen.previewCellScale(1)).toBe(1);
    expect(frozen.terminateAfterMs('field')).toBe(8_000);
  });

  it('restart T1 when the cell changes for another reason', () => {
    const live = new Budgets(false);
    for (let k = 0; k < ADAPT_AFTER; k++) live.recordT1(600);
    live.restartT1();
    expect(live.previewCellScale(1)).toBe(1);
    expect(live.snapshot().medians.t1).toBeNull();
  });
});
