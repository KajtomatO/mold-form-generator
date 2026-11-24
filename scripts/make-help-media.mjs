// Makes the app's media from the app itself: GA's gallery thumbnails and HB's help explode animations. It serves
// the app with Vite, opens media.html (src/diag/mediaPage.ts) in Playwright's Chromium, which draws in software with
// SwiftShader as the browser tests do, and saves what the page draws.
//
//   npm run media -- thumbs     each gallery model, 192 x 192 WebP, into public/gallery/thumbs/
//   npm run media -- explode    each mold type's parts on HELP_MODEL coming apart, a sprite sheet of 20 frames per
//                               theme, WebP, into public/help/, with public/help/explode.json saying what they show
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const root = resolve(import.meta.dirname, '..');
const JOBS = ['thumbs', 'explode'];
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
  if (job === 'explode') {
    // The names, sizes and limits the app reads, from src/help/media.ts through the page's own build.
    const media = await server.ssrLoadModule('/src/help/media.ts');
    const out = join(root, 'public', 'help');
    mkdirSync(out, { recursive: true });
    const model = await page.evaluate(() => window.__media.helpModel());
    const entry = (await page.evaluate(() => window.__media.entries())).find((e) => e.id === model);
    if (!entry) throw new Error(`HELP_MODEL names no gallery model ("${model}").`);
    const { GALLERY } = await server.ssrLoadModule('/src/gallery/catalogue.ts');
    const stl = readFileSync(join(root, 'public', 'gallery', GALLERY.find((e) => e.id === model).file));
    const manifest = {
      model,
      modelSha256: createHash('sha256').update(stl).digest('hex'),
      frames: media.EXPLODE_FRAMES,
      grid: [...media.EXPLODE_GRID],
      size: [...media.EXPLODE_SIZE],
      scale: media.EXPLODE_SCALE,
      fps: media.EXPLODE_FPS,
      types: {},
    };
    for (const type of await page.evaluate(() => window.__media.types())) {
      const { partsSha256, sheets } = await page.evaluate((t) => window.__media.explode(t), type);
      manifest.types[type] = { partsSha256 };
      for (const theme of media.HELP_THEMES) {
        const match = /^data:image\/webp;base64,(.+)$/.exec(sheets[theme]);
        if (!match) throw new Error(`${type}, ${theme}: the browser did not encode a WebP.`);
        const bytes = Buffer.from(match[1], 'base64');
        const file = media.explodeFile(type, theme);
        writeFileSync(join(out, file), bytes);
        console.log(`help/${file}  ${bytes.length} bytes${bytes.length > media.EXPLODE_MAX_BYTES ? `, over the ${media.EXPLODE_MAX_BYTES} the test allows` : ''}`);
      }
    }
    writeFileSync(join(out, 'explode.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log('help/explode.json');
  }
  if (errors.length > 0) throw new Error(errors.join('\n'));
} finally {
  await browser.close();
  await server.close();
}
