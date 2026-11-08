import Module, { type ManifoldToplevel } from 'manifold-3d';
import { MeshoptSimplifier } from 'meshoptimizer';
import type { HeavyLimits } from '../../src/core/mesh/simplify';
import { fieldHost, type Post } from '../../src/workers/fieldHost';
import type { FromWorker, ToWorker, WorkerLike } from '../../src/workers/protocol';
import { solidHost } from '../../src/workers/solidHost';
import { runProjectJob, type ProjectJob } from '../../src/workers/projectJob';

/**
 * A worker that runs the real host code in this process. Messages cross by structuredClone with the
 * transfer list, which detaches what is sent just as postMessage does, and arrive on a later task, so
 * the pipeline sees the same order of events it would in a browser. Terminate stops all delivery.
 */
class InProcessWorker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;
  private alive = true;
  private handle: ((message: ToWorker) => void) | null = null;
  private readonly queue: ToWorker[] = [];

  constructor(boot: (post: Post) => Promise<(message: ToWorker) => void>) {
    const post: Post = (message, transfer = []) => {
      const copy = structuredClone(message, { transfer: transfer as Transferable[] }) as FromWorker;
      setTimeout(() => {
        if (this.alive) this.onmessage?.({ data: copy });
      }, 0);
    };
    void boot(post).then((handle) => {
      this.handle = handle;
      // Drained in order, as the real bootstrap does.
      for (const message of this.queue.splice(0)) this.deliver(message);
    });
  }

  postMessage(message: ToWorker, transfer: Transferable[] = []): void {
    const copy = structuredClone(message, { transfer }) as ToWorker;
    // A real worker spins through a delay on its own thread. Here that would stop the pipeline's timers
    // too, so a slow job is a late one instead, and nothing else is delivered while it waits.
    const fault = 'fault' in copy ? copy.fault : undefined;
    const delay = fault?.kind === 'delay' ? fault.ms : 0;
    if (delay > 0) delete (copy as { fault?: unknown }).fault;
    this.chain = this.chain.then(() => new Promise<void>((resolve) => setTimeout(() => {
      if (this.alive) {
        if (this.handle) this.deliver(copy);
        else this.queue.push(copy);
      }
      resolve();
    }, delay)));
  }

  private chain: Promise<void> = Promise.resolve();

  private deliver(message: ToWorker): void {
    if (!this.alive) return;
    try {
      this.handle!(message);
    } catch (error) {
      this.onerror?.({ message: String(error) });
    }
  }

  terminate(): void {
    this.alive = false;
  }
}

const now = (): number => performance.now();

export function inProcessField(): WorkerLike {
  return new InProcessWorker(async (post) => {
    const handle = fieldHost(post, now);
    post({ t: 'ready', bootMs: 0, cached: {}, heapBytes: null });
    return handle;
  });
}

/** A fresh WASM instance per worker, as a respawn in the browser gets. `limits` brings G1.8's path within a test's reach. */
export function inProcessSolid(limits?: HeavyLimits): WorkerLike {
  return new InProcessWorker(async (post) => {
    let memory: WebAssembly.Memory | null = null;
    const api: ManifoldToplevel = await Module({
      instantiateWasm(imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance) => void) {
        void import('node:fs').then(async ({ readFileSync }) => {
          const path = new URL('../../node_modules/manifold-3d/manifold.wasm', import.meta.url);
          const { instance } = await WebAssembly.instantiate(readFileSync(path), imports);
          memory = Object.values(instance.exports).find((v) => v instanceof WebAssembly.Memory) as WebAssembly.Memory;
          done(instance);
        });
        return {};
      },
    } as unknown as Parameters<typeof Module>[0]);
    api.setup();
    await MeshoptSimplifier.ready;
    const heapBytes = (): number | null => (memory ? memory.buffer.byteLength : null);
    const handle = solidHost(api, MeshoptSimplifier, heapBytes, post, now, limits);
    post({ t: 'ready', bootMs: 0, cached: {}, heapBytes: heapBytes() });
    return handle;
  });
}

/** project.worker's own job code, in this process. */
export function inProcessProject(): WorkerLike {
  return new InProcessWorker(async (post) => (message) => {
    const { reply, transfer } = runProjectJob(message as ProjectJob);
    post(reply, transfer);
  });
}
