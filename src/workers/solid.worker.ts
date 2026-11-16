import { MeshoptSimplifier } from 'meshoptimizer';
import { bootManifold } from './bootManifold';
import type { Post } from './fieldHost';
import { solidHost, solidMemory } from './solidHost';

// Attach before any await: a module worker's message port starts delivering right after the script's
// first synchronous run, and a message arriving before onmessage exists is lost.
const queue: MessageEvent[] = [];
self.onmessage = (event: MessageEvent) => queue.push(event);

const post: Post = (message, transfer) => self.postMessage(message, { transfer: transfer ?? [] });
const started = performance.now();
try {
  const [{ api, heapBytes, heap }] = await Promise.all([bootManifold(), MeshoptSimplifier.ready]);
  const handle = solidHost(api, MeshoptSimplifier, heap, post, () => performance.now());
  post({ t: 'ready', bootMs: performance.now() - started, cached: {}, heapBytes: heapBytes(), memory: solidMemory(heap(), []) });
  self.onmessage = (event: MessageEvent) => handle(event.data);
  queue.forEach((event) => handle(event.data));
} catch (error) {
  // Main shows this inline. Without WASM the worker can do nothing, so it never posts ready.
  post({ t: 'error', id: -1, name: 'BootError', message: `The geometry engine could not start: ${String(error)}`, inline: true, cached: {} });
}
