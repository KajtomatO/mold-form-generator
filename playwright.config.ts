import { defineConfig } from '@playwright/test';
import { firefoxHasDisplay, firefoxLibDir, firefoxReady } from './e2e/firefox';
import { buildConstants } from './vite.config.ts';

// One build for the whole run: the servers' builds and the exports the tests make in Node to compare with
// them say the same version. The servers inherit the environment, and so do the test workers, which load
// this file again; buildInfo.ts reads the same constants from the global scope where no build defined them.
const build = buildConstants(process.env);
process.env.CFG_CHANNEL = build.channel;
process.env.CFG_COMMIT = build.commit;
process.env.CFG_BUILD_DATE = build.date;
Object.assign(globalThis, { __CFG_VERSION__: build.version, __CFG_CHANNEL__: build.channel, __CFG_COMMIT__: build.commit, __CFG_BUILD_DATE__: build.date });

// Tests run against the LAN address on purpose: 127.0.0.1 is a secure context
// and would hide every problem that only appears over plain http on a LAN IP.
const host = process.env.CFG_LAN_IP ?? '192.168.0.153';
const devPort = 5183;
const previewPort = 5184;

// Playwright's host check ignores LD_LIBRARY_PATH, so it would refuse the unpacked libraries.
if (firefoxLibDir) process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

const chromium = {
  channel: 'chromium',
  launchOptions: {
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  },
};

// The user's browser. It runs headed on a virtual display when there is one, because it has no
// WebGL when headless. Without a display, tests that need WebGL skip themselves.
const firefoxProject = {
  name: 'firefox',
  use: {
    browserName: 'firefox' as const,
    baseURL: `http://${host}:${previewPort}`,
    headless: !firefoxHasDisplay,
    launchOptions: {
      env: {
        ...(process.env as Record<string, string>),
        LIBGL_ALWAYS_SOFTWARE: '1',
        ...(firefoxLibDir ? { LD_LIBRARY_PATH: firefoxLibDir } : {}),
      },
      firefoxUserPrefs: {
        'webgl.force-enabled': true,
        'webgl.disable-fail-if-major-performance-caveat': true,
      },
    },
  },
};

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    acceptDownloads: true,
    viewport: { width: 1366, height: 768 },
  },
  projects: [
    { name: 'dev', use: { ...chromium, baseURL: `http://${host}:${devPort}` } },
    { name: 'preview', use: { ...chromium, baseURL: `http://${host}:${previewPort}` } },
    ...(firefoxReady ? [firefoxProject] : []),
  ],
  webServer: [
    {
      command: `npx vite --host 0.0.0.0 --port ${devPort} --strictPort`,
      url: `http://${host}:${devPort}/`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npx vite build --outDir dist-ci --emptyOutDir && npx vite preview --outDir dist-ci --host 0.0.0.0 --port ${previewPort} --strictPort`,
      url: `http://${host}:${previewPort}/`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
