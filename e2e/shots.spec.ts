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
  scroll?: 'cover' | 'pour' | 'grid' | 'demold' | 'advanced';
  /** A Show toggle pressed first: the Demold report's first hint, or the Diagnostics row of this code. */
  show?: 'hint' | 'air-underside' | 'air-sealed';
  /** Which sets take this shot: every size and theme in Chromium, and 1366 x 768 in both themes in Firefox, unless narrowed. */
  only?: (browser: Browser, width: number, theme: Theme) => boolean;
  /** Export ZIP pressed: held at its clearance step with the stage bar showing, or done, with the clearance it measured. */
  exporting?: 'mid' | 'done';
  /** M8: the section across this axis, with its caps. */
  section?: 'x' | 'y' | 'z';
  /** The camera square on to the cut, a little above, so the silicone's thickness can be judged. */
  faceCut?: boolean;
  explode?: boolean;
  /** The Top view button pressed. */
  topView?: boolean;
  /** A pour's ring held on its nearest neighbour, where it may not stand, with the reason beside the pointer. */
  dragInvalid?: boolean;
  /** One change made, and the undo button's title drawn under it: a native tooltip is not in a screenshot. */
  undoTitle?: boolean;
}

// The sidebar's lower sections and the empty state, at fewer sizes: their layout does not change with the model.
const SIDEBAR_SETS = (browser: Browser, width: number, theme: Theme): boolean => (browser === 'firefox' ? width === 1366 && theme === 'dark' : (width === 1366) === (theme === 'dark'));
// The export: every size and theme in Chromium, and the user's browser at 1366 x 768 in the dark theme.
const EXPORT_SETS = (browser: Browser, width: number, theme: Theme): boolean => browser === 'chromium' || (width === 1366 && theme === 'dark');
// M7's reports take the same sets as the export, and so do M8's view tools.
const REPORT_SETS = EXPORT_SETS;
const VIEW_SETS = EXPORT_SETS;

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
  { name: 'wolf-demold-hint', file: EXAMPLE_FILES.wolf, grid: [1, 1], scroll: 'demold', show: 'hint', only: REPORT_SETS },
  { name: 'benchy-underside-air', file: EXAMPLE_FILES.benchy, grid: [1, 1], scroll: 'demold', show: 'air-underside', only: REPORT_SETS },
  { name: 'barrel-sealed-void', file: EXAMPLE_FILES.barrel, grid: [1, 1], scroll: 'demold', show: 'air-sealed', only: REPORT_SETS },
  { name: 'vis35-bed', file: EXAMPLE_FILES.vis35, grid: [1, 1], only: REPORT_SETS },
  { name: 'x8-plausible', file: EXAMPLE_FILES.x8, grid: [1, 1], scroll: 'demold', only: REPORT_SETS },
  // The tape advice under Cover & joint.
  { name: 'wolf-cover', file: EXAMPLE_FILES.wolf, grid: [1, 1], scroll: 'cover', only: REPORT_SETS },
  { name: 'benchy-section-x', file: EXAMPLE_FILES.benchy, grid: [1, 1], section: 'x', only: VIEW_SETS },
  { name: 'wolf-section-y', file: EXAMPLE_FILES.wolf, grid: [1, 1], section: 'y', faceCut: true, only: VIEW_SETS },
  { name: 'barrel-section-x', file: EXAMPLE_FILES.barrel, grid: [1, 1], section: 'x', faceCut: true, only: VIEW_SETS },
  { name: 'wolf-exploded', file: EXAMPLE_FILES.wolf, grid: [1, 1], explode: true, only: VIEW_SETS },
  { name: 'x8-3x3-drag-invalid', file: EXAMPLE_FILES.x8, grid: [3, 3], topView: true, dragInvalid: true, only: VIEW_SETS },
  { name: 'benchy-top-view', file: EXAMPLE_FILES.benchy, grid: [1, 1], topView: true, only: VIEW_SETS },
  { name: 'jersey-undo-title', file: EXAMPLE_FILES.jersey, grid: [1, 1], undoTitle: true, only: VIEW_SETS },
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
          if (shot.show === 'hint') await page.locator('.cut-hint').first().getByRole('button', { name: 'Show' }).click();
          else if (shot.show) await page.locator(`.diagnostic[data-code="${shot.show}"]`).first().getByRole('button', { name: 'Show' }).click();
          if (shot.scroll === 'advanced') await page.locator('.advanced > summary').click();
          if (shot.scroll) {
            await page.locator(`[data-section="${shot.scroll}"]`).evaluate((section) => {
              const sections = section.closest('[data-testid="sections"]')!;
              sections.scrollTop = (section as HTMLElement).offsetTop - (sections as HTMLElement).offsetTop;
            });
          }
          if (shot.section) {
            await page.getByTestId('section').check();
            await page.locator(`[data-cut="${shot.section}"]`).click();
          }
          if (shot.faceCut) {
            // From the side the cut faces, back along the kept side's normal, and raised a little.
            await app(page, (a) => {
              const { min, max } = (window as unknown as { __pipeline: { partBounds: (p: string) => { min: number[]; max: number[] } } }).__pipeline.partBounds('cover');
              const c = [0, 1, 2].map((k) => (min[k] + max[k]) / 2);
              const d = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
              const n = a.scene.section.plane.normal;
              (window as unknown as { __pipeline: { setCamera: (v: unknown) => void } }).__pipeline.setCamera({ position: [c[0] - n.x * 1.6 * d, c[1] - n.y * 1.6 * d, c[2] - n.z * 1.6 * d + 0.35 * d], target: c, fov: 35 });
            });
          }
          if (shot.explode) await page.getByTestId('explode').check();
          if (shot.topView) {
            await page.getByTestId('top-view').click();
            // The click scrolled the sidebar to the button; Pour & funnel at the top shows the rows the drag moves.
            await page.locator('[data-section="pour"]').evaluate((section) => {
              const sections = section.closest('[data-testid="sections"]')!;
              sections.scrollTop = (section as HTMLElement).offsetTop - (sections as HTMLElement).offsetTop;
            });
          }
          if (shot.dragInvalid) {
            // The first pour's copy on the middle tile, held on the nearest other opening of that tile.
            const spots = await app(page, (a) => {
              const p = a.store.pipeline, placement = p.placement!.value, Zt = p.field!.value.rim.Zt;
              const [ox, oy] = placement.space.offsets[Math.floor(placement.space.offsets.length / 2)];
              const openings = placement.placement.openings;
              const pour = openings.find((o) => o.kind === 'pour')!;
              const other = openings.filter((o) => o !== pour).sort((a, b) => Math.hypot(a.x - pour.x, a.y - pour.y) - Math.hypot(b.x - pour.x, b.y - pour.y))[0];
              const screen = (x: number, y: number): { x: number; y: number } => (window as unknown as { __pipeline: { worldToScreen: (p: number[]) => { x: number; y: number } } }).__pipeline.worldToScreen([x + ox, y + oy, Zt]);
              return { from: screen(pour.x, pour.y), to: screen(other.x, other.y) };
            });
            await page.mouse.move(spots.from.x, spots.from.y);
            await page.mouse.down();
            await page.mouse.move(spots.to.x, spots.to.y, { steps: 8 });
            await expect(page.getByTestId('drag-reason')).toBeVisible();
          }
          if (shot.undoTitle) {
            await page.locator('[data-param="silicone.t"] input[type="range"]').evaluate((el) => {
              (el as HTMLInputElement).value = '3.5';
              el.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await hooks(page, (h) => h.idle());
            await page.getByTestId('undo').hover();
            await page.evaluate(() => {
              const button = document.querySelector('[data-testid="undo"]')!;
              const r = button.getBoundingClientRect();
              const tip = document.createElement('div');
              tip.textContent = button.getAttribute('title');
              tip.style.cssText = `position:fixed;top:${r.bottom + 8}px;right:${innerWidth - r.right - 40}px;padding:3px 7px;font:12px system-ui,sans-serif;background:#f8f8f8;color:#111;border:1px solid #888;box-shadow:0 1px 3px rgba(0,0,0,.3);z-index:99;white-space:nowrap`;
              document.body.append(tip);
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
          if (shot.dragInvalid) {
            await page.keyboard.press('Escape');
            await page.mouse.up();
          }
          console.log(`saved ${path}`);
          expect(watch.errors).toEqual([]);
          expect(watch.foreign).toEqual([]);
        });
      }
    }
  }
});
