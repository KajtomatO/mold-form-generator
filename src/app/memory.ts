/**
 * The memory meter (MM1): what the app itself holds for the model, added up from figures the app already
 * has. Each worker says what it holds in every message it sends anyway, and main counts its own arrays, so
 * nothing polls a worker, which a busy one could not answer. No browser call that rounds, delays or needs
 * a secure context or cross-origin isolation is used: none gives a live figure in both Firefox and Chromium.
 * Pure TS with no DOM, so the workers and Node tests load it too.
 */

/** What one worker holds, as it says in each message it sends. */
export interface WorkerMemory {
  /** Its WebAssembly heap in bytes: Manifold's in solid.worker, 0 in field.worker. */
  wasm: number;
  /** The typed arrays its caches keep between jobs, each buffer once, at its full length, in bytes. */
  arrays: number;
}

/**
 * Where a figure comes from: main's own arrays ('page'), the preview's field.worker, its solid.worker, the
 * reports' field.worker, an export's worker while it runs, and the one that simplifies a model on opening
 * (MM2), each while it lives.
 */
export type MemorySource = 'page' | 'field' | 'solid' | 'reports' | 'export' | 'simplify';

/** In the order the meter's tooltip lists them. */
export const MEMORY_SOURCES: readonly MemorySource[] = ['page', 'field', 'solid', 'reports', 'export', 'simplify'];

/**
 * From this many bytes the meter turns amber and its tooltip says what to do. Set at MM1 from the meter's
 * own readings, the same in Chromium and Firefox (docs/PLAN.md, Measured at MM1): the 3 million triangle
 * test model reads 0.84 GB once its preview stands, and 1.18 GB in merged mode; of the examples, from
 * opening through merged mode to the end of an export with the fit test, the largest, doomedmarine (285,260
 * triangles), peaks at 0.74 GB, with an export's worker beside the preview's, and Benchy at 0.51 GB. It is
 * the reading as it stands, so it goes grey again as a worker is ended. The large-model warning before
 * loading (MM2) is apart from it.
 */
export const MEMORY_WARN_BYTES = 0.8e9;

/** A walk stops past this many objects and arrays, and so reads low rather than hold main up. */
export const MAX_WALKED = 200_000;

const primitive = (value: unknown): boolean => value === null || (typeof value !== 'object' && typeof value !== 'function');

/**
 * An array that can hold no typed array: one of numbers, strings or the like, judged by its first item, or a
 * list of points, an array whose first item is an array of numbers, such as a polygon's [x, y] pairs.
 */
function holdsNoArrays(list: readonly unknown[]): boolean {
  if (list.length === 0) return true;
  const first = list[0];
  if (primitive(first)) return true;
  return Array.isArray(first) && first.length > 0 && primitive(first[0]);
}

/**
 * The bytes of the ArrayBuffers that `roots` reach, each buffer once and at its full length, so a subarray
 * counts the whole buffer it keeps alive, and two views of one buffer count it once. Buffers already in
 * `seen` are not counted again, so one walk can go on from another, and a worker seeds it with its
 * WebAssembly heap, whose views must not count twice. A root's own properties are walked, whatever its
 * class; below the roots only plain objects and arrays are, so a Manifold handle, a three.js object or a
 * WebAssembly module is passed over, as is an array that can hold no typed array. Cycles are walked once.
 * A detached buffer counts 0, as a transfer leaves it.
 */
export function arrayBytes(roots: readonly unknown[], seen: Set<ArrayBufferLike> = new Set()): number {
  let bytes = 0;
  let walked = 0;
  const visited = new Set<object>();
  const stack: unknown[] = [];
  const count = (buffer: ArrayBufferLike): void => {
    if (seen.has(buffer)) return;
    seen.add(buffer);
    bytes += buffer.byteLength;
  };
  /** Counts a buffer or a view at once, and puts what an object or array holds on the stack. */
  const visit = (value: unknown, root: boolean): void => {
    if (primitive(value) || typeof value === 'function') return;
    const object = value as object;
    if (object instanceof ArrayBuffer) return count(object);
    if (ArrayBuffer.isView(object)) return count(object.buffer);
    if (visited.has(object) || walked >= MAX_WALKED) return;
    visited.add(object);
    walked++;
    if (Array.isArray(object)) {
      if (!holdsNoArrays(object)) for (const item of object) stack.push(item);
      return;
    }
    const proto = Object.getPrototypeOf(object) as unknown;
    if (!root && proto !== Object.prototype && proto !== null) return;
    for (const key of Object.keys(object)) stack.push((object as Record<string, unknown>)[key]);
  };
  for (const root of roots) {
    visit(root, true);
    while (stack.length > 0) visit(stack.pop(), false);
  }
  return bytes;
}

/**
 * A worker's figure, or none if working it out throws: the meter rides on messages that carry results and
 * errors, and must never stop one from going. A message without a figure leaves the last one standing.
 */
export function figureOrNone(figure: () => WorkerMemory): WorkerMemory | undefined {
  try {
    return figure();
  } catch {
    return undefined;
  }
}

const sane = (bytes: number): number => (Number.isFinite(bytes) && bytes > 0 ? bytes : 0);

/**
 * Each source's latest figure. A worker's goes when the worker does, so a respawned, recycled or ended
 * worker's heap is never counted after it is gone. Listeners hear every change, with whether it was a drop,
 * which the store shows at once: a figure that falls must never wait behind one that rose.
 */
export class MemoryLedger {
  private readonly held = new Map<MemorySource, WorkerMemory>();
  private readonly listeners = new Set<(source: MemorySource, dropped: boolean) => void>();

  report(source: MemorySource, memory: WorkerMemory): void {
    this.held.set(source, { wasm: sane(memory.wasm), arrays: sane(memory.arrays) });
    for (const listener of this.listeners) listener(source, false);
  }

  drop(source: MemorySource): void {
    if (!this.held.delete(source)) return;
    for (const listener of this.listeners) listener(source, true);
  }

  /** The figures held, in the tooltip's order. */
  parts(): Partial<Record<MemorySource, WorkerMemory>> {
    const out: Partial<Record<MemorySource, WorkerMemory>> = {};
    for (const source of MEMORY_SOURCES) {
      const memory = this.held.get(source);
      if (memory) out[source] = { ...memory };
    }
    return out;
  }

  total(): number {
    let sum = 0;
    for (const { wasm, arrays } of this.held.values()) sum += wasm + arrays;
    return sum;
  }

  subscribe(listener: (source: MemorySource, dropped: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
