import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { HINT_DELAY_MS } from '../src/help/config';
import { EXPLODE_FRAMES, EXPLODE_GRID, EXPLODE_SIZE, explodeFile, HELP_THEMES } from '../src/help/media';
import { HELP } from '../src/help/topics';
import { hooks, openApp } from './appHarness';

/**
 * HB: the help on the mold type switch in the browser (docs/PLAN.md, HB; R46): the pictograms that pull apart, the
 * hint card with its explode animation, the "?" and its popover, reduced motion, and the help where the view cannot
 * draw. None of it needs WebGL, so it all runs in Firefox with no display too.
 */
const SHOTS = process.env.CFG_SHOTS === '1';
const SHOTS_DIR = process.env.CFG_SHOTS_DIR ?? join(import.meta.dirname, '..', 'test-results', 'shots');
const LAST = EXPLODE_FRAMES - 1;

/** The page's errors less the view's own where the browser has no WebGL, as Firefox without a display. */
const drawErrorsAside = (errors: string[]): string[] => errors.filter((e) => !/WebGL|webgl/.test(e));

const tile = (page: Page, id: string): Locator => page.locator(`.mold-tile[data-type="${id}"]`);
const hint = (page: Page): Locator => page.getByTestId('help-hint');
const help = (page: Page): Locator => page.getByTestId('help-button-mold.type');
const popover = (page: Page): Locator => page.getByTestId('help-popover');

/** Each moving part's computed transform in a tile's pictogram. */
function transforms(page: Page, id: string): Promise<string[]> {
  return tile(page, id).locator('.pictogram .part').evaluateAll((parts) => parts.map((p) => getComputedStyle(p).transform));
}

/** An animation's frame now. */
async function frameOf(animation: Locator): Promise<number> {
  return Number(await animation.getAttribute('data-frame'));
}

/** The pointer away from the switch, so nothing there is hovered. */
async function pointerAway(page: Page): Promise<void> {
  await page.mouse.move(400, 400);
}

/** Keyboard focus on a tile: from the "?" just before the tiles, by Tab, so it is the keyboard's (:focus-visible). */
async function tabTo(page: Page, id: string): Promise<void> {
  await help(page).focus();
  await page.keyboard.press('Tab');
  if (id !== 'one-piece') await page.keyboard.press('ArrowRight');
  await expect(tile(page, id)).toBeFocused();
}

/**
 * How many pixels of an element's own screenshot differ from its top left corner's, decoded in the page: an animation
 * whose sheet has not been painted yet is its panel's colour all over.
 */
async function paintedPixels(page: Page, element: Locator): Promise<number> {
  const png = (await element.screenshot()).toString('base64');
  return page.evaluate(async (data) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const { data: rgba } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let count = 0;
    for (let i = 0; i < rgba.length; i += 4) if (Math.abs(rgba[i] - rgba[0]) + Math.abs(rgba[i + 1] - rgba[1]) + Math.abs(rgba[i + 2] - rgba[2]) > 24) count++;
    return count;
  }, png);
}

/** Each frame of a sheet, decoded in the page: its drawn pixels, whether its four corners are clear, and the parts' height. */
interface SheetFrame {
  drawn: number;
  clearCorners: boolean;
  height: number;
}

async function useTheme(page: Page, theme: string): Promise<void> {
  if ((await page.evaluate(() => document.documentElement.dataset.theme ?? 'dark')) !== theme) await page.getByTestId('theme').click();
}

test.describe('HB: the help on the mold type switch', () => {
  test('@smoke hover and keyboard focus pull the pictogram\'s parts apart, and leaving puts them back', async ({ page }) => {
    const watch = await openApp(page);
    await pointerAway(page);
    expect(await transforms(page, 'clamshell')).toEqual(['none', 'none', 'none']);
    await tile(page, 'clamshell').hover();
    // The halves part sideways and the base drops, by their own offsets, once the 250 ms transition ends.
    await expect.poll(() => transforms(page, 'clamshell')).toEqual(['matrix(1, 0, 0, 1, -2.6, 0)', 'matrix(1, 0, 0, 1, 2.6, 0)', 'matrix(1, 0, 0, 1, 0, 2.4)']);
    // The other tile's do not move.
    expect(await transforms(page, 'one-piece')).toEqual(['none', 'none']);
    await pointerAway(page);
    await expect.poll(() => transforms(page, 'clamshell')).toEqual(['none', 'none', 'none']);
    // From the keyboard: the cover lifts and the base drops.
    await tabTo(page, 'one-piece');
    await expect.poll(() => transforms(page, 'one-piece')).toEqual(['matrix(1, 0, 0, 1, 0, -3.2)', 'matrix(1, 0, 0, 1, 0, 2.4)']);
    // The outlines for reduced motion stay hidden.
    expect(await tile(page, 'one-piece').locator('.pictogram .ghost').evaluateAll((g) => g.map((e) => getComputedStyle(e).display))).toEqual(['none', 'none']);
    expect(watch.foreign).toEqual([]);
    expect(drawErrorsAside(watch.errors)).toEqual([]);
  });

  test('the hint card shows after its delay with the type\'s animation and line, is the tile\'s description, and goes on leave, blur and Esc', async ({ page }) => {
    const watch = await openApp(page);
    const help: string[] = [];
    page.on('response', (r) => {
      if (new URL(r.url()).pathname.includes('/help/')) help.push(`${r.status()} ${new URL(r.url()).pathname}`);
    });
    await pointerAway(page);
    await tile(page, 'clamshell').hover();
    const shownAt = Date.now();
    await expect(hint(page)).toBeVisible();
    expect(Date.now() - shownAt).toBeGreaterThanOrEqual(HINT_DELAY_MS - 50);
    await expect(hint(page)).toHaveAttribute('role', 'tooltip');
    await expect(hint(page)).toContainText(HELP['mold.clamshell'].summary);
    const animation = hint(page).locator('.help-anim');
    await expect(animation).toHaveAttribute('data-type', 'clamshell');
    await expect(animation).toHaveAttribute('style', /help\/explode-clamshell-dark\.webp/);
    // It plays: the frame moves on.
    await expect.poll(() => frameOf(animation)).toBeGreaterThan(0);
    // Clear of the row of tiles, so it covers neither, level with the tile.
    const [card, row, at] = [await hint(page).boundingBox(), await page.locator('.mold-tiles').boundingBox(), await tile(page, 'clamshell').boundingBox()];
    expect(card!.x + card!.width).toBeLessThanOrEqual(row!.x);
    expect(Math.abs(card!.y - at!.y)).toBeLessThan(1);
    await expect(tile(page, 'clamshell')).toHaveAttribute('aria-describedby', 'mold-tile-hint-clamshell');
    // Its line, then what the Two-part cover saves here once the estimate is in; the tile has no title to say it again.
    await expect(tile(page, 'clamshell')).toHaveAccessibleDescription(new RegExp(`^${HELP['mold.clamshell'].summary.replace(/[.]/g, '\\.')}`));
    await expect(tile(page, 'clamshell')).not.toHaveAttribute('title');
    // It takes no pointer and no focus: the tile under the pointer keeps them.
    expect(await hint(page).evaluate((e) => getComputedStyle(e).pointerEvents)).toBe('none');
    await pointerAway(page);
    await expect(hint(page)).toHaveCount(0);
    await expect(tile(page, 'clamshell')).not.toHaveAttribute('aria-describedby', /hint/);

    // Leaving before the delay shows nothing.
    await tile(page, 'one-piece').hover();
    await pointerAway(page);
    await page.waitForTimeout(HINT_DELAY_MS + 200);
    await expect(hint(page)).toHaveCount(0);

    // By keyboard focus, in the light theme: its own sheet; Esc hides it, focus stays on the tile.
    await useTheme(page, 'light');
    await tabTo(page, 'one-piece');
    await expect(hint(page)).toBeVisible();
    await expect(hint(page).locator('.help-anim')).toHaveAttribute('style', /help\/explode-one-piece-light\.webp/);
    await page.keyboard.press('Escape');
    await expect(hint(page)).toHaveCount(0);
    await expect(tile(page, 'one-piece')).toBeFocused();
    // Blur hides it too.
    await page.keyboard.press('ArrowRight');
    await expect(hint(page)).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(hint(page)).toHaveCount(0);
    // A click on a tile does not leave a card over the window it opens.
    await useTheme(page, 'dark');
    await tile(page, 'clamshell').click();
    await page.waitForTimeout(HINT_DELAY_MS + 200);
    await expect(hint(page)).toHaveCount(0);

    expect(help.every((line) => line.startsWith('200 '))).toBe(true);
    expect(help).toEqual(expect.arrayContaining(['200 /help/explode.json', '200 /help/explode-clamshell-dark.webp', '200 /help/explode-one-piece-light.webp']));
    expect(watch.foreign).toEqual([]);
    expect(drawErrorsAside(watch.errors)).toEqual([]);
  });

  test('the "?" opens every type\'s help with its animation and Replay, and closes on Esc, a click outside and itself', async ({ page }) => {
    const watch = await openApp(page);
    await expect(help(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(help(page)).toHaveAttribute('aria-controls', 'help-mold-type');
    await expect(popover(page)).not.toBeVisible();
    await help(page).click();
    await expect(popover(page)).toBeVisible();
    await expect(help(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(popover(page)).toHaveAttribute('id', 'help-mold-type');
    for (const id of ['mold.one-piece', 'mold.clamshell', 'seam-bolts', 'seam-clips'] as const) await expect(popover(page).locator(`[data-help="${id}"]`)).toContainText(HELP[id].title);
    const animations = popover(page).locator('.help-anim');
    await expect(animations).toHaveCount(2);
    // Each plays once its sheet has loaded, to the parts apart.
    for (const animation of await animations.all()) {
      await expect(animation).toHaveAttribute('data-ready', 'true');
      await expect.poll(() => frameOf(animation)).toBe(LAST);
    }
    const clamshell = popover(page).locator('.help-anim[data-type="clamshell"]');
    await popover(page).getByRole('button', { name: 'Replay: Two-part cover' }).click();
    await expect.poll(() => frameOf(clamshell)).toBeLessThan(LAST);
    await expect.poll(() => frameOf(clamshell)).toBe(LAST);
    // Under the "?", inside the window, and placed again inside a narrower one.
    const [button, box] = [await help(page).boundingBox(), await popover(page).boundingBox()];
    expect(box!.y).toBeGreaterThan(button!.y + button!.height - 1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    const viewport = page.viewportSize()!;
    await page.setViewportSize({ width: 1000, height: 600 });
    await expect.poll(async () => { const b = (await popover(page).boundingBox())!; return b.x + b.width <= 1000 && b.y + b.height <= 600; }).toBe(true);
    await page.setViewportSize(viewport);
    // No hint card over the open popover: a tile's hover waits it out.
    await tile(page, 'clamshell').dispatchEvent('pointerenter');
    await page.waitForTimeout(HINT_DELAY_MS + 200);
    await expect(hint(page)).toHaveCount(0);
    await tile(page, 'clamshell').dispatchEvent('pointerleave');
    // Not a dialog: the "?" is its disclosure, and the switch window stays the app's one dialog.
    await expect(popover(page)).not.toHaveAttribute('role');
    await page.keyboard.press('Escape');
    await expect(popover(page)).not.toBeVisible();
    await expect(help(page)).toHaveAttribute('aria-expanded', 'false');
    // A click outside closes it.
    await help(page).click();
    await expect(popover(page)).toBeVisible();
    await page.mouse.click(200, 400);
    await expect(popover(page)).not.toBeVisible();
    // And a second click on the "?".
    await help(page).click();
    await expect(popover(page)).toBeVisible();
    await help(page).click();
    await expect(popover(page)).not.toBeVisible();
    await expect(help(page)).toHaveAttribute('aria-expanded', 'false');
    expect(watch.foreign).toEqual([]);
    expect(drawErrorsAside(watch.errors)).toEqual([]);
  });

  test('with reduced motion the parts stay still with an outline where each goes, and the animations show their last frame until Replay', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const watch = await openApp(page);
    await pointerAway(page);
    await tile(page, 'clamshell').hover();
    await expect(hint(page)).toBeVisible();
    expect(await transforms(page, 'clamshell')).toEqual(['none', 'none', 'none']);
    const ghosts = tile(page, 'clamshell').locator('.pictogram .ghost');
    expect(await ghosts.evaluateAll((g) => g.map((e) => [getComputedStyle(e).display, getComputedStyle(e).transform]))).toEqual([
      ['inline', 'matrix(1, 0, 0, 1, -2.6, 0)'],
      ['inline', 'matrix(1, 0, 0, 1, 2.6, 0)'],
      ['inline', 'matrix(1, 0, 0, 1, 0, 2.4)'],
    ]);
    const still = hint(page).locator('.help-anim');
    await expect(still).toHaveAttribute('data-frame', String(LAST));
    await page.waitForTimeout(500);
    await expect(still).toHaveAttribute('data-frame', String(LAST));
    await pointerAway(page);
    await help(page).click();
    const clamshell = popover(page).locator('.help-anim[data-type="clamshell"]');
    await expect(clamshell).toHaveAttribute('data-frame', String(LAST));
    // Replay plays once, only on its click.
    await popover(page).getByRole('button', { name: 'Replay: Two-part cover' }).click();
    await expect.poll(() => frameOf(clamshell)).toBeLessThan(LAST);
    await expect.poll(() => frameOf(clamshell)).toBe(LAST);
    await page.waitForTimeout(500);
    await expect(clamshell).toHaveAttribute('data-frame', String(LAST));
    // A new sheet after that click, as the theme changes from the keyboard with the popover open, plays nothing.
    await clamshell.evaluate((element) => {
      const seen: string[] = [];
      (window as unknown as { __frames: string[] }).__frames = seen;
      new MutationObserver(() => seen.push(element.getAttribute('data-frame') ?? '')).observe(element, { attributes: true, attributeFilter: ['data-frame'] });
    });
    await page.getByTestId('theme').focus();
    await page.keyboard.press('Enter');
    await expect(popover(page)).toBeVisible();
    await expect(clamshell).toHaveAttribute('style', /explode-clamshell-light\.webp/);
    await page.waitForTimeout(800);
    expect((await page.evaluate(() => (window as unknown as { __frames: string[] }).__frames)).filter((f) => f !== String(LAST))).toEqual([]);
    await expect(clamshell).toHaveAttribute('data-frame', String(LAST));
    expect(watch.foreign).toEqual([]);
    expect(drawErrorsAside(watch.errors)).toEqual([]);
  });

  test('each sheet\'s frames show the parts on a clear background, further apart in the last frame than in the first', async ({ page }) => {
    await openApp(page);
    const [width, height] = EXPLODE_SIZE, [columns] = EXPLODE_GRID;
    for (const type of ['one-piece', 'clamshell']) {
      for (const theme of HELP_THEMES) {
        const frames = await page.evaluate(
          async ({ url, width, height, columns, picks }) => {
            const bitmap = await createImageBitmap(await (await fetch(url)).blob());
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const context = canvas.getContext('2d')!;
            context.drawImage(bitmap, 0, 0);
            return picks.map((k) => {
              const { data } = context.getImageData((k % columns) * width, Math.floor(k / columns) * height, width, height);
              const alpha = (x: number, y: number): number => data[4 * (y * width + x) + 3];
              let drawn = 0, top = height, bottom = -1;
              for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                  if (alpha(x, y) < 8) continue;
                  drawn++;
                  top = Math.min(top, y);
                  bottom = Math.max(bottom, y);
                }
              }
              const clearCorners = [alpha(0, 0), alpha(width - 1, 0), alpha(0, height - 1), alpha(width - 1, height - 1)].every((a) => a === 0);
              return { drawn, clearCorners, height: bottom - top + 1 };
            });
          },
          { url: `help/${explodeFile(type, theme)}`, width, height, columns, picks: [0, LAST] },
        );
        const [first, last] = frames as SheetFrame[];
        for (const frame of [first, last]) {
          expect(frame.drawn, `${type} ${theme}`).toBeGreaterThan(0.05 * width * height);
          expect(frame.clearCorners, `${type} ${theme}`).toBe(true);
        }
        // The base drops away under the cover, or the halves under the seam, so the parts stand taller apart.
        expect(last.height, `${type} ${theme}`).toBeGreaterThan(first.height);
      }
    }
  });

  test('without WebGL 2 the switch and its help still work', async ({ page }) => {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
        return /webgl/i.test(kind) ? null : (original as (...a: unknown[]) => RenderingContext | null).call(this, kind, ...rest);
      } as typeof original;
    });
    const watch = await openApp(page);
    await expect(page.locator('.no-gl')).toBeVisible();
    await pointerAway(page);
    await tile(page, 'clamshell').hover();
    await expect(hint(page)).toBeVisible();
    await expect.poll(() => transforms(page, 'clamshell')).toEqual(['matrix(1, 0, 0, 1, -2.6, 0)', 'matrix(1, 0, 0, 1, 2.6, 0)', 'matrix(1, 0, 0, 1, 0, 2.4)']);
    await expect.poll(() => frameOf(hint(page).locator('.help-anim'))).toBeGreaterThan(0);
    await pointerAway(page);
    await help(page).click();
    await expect(popover(page).locator('.help-anim')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(popover(page)).not.toBeVisible();
    // The switch itself still switches.
    await tile(page, 'clamshell').click();
    await expect.poll(() => hooks(page, (h) => h.params().mold.type)).toBe('clamshell');
    expect(watch.foreign).toEqual([]);
    expect(drawErrorsAside(watch.errors)).toEqual([]);
  });

  test('review shots: hb-hint, hb-popover and hb-reduced in both themes', async ({ page, browserName }) => {
    test.skip(!SHOTS, 'CFG_SHOTS=1 takes the review shots');
    mkdirSync(SHOTS_DIR, { recursive: true });
    await openApp(page);
    for (const theme of ['dark', 'light']) {
      await useTheme(page, theme);
      await pointerAway(page);
      await tile(page, 'clamshell').hover();
      await expect(hint(page)).toBeVisible();
      await expect.poll(() => frameOf(hint(page).locator('.help-anim'))).toBeGreaterThanOrEqual(12);
      await page.screenshot({ path: join(SHOTS_DIR, `hb-hint-${browserName}-${theme}.png`) });
      await pointerAway(page);
      await help(page).click();
      // The popover draws its content once it is open, so count the animations before taking them: all() does not wait.
      await expect(popover(page).locator('.help-anim')).toHaveCount(2);
      for (const animation of await popover(page).locator('.help-anim').all()) {
        await expect(animation).toHaveAttribute('data-ready', 'true');
        await expect.poll(() => frameOf(animation)).toBe(LAST);
        // And until the frame itself shows the parts, as data-ready says the sheet is decoded, not painted.
        await expect.poll(() => paintedPixels(page, animation)).toBeGreaterThan(1000);
      }
      await page.screenshot({ path: join(SHOTS_DIR, `hb-popover-${browserName}-${theme}.png`) });
      await page.keyboard.press('Escape');
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const theme of ['dark', 'light']) {
      await useTheme(page, theme);
      await pointerAway(page);
      await tile(page, 'clamshell').hover();
      await expect(hint(page)).toBeVisible();
      await page.screenshot({ path: join(SHOTS_DIR, `hb-reduced-${browserName}-${theme}.png`) });
    }
  });
});
