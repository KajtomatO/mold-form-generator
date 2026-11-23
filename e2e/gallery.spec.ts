import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_GALLERY_MODEL, GALLERY, GALLERY_LICENCES } from '../src/gallery/catalogue';
import { THIRD_PARTY } from '../test/fixtures/galleryFixture';
import { EXAMPLE_FILES } from '../test/fixtures/loadExamples';
import { app, canDraw, checkLayout, dropExample, hooks, idle, openApp, watchPage, type PageWatch } from './appHarness';
import { NO_FIREFOX_WEBGL } from './firefox';

/**
 * GA: the example gallery in the browser (R47, R48, D29): the sphere a plain load opens, the empty page ?test=1
 * keeps, the Examples panel and the empty view's thumbnails, and the credit of a model not ours, which the test
 * hooks add from test/fixtures/galleryFixture.ts as the gallery holds none until MP6.
 */
const SHOTS = process.env.CFG_SHOTS === '1';
const SHOTS_DIR = process.env.CFG_SHOTS_DIR ?? join(import.meta.dirname, '..', 'test-results', 'shots');
const sphere = GALLERY.find((e) => e.id === DEFAULT_GALLERY_MODEL)!;

/** Whether leaving the page now would ask first: the page's own beforeunload handler, dispatched. */
const leaving = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });

/** Opens a page of the app without the test hooks, as a visitor does, watched as openApp watches. */
async function openPlain(page: Page, path: string, hold?: (path: string) => Promise<void> | null): Promise<PageWatch> {
  const watch = await watchPage(page, hold);
  await page.goto(path);
  await expect(page).toHaveTitle('Mold Form Generator');
  return watch;
}

/** The gallery files the page asked for, by path. */
function galleryRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (path.includes('/gallery/')) seen.push(path);
  });
  return seen;
}

const fileName = (page: Page) => page.getByTestId('file-name');

test.describe('GA: the gallery and the default sphere', () => {
  test.beforeEach(({ page }) => {
    test.skip(!canDraw(page), NO_FIREFOX_WEBGL);
  });

  test('@smoke a plain load opens the sphere, fetched from the host relative to the page, with nothing unsaved and no history; a drop replaces it with no question, also after a setting changed', async ({ page }) => {
    const requests = galleryRequests(page);
    const watch = await openPlain(page, '/');
    await expect(fileName(page)).toHaveText(`${sphere.file}, 2,022 triangles`);
    expect(requests.filter((p) => p.endsWith('.stl'))).toEqual(['/gallery/sphere.stl']);
    await expect(page.getByTestId('stale')).toBeHidden({ timeout: 120_000 });
    // The page starts with no history and nothing unsaved: leaving it asks nothing.
    await expect(page.getByTestId('undo')).toBeDisabled();
    await expect(page.getByTestId('project-changed')).toHaveCount(0);
    expect(await leaving(page)).toBe(false);
    // Our own model shows no credit, and the empty view's examples are gone with the drop hint.
    await expect(page.getByTestId('model-credit')).toHaveCount(0);
    await expect(page.getByTestId('drop-examples')).toHaveCount(0);

    // A setting changed: leaving asks, and a drop still opens with no question, as nothing of the maker's is lost.
    const t = page.locator('[data-param="silicone.t"] input.num');
    await t.fill('4');
    await t.press('Enter');
    await expect(page.getByTestId('undo')).toBeEnabled();
    expect(await leaving(page)).toBe(true);
    await dropExample(page, EXAMPLE_FILES.jersey);
    await expect(fileName(page)).toContainText(EXAMPLE_FILES.jersey);
    await expect(page.getByTestId('replace-prompt')).toHaveCount(0);
    expect(await leaving(page)).toBe(false);
    expect(watch.errors).toEqual([]);
    expect(watch.foreign).toEqual([]);
  });

  test('?test=1 stays empty, ?test=1&model=cone opens the cone, and model=none keeps a plain page empty', async ({ page }) => {
    const requests = galleryRequests(page);
    const watch = await openApp(page);
    // The empty view offers the examples; nothing of the gallery but their thumbnails is fetched.
    await expect(page.getByTestId('drop-examples').getByRole('button')).toHaveCount(GALLERY.length);
    await expect.poll(() => page.locator('.drop-example img').evaluateAll((imgs) => imgs.map((img) => (img as HTMLImageElement).naturalWidth))).toEqual(GALLERY.map(() => 192));
    expect(await app(page, (a) => a.store.pipeline.modelName)).toBeNull();
    expect(requests.filter((p) => p.endsWith('.stl'))).toEqual([]);

    await page.goto('/?test=1&model=cone');
    await page.waitForFunction(() => '__app' in window);
    await expect(fileName(page)).toHaveText('cone.stl, 254 triangles');
    await idle(page);
    expect(await app(page, (a) => ({ unsaved: a.store.unsaved(), history: a.store.history.depth, gallery: a.store.galleryModel.value }))).toEqual({ unsaved: false, history: { undo: 0, redo: 0 }, gallery: 'cone' });

    await page.goto('/?model=none');
    await expect(page.getByTestId('drop-examples')).toBeVisible();
    await page.waitForTimeout(500);
    await expect(fileName(page)).toHaveText('Or drop an STL or a project on the view.');
    expect(requests.filter((p) => p.endsWith('.stl'))).toEqual(['/gallery/cone.stl']);
    expect(watch.errors).toEqual([]);
    expect(watch.foreign).toEqual([]);
  });

  test('a file dropped while the default is fetched wins', async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let asked!: () => void;
    const reached = new Promise<void>((resolve) => (asked = resolve));
    const watch = await openPlain(page, '/', (path) => {
      if (!path.endsWith('/gallery/sphere.stl')) return null;
      asked();
      return held;
    });
    await reached;
    // Meanwhile the empty view says the sphere is coming, in place of the drop hint and its examples.
    await expect(page.getByTestId('gallery-pending')).toHaveText(`Opening ${sphere.title}…`);
    await expect(page.getByTestId('drop-examples')).toHaveCount(0);
    await dropExample(page, EXAMPLE_FILES.jersey);
    await expect(fileName(page)).toContainText(EXAMPLE_FILES.jersey);
    const done = page.waitForEvent('requestfinished', (r) => r.url().endsWith('/gallery/sphere.stl'));
    release();
    await done;
    // Past the fetch, the default is dropped: the model stays the file.
    await page.waitForTimeout(1000);
    await expect(fileName(page)).toContainText(EXAMPLE_FILES.jersey);
    await expect(page.getByTestId('replace-prompt')).toHaveCount(0);
    expect(watch.errors).toEqual([]);
    expect(watch.foreign).toEqual([]);
  });

  test('every card opens its model; the third-party card and its credit line link the right pages, our own show none; the keyboard path returns focus', async ({ page }) => {
    const watch = await openApp(page);
    await hooks(page, (h, entry: never) => h.addGalleryEntry(entry), THIRD_PARTY);
    const examples = page.getByTestId('examples');
    const panel = page.getByTestId('examples-panel');
    for (const entry of [...GALLERY, THIRD_PARTY]) {
      if (!(await panel.isVisible())) await examples.click();
      await expect(examples).toHaveAttribute('aria-expanded', 'true');
      const card = panel.getByRole('button', { name: `Open the example ${entry.title}` });
      await card.click();
      // The panel closes as the model opens, and gives focus back to its button.
      await expect(panel).toHaveCount(0);
      await expect(examples).toBeFocused();
      await expect.poll(() => app(page, (a) => [a.store.pipeline.modelName, a.store.galleryModel.value])).toEqual([entry.file, entry.id]);
      await expect(page.getByTestId('replace-prompt')).toHaveCount(0);
      const credit = page.getByTestId('model-credit');
      if (entry.own) {
        await expect(credit).toHaveCount(0);
        continue;
      }
      const licence = GALLERY_LICENCES[entry.licence];
      await expect(credit).toHaveText(`${entry.title} by ${entry.author} · Printables · ${licence.short}`);
      const links = (scope: typeof credit) => scope.locator('a').evaluateAll((anchors) => anchors.map((a) => [a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel'), a.getAttribute('data-link')]));
      const expected = [[entry.authorUrl, '_blank', 'noopener', 'author'], [entry.url, '_blank', 'noopener', 'model'], [licence.deed, '_blank', 'noopener', 'licence']];
      expect(await links(credit)).toEqual(expected);
      // Its card says the same, under its button.
      await examples.click();
      const cardCredit = panel.locator(`[data-gallery="${entry.id}"] [data-testid="card-credit"]`);
      await expect(cardCredit).toHaveText((await credit.textContent()) ?? '');
      expect(await links(cardCredit)).toEqual(expected);
      await expect(panel.locator('[data-testid="card-credit"]')).toHaveCount(1);
      await page.keyboard.press('Escape');
    }
    // The badge marks the sphere alone.
    await examples.click();
    await expect(panel.locator('.gallery-badge')).toHaveCount(1);
    await expect(panel.locator(`[data-gallery="${DEFAULT_GALLERY_MODEL}"] .gallery-badge`)).toHaveText('Two-part');
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);

    // By keyboard alone: Enter opens the panel on its first card, Esc closes it back to the button, and a card
    // chosen with Enter opens its model and gives focus back there too.
    await examples.focus();
    await page.keyboard.press('Enter');
    await expect(panel.getByRole('button', { name: `Open the example ${GALLERY[0].title}` })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(examples).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await expect(panel.getByRole('button', { name: `Open the example ${GALLERY[1].title}` })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(panel).toHaveCount(0);
    await expect(examples).toBeFocused();
    await expect.poll(() => app(page, (a) => a.store.pipeline.modelName)).toBe(GALLERY[1].file);
    await idle(page);
    await checkLayout(page, watch);
  });

  test('the empty view\'s thumbnails open their models, a model not ours with its author, and give focus to Examples; the file row is one line', async ({ page }) => {
    const watch = await openApp(page);
    await hooks(page, (h, entry: never) => h.addGalleryEntry(entry), THIRD_PARTY);
    // Open, Save project and Examples fit on one line of the sidebar.
    const tops = await page.locator('.file-row > .btn').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
    expect(tops).toHaveLength(3);
    expect(new Set(tops).size).toBe(1);
    const third = page.getByTestId('drop-examples').getByRole('button', { name: `Open the example ${THIRD_PARTY.title}` });
    await expect(third).toContainText(`by ${THIRD_PARTY.author}`);
    await expect(third).toHaveAttribute('title', /Test Block by A\. Tester · Printables · CC BY 4\.0$/);
    await page.getByTestId('drop-examples').getByRole('button', { name: 'Open the example Cylinder' }).click();
    await expect(fileName(page)).toHaveText('cylinder.stl, 508 triangles');
    await expect(page.getByTestId('drop-examples')).toHaveCount(0);
    await expect(page.getByTestId('examples')).toBeFocused();
    await idle(page);
    expect(watch.errors).toEqual([]);
    expect(watch.foreign).toEqual([]);
  });

  test('Esc in the Examples panel closes the panel alone, so Pick a face stays on', async ({ page }) => {
    const watch = await openApp(page);
    await page.getByTestId('drop-examples').getByRole('button', { name: 'Open the example Cube' }).click();
    await expect(fileName(page)).toHaveText('cube.stl, 12 triangles');
    await idle(page);
    await app(page, (a) => (a.store.pickMode.value = true));
    await page.getByTestId('examples').click();
    await expect(page.getByTestId('examples')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('examples-panel')).toHaveCount(0);
    expect(await app(page, (a) => a.store.pickMode.value)).toBe(true);
    // The next Esc, with the panel closed, leaves Pick a face.
    await page.keyboard.press('Escape');
    expect(await app(page, (a) => a.store.pickMode.value)).toBe(false);
    expect(watch.errors).toEqual([]);
  });

  test('a gallery model saved as a project is the maker\'s own: changed after Save project, a drop asks first', async ({ page }) => {
    const watch = await openApp(page, '&model=sphere');
    await expect(fileName(page)).toHaveText(`${sphere.file}, 2,022 triangles`);
    await idle(page);
    const t = page.locator('[data-param="silicone.t"] input.num');
    await t.fill('4');
    await t.press('Enter');
    const download = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByTestId('save-project').click();
    expect((await download).suggestedFilename()).toBe('sphere.moldproj');
    await expect.poll(() => app(page, (a) => a.store.galleryModel.value)).toBeNull();
    await t.fill('5');
    await t.press('Enter');
    await dropExample(page, EXAMPLE_FILES.jersey);
    await expect(page.getByTestId('replace-prompt')).toBeVisible();
    expect(watch.errors).toEqual([]);
  });

  test('review shots of the Examples panel, the credit and the empty view, in both themes', async ({ page, browserName }) => {
    test.skip(!SHOTS, 'CFG_SHOTS=1 takes them');
    mkdirSync(SHOTS_DIR, { recursive: true });
    await openApp(page);
    await hooks(page, (h, entry: never) => h.addGalleryEntry(entry), THIRD_PARTY);
    for (const theme of ['dark', 'light']) {
      if ((await page.evaluate(() => document.documentElement.dataset.theme ?? 'dark')) !== theme) await page.getByTestId('theme').click();
      await page.mouse.move(683, 400);
      await page.screenshot({ path: join(SHOTS_DIR, `ga-empty-${browserName}-${theme}.png`) });
    }
    await page.getByTestId('examples').click();
    await page.getByTestId('examples-panel').getByRole('button', { name: `Open the example ${THIRD_PARTY.title}` }).click();
    await idle(page);
    for (const theme of ['light', 'dark']) {
      if ((await page.evaluate(() => document.documentElement.dataset.theme ?? 'dark')) !== theme) await page.getByTestId('theme').click();
      await page.mouse.move(683, 400);
      // The credit under the file row, with the panel closed and the Model section at the top.
      await page.getByTestId('sections').evaluate((el) => (el.scrollTop = 0));
      await page.screenshot({ path: join(SHOTS_DIR, `ga-credit-${browserName}-${theme}.png`), clip: (await page.locator('[data-section="model"]').boundingBox())! });
      await page.getByTestId('examples').click();
      await page.screenshot({ path: join(SHOTS_DIR, `ga-gallery-panel-${browserName}-${theme}.png`) });
      await page.keyboard.press('Escape');
    }
  });
});
