import type { BenchResult } from '../core/bench/suite';

const status = document.querySelector('#status') as HTMLElement;
const table = document.querySelector('#table') as HTMLTableElement;
const copy = document.querySelector('#copy') as HTMLElement;

interface BenchOutput {
  results: BenchResult[];
  bootMs: number;
  cores: number;
  memoryGb: number | null;
  userAgent: string;
}

const done = new Promise<BenchOutput>((resolve, reject) => {
  const worker = new Worker(new URL('../workers/diag.worker.ts', import.meta.url), { type: 'module' });
  let bootMs = 0;
  worker.onerror = (event) => reject(new Error(event.message));
  worker.onmessage = (event) => {
    const message = event.data;
    if (message.t === 'ready') {
      bootMs = message.bootMs;
    } else if (message.t === 'bench') {
      worker.terminate();
      resolve({
        results: message.results,
        bootMs,
        cores: navigator.hardwareConcurrency,
        memoryGb: (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null,
        userAgent: navigator.userAgent,
      });
    }
  };
  worker.postMessage({ t: 'bench' });
});

done.then(
  (output) => {
    status.textContent = 'Finished. Please send the text below.';
    const header = table.insertRow();
    header.insertCell().textContent = 'Test';
    header.insertCell().textContent = 'ms';
    for (const { name, ms } of output.results) {
      const row = table.insertRow();
      row.insertCell().textContent = name;
      row.insertCell().textContent = String(ms);
    }
    copy.hidden = false;
    copy.textContent = JSON.stringify(output, null, 1);
  },
  (error: unknown) => {
    status.textContent = `Failed: ${String(error)}`;
  },
);

(window as unknown as { __bench: object }).__bench = { done };
