import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { expect, test, type Locator, type Page } from '@playwright/test';
import Module from 'manifold-3d';
import { fieldSettings } from '../src/core/field/grid';
import { defaultParams } from '../src/core/params/defaults';
import { basePose, coverPose } from '../src/core/parts/poses';
import { deriveRim, moldBounds } from '../src/core/parts/rim';
import { withArena } from '../src/core/solid/arena';
import { formatSize } from '../src/ui/format';
import type { ExportReport } from '../src/workers/exportJob';
import { orientedExample } from '../test/fixtures/fieldRuns';
import { EXAMPLE_FILES } from '../test/fixtures/loadExamples';
import { holeCentres, unpose } from '../test/fixtures/solidChecks';
import { app, canDraw, checkLayout, dropAndWait, hooks, idle, openApp, type PageWatch } from './appHarness';
import { NO_FIREFOX_WEBGL } from './firefox';
import { inNode, nodeHash } from './nodeRuns';

const row = (page: Page, path: string): Locator => page.locator(`[data-param="${path}"]`);
const note = (page: Page, path: string, code: string): Locator => row(page, path).locator(`.note[data-code="${code}"]`);
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

async function typeValue(box: Locator, value: string): Promise<void> {
  await box.click();
  await box.fill(value);
  await box.press('Enter');
}

/** M10's rim for jersey, from core in Node, which the status strip's box must match. */
function nodeBox(): string {
  const params = defaultParams();
  params.bolts.enabled = true;
  const { mesh, bounds } = orientedExample('jersey');
  const rim = deriveRim(moldBounds(mesh, bounds, fieldSettings(params, bounds)), params);
  return `box ${formatSize([rim.O.x1 - rim.O.x0, rim.O.y1 - rim.O.y0, rim.Zt + rim.Tb])}`;
}

test.describe('the bolts of M10 on index.html', () => {
  let watch: PageWatch;
  test.beforeEach(async ({ page }, info) => {
    // The build is what the user gets, and the dev server serves the same UI code; this keeps the quick suite in its time.
    test.skip(info.project.name === 'dev', 'runs on the build, in Chromium and Firefox');
    test.skip(!canDraw(page), NO_FIREFOX_WEBGL);
    watch = await openApp(page);
  });
  test.afterEach(({}, info) => {
    // A test that beforeEach skipped, as Firefox without a display does, never opened the app.
    if (info.status === 'skipped') return;
    expect(watch.errors).toEqual([]);
    expect(watch.foreign).toEqual([]);
  });

  test('@smoke the Bolts group: off it is the toggle and the tape; on, its rows, the bolt list for the tape, the box and geometry Node gives, and its warnings inline', async ({ page }) => {
    await dropAndWait(page, EXAMPLE_FILES.jersey);
    const group = page.getByTestId('bolts-group');
    await expect(group).toHaveText('Bolts');
    await expect(page.locator('[data-param^="bolts."]')).toHaveCount(1);
    await expect(page.getByTestId('clamp-advice')).toContainText('Tape: hold');
    await expect(page.getByTestId('bolt-advice')).toHaveCount(0);

    await row(page, 'bolts.enabled').locator('input').check();
    await idle(page);
    await expect(page.locator('[data-param^="bolts."]')).toHaveCount(6);
    await expect(row(page, 'bolts.size').getByRole('button', { name: 'M3' })).toHaveAttribute('aria-pressed', 'true');
    const length = row(page, 'bolts.length').locator('select');
    await expect(length).toHaveValue('auto');
    await expect(length.locator('option:checked')).toHaveText('Auto, 12 mm');
    // The bolt list in place of the tape count, and whether four are enough for this box.
    await expect(page.getByTestId('clamp-advice')).toHaveCount(0);
    const advice = page.getByTestId('bolt-advice');
    await expect(advice).toContainText('Bolts: 4 × M3 × 12 mm countersunk screws and 4 × M3 hex nuts');
    await expect(advice).toContainText('Four bolts are enough for this box');
    await expect(advice).toHaveAttribute('data-enough', 'true');
    // The outer land grows, and says so under the toggle; the box is the one core derives in Node.
    await expect(note(page, 'bolts.enabled', 'bolt-land')).toContainText('The outer land grows from 2.0 to 6.1 mm');
    await expect(page.getByTestId('status-box')).toHaveText(nodeBox());
    expect(await hooks(page, (h) => h.geometryHash())).toEqual(await nodeHash('jersey', (p) => p.setParams((params) => (params.bolts.enabled = true))));
    await checkLayout(page, watch);

    // M4 on a 3 mm base: the plate over the countersinks is too thin, under both controls, with the value to use.
    await row(page, 'bolts.size').getByRole('button', { name: 'M4' }).click();
    await typeValue(row(page, 'base.thickness').locator('input.num'), '3');
    await idle(page);
    await expect(note(page, 'base.thickness', 'bolt-plate-thin')).toContainText('raise Base thickness to at least 3.6 mm');
    await expect(note(page, 'bolts.size', 'bolt-plate-thin')).toBeVisible();
    // A screw too short, from the list: it says the length to use, and undo takes it back to auto.
    await length.selectOption('8');
    await idle(page);
    await expect(note(page, 'bolts.length', 'bolt-short')).toContainText('An M4 x 8 mm screw does not reach through the nut');
    await expect(note(page, 'bolts.length', 'bolt-short')).toContainText('use 12 mm or longer');
    await expect(page.locator('.diagnostic[data-code="bolt-short"]')).toHaveCount(1);
    // The bolt list says so too, and no longer counts the bolts as holding the cover.
    await expect(advice).toContainText('But 8 mm screws do not fit this mold');
    await expect(advice).not.toContainText('Four bolts are enough');
    await expect(advice).toHaveAttribute('data-enough', 'false');
    await length.focus();
    await page.keyboard.press('Control+z');
    await expect(length).toHaveValue('auto');
    await idle(page);
    await expect(note(page, 'bolts.length', 'bolt-short')).toHaveCount(0);
    // Too long for the cover: on this 3 mm base the longest that keeps its wall under the top is 25 mm.
    // A double-click on the label goes back to auto, as on every auto setting.
    await length.selectOption('40');
    await idle(page);
    await expect(note(page, 'bolts.length', 'bolt-long')).toContainText('Use 25 mm or shorter.');
    await row(page, 'bolts.length').locator('label').dblclick();
    await expect(length).toHaveValue('auto');
    expect(await app(page, (a) => a.store.pipeline.params.bolts.length)).toBeNull();
  });

  test('@smoke Export ZIP with the bolts on: the README lists the parts and says to unscrew, the files are Node\'s, and the axes reassemble', async ({ page }) => {
    test.setTimeout(240_000);
    await hooks(page, (h) => h.setParam('bolts.enabled', true));
    await dropAndWait(page, EXAMPLE_FILES.jersey);
    // Built in Node while the browser builds its own.
    const node = inNode('jersey', (p) => p.setParams((params) => (params.bolts.enabled = true)), (p) => p.exportParts());
    const download = page.waitForEvent('download', { timeout: 120_000 });
    await page.getByTestId('export-zip').click();
    const files = unzipSync(new Uint8Array(await readFile(await (await download).path())));
    const want = await node;
    for (const name of ['cover.stl', 'base.stl', 'README.txt']) expect(Buffer.compare(Buffer.from(files[name]), Buffer.from(want.files[name])), name).toBe(0);
    const report = JSON.parse(text(files['report.json'])) as ExportReport;
    const { timings: _a, ...browserReport } = report;
    const { timings: _b, ...nodeReport } = want.report!;
    expect(browserReport).toEqual(nodeReport);
    expect(report.bolts).toMatchObject({ size: 'M3', length: 12, screw: 'ISO 10642', nut: 'ISO 4032' });

    const readme = text(files['README.txt']).replace(/\r\n\s*/g, ' ');
    expect(readme).toContain('- 4 x M3 x 12 mm countersunk screws with a 90 degree head, ISO 10642 (hex socket) or DIN 7991.');
    expect(readme).toContain('- 4 x M3 hex nuts, ISO 4032: 5.5 mm across the flats, 2.4 mm high.');
    expect(readme).toContain('Fit the nuts before you assemble the mold');
    expect(readme).toContain('no more than snug');
    expect(readme).toContain('Unscrew the 4 bolts from under the base');

    // Back from both print poses, the holes in the base and the cover share their axes.
    const api = await Module();
    api.setup();
    withArena(api, (arena) => {
      const rim = want.rim!;
      const b = rim.bolts!;
      const cover = unpose(arena, files['cover.stl'], coverPose(rim));
      const base = unpose(arena, files['base.stl'], basePose(rim));
      const inCover = holeCentres(arena, cover, (b.slotFloor - b.layer) / 2, b.spots, b.holeRadius);
      const inBase = holeCentres(arena, base, (b.bed + b.sinkDepth) / 2, b.spots, b.holeRadius);
      b.spots.forEach((spot, k) => {
        expect(Math.hypot(inCover[k]![0] - inBase[k]![0], inCover[k]![1] - inBase[k]![1]), `${spot.x}, ${spot.y}`).toBeLessThan(1e-3);
        // And where the layout put them, so a shift both parts share is caught too.
        expect(Math.hypot(inCover[k]![0] - spot.x, inCover[k]![1] - spot.y), `${spot.x}, ${spot.y}: the layout`).toBeLessThan(1e-3);
      });
    });
    await expect(page.getByTestId('status-clearance')).toContainText('clearance measured');
  });
});
