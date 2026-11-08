import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { expect, test, type Page } from '@playwright/test';
import { defaultParams } from '../src/core/params/defaults';
import { checkPieces } from './fitChecks';

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
