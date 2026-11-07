import { defineConfig } from '@playwright/test';

// Tests run against the LAN address on purpose: 127.0.0.1 is a secure context
// and would hide every problem that only appears over plain http on a LAN IP.
const host = process.env.CFG_LAN_IP ?? '192.168.0.153';
const devPort = 5183;
const previewPort = 5184;

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    channel: 'chromium',
    acceptDownloads: true,
    viewport: { width: 1366, height: 768 },
    launchOptions: {
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  projects: [
    { name: 'dev', use: { baseURL: `http://${host}:${devPort}` } },
    { name: 'preview', use: { baseURL: `http://${host}:${previewPort}` } },
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
