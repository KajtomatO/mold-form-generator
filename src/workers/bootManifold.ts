import Module from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';

type Toplevel = Awaited<ReturnType<typeof Module>>;

export interface BootedManifold {
  api: Toplevel;
  /** Size of the WASM heap, or null if the glue hides the memory object. */
  heapBytes(): number | null;
}

/**
 * Loads Manifold through instantiateWasm so we can hold the memory object: the npm
 * typings do not expose heap size, and worker recycling depends on knowing it.
 */
export async function bootManifold(): Promise<BootedManifold> {
  let memory: WebAssembly.Memory | null = null;
  let fail: (reason: unknown) => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });

  const config = {
    locateFile: () => wasmUrl,
    instantiateWasm(
      imports: WebAssembly.Imports,
      done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
    ): object {
      fetch(wasmUrl)
        .then((response) => response.arrayBuffer())
        .then((bytes) => WebAssembly.instantiate(bytes, imports))
        .then(({ instance, module }) => {
          const found = Object.values(instance.exports).find((v) => v instanceof WebAssembly.Memory);
          memory = (found as WebAssembly.Memory | undefined) ?? null;
          done(instance, module);
        })
        .catch(fail);
      return {};
    },
  };

  const api = await Promise.race([Module(config as Parameters<typeof Module>[0]), failed]);
  api.setup();
  return { api, heapBytes: () => (memory ? memory.buffer.byteLength : null) };
}
