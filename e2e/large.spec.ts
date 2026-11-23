import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { SIMPLIFIED_ENTRY } from '../src/app/projectArchive';
import { transformPositions } from '../src/core/base/orient';
import { weld } from '../src/core/mesh/weld';
import { parseStl } from '../src/core/stl/parse';
import { writeBinaryStl } from '../src/core/stl/write';
import { MEMORY_ADVICE_SIMPLIFY } from '../src/ui/format';
import type { ExportReport } from '../src/workers/exportJob';
import { exampleBytes, EXAMPLE_FILES } from '../test/fixtures/loadExamples';
import { app, canDraw, dropAndWait, hooks, idle, openApp, type PageWatch } from './appHarness';
import { NO_FIREFOX_WEBGL } from './firefox';

/**
 * MM2 in the browser: the question before a large model loads, the simplified copy, and the maker's own file in
 * model_oriented.stl (R42). The warning point is lowered for these tests, so jersey and Benchy reach it.
 */
const DEV_SKIP = 'the build is what the user gets, and the dev server serves the same UI code';
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
/** Benchy simplified to 50,000 triangles, as Node gives it (test/unit/simplifyModel.test.ts). */
const BENCHY_50K = '995c7b1010ce703f82660a64ccf8d3e6f10fbe2c4a3cc51b4a1ebf3748929b71';

async function choose(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await page.locator('[data-section="model"] input[type="file"]').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
}

async function lowerWarningPoint(page: Page, triangles = 1_000): Promise<void> {
  await app(page, (a, t: number) => (a.store.largeLimits = { triangles: t, bytes: 1e12 }), triangles);
}

async function download(page: Page, testId: string): Promise<{ name: string; bytes: Uint8Array }> {
  const saved = page.waitForEvent('download', { timeout: 240_000 });
  await page.getByTestId(testId).click();
  const file = await saved;
  return { name: file.suggestedFilename(), bytes: new Uint8Array(await readFile(await file.path())) };
}

test.describe('MM2: large models', () => {
  let watch: PageWatch;
  test.beforeEach(async ({ page }) => {
    test.skip(!canDraw(page), NO_FIREFOX_WEBGL);
    watch = await openApp(page);
  });
  test.afterEach(({}, info) => {
    // A test that beforeEach skipped, as Firefox without a display does, never opened the app.
    if (info.status === 'skipped') return;
    expect(watch.errors).toEqual([]);
  });

  test('@smoke a model past the warning point asks before it is read: Cancel leaves the page, Load anyway loads it as before', async ({ page }, info) => {
    test.skip(info.project.name === 'dev', DEV_SKIP);
    await lowerWarningPoint(page);
    const jersey = exampleBytes('jersey');
    await choose(page, EXAMPLE_FILES.jersey, jersey);
    const prompt = page.getByTestId('large-prompt');
    await expect(prompt).toContainText('jersey-barrier.stl has 1,340 triangles (0.1 MB). A model this large took about 1.3 GB of memory in the browser in our tests');
    await expect(prompt).toContainText('model_oriented.stl, the model you print and glue in, is still your own file.');
    // Nothing has started: the pipeline holds no file and has run no job.
    expect(await app(page, (a) => ({ model: a.store.pipeline.modelName, bytes: a.store.pipeline.stlBytes, jobs: a.store.pipeline.log.filter((e) => e.event === 'dispatch').length }))).toEqual({ model: null, bytes: null, jobs: 0 });
    await page.getByTestId('large-cancel').click();
    await expect(prompt).toHaveCount(0);
    expect(await app(page, (a) => a.store.pipeline.modelName)).toBeNull();
    await choose(page, EXAMPLE_FILES.jersey, jersey);
    await page.getByTestId('large-load').click();
    await expect(page.getByTestId('file-name')).toHaveText('jersey-barrier.stl, 1,340 triangles');
    await idle(page);
    const loaded = await hooks(page, (h) => h.geometryHash().all);
    // The same file dropped as any file: the same geometry.
    await lowerWarningPoint(page, 1e9);
    await dropAndWait(page, EXAMPLE_FILES.jersey);
    expect(await hooks(page, (h) => h.geometryHash().all)).toBe(loaded);
  });

  test('@smoke Simplify loads jersey\'s copy and says so; the export\'s model_oriented.stl is the file itself; Use the original brings it back', async ({ page }, info) => {
    test.skip(info.project.name === 'dev', DEV_SKIP);
    await lowerWarningPoint(page);
    const jersey = exampleBytes('jersey');
    await choose(page, EXAMPLE_FILES.jersey, jersey);
    await page.getByTestId('simplify-target').fill('900');
    await page.getByTestId('simplify-target').blur();
    await page.getByTestId('large-simplify').click();
    await expect(page.getByTestId('simplified-note')).toContainText('Made from a copy simplified from 1,340 to');
    await expect(page.getByTestId('file-name')).toContainText('(simplified)');
    await idle(page);
    expect(await app(page, (a) => a.store.pipeline.memory.parts().simplify)).toBeUndefined();
    const files = unzipSync((await download(page, 'export-zip')).bytes);
    expect(parseStl(files['model_oriented.stl']).rawTriangleCount).toBe(1340);
    expect(parseStl(files['cover.stl']).rawTriangleCount).toBeGreaterThan(0);
    await page.getByTestId('use-original').click();
    await expect(page.getByTestId('file-name')).toHaveText('jersey-barrier.stl, 1,340 triangles');
    await expect(page.getByTestId('large-prompt')).toHaveCount(0);
  });

  test('Benchy\'s copy at 50,000 is Node\'s, byte for byte, in this browser; model_oriented.stl is the file itself; Use the original brings the file back with the settings', async ({ page }, info) => {
    test.skip(info.project.name === 'dev', DEV_SKIP);
    test.setTimeout(300_000);
    await lowerWarningPoint(page);
    const benchy = exampleBytes('benchy');
    await choose(page, EXAMPLE_FILES.benchy, benchy);
    const prompt = page.getByTestId('large-prompt');
    // The file's own count, before the parser drops its 552 collapsed triangles.
    await expect(prompt).toContainText('3dbenchy.stl has 225,706 triangles (11.3 MB).');
    await page.getByTestId('simplify-target').fill('50000');
    await page.getByTestId('simplify-target').blur();
    await page.getByTestId('large-simplify').click();
    await expect(page.getByTestId('simplify-busy')).toContainText('Simplifying 3dbenchy.stl to 50,000 triangles, which can take a minute or more:');
    const note = page.getByTestId('simplified-note');
    await expect(note).toContainText('Made from a copy simplified from 225,154 to 49,998 triangles, within 0.037 mm of 3dbenchy.stl. model_oriented.stl is your own file.', { timeout: 120_000 });
    await expect(page.getByTestId('file-name')).toHaveText('3dbenchy.stl, 49,998 triangles (simplified)');
    await idle(page);
    // The same copy as Node makes, in this browser too: the format does not need it, README.txt's "the same copy" does.
    const origin = await app(page, (a) => a.store.pipeline.modelOrigin()!.record!);
    expect(origin.sha256).toBe(BENCHY_50K);
    expect(await app(page, (a) => a.store.pipeline.memory.parts().simplify)).toBeUndefined();
    await expect(page.locator('[data-testid="diagnostics"] [data-code="model-simplified"]')).toContainText('The mold is made from a copy of 3dbenchy.stl simplified from 225,154 to 49,998 triangles');
    const zip = await download(page, 'export-zip');
    const files = unzipSync(zip.bytes);
    expect(parseStl(files['model_oriented.stl']).rawTriangleCount).toBe(225_154);
    const report = JSON.parse(text(files['report.json'])) as ExportReport;
    expect(report.model.simplified?.sha256).toBe(BENCHY_50K);
    expect(report.clearance.simplifyErrorMm).toBe(origin.errorMm);
    // Save simplified STL: the copy itself.
    const copy = await download(page, 'save-simplified');
    expect(copy.name).toBe('3dbenchy-simplified.stl');
    expect(sha(copy.bytes)).toBe(BENCHY_50K);
    // Use the original: the file again, the settings kept, and no question asked.
    await hooks(page, (h) => h.setParam('silicone.t', 3.5));
    await idle(page);
    await page.getByTestId('use-original').click();
    await expect(page.getByTestId('file-name')).toHaveText('3dbenchy.stl, 225,154 triangles');
    await expect(page.getByTestId('large-prompt')).toHaveCount(0);
    await idle(page);
    expect(await app(page, (a) => ({ t: a.store.pipeline.params.silicone.t, origin: a.store.pipeline.modelOrigin(), undo: a.store.history.depth.undo }))).toEqual({ t: 3.5, origin: null, undo: 0 });
    // A model loaded as it is, past the point: Simplify… offers the copy again, and the meter's tooltip says so when amber.
    await expect(page.getByTestId('simplify-loaded')).toBeVisible();
    await app(page, (a) => (a.store.memory.value = { total: 841_820_304, parts: { page: { wasm: 0, arrays: 841_820_304 } } }));
    await expect(page.getByTestId('status-memory')).toHaveClass(/warn/);
    await expect(page.getByTestId('status-memory')).toHaveAttribute('title', new RegExp(MEMORY_ADVICE_SIMPLIFY.replace(/[.…]/g, '.')));
    // Simplify… asks the question in its form for the model on screen: no Load anyway, and the history it clears.
    await page.getByTestId('simplify-loaded').click();
    const again = page.getByTestId('large-prompt');
    await expect(again).toContainText('3dbenchy.stl has 225,154 triangles');
    await expect(again).toContainText('the undo history is cleared');
    await expect(page.getByTestId('large-load')).toHaveCount(0);
    await page.getByTestId('large-cancel').click();
    await expect(again).toHaveCount(0);
    expect(await app(page, (a) => a.store.pipeline.modelOrigin())).toBeNull();
  });

  test('Cancel while the copy is made ends it at once and leaves the page as it was', async ({ page }, info) => {
    test.skip(info.project.name === 'dev', DEV_SKIP);
    await lowerWarningPoint(page);
    await choose(page, EXAMPLE_FILES.benchy, exampleBytes('benchy'));
    await page.getByTestId('simplify-target').fill('50000');
    await page.getByTestId('simplify-target').blur();
    await page.getByTestId('large-simplify').click();
    const busy = page.getByTestId('simplify-busy');
    await expect(busy).toBeVisible();
    // Once the job has said what it holds, so Cancel has a figure to take off the meter.
    await expect.poll(() => app(page, (a) => a.store.pipeline.memory.parts().simplify !== undefined)).toBe(true);
    await page.getByTestId('simplify-cancel').click();
    await expect(busy).toHaveCount(0);
    expect(await app(page, (a) => ({ model: a.store.pipeline.modelName, simplify: a.store.pipeline.memory.parts().simplify ?? null, question: a.store.large.value, notice: a.store.fileNotice.value }))).toEqual({ model: null, simplify: null, question: null, notice: null });
    await expect(page.getByTestId('simplified-note')).toHaveCount(0);
  });

  test('a .moldproj past the warning point asks after it is opened, and Simplify keeps its settings; saved and reopened, it does not ask and exports the file itself', async ({ page }, info) => {
    test.skip(info.project.name === 'dev', DEV_SKIP);
    test.setTimeout(300_000);
    const jersey = exampleBytes('jersey');
    await dropAndWait(page, EXAMPLE_FILES.jersey);
    await hooks(page, (h) => h.setParam('silicone.t', 4.5));
    await idle(page);
    const plain = await download(page, 'save-project');
    await lowerWarningPoint(page);
    await choose(page, plain.name, plain.bytes);
    await expect(page.getByTestId('large-prompt')).toContainText('jersey-barrier.stl, the model in jersey-barrier.moldproj, has 1,340 triangles');
    await page.getByTestId('simplify-target').fill('900');
    await page.getByTestId('simplify-target').blur();
    await page.getByTestId('large-simplify').click();
    await expect(page.getByTestId('simplified-note')).toBeVisible({ timeout: 60_000 });
    await idle(page);
    expect(await hooks(page, (h) => h.params().silicone.t)).toBe(4.5);
    const saved = await download(page, 'save-project');
    expect(Object.keys(unzipSync(saved.bytes))).toContain(SIMPLIFIED_ENTRY);
    // Reopened on a fresh page with the point lowered still: no question, the copy, and model_oriented.stl the file.
    await page.reload();
    await page.waitForFunction(() => '__app' in window);
    await lowerWarningPoint(page);
    await choose(page, saved.name, saved.bytes);
    await expect(page.getByTestId('simplified-note')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('large-prompt')).toHaveCount(0);
    await idle(page);
    const files = unzipSync((await download(page, 'export-zip')).bytes);
    // The file itself, welded and turned by the plan as model_oriented.stl always is: not the copy.
    const transform = await app(page, (a) => a.store.pipeline.oriented!.value.oriented.transform);
    const welded = weld(parseStl(jersey).positions);
    expect(sha(files['model_oriented.stl'])).toBe(sha(writeBinaryStl(transformPositions(welded.positions, transform), welded.indices)));
    expect(parseStl(files['model_oriented.stl']).rawTriangleCount).toBe(1340);
  });

  test('a text STL past the point says about how many triangles, estimated from its first bytes', async ({ page }, info) => {
    test.skip(info.project.name === 'dev', DEV_SKIP);
    // 300,000 facets of text, about 75 MB: counted from its first 64 kB.
    const facet = ' facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 1 0 0\n   vertex 0 1 0\n  endloop\n endfacet\n';
    const big = new TextEncoder().encode(`solid big\n${facet.repeat(300_000)}endsolid big\n`);
    await lowerWarningPoint(page, 200_000);
    await choose(page, 'big.stl', big);
    await expect(page.getByTestId('large-prompt')).toContainText('big.stl has about 300,000 triangles (30.3 MB of text).');
    await page.getByTestId('large-cancel').click();
  });
});
