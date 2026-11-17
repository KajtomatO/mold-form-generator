import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { MeshoptSimplifier } from 'meshoptimizer';
import { auditEdges } from '../src/core/mesh/audit';
import { repairMesh } from '../src/core/mesh/repairImport';
import { weld, type WeldedMesh } from '../src/core/mesh/weld';
import { parseStl } from '../src/core/stl/parse';
import { writeBinaryStl } from '../src/core/stl/write';
import type { ExportReport } from '../src/workers/exportJob';
import { exampleBytes, EXAMPLE_FILES, loadManifold } from '../test/fixtures/loadExamples';
import { finnedBox, openTopBox } from '../test/fixtures/synthetic';
import { app, canDraw, idle, openApp, type PageWatch } from './appHarness';
import { NO_FIREFOX_WEBGL } from './firefox';

/**
 * RM in the browser (R43): Repair mesh offered under the file row only for a file that is no closed solid, the repaired
 * copy loaded with merged mode then open to it, Use the original going back, and the repaired copy the same bytes as
 * Node makes, which README.txt's "which gives the same copy" needs.
 */
const DEV_SKIP = 'the build is what the user gets, and the dev server serves the same UI code';
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const stlOf = (mesh: WeldedMesh): Uint8Array => writeBinaryStl(mesh.positions, mesh.indices);

async function choose(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await page.locator('[data-section="model"] input[type="file"]').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
}

async function download(page: Page, testId: string): Promise<{ name: string; bytes: Uint8Array }> {
  const saved = page.waitForEvent('download', { timeout: 240_000 });
  await page.getByTestId(testId).click();
  const file = await saved;
  return { name: file.suggestedFilename(), bytes: new Uint8Array(await readFile(await file.path())) };
}

test.describe('RM: Repair mesh', () => {
  let watch: PageWatch;
  test.beforeEach(async ({ page }) => {
    test.skip(!canDraw(page), NO_FIREFOX_WEBGL);
    watch = await openApp(page);
  });
  test.afterEach(() => {
    expect(watch.errors).toEqual([]);
  });

  test('@smoke the open-top box: the offer, the click, merged mode open to the copy, and Use the original back to the file', async ({ page }, info) => {
    test.skip(info.project.name === 'dev', DEV_SKIP);
    await choose(page, 'open-top.stl', stlOf(openTopBox()));
    const offer = page.getByTestId('repair-offer');
    await expect(offer).toContainText('open-top.stl is not a closed solid: it has 1 hole of 600.0 mm². So merged mode cannot be used with it, and the silicone thickness cannot be measured.');
    await expect(offer).toContainText('Repair mesh closes its hole with new triangles and keeps every triangle of your file. The mold is then made from that closed copy; model_oriented.stl stays your own file.');
    // A fill needs no grid.
    await expect(page.getByTestId('repair-cell')).toHaveCount(0);
    await idle(page);
    const mode = page.locator('[data-param="base.mode"]');
    await expect(mode.getByRole('button', { name: 'Merged (B)' })).toBeDisabled();
    await expect(mode.locator('[data-code="soup-mode"]')).toContainText('To use merged mode and a measured thickness, use Repair mesh in the Model section to make a closed copy of it.');
    await page.getByTestId('repair-mesh').click();
    const note = page.getByTestId('repaired-note');
    await expect(note).toContainText('Made from a repaired copy: its hole of 600.0 mm² closed with 2 new triangles, every triangle of open-top.stl kept. model_oriented.stl is your own file.');
    await expect(page.getByTestId('file-name')).toHaveText('open-top.stl, 12 triangles (repaired)');
    await expect(offer).toHaveCount(0);
    await idle(page);
    expect(await app(page, (a) => ({ closed: a.store.pipeline.modelClosed(), repair: a.store.pipeline.memory.parts().repair ?? null, undo: a.store.history.depth.undo }))).toEqual({ closed: true, repair: null, undo: 0 });
    await expect(page.locator('[data-testid="diagnostics"] [data-code="model-repaired"]')).toContainText('The mold is made from a repaired copy of open-top.stl: its hole of 600.0 mm² closed, every triangle of your file kept');
    // Merged mode is open to the closed copy.
    await expect(mode.getByRole('button', { name: 'Merged (B)' })).toBeEnabled();
    await mode.getByRole('button', { name: 'Merged (B)' }).click();
    await idle(page);
    await expect(note).toContainText('In merged mode the base carries this copy.');
    const zip = unzipSync((await download(page, 'export-zip')).bytes);
    expect(Object.keys(zip)).not.toContain('model_oriented.stl');
    const report = JSON.parse(text(zip['report.json'])) as ExportReport;
    expect(report.model.repaired).toMatchObject({ method: 'filled', holes: 1, triangles: 12 });
    expect(report.clearance.measured).toBeGreaterThanOrEqual(3);
    // Use the original: the file again, a soup, the offer back, merged mode as the project had it, and refused.
    await page.getByTestId('use-original').click();
    await expect(page.getByTestId('file-name')).toHaveText('open-top.stl, 10 triangles');
    await expect(offer).toBeVisible();
    await idle(page);
    expect(await app(page, (a) => ({ closed: a.store.pipeline.modelClosed(), origin: a.store.pipeline.modelOrigin(), mode: a.store.pipeline.params.base.mode }))).toEqual({ closed: false, origin: null, mode: 'merged' });
  });

  test('jersey, a closed solid, shows no repair control', async ({ page }, info) => {
    test.skip(info.project.name === 'dev', DEV_SKIP);
    await choose(page, EXAMPLE_FILES.jersey, exampleBytes('jersey'));
    await expect(page.getByTestId('file-name')).toHaveText('jersey-barrier.stl, 1,340 triangles');
    await idle(page);
    await expect(page.getByTestId('repair-offer')).toHaveCount(0);
    await expect(page.getByTestId('repair-mesh')).toHaveCount(0);
  });

  test('finnedBox rebuilt on a 0.5 mm grid is Node\'s copy, byte for byte, in this browser, and Save repaired STL saves it', async ({ page }, info) => {
    test.skip(info.project.name === 'dev', DEV_SKIP);
    test.setTimeout(240_000);
    const fixture = finnedBox();
    // The same repair in Node, from the same bytes, as the app welds them.
    const bytes = stlOf(fixture);
    await MeshoptSimplifier.ready;
    const welded = weld(parseStl(bytes).positions);
    const node = repairMesh(await loadManifold(), MeshoptSimplifier, welded, auditEdges(welded), { name: 'finned.stl', cell: 0.5 });
    const expected = sha(writeBinaryStl(node.mesh.positions, node.mesh.indices));
    await choose(page, 'finned.stl', bytes);
    const offer = page.getByTestId('repair-offer');
    // The fin's free edges are open loops to the audit, and its foot an edge three faces share.
    await expect(offer).toContainText('finned.stl is not a closed solid: it has 2 holes of 396.6 mm² in all and 1 edge shared by more than two faces.');
    await expect(offer).toContainText('Repair mesh rebuilds it as one closed solid on a grid of');
    await page.getByTestId('repair-cell').fill('0.5');
    await page.getByTestId('repair-cell').blur();
    await expect(offer).toContainText('on a grid of 0.50 mm');
    await page.getByTestId('repair-mesh').click();
    const note = page.getByTestId('repaired-note');
    await expect(note).toContainText(`Made from a copy of finned.stl rebuilt as one closed solid on a 0.50 mm grid, ${node.figures.triangles} triangles. Your file lies inside the copy or within ${node.figures.nearMm.toFixed(3)} mm of it, except 2 triangles the repair left out, up to ${node.figures.outside!.farthestMm.toFixed(2)} mm away, such as a fin, a wall thinner than the grid, a fold or a sharp edge`, { timeout: 120_000 });
    await idle(page);
    const record = await app(page, (a) => a.store.pipeline.modelOrigin()!.repair!.record);
    expect(record.sha256).toBe(expected);
    expect(record.nearMm).toBe(node.figures.nearMm);
    expect(record.outside).toEqual(node.figures.outside);
    const copy = await download(page, 'save-repaired');
    expect(copy.name).toBe('finned-repaired.stl');
    expect(sha(copy.bytes)).toBe(expected);
  });
});
