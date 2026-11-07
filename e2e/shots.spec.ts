import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { EXAMPLE_FILES } from '../test/fixtures/loadExamples';
import { app, canDraw, dropAndWait, hooks, openApp } from './appHarness';
import { NO_FIREFOX_WEBGL } from './firefox';

/**
 * The builder's review set: named PNGs at a fixed camera, for reading before a commit. Opt-in with
 * CFG_SHOTS=1, so CI does not write them on every run. CFG_SHOTS_DIR says where they go.
 */
const SHOTS = process.env.CFG_SHOTS === '1';
const DIR = process.env.CFG_SHOTS_DIR ?? join(import.meta.dirname, '..', 'test-results', 'shots');

type Theme = 'dark' | 'light';
type Browser = 'chromium' | 'firefox';
interface Shot {
  name: string;
  /** null for the empty app, before any model. */
  file: string | null;
  grid: readonly [number, number];
  /** The sidebar section scrolled to the top, Advanced opened first. */
  scroll?: 'pour' | 'grid' | 'advanced';
  /** Which sets take this shot: every size and theme in Chromium, and 1366 x 768 in both themes in Firefox, unless narrowed. */
  only?: (browser: Browser, width: number, theme: Theme) => boolean;
  /** Export ZIP pressed: held at its clearance step with the stage bar showing, or done, with the clearance it measured. */
  exporting?: 'mid' | 'done';
}

// The sidebar's lower sections and the empty state, at fewer sizes: their layout does not change with the model.
const SIDEBAR_SETS = (browser: Browser, width: number, theme: Theme): boolean => (browser === 'firefox' ? width === 1366 && theme === 'dark' : (width === 1366) === (theme === 'dark'));
// The export: every size and theme in Chromium, and the user's browser at 1366 x 768 in the dark theme.
const EXPORT_SETS = (browser: Browser, width: number, theme: Theme): boolean => browser === 'chromium' || (width === 1366 && theme === 'dark');

const CASES: Shot[] = [
  { name: 'benchy', file: EXAMPLE_FILES.benchy, grid: [1, 1] },
  { name: 'x8-3x3', file: EXAMPLE_FILES.x8, grid: [3, 3] },
  { name: 'vis35-two-levels', file: EXAMPLE_FILES.vis35, grid: [1, 1] },
  { name: 'x8-3x3-pour', file: EXAMPLE_FILES.x8, grid: [3, 3], scroll: 'pour', only: SIDEBAR_SETS },
  { name: 'x8-3x3-grid', file: EXAMPLE_FILES.x8, grid: [3, 3], scroll: 'grid', only: SIDEBAR_SETS },
  { name: 'wolf-advanced', file: EXAMPLE_FILES.wolf, grid: [1, 1], scroll: 'advanced', only: SIDEBAR_SETS },
  { name: 'empty', file: null, grid: [1, 1], only: SIDEBAR_SETS },
  { name: 'benchy-exporting', file: EXAMPLE_FILES.benchy, grid: [1, 1], only: EXPORT_SETS, exporting: 'mid' },
  { name: 'benchy-exported', file: EXAMPLE_FILES.benchy, grid: [1, 1], only: EXPORT_SETS, exporting: 'done' },
];

const SIZES = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
];

test.describe('review screenshots', () => {
  test.skip(!SHOTS, 'opt-in with CFG_SHOTS=1');

  for (const shot of CASES) {
    for (const size of SIZES) {
      for (const theme of ['dark', 'light'] as const) {
        test(`${shot.name} at ${size.width} x ${size.height}, ${theme}`, async ({ page }, info) => {
          const browser: Browser = info.project.name === 'firefox' ? 'firefox' : 'chromium';
          test.skip(info.project.name === 'dev', 'the build is what the user gets');
          test.skip(browser === 'firefox' && size.width !== 1366, 'Firefox takes the 1366 x 768 sets');
          test.skip(shot.only !== undefined && !shot.only(browser, size.width, theme), 'not in this set');
          test.skip(!canDraw(page), NO_FIREFOX_WEBGL);
          test.setTimeout(240_000);
          mkdirSync(DIR, { recursive: true });
          await page.setViewportSize(size);
          const watch = await openApp(page);
          if (theme === 'light') await page.getByTestId('theme').click();
          await hooks(page, (h, grid: readonly number[]) => {
            h.setParam('grid.nx', grid[0]);
            h.setParam('grid.ny', grid[1]);
          }, shot.grid);
          // The renderer card is what this server shows; it stays in one shot of the set to be reviewed there.
          const card = page.getByTestId('software-renderer');
          const keepCard = shot.name === 'benchy' && size.width === 1366 && theme === 'dark';
          if (shot.file) {
            await dropAndWait(page, shot.file);
            if (shot.grid[0] * shot.grid[1] > 1) await expect.poll(() => hooks(page, (h) => h.walls().result !== null), { timeout: 120_000 }).toBe(true);
            if (shot.name === 'vis35-two-levels') await expect(page.getByTestId('upper-level')).toBeVisible();
            if (!keepCard && (await card.count()) > 0) await card.getByRole('button', { name: 'Dismiss' }).click();
            // The fixed camera: front right, above, at a distance set by the box.
            await hooks(page, (h) => {
              const { min, max } = h.partBounds('cover')!;
              const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
              const d = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
              h.setCamera({ position: [c[0] + 0.6 * d, c[1] - 1.4 * d, c[2] + 0.9 * d], target: [c[0], c[1], c[2]], fov: 35 });
            });
            expect(await app(page, (a) => a.store.pipeline.status().stale)).toBe(false);
          } else if ((await card.count()) > 0) {
            await card.getByRole('button', { name: 'Dismiss' }).click();
          }
          if (shot.scroll === 'advanced') await page.locator('.advanced > summary').click();
          if (shot.scroll) {
            await page.locator(`[data-section="${shot.scroll}"]`).evaluate((section) => {
              const sections = section.closest('[data-testid="sections"]')!;
              sections.scrollTop = (section as HTMLElement).offsetTop - (sections as HTMLElement).offsetTop;
            });
          }
          if (shot.exporting === 'mid') {
            await hooks(page, (h) => h.armFault('export', { kind: 'delay', ms: 120_000, at: 'clearance' }));
            await page.getByTestId('export-zip').click();
            await expect(page.getByTestId('stage-bar')).toHaveAttribute('data-step', 'clearance', { timeout: 120_000 });
          } else if (shot.exporting === 'done') {
            const download = page.waitForEvent('download', { timeout: 180_000 });
            await page.getByTestId('export-zip').click();
            await download;
            await expect(page.getByTestId('status-clearance')).toContainText('clearance measured');
          }
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const path = join(DIR, `${browser}-${shot.name}-${size.width}x${size.height}-${theme}.png`);
          await page.screenshot({ path });
          if (shot.exporting === 'mid') await page.getByTestId('export-cancel').click();
          console.log(`saved ${path}`);
          expect(watch.errors).toEqual([]);
          expect(watch.foreign).toEqual([]);
        });
      }
    }
  }
});
