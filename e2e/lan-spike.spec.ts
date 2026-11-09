import { readFile, writeFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { expect, test, type Page } from '@playwright/test';
import Module from 'manifold-3d';
import { runBench, type BenchResult } from '../src/core/bench/suite';
import { withPreamble } from '../test/fixtures/benchmarks';
import { firefoxHasDisplay, NO_FIREFOX_WEBGL } from './firefox';

interface Diag {
  secureContext: boolean;
  sharedArrayBuffer: boolean;
  webGpu: boolean;
  bootMs: number;
  heapBytes: number | null;
  jobsBeforeReady: { id: number; volume: number }[];
  gl: { webgl2: boolean; renderer: string; stencilBits: number; distinctColours: number; error: string | null };
  transferSourceLength: number;
  transferEchoLength: number;
  indexedDb: boolean | string;
  error: string | null;
}

async function runDiag(page: Page): Promise<Diag> {
  await page.goto('/diag.html');
  await expect(page).toHaveTitle(/diagnostics/);
  return page.evaluate(() => (window as unknown as { __diag: { done: Promise<Diag> } }).__diag.done);
}

test('@smoke the app runs over plain http on the LAN address', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const diag = await runDiag(page);
  console.log(JSON.stringify(diag));

  expect(diag.error).toBeNull();
  expect(diag.secureContext).toBe(false);
  expect(diag.sharedArrayBuffer).toBe(false);

  // Jobs posted before WASM finished loading must all be answered, with correct volumes.
  expect(diag.jobsBeforeReady.map((j) => j.id)).toEqual([0, 1, 2]);
  diag.jobsBeforeReady.forEach(({ id, volume }) => {
    const size = 20 + id;
    const expected = size ** 3 - (4 / 3) * Math.PI * (size * 0.3) ** 3;
    expect(Math.abs(volume - expected) / expected).toBeLessThan(0.005);
  });

  expect(diag.transferSourceLength).toBe(0);
  expect(diag.transferEchoLength).toBe(1024);
  expect(diag.indexedDb).toBe(true);
  expect(errors).toEqual([]);
});

test('@smoke WebGL2 draws with stencil and a float height texture', async ({ page, browserName }) => {
  test.skip(browserName === 'firefox' && !firefoxHasDisplay, NO_FIREFOX_WEBGL);
  const { gl } = await runDiag(page);
  expect(gl.error).toBeNull();
  expect(gl.webgl2).toBe(true);
  expect(gl.stencilBits).toBeGreaterThan(0);
  expect(gl.distinctColours).toBeGreaterThan(8);
});

test('@smoke page screenshots capture the WebGL canvas', async ({ page, browserName }) => {
  test.skip(browserName === 'firefox' && !firefoxHasDisplay, NO_FIREFOX_WEBGL);
  await runDiag(page);
  const png = await page.locator('#gl').screenshot();
  const distinct = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const colours = new Set<number>();
    for (let i = 0; i < data.length; i += 4) colours.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    return colours.size;
  }, png.toString('base64'));
  expect(distinct).toBeGreaterThan(8);
});

test('@smoke STL and ZIP downloads arrive byte-identical', async ({ page }) => {
  await runDiag(page);
  const expected = await page.evaluate(() => {
    const d = (window as unknown as { __diag: { stl(): number[]; zip(): number[] } }).__diag;
    return { stl: d.stl(), zip: d.zip() };
  });

  const stlDownload = page.waitForEvent('download');
  await page.click('#dl-stl');
  const stl = await stlDownload;
  expect(stl.suggestedFilename()).toBe('download-test.stl');
  expect(Array.from(await readFile(await stl.path()))).toEqual(expected.stl);

  const zipDownload = page.waitForEvent('download');
  await page.click('#dl-zip');
  const zip = await zipDownload;
  expect(zip.suggestedFilename()).toBe('download-test.zip');
  const zipBytes = await readFile(await zip.path());
  expect(Array.from(zipBytes)).toEqual(expected.zip);
  expect(Array.from(unzipSync(zipBytes)['test.stl'])).toEqual(expected.stl);
});

test('browser-to-Node speed ratio', async ({ page }, info) => {
  test.skip(info.project.name !== 'preview', 'measured once, on the production build');
  await page.goto('/bench.html');
  const browser = await page.evaluate(() => (window as unknown as { __bench: { done: Promise<{ results: BenchResult[] }> } }).__bench.done);

  const api = await Module();
  api.setup();
  const node = runBench(api, () => performance.now());

  const rows = browser.results.map((b, i) => ({
    name: b.name,
    chromium: b.ms,
    node: node[i].ms,
    ratio: Math.round((b.ms / node[i].ms) * 100) / 100,
  }));
  console.log(JSON.stringify(rows));
  rows.forEach((row) => expect(row.chromium).toBeGreaterThan(0));

  if (process.env.CFG_RECORD === '1') {
    const lines = [
      '# Benchmarks',
      '',
      'Chromium worker against Node on the same server. Written by `scripts/ci.sh --record`.',
      '',
      '| Test | Chromium ms | Node ms | Ratio |',
      '|---|---|---|---|',
      ...rows.map((r) => `| ${r.name} | ${r.chromium} | ${r.node} | ${r.ratio} |`),
      '',
    ];
    // The field, solid and openings tables come from the unit tests in the same --record run, so they stay.
    await writeFile('docs/BENCHMARKS.md', withPreamble(await readFile('docs/BENCHMARKS.md', 'utf8'), lines.join('\n')));
  }
});
