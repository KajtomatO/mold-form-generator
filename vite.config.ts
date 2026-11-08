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
    // Every browser the app supports preloads modules itself. Vite's polyfill for those that do not is
    // adapted from es-module-shims, and Vite ships it without that project's notice, so it stays out.
    modulePreload: { polyfill: false },
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
