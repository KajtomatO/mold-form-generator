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

// MP3b (docs/PLAN.md, G13.10.19): with Seam fasteners Clips the fit test holds the clip coupon's block and keys, and the
// Clips rows show under Seam clips; with Bolts neither, and back on Clips the values set are kept; in the One-piece cover the
// rows hide, with Clips kept, and they come back with their values on switching back.
test('the Two-part cover\'s fit test holds the clip coupon with Seam fasteners Clips, whose rows show only then', async ({ page }) => {
  test.skip(!canDraw(page), NO_FIREFOX_WEBGL);
  const watch = await openApp(page, '&model=cube');
  await expect.poll(() => app(page, (a) => a.store.pipeline.modelName)).toBe('cube.stl');
  await idle(page);
  const clip = ['fit_test/clip_coupon_block.stl', 'fit_test/clip_coupon_keys.stl'];
  const coupons = (files: Record<string, Uint8Array>): string[] => Object.keys(files).filter((name) => name.includes('_coupon')).sort();
  const clearance = page.locator('.sidebar [data-param="clips.clearance"]');

  await hooks(page, (h) => h.enableMoldType('clamshell'));
  await hooks(page, (h) => h.setParam('silicone.t', 3));
  await page.locator('.mold-tile[data-type="clamshell"]').click();
  await expect(clearance).toHaveCount(0);
  await page.locator('.sidebar [data-param="clamshell.fastener"]').getByRole('button', { name: 'Clips' }).click();
  expect(await hooks(page, (h) => [h.params().mold.type, h.params().clamshell.fastener])).toEqual(['clamshell', 'clips']);
  await expect(clearance).toHaveCount(1);
  await expect(page.getByTestId('clips-group')).toHaveText('Seam clips');
  await hooks(page, (h) => h.setParam('clips.clearance', 0.25));

  const clipped = await fitFromApp(page);
  expect(coupons(clipped)).toEqual(clip);
  const readme = new TextDecoder().decode(clipped['fit_test/README.txt']).replace(/\r\n\s*/g, ' ');
  expect(readme).toContain('at a Clip clearance of 0.15, 0.25 and 0.35 mm per side');
  expect(readme).toContain('Push the clip with 2 notches into the socket');
  expect(readme).toContain('Set Clip clearance under Two-part cover, Seam clips to 0.25 mm, the value of the clip with 2 notches');
  for (const name of clip) expect(clipped[name].length).toBeGreaterThan(84 + 50 * 30);

  await page.locator('.sidebar [data-param="clamshell.fastener"]').getByRole('button', { name: 'Bolts' }).click();
  await expect(clearance).toHaveCount(0);
  expect(coupons(await fitFromApp(page))).toEqual(['fit_test/seam_bolt_coupon_neg.stl', 'fit_test/seam_bolt_coupon_pos.stl']);
  await page.locator('.sidebar [data-param="clamshell.fastener"]').getByRole('button', { name: 'Clips' }).click();
  expect(await hooks(page, (h) => h.params().clips.clearance)).toBe(0.25);
  // In the one-piece type the Clips rows hide, with Seam fasteners Clips kept; back on the Two-part cover they return.
  await page.locator('.mold-tile[data-type="one-piece"]').click();
  expect(await hooks(page, (h) => [h.params().mold.type, h.params().clamshell.fastener])).toEqual(['one-piece', 'clips']);
  await expect(clearance).toHaveCount(0);
  await expect(page.getByTestId('clips-group')).toHaveCount(0);
  // Clip clearance is yours, so the switch window opens on it, with 0.25 kept: Transfer brings it back.
  await page.locator('.mold-tile[data-type="clamshell"]').click();
  await expect(page.getByTestId('switch-dialog').locator('tr[data-param="clips.clearance"]').getByTestId('switch-yours')).toHaveText('0.25 mm');
  await page.getByTestId('switch-transfer').click();
  await expect(clearance).toHaveCount(1);
  await expect(clearance.locator('input.num')).toHaveValue('0.25');
  expect(await hooks(page, (h) => [h.params().mold.type, h.params().clamshell.fastener, h.params().clips.clearance])).toEqual(['clamshell', 'clips', 0.25]);
  expect(watch.errors).toEqual([]);
});
