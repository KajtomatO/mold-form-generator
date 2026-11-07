import { runBench } from '../core/bench/suite';
import { withArena } from '../core/solid/arena';
import { bootManifold } from './bootManifold';

// Attach before any await: a module worker's message port starts delivering right after
// the script's first synchronous run, and a message arriving before onmessage exists is lost.
const queue: MessageEvent[] = [];
self.onmessage = (event) => queue.push(event);

const started = performance.now();
const { api, heapBytes } = await bootManifold();

function handle(event: MessageEvent): void {
  const job = event.data;
  if (job.t === 'boolean') {
    const volume = withArena(api, ({ track }) => {
      const box = track(api.Manifold.cube([job.size, job.size, job.size], true));
      const ball = track(api.Manifold.sphere(job.size * 0.3, 64));
      return track(box.subtract(ball)).volume();
    });
    self.postMessage({ t: 'result', id: job.id, volume, heapBytes: heapBytes() });
  } else if (job.t === 'echo') {
    const bytes = new Uint8Array(job.buffer as ArrayBuffer);
    self.postMessage({ t: 'echoed', length: bytes.length, first: bytes[0] });
  } else if (job.t === 'bench') {
    const results = runBench(api, () => performance.now());
    self.postMessage({ t: 'bench', results, heapBytes: heapBytes() });
  }
}

self.postMessage({ t: 'ready', bootMs: performance.now() - started, heapBytes: heapBytes() });
self.onmessage = handle;
queue.forEach(handle);
