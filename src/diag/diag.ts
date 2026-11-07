import { zipSync } from 'fflate';
import { saveBytes } from '../app/download';
import { writeBinaryStl } from '../core/stl/write';
import { probeGl, type GlProbeResult } from '../view/glProbe';

interface DiagResults {
  secureContext: boolean;
  sharedArrayBuffer: boolean;
  webGpu: boolean;
  bootMs: number | null;
  heapBytes: number | null;
  jobsBeforeReady: { id: number; volume: number }[];
  gl: GlProbeResult | null;
  transferSourceLength: number | null;
  transferEchoLength: number | null;
  indexedDb: boolean | string;
  error: string | null;
}

// A tetrahedron: small, closed, and asymmetric.
const positions = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]);
const indices = new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]);
const stlBytes = writeBinaryStl(positions, indices);
const zipBytes = zipSync({ 'test.stl': [stlBytes, { mtime: new Date('2020-01-01T00:00:00Z') }] });

const results: DiagResults = {
  secureContext: window.isSecureContext,
  sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  webGpu: 'gpu' in navigator,
  bootMs: null,
  heapBytes: null,
  jobsBeforeReady: [],
  gl: null,
  transferSourceLength: null,
  transferEchoLength: null,
  indexedDb: false,
  error: null,
};

function render(): void {
  const table = document.querySelector('#results') as HTMLTableElement;
  table.replaceChildren();
  const add = (label: string, value: unknown): void => {
    const row = table.insertRow();
    row.insertCell().textContent = label;
    row.insertCell().textContent = typeof value === 'string' ? value : JSON.stringify(value);
  };
  add('Secure context', results.secureContext);
  add('SharedArrayBuffer', results.sharedArrayBuffer);
  add('Manifold boot (ms)', results.bootMs === null ? 'pending' : Math.round(results.bootMs));
  add('WASM heap (MB)', results.heapBytes === null ? 'unknown' : Math.round(results.heapBytes / 1048576));
  add('Boolean jobs answered', results.jobsBeforeReady.length);
  add('Renderer', results.gl?.renderer ?? 'pending');
  add('WebGL2', results.gl?.webgl2 ?? 'pending');
  add('Stencil bits', results.gl?.stencilBits ?? 'pending');
  add('Float height texture', results.gl ? results.gl.distinctColours > 8 : 'pending');
  add('Worker transfer', results.transferSourceLength === 0);
  add('IndexedDB', results.indexedDb);
  if (results.error) add('Error', results.error);
}

async function checkWorker(): Promise<void> {
  const worker = new Worker(new URL('../workers/diag.worker.ts', import.meta.url), { type: 'module' });
  const expected = 3;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker did not answer in 60 s')), 60_000);
    let echoed = false;
    const finishIfDone = (): void => {
      if (echoed && results.jobsBeforeReady.length === expected) {
        clearTimeout(timer);
        resolve();
      }
    };
    worker.onerror = (event) => reject(new Error(event.message));
    worker.onmessage = (event) => {
      const message = event.data;
      if (message.t === 'ready') {
        results.bootMs = message.bootMs;
        results.heapBytes = message.heapBytes;
      } else if (message.t === 'result') {
        results.jobsBeforeReady.push({ id: message.id, volume: message.volume });
        results.heapBytes = message.heapBytes;
      } else if (message.t === 'echoed') {
        results.transferEchoLength = message.length;
        echoed = true;
      }
      render();
      finishIfDone();
    };
    // Sent before WASM has finished loading: none of these may be lost.
    for (let id = 0; id < expected; id++) worker.postMessage({ t: 'boolean', id, size: 20 + id });
    const buffer = new Uint8Array(1024).fill(7).buffer;
    worker.postMessage({ t: 'echo', buffer }, [buffer]);
    results.transferSourceLength = buffer.byteLength;
  });
  worker.terminate();
}

function checkIndexedDb(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const name = 'cfg-diag';
    const open = indexedDB.open(name, 1);
    open.onerror = () => reject(open.error);
    open.onupgradeneeded = () => open.result.createObjectStore('s');
    open.onsuccess = () => {
      const db = open.result;
      const put = db.transaction('s', 'readwrite').objectStore('s').put(new Uint8Array([1, 2, 3]), 'k');
      put.onerror = () => reject(put.error);
      put.onsuccess = () => {
        const get = db.transaction('s').objectStore('s').get('k');
        get.onerror = () => reject(get.error);
        get.onsuccess = () => {
          const ok = (get.result as Uint8Array)[2] === 3;
          db.close();
          indexedDB.deleteDatabase(name);
          resolve(ok);
        };
      };
    };
  });
}

/** G12: built by the real builders in a fresh worker, as an export is. */
function downloadFitTest(): Promise<void> {
  const status = document.querySelector('#fit-status') as HTMLElement;
  const taperClearance = (document.querySelector('#fit-taper') as HTMLInputElement).valueAsNumber;
  if (!(taperClearance > 0)) {
    status.textContent = 'Please enter a taper clearance above 0 mm.';
    return Promise.resolve();
  }
  status.textContent = 'Building 8 pairs...';
  const worker = new Worker(new URL('../workers/diag.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<void>((resolve) => {
    const finish = (message: string): void => {
      status.textContent = message;
      worker.terminate();
      resolve();
    };
    worker.onerror = (event) => finish(`Could not build the pieces: ${event.message}`);
    worker.onmessage = (event) => {
      const message = event.data;
      if (message.t !== 'fit-test') return;
      saveBytes('fit-test.zip', message.zip, 'application/zip');
      finish(`Saved fit-test.zip, ${Math.round(message.zip.length / 1024)} KB. Its README.txt says how to read the result.`);
    };
    worker.postMessage({ t: 'fit-test', taperClearance });
  });
}

document.querySelector('#dl-fit')?.addEventListener('click', () => void downloadFitTest());
document.querySelector('#dl-stl')?.addEventListener('click', () => saveBytes('cfg-test.stl', stlBytes, 'model/stl'));
document.querySelector('#dl-zip')?.addEventListener('click', () => saveBytes('cfg-test.zip', zipBytes, 'application/zip'));

const done = (async (): Promise<DiagResults> => {
  render();
  try {
    results.gl = probeGl(document.querySelector('#gl') as HTMLCanvasElement);
    render();
    await checkWorker();
    results.indexedDb = await checkIndexedDb().catch((error: unknown) => String(error));
  } catch (error) {
    results.error = String(error);
  }
  render();
  return results;
})();

(window as unknown as { __diag: object }).__diag = {
  done,
  stl: () => Array.from(stlBytes),
  zip: () => Array.from(zipBytes),
};
