import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = import.meta.dirname;

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  worker: { format: 'es' },
  server: { host: true },
  preview: { host: true },
  build: {
    target: 'es2022',
    rolldownOptions: {
      input: {
        index: resolve(root, 'index.html'),
        diag: resolve(root, 'diag.html'),
        bench: resolve(root, 'bench.html'),
        pipeline: resolve(root, 'pipeline.html'),
      },
    },
  },
});
