import { defineConfig } from 'vitest/config';
import { buildConstants, buildDefines } from './vite.config.ts';

export default defineConfig({
  // The tests are a local build, so what they export says the version and commit they ran on.
  define: buildDefines(buildConstants(process.env)),
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    maxWorkers: 2,
    testTimeout: 60_000,
  },
});
