// Makes the app's media from the app itself: GA's gallery thumbnails, which HB extends with the help's explode
// animations. It serves the app with Vite, opens media.html (src/diag/mediaPage.ts) in Playwright's Chromium,
// which draws in software with SwiftShader as the browser tests do, and saves what the page draws.
//
//   npm run media -- thumbs     each gallery model, 192 x 192 WebP, into public/gallery/thumbs/
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const root = resolve(import.meta.dirname, '..');
const JOBS = ['thumbs'];
const job = process.argv[2];
if (!JOBS.includes(job)) {
  console.error(`usage: npm run media -- <${JOBS.join(' | ')}>`);
  process.exit(1);
}

const server = await createServer({ root, configFile: join(root, 'vite.config.ts'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const { port } = server.httpServer.address();
const browser = await chromium.launch({ channel: 'chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${port}/media.html`);
  await page.waitForFunction(() => '__media' in window);
  if (job === 'thumbs') {
    const out = join(root, 'public', 'gallery', 'thumbs');
    mkdirSync(out, { recursive: true });
    const entries = await page.evaluate(() => window.__media.entries());
    for (const { id, thumbnail } of entries) {
      const url = await page.evaluate((model) => window.__media.thumbnail(model), id);
      const match = /^data:image\/webp;base64,(.+)$/.exec(url);
      if (!match) throw new Error(`${id}: the browser did not encode a WebP.`);
      const bytes = Buffer.from(match[1], 'base64');
      writeFileSync(join(out, thumbnail), bytes);
      console.log(`thumbs/${thumbnail}  ${bytes.length} bytes`);
    }
  }
  if (errors.length > 0) throw new Error(errors.join('\n'));
} finally {
  await browser.close();
  await server.close();
}
