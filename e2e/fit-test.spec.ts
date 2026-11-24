import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { expect, test, type Page } from '@playwright/test';
import { defaultParams } from '../src/core/params/defaults';
import { app, canDraw, hooks, idle, openApp } from './appHarness';
import { checkPieces } from './fitChecks';
import { NO_FIREFOX_WEBGL } from './firefox';

async function downloadPieces(page: Page): Promise<Record<string, Uint8Array>> {
  const download = page.waitForEvent('download');
  await page.click('#dl-fit');
  const saved = await download;
  expect(saved.suggestedFilename()).toBe('fit-test.zip');
  await expect(page.locator('#fit-status')).toContainText('Saved fit-test.zip');
  return unzipSync(await readFile(await saved.path()));
}

test('@smoke the fit-test pieces download from diag.html, built by the real code in a worker', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/diag.html');
  await checkPieces(await downloadPieces(page), defaultParams());
  expect(errors).toEqual([]);
});

test('@smoke a printer that needs a looser taper gets its groove series rebuilt at that clearance', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/diag.html');

  await page.fill('#fit-taper', '0');
  await page.click('#dl-fit');
  await expect(page.locator('#fit-status')).toContainText('above 0 mm');

  await page.fill('#fit-taper', '0.2');
  const files = await downloadPieces(page);
  const params = defaultParams();
  params.joint.taperClearance = 0.2;
  await checkPieces(files, params);
  expect(Object.keys(files)).toContain('fit_test/groove-0.35-taper-0.20_cover.stl');
  expect(new TextDecoder().decode(files['fit_test/README.txt']).replace(/\r\n\s*/g, ' ')).toContain('builds it at a taper clearance of 0.20 mm');
  expect(errors).toEqual([]);
});

/** The Fit test button's ZIP from the app, by its file names. */
async function fitFromApp(page: Page): Promise<Record<string, Uint8Array>> {
  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByTestId('export-fit-test').click();
  const saved = await download;
  return unzipSync(await readFile(await saved.path()));
}

// MP3 (docs/PLAN.md, G13.10.12): the Two-part tile is "Not built yet" until MP5, so the test hook enables it, as in
// e2e/moldType.spec.ts. The fit test needs no mold built, so this runs whatever the two-part preview shows; the Fit test
// button needs a model open, which needs the view.
test('@smoke the Two-part cover\'s fit test holds the two seam bolt coupons with Seam fasteners Bolts, and neither with None or in the One-piece cover', async ({ page }) => {
  test.skip(!canDraw(page), NO_FIREFOX_WEBGL);
  const watch = await openApp(page, '&model=cube');
  await expect.poll(() => app(page, (a) => a.store.pipeline.modelName)).toBe('cube.stl');
  await idle(page);
  const seam = ['fit_test/seam_bolt_coupon_neg.stl', 'fit_test/seam_bolt_coupon_pos.stl'];
  const coupons = (files: Record<string, Uint8Array>): string[] => Object.keys(files).filter((name) => name.includes('bolt_coupon')).sort();

  expect(coupons(await fitFromApp(page))).toEqual([]);
  await hooks(page, (h) => h.enableMoldType('clamshell'));
  // The tiles read the registry as they draw: a change of the project draws them again.
  await hooks(page, (h) => h.setParam('silicone.t', 3));
  await page.locator('.mold-tile[data-type="clamshell"]').click();
  expect(await hooks(page, (h) => [h.params().mold.type, h.params().clamshell.fastener])).toEqual(['clamshell', 'bolts']);
  const bolted = await fitFromApp(page);
  expect(coupons(bolted)).toEqual(seam);
  const readme = new TextDecoder().decode(bolted['fit_test/README.txt']).replace(/\r\n\s*/g, ' ');
  expect(readme).toContain('Assemble the two coupons on a flat table, seam faces together.');
  for (const name of seam) expect(bolted[name].length).toBeGreaterThan(84 + 50 * 100);

  await page.locator('.sidebar [data-param="clamshell.fastener"]').getByRole('button', { name: 'None' }).click();
  expect(await hooks(page, (h) => h.params().clamshell.fastener)).toBe('none');
  expect(coupons(await fitFromApp(page))).toEqual([]);
  expect(watch.errors).toEqual([]);
});
