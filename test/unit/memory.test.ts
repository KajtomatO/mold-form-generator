import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Timers } from '../../src/app/jobGate';
import { arrayBytes, MAX_WALKED, MEMORY_WARN_BYTES, MemoryLedger, type WorkerMemory } from '../../src/app/memory';
import { Pipeline } from '../../src/app/pipeline';
import { stageKeys } from '../../src/app/stages';
import { MEMORY_THROTTLE_MS, Store, type MeterPage } from '../../src/app/store';
import { defaultParams } from '../../src/core/params/defaults';
import { formatMemory, memoryText, memoryTitle, MEMORY_ADVICE, MEMORY_ADVICE_SIMPLIFY, MEMORY_NOT_COUNTED } from '../../src/ui/format';
import { ModelSimplifier } from '../../src/app/modelSimplifier';
import { runPrepareJob } from '../../src/workers/prepareJob';
import { MeshoptSimplifier } from 'meshoptimizer';
import { loadManifold } from '../fixtures/loadExamples';
import { weld } from '../../src/core/mesh/weld';
import { parseStl } from '../../src/core/stl/parse';
import { fieldHost } from '../../src/workers/fieldHost';
import { DEFAULT_PLANE, FieldStages, PLAIN_IMPORT } from '../../src/workers/fieldStages';
import type { FromWorker, ToWorker, WorkerLike } from '../../src/workers/protocol';
import { ReportStages } from '../../src/workers/reportStages';
import { solidMemory } from '../../src/workers/solidHost';
import { SolidStages } from '../../src/workers/solidStages';
import { exampleBytes, EXAMPLE_FILES } from '../fixtures/loadExamples';
import { inProcessField, inProcessSolid } from '../fixtures/inProcessWorker';
import { asciiStl, box, boxWithTopHole, inverted, toSoup } from '../fixtures/synthetic';

const root = join(import.meta.dirname, '..', '..');

/** An embind handle as Manifold's glue makes one: a class instance whose own fields hold its pointer. */
class Handle {
  $$ = { ptr: 1024, count: { value: 1 } };
  shadow = new Float64Array(100);
}

describe('MM1: arrayBytes', () => {
  it('counts each buffer once, at its full length: two views of one buffer, a subarray, a DataView, a detached buffer and a cycle', () => {
    const buffer = new ArrayBuffer(1000);
    expect(arrayBytes([{ a: new Float32Array(buffer), b: new Uint8Array(buffer, 10, 20) }])).toBe(1000);
    // A subarray keeps its whole buffer alive.
    expect(arrayBytes([new Float32Array(250).subarray(0, 10)])).toBe(1000);
    expect(arrayBytes([new DataView(new ArrayBuffer(48), 8, 8)])).toBe(48);
    // A transfer leaves the sender's buffer detached, and it then holds nothing.
    const sent = new ArrayBuffer(64);
    structuredClone(sent, { transfer: [sent] });
    expect(arrayBytes([sent, { sent }])).toBe(0);
    const node: Record<string, unknown> = { values: new Uint32Array(8) };
    node.self = node;
    node.list = [node, { again: node }];
    expect(arrayBytes([node, node])).toBe(32);
    // One set of buffers seen goes on from one walk to the next, so the view's arrays that are the pipeline's count once.
    const seen = new Set<ArrayBufferLike>();
    const shared = new Float32Array(10);
    expect(arrayBytes([{ shared }], seen) + arrayBytes([{ attribute: { array: shared } }, new Uint8Array(5)], seen)).toBe(45);
  });

  it("does not count a view into a worker's WebAssembly heap, which the heap's figure holds already", () => {
    const heap = new ArrayBuffer(4096);
    const held = { mesh: { positions: new Float32Array(heap, 0, 12), indices: new Uint32Array(6) } };
    expect(arrayBytes([held])).toBe(4096 + 24);
    expect(arrayBytes([held], new Set([heap]))).toBe(24);
    // A solid worker's figure: the heap whole, and the arrays it keeps outside it.
    expect(solidMemory(heap, [held])).toEqual({ wasm: 4096, arrays: 24 });
    expect(solidMemory(null, [held])).toEqual({ wasm: 0, arrays: 4096 + 24 });
  });

  it("walks a root's own fields whatever its class, but below the roots only plain objects and arrays: a handle, a three.js-like object and a list of numbers are passed over", () => {
    const handle = new Handle();
    expect(arrayBytes([handle])).toBe(800);
    expect(arrayBytes([{ solid: handle }, [handle]])).toBe(0);
    class Geometry {
      attributes = { position: { array: new Float32Array(30) } };
    }
    expect(arrayBytes([{ geometry: new Geometry() }])).toBe(0);
    expect(arrayBytes([new Geometry()])).toBe(120);
    expect(arrayBytes([[1, 2, 3], ['a', new Float32Array(4)], null, undefined, 7, 'text', () => new Float32Array(9)])).toBe(0);
    // Arrays holding arrays are walked, a list of typed arrays among them.
    expect(arrayBytes([[[new Uint8Array(3)], [new Uint8Array(5)]]])).toBe(8);
  });

  it(`stops past ${MAX_WALKED} objects and reads low, and a list of points is one step, not one per point`, () => {
    const tail = { mesh: new Float32Array(25) };
    const many = Array.from({ length: MAX_WALKED + 10 }, () => ({}));
    expect(arrayBytes([many, tail])).toBe(0);
    // A polygon's points are [x, y] pairs: 300,000 of them do not use up the walk.
    const points = Array.from({ length: 300_000 }, (_, k) => [k, k]);
    expect(arrayBytes([{ outline: [points, points] }, tail])).toBe(100);
  });
});

describe('MM1: the memory ledger and its text', () => {
  it('keeps the latest figure of each source in the tooltip order, drops a source as its worker goes, and adds them up', () => {
    const ledger = new MemoryLedger();
    const heard: [string, boolean][] = [];
    ledger.subscribe((source, dropped) => heard.push([source, dropped]));
    ledger.report('export', { wasm: 1e9, arrays: 2e8 });
    ledger.report('page', { wasm: 0, arrays: 3e8 });
    ledger.report('solid', { wasm: 6e8, arrays: 1e7 });
    ledger.report('solid', { wasm: 7e8, arrays: 1e7 });
    // A figure that is no number counts nothing.
    ledger.report('field', { wasm: Number.NaN, arrays: -5 });
    expect(Object.keys(ledger.parts())).toEqual(['page', 'field', 'solid', 'export']);
    expect(ledger.total()).toBe(1e9 + 2e8 + 3e8 + 7e8 + 1e7);
    ledger.drop('export');
    ledger.drop('export');
    expect(ledger.total()).toBe(3e8 + 7e8 + 1e7);
    expect(heard.filter(([, dropped]) => dropped)).toEqual([['export', true]]);
    expect(heard).toHaveLength(6);
  });

  it('reads in decimal units, coarse in the strip and fine in its tooltip, which gives the advice first past the warning figure, every part that holds something, and what is not counted', () => {
    expect([0, 4.9e6, 412e6, 994e6, 995e6, 1.24e9, 3.06e9].map((b) => formatMemory(b))).toEqual(['0 MB', '0 MB', '410 MB', '990 MB', '1.0 GB', '1.2 GB', '3.1 GB']);
    expect([412.4e6, 999.4e6, 999.5e6, 1.244e9].map((b) => formatMemory(b, true))).toEqual(['412 MB', '999 MB', '1.00 GB', '1.24 GB']);
    const parts: Partial<Record<string, WorkerMemory>> = { page: { wasm: 0, arrays: 310e6 }, field: { wasm: 0, arrays: 280e6 }, solid: { wasm: 600e6, arrays: 20e6 }, reports: { wasm: 0, arrays: 30e6 } };
    expect(memoryText({ total: 1.24e9, parts })).toBe('App memory 1.2 GB');
    const title = memoryTitle({ total: 1.24e9, parts }, 1.5e9);
    expect(title.split('\n')).toEqual([
      'Memory this app holds: 1.24 GB',
      '  This page (model, parts, view): 310 MB',
      '  Preview worker: 280 MB',
      '  Geometry engine: 620 MB',
      '  Reports worker: 30 MB',
      '  Export: not running',
      MEMORY_NOT_COUNTED,
    ]);
    // Past the warning figure the advice comes right after the total, before the parts.
    const exporting = memoryTitle({ total: 2.5e9, parts: { ...parts, export: { wasm: 1.1e9, arrays: 50e6 } } }, 1.5e9).split('\n');
    expect(exporting.slice(0, 2)).toEqual(['Memory this app holds: 2.50 GB', MEMORY_ADVICE]);
    expect(exporting).toContain('  Export: 1.15 GB');
    expect(exporting.at(-1)).toBe(MEMORY_NOT_COUNTED);
    // A part that would read 0 MB says nothing and is left out; the export always says whether it runs.
    const empty = { total: 17e6, parts: { page: { wasm: 0, arrays: 0.4e6 }, field: { wasm: 0, arrays: 0 }, solid: { wasm: 16.8e6, arrays: 0 }, reports: { wasm: 0, arrays: 0 } } };
    expect(memoryTitle(empty).split('\n')).toEqual(['Memory this app holds: 17 MB', '  Geometry engine: 17 MB', '  Export: not running', MEMORY_NOT_COUNTED]);
    expect(memoryText(empty)).toBe('App memory 20 MB');
    // MM2 and RM: a copy being made, or a repair, has a line of its own while its worker lives.
    expect(memoryTitle({ total: 1e9, parts: { ...parts, simplify: { wasm: 50e6, arrays: 100e6 }, repair: { wasm: 60e6, arrays: 480e6 } } }, 1.5e9).split('\n').slice(-3, -1)).toEqual(['  Simplify: 150 MB', '  Repair: 540 MB']);
    expect(MEMORY_NOT_COUNTED).toContain("the simplifier's own working memory. While a mesh is repaired, the Repair part counts that working memory too, as an estimate.");
    // Until a worker has said what it holds, main's share alone would read low: an ellipsis, not 0 MB.
    const early = { total: 42e3, parts: { page: { wasm: 0, arrays: 42e3 } } };
    expect(memoryText(early)).toBe('App memory …');
    expect(memoryText({ total: 0, parts: {} })).toBe('App memory …');
    expect(memoryTitle(early).split('\n')[0]).toBe('Memory this app holds: …');
  });

  it(`turns amber at the figure the docs give, ${MEMORY_WARN_BYTES / 1e9} GB, and reads at most every ${MEMORY_THROTTLE_MS} ms`, () => {
    expect(MEMORY_THROTTLE_MS).toBe(500);
    // Every "amber while it reads … GB" the docs say names the figure the code has.
    const figure = (MEMORY_WARN_BYTES / 1e9).toFixed(1);
    for (const doc of ['README.md', 'docs/DEPLOY.md', 'docs/REQUIREMENTS.md', 'docs/PLAN.md']) {
      const said = [...readFileSync(join(root, doc), 'utf8').matchAll(/amber (?:from|while it reads) (\d+(?:\.\d+)?) GB/g)].map((match) => match[1]);
      expect(said.length, `${doc} says when the meter turns amber`).toBeGreaterThan(0);
      expect(new Set(said), doc).toEqual(new Set([figure]));
    }
  });
});

/** Timers that move only when the test says. */
class ManualClock implements Timers {
  now = 0;
  private timers: { at: number; run: () => void; id: number }[] = [];
  private next = 0;
  set(run: () => void, ms: number): unknown {
    const id = ++this.next;
    this.timers.push({ at: this.now + ms, run, id });
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

/** A worker that never answers, so the pipeline does nothing of its own. */
const silent = (): WorkerLike => ({ postMessage() {}, terminate() {}, onmessage: null, onerror: null });

/** A worker whose every message the test also sees. */
function tapped(worker: WorkerLike, heard: FromWorker[]): WorkerLike {
  let handler: WorkerLike['onmessage'] = null;
  worker.onmessage = (event) => {
    heard.push(event.data);
    handler?.(event);
  };
  return {
    postMessage: (message, transfer) => worker.postMessage(message, transfer),
    terminate: () => worker.terminate(),
    get onmessage() {
      return handler;
    },
    set onmessage(next) {
      handler = next;
    },
    get onerror() {
      return worker.onerror;
    },
    set onerror(next) {
      worker.onerror = next;
    },
  };
}

/**
 * Every buffer an object reaches through any own property, enumerable or not, of any class, and through a
 * Map's or a Set's entries, with a path to it, past the keys named: a stricter walk than the meter's, to
 * find what a heldArrays() list leaves out.
 */
function everyBuffer(root: unknown, skip: ReadonlySet<string>): Map<ArrayBufferLike, string> {
  const found = new Map<ArrayBufferLike, string>();
  const visited = new Set<object>();
  const stack: [unknown, string][] = [[root, 'this']];
  while (stack.length > 0) {
    const [value, path] = stack.pop()!;
    if (value === null || typeof value !== 'object') continue;
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const buffer = value instanceof ArrayBuffer ? value : value.buffer;
      if (!found.has(buffer)) found.set(buffer, path);
      continue;
    }
    if (visited.has(value)) continue;
    visited.add(value);
    if (value instanceof Map) for (const [key, item] of value) stack.push([key, `${path}<key>`], [item, `${path}<${String(key)}>`]);
    else if (value instanceof Set) for (const item of value) stack.push([item, `${path}{}`]);
    else
      for (const key of Object.getOwnPropertyNames(value)) {
        if (skip.has(key)) continue;
        stack.push([(value as Record<string, unknown>)[key], `${path}.${key}`]);
      }
  }
  return found;
}

/** What a heldArrays() list misses of what its owner holds, by path and size. */
function missed(owner: unknown, held: unknown[], skip: ReadonlySet<string>): string[] {
  const seen = new Set<ArrayBufferLike>();
  arrayBytes(held, seen);
  return [...everyBuffer(owner, skip)].filter(([buffer]) => buffer.byteLength > 0 && !seen.has(buffer)).map(([buffer, path]) => `${path}: ${buffer.byteLength} bytes`);
}

const pipelines: Pipeline[] = [];
afterEach(() => {
  pipelines.splice(0).forEach((p) => p.dispose());
});

describe('MM1: the store reads the meter', () => {
  it('within 500 ms of a change, at once when a figure falls, never with nothing new, and not at all while the page is hidden', () => {
    const clock = new ManualClock();
    const pipeline = new Pipeline({ spawnField: silent, spawnSolid: silent, frozen: true, timers: clock, now: () => clock.now });
    pipelines.push(pipeline);
    let reads = 0;
    const held = pipeline.heldArrays.bind(pipeline);
    pipeline.heldArrays = () => {
      reads++;
      return held();
    };
    const store = new Store(pipeline);
    let hidden = false;
    const listeners: (() => void)[] = [];
    const page: MeterPage = { hidden: () => hidden, onVisibility: (listener) => listeners.push(listener) };
    const show = (now: boolean): void => {
      hidden = !now;
      listeners.forEach((listener) => listener());
    };
    // Nothing is read before the meter starts, as in a Node test of the store.
    pipeline.memory.report('field', { wasm: 0, arrays: 5e6 });
    expect(reads).toBe(0);
    store.startMemoryMeter(page, clock, () => clock.now);
    expect(reads).toBe(1);
    expect(store.memory.value.total).toBe(5e6);
    // A burst of figures within the throttle is one reading, at its end.
    for (let k = 1; k <= 20; k++) {
      clock.advance(10);
      pipeline.memory.report('solid', { wasm: k * 1e6, arrays: 0 });
    }
    expect(reads).toBe(1);
    clock.advance(MEMORY_THROTTLE_MS - 200);
    expect(reads).toBe(2);
    expect(store.memory.value.total).toBe(25e6);
    // With nothing new it reads nothing: it has no clock of its own.
    clock.advance(60_000);
    expect(reads).toBe(2);
    // A figure after a long quiet reads at once; one soon after waits for the throttle.
    pipeline.memory.report('reports', { wasm: 0, arrays: 1e6 });
    expect(reads).toBe(3);
    pipeline.memory.report('reports', { wasm: 0, arrays: 2e6 });
    expect(reads).toBe(3);
    // A figure that falls shows at once, and takes the waiting reading's place.
    pipeline.memory.drop('solid');
    expect(reads).toBe(4);
    expect(store.memory.value.parts).toEqual({ page: { wasm: 0, arrays: 0 }, field: { wasm: 0, arrays: 5e6 }, reports: { wasm: 0, arrays: 2e6 } });
    clock.advance(MEMORY_THROTTLE_MS);
    expect(reads).toBe(4);
    // Hidden: no reading at all, whatever happens, and none waiting from before.
    pipeline.memory.report('solid', { wasm: 3e6, arrays: 0 });
    pipeline.memory.report('solid', { wasm: 4e6, arrays: 0 });
    expect(reads).toBe(5);
    show(false);
    pipeline.memory.report('solid', { wasm: 9e6, arrays: 0 });
    pipeline.memory.drop('field');
    clock.advance(10 * MEMORY_THROTTLE_MS);
    expect(reads).toBe(5);
    expect(store.memory.value.total).toBe(10e6);
    // Shown again: at once.
    show(true);
    expect(reads).toBe(6);
    expect(store.memory.value.total).toBe(11e6);
    // The same reading again sets nothing, so the strip's item does not draw again.
    const before = store.memory.value;
    store.measureMemory();
    expect(store.memory.value).toBe(before);
    // A change the pipeline makes is read too, as main's own arrays change with it.
    clock.advance(MEMORY_THROTTLE_MS);
    pipeline.load(new Uint8Array(684), 'empty.stl');
    expect(reads).toBe(8);
    expect(store.memory.value.parts.page!.arrays).toBe(684);
  });

  it("counts the view's arrays once with the pipeline's, as one walk, and a file that waits on the replace question until it is answered", { timeout: 120_000 }, async () => {
    const clock = new ManualClock();
    const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true });
    pipelines.push(p);
    const store = new Store(p);
    store.startMemoryMeter({ hidden: () => false, onVisibility() {} }, clock, () => clock.now);
    store.load(exampleBytes('jersey'), EXAMPLE_FILES.jersey);
    await p.idle();
    const page = (): number => {
      clock.advance(MEMORY_THROTTLE_MS);
      store.measureMemory();
      return store.memory.value.parts.page!.arrays;
    };
    const alone = page();
    expect(alone).toBeGreaterThan(exampleBytes('jersey').byteLength);
    // The view draws the pipeline's own arrays: they count once, so the share does not change.
    const welded = p.parsed!.value.welded, cover = p.cover!.value;
    store.setViewRoots(() => [welded.positions, { attributes: { position: { array: welded.positions } } }, { array: cover.indices }, ...p.heldArrays()]);
    expect(page()).toBe(alone);
    // An array of the view's own counts in full.
    const normals = new Float32Array(welded.positions.length);
    store.setViewRoots(() => [welded.positions, normals]);
    expect(page()).toBe(alone + normals.byteLength);
    store.setViewRoots(() => []);

    // A file that would replace the model with changes not saved waits on the question, and holds its bytes meanwhile.
    store.setParam('silicone.t', 4);
    await p.idle();
    const before = page();
    const other = exampleBytes('jersey').slice();
    await store.openFile(new File([other], 'other.stl'));
    expect(store.replacing.value).not.toBeNull();
    expect(page()).toBe(before + other.byteLength);
    // Kept out: its bytes leave the meter at once, without waiting for the throttle.
    clock.advance(1);
    store.measureMemory();
    const waiting = store.memory.value.parts.page!.arrays;
    clock.advance(1);
    await store.answerReplace('cancel');
    expect(store.replacing.value).toBeNull();
    expect(store.memory.value.parts.page!.arrays).toBe(waiting - other.byteLength);
  });

  it("never throws from a reading, which runs inside the workers' and the pipeline's handlers: a walk that fails leaves the page's last figure", () => {
    const pipeline = new Pipeline({ spawnField: silent, spawnSolid: silent, frozen: true });
    pipelines.push(pipeline);
    const store = new Store(pipeline);
    store.setViewRoots(() => [new Uint8Array(1000)]);
    store.measureMemory();
    expect(store.memory.value.parts.page).toEqual({ wasm: 0, arrays: 1000 });
    pipeline.memory.report('solid', { wasm: 5e6, arrays: 0 });
    store.setViewRoots(() => {
      throw new Error('a view that cannot be walked');
    });
    expect(() => store.measureMemory()).not.toThrow();
    expect(store.memory.value).toEqual({ total: 5e6 + 1000, parts: { page: { wasm: 0, arrays: 1000 }, solid: { wasm: 5e6, arrays: 0 } } });
  });
});

describe('MM1: what the pipeline and its workers say they hold', () => {
  it("every message of a gate's or an export's worker says what it holds: field.worker its caches, at least the welded mesh, and solid.worker its heap whole", { timeout: 120_000 }, async () => {
    const heard: { field: FromWorker[]; solid: FromWorker[] } = { field: [], solid: [] };
    const p = new Pipeline({ spawnField: () => tapped(inProcessField(), heard.field), spawnSolid: () => tapped(inProcessSolid(), heard.solid), frozen: true, reports: true });
    pipelines.push(p);
    p.load(exampleBytes('jersey'), EXAMPLE_FILES.jersey);
    await p.idle();
    const welded = p.parsed!.value.welded;
    const kinds = new Set(['ready', 'stage', 'result', 'miss', 'error', 'progress']);
    for (const message of [...heard.field, ...heard.solid].filter((m) => kinds.has(m.t))) expect(message, message.t).toHaveProperty('memory');
    const results = (list: FromWorker[]) => list.filter((m): m is Extract<FromWorker, { t: 'result' }> => m.t === 'result');
    // The field reaches main in a message of its own, ahead of placement, whose result ends T1.
    const field = results(heard.field).find((m) => 'S7' in m.outputs)!;
    expect(field.memory!.wasm).toBe(0);
    expect(field.memory!.arrays).toBeGreaterThanOrEqual(welded.positions.byteLength + welded.indices.byteLength);
    for (const message of results(heard.solid)) expect(message.memory!.wasm).toBe(message.heapBytes);
    // The ledger has each worker's last word: the preview's field.worker, the reports' and the solid worker.
    const parts = p.memory.parts();
    expect(Object.keys(parts)).toEqual(['field', 'solid', 'reports']);
    expect(parts.solid!.wasm).toBe((await p.readSolidHeap()).capacity);
    expect(parts.field!.arrays).toBeGreaterThanOrEqual(welded.positions.byteLength + welded.indices.byteLength);

    // A recycle ends the solid worker, and its heap leaves the meter before the fresh one says anything.
    p.recycleSolid();
    expect(p.memory.parts().solid).toBeUndefined();
    const end = performance.now() + 20_000;
    while (!p.memory.parts().solid && performance.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(p.memory.parts().solid!.wasm).toBeGreaterThan(0);

    // The export's worker counts while it runs, its heap, its inputs and what it has built so far, and goes when it ends.
    const during: [string, WorkerMemory | undefined][] = [];
    const exported = await p.exportParts((progress) => during.push([progress.step, p.memory.parts().export]));
    const at = new Map(during.filter(([step]) => step !== 'wait').map(([step, memory]) => [step, memory!]));
    expect([...at.keys()]).toEqual(['import', 'field', 'tool', 'cover', 'base', 'clearance', 'files', 'zip']);
    for (const memory of at.values()) {
      expect(memory.wasm).toBeGreaterThan(0);
      expect(memory.arrays).toBeGreaterThanOrEqual(welded.positions.byteLength + welded.indices.byteLength);
    }
    // The export's field counts as soon as its step ends, and the parts' files once they are made (the zip step adds its texts).
    expect(at.get('tool')!.arrays).toBeGreaterThan(at.get('field')!.arrays);
    const files = Object.entries(exported.files).reduce((sum, [name, bytes]) => sum + (name.endsWith('.stl') ? bytes.byteLength : 0), 0);
    expect(Object.keys(exported.files).filter((name) => name.endsWith('.stl')).sort()).toEqual(['base.stl', 'cover.stl', 'funnel.stl', 'model_oriented.stl']);
    expect(at.get('zip')!.arrays).toBeGreaterThanOrEqual(at.get('tool')!.arrays + files);
    expect(p.memory.parts().export).toBeUndefined();
    p.dispose();
    expect(p.memory.parts()).toEqual({});
  });

  it("an export holds one build at a time: after a raise of the margin the first build no longer counts", { timeout: 120_000 }, async () => {
    const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true });
    pipelines.push(p);
    p.load(exampleBytes('jersey'), EXAMPLE_FILES.jersey);
    p.setParams((params) => (params.silicone.printMargin = -0.6));
    await p.idle();
    const during: [string, number][] = [];
    const exported = await p.exportParts((progress) => during.push([progress.step, p.memory.parts().export?.arrays ?? 0]));
    expect(exported.clearance!.raisedBy).toBeGreaterThan(0);
    const steps = during.map(([step]) => step);
    expect(steps).toEqual(['import', 'field', 'tool', 'cover', 'base', 'clearance', 'raise', 'clearance', 'files', 'zip']);
    const [field, first, , again] = [1, 5, 6, 7].map((k) => during[k][1]);
    const build = first - field;
    expect(build).toBeGreaterThan(0);
    // Held twice, the raise's build would add a whole build again; held once, it only differs by its larger field.
    expect(again - first, `the first build ${build} bytes, after the raise ${again - field}`).toBeLessThan(build / 2);
  });

  it("the hosts' miss and error replies say what the worker holds, as their results do", { timeout: 60_000 }, async () => {
    const replies: FromWorker[] = [];
    const handle = fieldHost((message) => replies.push(message), () => 0);
    const params = defaultParams();
    const keysOf = (file: string) => stageKeys(params, { file, import: 'plain', plane: JSON.stringify(DEFAULT_PLANE), tier: 'preview', cellScale: 1, pins: [], removed: [], drag: null, outside: '' });
    const inputs = (file: ArrayBuffer | null) => ({ file, import: PLAIN_IMPORT, plane: DEFAULT_PLANE, cellScale: 1, pins: [], removed: [] });
    handle({ t: 'field', id: 1, keys: keysOf('f'), want: ['S6', 'S7'], params, inputs: inputs(exampleBytes('jersey').slice().buffer) });
    const held = (replies.find((m) => m.t === 'result') as Extract<FromWorker, { t: 'result' }>).memory!;
    expect(held.arrays).toBeGreaterThan(0);
    // Another file's job with no file sent: a miss. A crash: an error. The reports' worker misses and crashes too.
    handle({ t: 'field', id: 2, keys: keysOf('f'), want: ['S6'], params, inputs: inputs(null), fault: { kind: 'oob' } });
    handle({ t: 'field', id: 3, keys: keysOf('g'), want: ['S6'], params, inputs: inputs(null) });
    handle({ t: 'reports', id: 4, keys: keysOf('f'), params, inputs: { mesh: null } as never });
    handle({ t: 'reports', id: 5, keys: keysOf('f'), params, inputs: { mesh: null } as never, fault: { kind: 'oob' } });
    const answers = replies.filter((m) => m.t === 'miss' || m.t === 'error').map((m) => [m.t, (m as { id: number }).id, 'memory' in m ? m.memory : 'none']);
    expect(answers).toEqual([
      ['error', 2, held],
      ['miss', 3, { wasm: 0, arrays: expect.any(Number) }],
      ['miss', 4, { wasm: 0, arrays: expect.any(Number) }],
      ['error', 5, { wasm: 0, arrays: expect.any(Number) }],
    ]);

    // solid.worker: a job with no model sent misses, and a crash errs; both say its heap, whole.
    const heard: FromWorker[] = [];
    const solid = tapped(inProcessSolid(), heard);
    solid.onmessage = () => {};
    const job = (id: number, fault?: ToWorker extends infer M ? (M extends { fault?: infer F } ? F : never) : never): ToWorker => ({ t: 'solid', id, keys: keysOf('f'), want: ['S1'], params, inputs: { model: null, drag: null } as never, ...(fault ? { fault } : {}) });
    solid.postMessage(job(1));
    solid.postMessage(job(2, { kind: 'oob' }));
    const end = performance.now() + 30_000;
    while (heard.filter((m) => m.t === 'miss' || m.t === 'error').length < 2 && performance.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
    const ready = heard.find((m) => m.t === 'ready') as Extract<FromWorker, { t: 'ready' }>;
    const solidAnswers = heard.filter((m) => m.t === 'miss' || m.t === 'error').map((m) => [m.t, 'memory' in m ? m.memory : 'none']);
    expect(solidAnswers).toEqual([
      ['miss', { wasm: ready.heapBytes, arrays: 0 }],
      ['error', { wasm: ready.heapBytes, arrays: 0 }],
    ]);
    solid.terminate();
  });

  it('a worker whose figure cannot be worked out still sends its result and its errors, only without a figure', () => {
    const spy = vi.spyOn(FieldStages.prototype, 'heldArrays').mockImplementation(() => {
      throw new Error('a cache that cannot be walked');
    });
    try {
      const replies: FromWorker[] = [];
      const handle = fieldHost((message) => replies.push(message), () => 0);
      const params = defaultParams();
      const keys = stageKeys(params, { file: 'f', import: 'plain', plane: JSON.stringify(DEFAULT_PLANE), tier: 'preview', cellScale: 1, pins: [], removed: [], drag: null, outside: '' });
      const inputs = (file: ArrayBuffer | null) => ({ file, import: PLAIN_IMPORT, plane: DEFAULT_PLANE, cellScale: 1, pins: [], removed: [] });
      handle({ t: 'field', id: 1, keys, want: ['S6', 'S7'], params, inputs: inputs(exampleBytes('jersey').slice().buffer) });
      handle({ t: 'field', id: 2, keys, want: ['S6'], params, inputs: inputs(null), fault: { kind: 'oob' } });
      expect(replies.map((m) => [m.t, 'memory' in m ? m.memory : undefined])).toEqual([
        ['stage', undefined],
        ['result', undefined],
        ['error', undefined],
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('a figure the pipeline cannot take never stops an export', { timeout: 120_000 }, async () => {
    const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true });
    pipelines.push(p);
    p.load(exampleBytes('jersey'), EXAMPLE_FILES.jersey);
    await p.idle();
    const report = p.memory.report.bind(p.memory);
    p.memory.report = (source, memory) => {
      if (source === 'export') throw new Error('a meter that fails');
      report(source, memory);
    };
    // Every step still reaches the stage bar, and the files come.
    const steps: string[] = [];
    const exported = await p.exportParts((progress) => steps.push(progress.step));
    expect(steps).toEqual(['import', 'field', 'tool', 'cover', 'base', 'clearance', 'files', 'zip']);
    expect(Object.keys(exported.files)).toContain('cover.stl');
  });

  it('each heldArrays() reaches every buffer its owner keeps: the pipeline, and the field, reports and solid workers\' caches, for a model, one with holes and one the import turns inside out', { timeout: 120_000 }, async () => {
    // The pipeline's gates, workers, options and records hold no model; the solid caches' engine is its heap, counted whole.
    const pipelineSkip = new Set(['fieldGate', 'solidGate', 'reportsGate', 'options', 'memory', 'budgets', 'listeners', 'timers', 'log', 'events', 'idleWaiters', 'exportWorker', 'wallJob']);
    const engine = new Set(['api', 'simplifier']);
    const field = vi.spyOn(FieldStages.prototype, 'run'), reports = vi.spyOn(ReportStages.prototype, 'run'), solid = vi.spyOn(SolidStages.prototype, 'run');
    try {
      const models: [string, Uint8Array, boolean][] = [
        ['jersey', exampleBytes('jersey'), true],
        ['open box', asciiStl(toSoup(boxWithTopHole(4)), 'open'), false],
        ['inside-out box', asciiStl(toSoup(inverted(box([0, 0, 0], [20, 20, 10]))), 'flipped'), false],
      ];
      for (const [name, bytes, exportIt] of models) {
        for (const spy of [field, reports, solid]) spy.mockClear();
        const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true, reports: true });
        pipelines.push(p);
        p.load(bytes, `${name}.stl`);
        await p.idle();
        if (exportIt) await p.exportParts();
        expect(field.mock.contexts.length * solid.mock.contexts.length, name).toBeGreaterThan(0);
        expect(missed(p, p.heldArrays(), pipelineSkip), `${name}: the pipeline`).toEqual([]);
        for (const stages of new Set(field.mock.contexts as FieldStages[])) expect(missed(stages, stages.heldArrays(), engine), `${name}: field.worker`).toEqual([]);
        for (const stages of new Set(reports.mock.contexts as ReportStages[])) expect(missed(stages, stages.heldArrays(), engine), `${name}: the reports`).toEqual([]);
        for (const stages of new Set(solid.mock.contexts as SolidStages[])) expect(missed(stages, stages.heldArrays(), engine), `${name}: solid.worker`).toEqual([]);
      }
    } finally {
      for (const spy of [field, reports, solid]) spy.mockRestore();
    }
  });

  it("main's own share counts the file, the welded mesh, the cover, the base and the last export's files, each buffer once", { timeout: 120_000 }, async () => {
    const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true });
    pipelines.push(p);
    p.load(exampleBytes('jersey'), EXAMPLE_FILES.jersey);
    await p.idle();
    const exported = await p.exportParts();
    const expected = [p.stlBytes!, p.parsed!.value.welded.positions, p.parsed!.value.welded.indices, p.cover!.value.positions, p.cover!.value.indices, p.base!.value.positions, p.base!.value.indices, ...Object.values(exported.files)];
    const buffers = new Set(expected.map((array) => array.buffer));
    expect(buffers.size).toBe(expected.length);
    const seen = new Set<ArrayBufferLike>();
    const share = arrayBytes(p.heldArrays(), seen);
    for (const array of expected) expect(seen.has(array.buffer), `${array.constructor.name} of ${array.byteLength} bytes`).toBe(true);
    // Each buffer once: the share is the sum over the buffers it saw, at least those above.
    expect(share).toBe([...seen].reduce((sum, buffer) => sum + buffer.byteLength, 0));
    expect(share).toBeGreaterThanOrEqual([...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0));
    expect(exampleBytes('jersey').byteLength).toBe(p.stlBytes!.byteLength);
  });
});

describe('MM2: what simplifying a model holds', () => {
  it('the prepare worker says what it holds as it says ready and as each step begins, at least the welded file while it simplifies and the lock loop\'s arrays while it measures, and its figure goes with it', { timeout: 120_000 }, async () => {
    const ledger = new MemoryLedger();
    const said: { t: string; step?: string; memory?: WorkerMemory }[] = [];
    const simplifier = new ModelSimplifier(() => {
      const worker = inProcessSolid();
      const real = worker.onmessage;
      void real;
      return new Proxy(worker, {
        set(target, key, value) {
          if (key === 'onmessage' && value) {
            target.onmessage = (event: { data: FromWorker }) => {
              said.push({ t: event.data.t, step: 'step' in event.data ? event.data.step : undefined, memory: 'memory' in event.data ? event.data.memory : undefined });
              value(event);
            };
            return true;
          }
          return Reflect.set(target, key, value);
        },
      });
    }, ledger);
    const bytes = exampleBytes('benchy');
    const welded = weld(parseStl(bytes).positions);
    const seen: (WorkerMemory | undefined)[] = [];
    ledger.subscribe((source) => source === 'simplify' && seen.push(ledger.parts().simplify));
    const prepared = await simplifier.run({ kind: 'stl', blob: new Blob([bytes as BlobPart]) }, EXAMPLE_FILES.benchy, { target: 50_000, maxErrorMm: 0.05 });
    expect(prepared.record!.triangles).toBe(49_998);
    expect(said.map((m) => m.step ?? m.t)).toEqual(['ready', 'read', 'parse', 'simplify', 'measure', 'check', 'write', 'prepared']);
    for (const m of said.filter((m) => m.t !== 'prepared')) expect(m.memory?.wasm, m.step ?? m.t).toBeGreaterThan(0);
    const simplifying = said.find((m) => m.step === 'simplify')!.memory!;
    expect(simplifying.arrays).toBeGreaterThanOrEqual(welded.positions.byteLength + welded.indices.byteLength);
    // MM2's review: while the round measures, the lock loop's own arrays too: the locks, the bound's distance at
    // each vertex of the file, the copy and its buckets, which a figure of the welded file alone would leave out.
    const vertices = welded.positions.length / 3;
    const measuring = said.find((m) => m.step === 'measure')!.memory!;
    expect(measuring.arrays).toBeGreaterThanOrEqual(welded.positions.byteLength + welded.indices.byteLength + vertices * 9 + prepared.stl.byteLength / 50 * 36);
    // While it parses, the file's bytes, which it lets go of once parsed: the welded file alone is less.
    expect(said.find((m) => m.step === 'parse')!.memory!.arrays).toBeGreaterThanOrEqual(bytes.byteLength);
    expect(bytes.byteLength).toBeGreaterThan(welded.positions.byteLength + welded.indices.byteLength);
    expect(seen.at(-1)).toBeUndefined();
    expect(ledger.parts().simplify).toBeUndefined();
  });

  it('an export\'s worker counts the file it reads for model_oriented.stl from that step on, and not before', { timeout: 120_000 }, async () => {
    const api = await loadManifold();
    await MeshoptSimplifier.ready;
    const bytes = exampleBytes('jersey');
    const prepared = runPrepareJob(api, MeshoptSimplifier, { source: { kind: 'stl', blob: new Blob([bytes as BlobPart]) }, name: EXAMPLE_FILES.jersey, simplify: { target: 900, maxErrorMm: 0.05 } }, () => bytes, () => {}, () => performance.now());
    const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true });
    pipelines.push(p);
    p.load(prepared.stl, EXAMPLE_FILES.jersey, { original: { kind: 'stl', blob: new Blob([bytes as BlobPart]) }, from: prepared.from, record: prepared.record, repair: null });
    await p.idle();
    const during: [string, number][] = [];
    await p.exportParts((progress) => during.push([progress.step, p.memory.parts().export?.arrays ?? 0]));
    const at = (step: string): number => during.find(([s]) => s === step)![1];
    // The figure at the file's own step is what came before, and from the files on it holds the file's STL.
    const stl = 84 + 50 * prepared.from.triangles;
    expect(at('files') - at('original')).toBeGreaterThanOrEqual(stl);
    // The file's own bytes, its soup and its welded mesh are let go as each step replaces them: only the STL stays.
    expect(at('files') - at('original')).toBeLessThan(stl + bytes.byteLength / 2);
    expect(at('original') - at('clearance')).toBeLessThan(stl);
  });

  it('past the warning figure the tooltip points at Simplify… only where the Model section offers it', () => {
    const reading = { total: 1e9, parts: { page: { wasm: 0, arrays: 1e8 }, solid: { wasm: 9e8, arrays: 0 } } };
    expect(memoryTitle(reading).split('\n')[1]).toBe(MEMORY_ADVICE);
    expect(memoryTitle(reading, MEMORY_WARN_BYTES, true).split('\n')[1]).toBe(MEMORY_ADVICE_SIMPLIFY);
    expect(MEMORY_ADVICE_SIMPLIFY).toBe('That is a lot for one web page: close other browser tabs to free memory, or use Simplify… in the Model section to make the model lighter.');
    // Under it there is no advice at all, Simplify… or not.
    expect(memoryTitle({ ...reading, total: 1e8 }, MEMORY_WARN_BYTES, true)).not.toContain('Simplify');
  });
});
