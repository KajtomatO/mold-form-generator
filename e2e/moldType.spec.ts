import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { projectFile, projectJson } from '../src/app/project';
import { packProject } from '../src/app/projectArchive';
import { defaultParams } from '../src/core/params/defaults';
import { DEFAULT_PLANE } from '../src/workers/fieldStages';
import { app, canDraw, hooks, openApp } from './appHarness';

/**
 * MT: the mold type switch and its window in the browser (docs/PLAN.md, MT; R44, D27). The Two-part tile is "Not
 * built yet" until MP5, so the test hook enables it, as it adds a fixture type to see the tiles wrap. None of this
 * needs the 3D view, so it runs in Firefox with no WebGL too; only the project reopened opens a model.
 */
const SHOTS = process.env.CFG_SHOTS === '1';
const SHOTS_DIR = process.env.CFG_SHOTS_DIR ?? join(import.meta.dirname, '..', 'test-results', 'shots');
const CUBE = new Uint8Array(readFileSync(join(import.meta.dirname, '..', 'public', 'gallery', 'cube.stl')));

const tile = (page: Page, id: string): Locator => page.locator(`.mold-tile[data-type="${id}"]`);
const row = (page: Page, path: string): Locator => page.locator(`.sidebar [data-param="${path}"]`);
const dialog = (page: Page): Locator => page.getByTestId('switch-dialog');
const typeOf = (page: Page): Promise<string> => hooks(page, (h) => h.params().mold.type);
const undoTitle = (page: Page): Promise<string | null> => page.getByTestId('undo').getAttribute('title');

/** Opens the app with the Two-part tile enabled, as the test hook does before MP5. */
async function openEnabled(page: Page): Promise<void> {
  await openApp(page);
  await hooks(page, (h) => h.enableMoldType('clamshell'));
  // The tiles read the registry as they draw: a change of the project draws them again.
  await hooks(page, (h) => h.setParam('silicone.t', 3));
  await expect(tile(page, 'clamshell')).not.toHaveAttribute('aria-disabled', 'true');
}

/** Types a value in a number row and commits it, as a maker does. */
async function typeIn(page: Page, path: string, value: string): Promise<void> {
  const box = row(page, path).locator('input.num');
  await box.fill(value);
  await box.press('Enter');
}

test.describe('MT: the mold type switch', () => {
  test('@smoke two tiles pinned at the top of the sidebar, the Two-part one not built yet; a third type wraps with no change', async ({ page }) => {
    const watch = await openApp(page);
    const block = page.locator('.mold-type');
    await expect(block.locator('h2')).toHaveText('Mold type');
    await expect(page.locator('.mold-tiles')).toHaveAttribute('role', 'group');
    // Above Model, and outside the sections that scroll.
    expect(await page.evaluate(() => {
      const switcher = document.querySelector('.mold-type')!, sections = document.querySelector('[data-testid="sections"]')!;
      return { inside: sections.contains(switcher), before: Boolean(switcher.compareDocumentPosition(sections) & Node.DOCUMENT_POSITION_FOLLOWING) };
    })).toEqual({ inside: false, before: true });
    await expect(page.locator('.mold-tile')).toHaveCount(2);
    await expect(tile(page, 'one-piece')).toHaveAttribute('aria-pressed', 'true');
    await expect(tile(page, 'one-piece')).toContainText('One-piece cover');
    await expect(tile(page, 'clamshell')).toHaveAttribute('aria-pressed', 'false');
    await expect(tile(page, 'clamshell')).toHaveAttribute('aria-disabled', 'true');
    await expect(tile(page, 'clamshell')).toHaveAttribute('title', 'Two-part cover: Not built yet.');
    await expect(tile(page, 'clamshell').locator('.why')).toHaveText('Not built yet');
    // The reason in full is the tile's description, as its title is not shown on focus.
    await expect(tile(page, 'clamshell')).toHaveAccessibleDescription('Not built yet.');
    // Not built yet, a click does nothing.
    await tile(page, 'clamshell').click({ force: true });
    expect(await typeOf(page)).toBe('one-piece');
    await expect(dialog(page)).not.toBeVisible();
    // The two-part cover's settings are hidden in the one-piece cover.
    await expect(row(page, 'clamshell.axis')).toHaveCount(0);
    await expect(page.getByTestId('two-part-group')).toHaveCount(0);

    // A third type, a fixture added by the test hook, is a third tile with no other change; a fourth goes on a second row.
    await hooks(page, (h) => h.addMoldType('tub', { name: 'Tub cover', blurb: 'A test type.', icon: 'tub', help: 'none' }));
    await expect(page.locator('.mold-tile')).toHaveCount(3);
    const boxes = async (): Promise<{ x: number; y: number; right: number }[]> =>
      page.locator('.mold-tile').evaluateAll((all) => all.map((t) => {
        const r = t.getBoundingClientRect();
        return { x: r.x, y: r.y, right: r.right };
      }));
    const three = await boxes();
    expect(new Set(three.map((b) => Math.round(b.y))).size).toBe(1);
    await hooks(page, (h) => h.addMoldType('crate', { name: 'Crate cover', blurb: 'A test type.', icon: 'crate', help: 'none' }));
    await expect(page.locator('.mold-tile')).toHaveCount(4);
    const four = await boxes();
    expect(four[3].y).toBeGreaterThan(four[0].y);
    expect(Math.round(four[3].x)).toBe(Math.round(four[0].x));
    // Every tile within the block, and the sidebar no wider for them.
    const edge = await page.locator('.mold-tiles').evaluate((g) => ({ right: g.getBoundingClientRect().right, scroll: g.scrollWidth - g.clientWidth }));
    expect(edge.scroll).toBe(0);
    for (const b of four) expect(b.right).toBeLessThanOrEqual(edge.right + 0.5);
    await expect(tile(page, 'tub')).toHaveAttribute('aria-disabled', 'true');
    // Firefox with no display has no WebGL, and says so in the console; the switch needs none.
    if (canDraw(page)) expect(watch.errors).toEqual([]);
  });

  test('with nothing changed there is no window: the tile pressed at once, Undo back; arrows move the focus and never switch', async ({ page }) => {
    await openEnabled(page);
    // Arrow keys along the tiles, then Enter switches, as a click does.
    await tile(page, 'one-piece').focus();
    await page.keyboard.press('ArrowRight');
    await expect(tile(page, 'clamshell')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(tile(page, 'one-piece')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(tile(page, 'clamshell')).toBeFocused();
    expect(await typeOf(page)).toBe('one-piece');
    await page.keyboard.press('Enter');
    await expect(tile(page, 'clamshell')).toHaveAttribute('aria-pressed', 'true');
    await expect(tile(page, 'one-piece')).toHaveAttribute('aria-pressed', 'false');
    await expect(dialog(page)).not.toBeVisible();
    expect(await typeOf(page)).toBe('clamshell');
    expect(await undoTitle(page)).toBe('Undo switching to Two-part cover (Ctrl+Z)');
    // The base layer takes the type's default, 0, at its default; its rows show, and the two-part block.
    await expect(row(page, 'silicone.baseLayer').locator('input.num')).toHaveValue('0');
    await expect(row(page, 'silicone.baseLayer').locator('.mark.dot')).toHaveAttribute('title', 'At its Two-part cover default, 0 mm.');
    await expect(page.getByTestId('two-part-group')).toHaveText('Two-part cover');
    // MT's review: at the type's number default the row has no auto or set tag, and its hint is the type's own.
    await expect(row(page, 'silicone.baseLayer').locator('.tag')).toHaveCount(0);
    await expect(row(page, 'silicone.baseLayer')).toHaveAttribute('title', 'Silicone over the whole base plate inside the joint. The Two-part cover leaves it out (0) by default; set a thickness to have one.');
    await expect(row(page, 'clamshell.fastener')).toBeVisible();
    // Clips' own rows only with Seam fasteners Clips.
    await expect(row(page, 'clips.clearance')).toHaveCount(0);
    await row(page, 'clamshell.fastener').getByRole('button', { name: 'Clips' }).click();
    await expect(row(page, 'clips.clearance')).toBeVisible();
    await expect(page.getByTestId('clips-group')).toHaveText('Seam clips');
    await page.getByTestId('undo').click();
    await page.getByTestId('undo').click();
    await expect(tile(page, 'one-piece')).toHaveAttribute('aria-pressed', 'true');
    expect(await hooks(page, (h) => h.params())).toEqual(defaultParams());
    expect(await page.getByTestId('redo').getAttribute('title')).toBe('Redo switching to Two-part cover (Ctrl+Shift+Z or Ctrl+Y)');
  });

  test('a changed setting opens the window, which lists it with both values: Cancel, Transfer ticked, Transfer unticked and Discard', async ({ page }) => {
    await openEnabled(page);
    await typeIn(page, 'silicone.t', '4');
    const before = await undoTitle(page);
    await tile(page, 'clamshell').click();
    const d = dialog(page);
    await expect(d).toBeVisible();
    expect(await d.evaluate((e) => (e as HTMLDialogElement).open && e.matches(':modal'))).toBe(true);
    await expect(d.locator('h2')).toHaveText('Switching to Two-part cover');
    await expect(d.locator('.lead')).toHaveText('These settings were changed by you and differ from the Two-part cover defaults. Ticked settings keep your value.');
    const t = d.locator('tr[data-param="silicone.t"]');
    await expect(d.locator('tbody tr')).toHaveCount(1);
    await expect(t).toContainText('Silicone › Silicone thickness');
    await expect(t.getByTestId('switch-yours')).toHaveText('4 mm');
    await expect(t.getByTestId('switch-default')).toHaveText('3 mm');
    await expect(t).toContainText('same default in both');
    await expect(t).toHaveAttribute('title', 'The One-piece cover default is 3 mm.');
    await expect(t.getByRole('checkbox', { name: 'Silicone thickness' })).toBeChecked();
    await expect(d.getByTestId('switch-all')).toBeChecked();
    await expect(d.getByTestId('switch-transfer')).toBeFocused();
    // A click on the backdrop does nothing.
    await page.mouse.click(5, 5);
    await expect(d).toBeVisible();

    // Cancel: no change, no step.
    await d.getByTestId('switch-cancel').click();
    await expect(d).not.toBeVisible();
    expect(await typeOf(page)).toBe('one-piece');
    expect(await undoTitle(page)).toBe(before);

    // Transfer with t ticked: the type, and t kept.
    await tile(page, 'clamshell').click();
    await d.getByTestId('switch-transfer').click();
    await expect(d).not.toBeVisible();
    expect(await hooks(page, (h) => [h.params().mold.type, h.params().silicone.t])).toEqual(['clamshell', 4]);
    await expect(row(page, 'silicone.t').locator('button.mark')).toHaveAttribute('title', 'Changed from its Two-part cover default, 3 mm. Click to reset it.');
    expect(await undoTitle(page)).toBe('Undo switching to Two-part cover (Ctrl+Z)');
    await page.getByTestId('undo').click();
    expect(await hooks(page, (h) => [h.params().mold.type, h.params().silicone.t])).toEqual(['one-piece', 4]);

    // Transfer with t unticked, by the header's box: t takes the new default.
    await tile(page, 'clamshell').click();
    await d.getByTestId('switch-all').uncheck();
    await expect(d.locator('tr[data-param="silicone.t"] input[type="checkbox"]')).not.toBeChecked();
    await d.getByTestId('switch-transfer').click();
    expect(await hooks(page, (h) => [h.params().mold.type, h.params().silicone.t])).toEqual(['clamshell', 3]);
    await page.getByTestId('undo').click();

    // Discard all changes, ticked or not.
    await tile(page, 'clamshell').click();
    await expect(d.locator('tr[data-param="silicone.t"] input[type="checkbox"]')).toBeChecked();
    await d.getByTestId('switch-discard').click();
    expect(await hooks(page, (h) => h.params())).toEqual(defaultParams('clamshell'));
    await page.getByTestId('undo').click();
    expect(await hooks(page, (h) => [h.params().mold.type, h.params().silicone.t])).toEqual(['one-piece', 4]);
  });

  test('Tab stays in the window, Ctrl+Z, Ctrl+S and Ctrl+O do nothing inside it, Esc cancels it, and focus returns to the tile', async ({ page }) => {
    await openEnabled(page);
    await typeIn(page, 'silicone.t', '4');
    await typeIn(page, 'cover.wall', '4');
    await tile(page, 'clamshell').click();
    const d = dialog(page);
    await expect(d).toBeVisible();
    const inside = (): Promise<boolean> => page.evaluate(() => document.querySelector('[data-testid="switch-dialog"]')!.contains(document.activeElement));
    for (let k = 0; k < 8; k++) {
      await page.keyboard.press('Tab');
      expect(await inside(), `Tab ${k + 1}`).toBe(true);
    }
    for (let k = 0; k < 8; k++) {
      await page.keyboard.press('Shift+Tab');
      expect(await inside(), `Shift+Tab ${k + 1}`).toBe(true);
    }
    // Each key reaches the page cancelled, so the browser's own Save page never opens; and the app does nothing.
    await page.evaluate(() => {
      (window as unknown as { seen: string[] }).seen = [];
      window.addEventListener('keydown', (e) => (window as unknown as { seen: string[] }).seen.push(`${e.key}:${e.defaultPrevented}`));
    });
    for (const key of ['Control+z', 'Control+s', 'Control+o', 'Control+y']) await page.keyboard.press(key);
    expect(await page.evaluate(() => (window as unknown as { seen: string[] }).seen.filter((s) => s !== 'Control:false'))).toEqual(['z:true', 's:true', 'o:true', 'y:true']);
    await expect(d).toBeVisible();
    expect(await hooks(page, (h) => [h.params().mold.type, h.params().silicone.t, h.params().cover.wall])).toEqual(['one-piece', 4, 4]);
    expect(await app(page, (a) => a.store.history.depth.undo)).toBe(2);
    expect(await app(page, (a) => a.store.fileNotice.value)).toBeNull();
    // Esc cancels it, and only it: nothing changed, nothing recorded, the focus back on the tile.
    await page.keyboard.press('Escape');
    await expect(d).not.toBeVisible();
    expect(await typeOf(page)).toBe('one-piece');
    expect(await app(page, (a) => a.store.history.depth.undo)).toBe(2);
    await expect(tile(page, 'clamshell')).toBeFocused();
    // After Transfer the focus is on the tile too, now pressed.
    await tile(page, 'clamshell').click();
    await d.getByTestId('switch-transfer').click();
    await expect(tile(page, 'clamshell')).toBeFocused();
    await expect(tile(page, 'clamshell')).toHaveAttribute('aria-pressed', 'true');
  });

  test('locked rows show off with their reasons, keeping your value, which comes back on switching; Reset names the type and keeps it', async ({ page }) => {
    await openEnabled(page);
    await typeIn(page, 'grid.nx', '2');
    await tile(page, 'clamshell').click();
    const d = dialog(page);
    // Columns is listed, off, with its reason, and kept by Transfer.
    const columns = d.locator('tr[data-param="grid.nx"]');
    await expect(columns.getByTestId('switch-locked')).toHaveText('This type makes one model.');
    // Its new value is the one the type holds, as the sidebar will show it, with no "same default in both".
    await expect(columns.getByTestId('switch-default')).toHaveText('1 (held by this type)');
    await expect(columns).not.toContainText('same default in both');
    await expect(columns.getByRole('checkbox')).toHaveAccessibleDescription('The One-piece cover default is 1.');
    await expect(columns.locator('input[type="checkbox"]')).toBeDisabled();
    await expect(columns.locator('input[type="checkbox"]')).toBeChecked();
    await d.getByTestId('switch-transfer').click();
    // In the sidebar, each lock: the type's value, off, the reason under the row and as its title, no mark.
    const locks: [string, string][] = [
      ['grid.nx', 'This type makes one model.'],
      ['grid.ny', 'This type makes one model.'],
      ['bolts.enabled', 'The halves print on their backs, so corner bolts would lie sideways; this type bolts the seam (Seam fasteners).'],
      ['joint.pryNotches', 'The halves slide off the base; pry at the seam\'s V pockets.'],
    ];
    for (const [path, reason] of locks) {
      const r = row(page, path);
      await expect(r, path).toHaveAttribute('data-locked', '');
      await expect(r.getByTestId('locked-reason'), path).toHaveText(reason);
      await expect(r, path).toHaveAttribute('title', reason);
      await expect(r.locator('input').first(), path).toBeDisabled();
      await expect(r.locator('.mark.dot, button.mark'), path).toHaveCount(0);
    }
    await expect(row(page, 'grid.nx').locator('input.num')).toHaveValue('1');
    await expect(row(page, 'joint.pryNotches').locator('input[type="checkbox"]')).not.toBeChecked();
    expect(await hooks(page, (h) => h.params().grid.nx)).toBe(2);

    // Reset names the type, and sets its defaults: a locked value and the type stay.
    await typeIn(page, 'silicone.t', '4');
    const resetAll = page.getByTestId('reset-all');
    await expect(resetAll).toHaveAttribute('title', 'Reset every setting to the Two-part cover defaults: 1 changed (Silicone thickness). The base face, moved openings and removed vents stay. Undo takes it back (Ctrl+Z).');
    await expect(page.locator('[data-section="silicone"]').getByTestId('section-reset')).toHaveAttribute('title', 'Reset the setting changed in Silicone to its Two-part cover default: Silicone thickness. Undo takes it back (Ctrl+Z).');
    await resetAll.click();
    expect(await hooks(page, (h) => [h.params().mold.type, h.params().silicone.t, h.params().grid.nx])).toEqual(['clamshell', 3, 2]);
    await expect(resetAll).toHaveAttribute('title', 'Every setting is at its Two-part cover default.');

    // A two-part setting, hidden in the one-piece cover, keeps its value there and comes back on switching.
    await typeIn(page, 'clamshell.ceilingDeg', '30');
    await tile(page, 'one-piece').click();
    // Columns of 2 is yours, and differs from the one-piece's 1: Transfer brings it back.
    await expect(d.locator('tbody tr')).toHaveCount(1);
    await expect(d.locator('tr[data-param="grid.nx"]').getByTestId('switch-yours')).toHaveText('2');
    await d.getByTestId('switch-transfer').click();
    await expect(row(page, 'grid.nx').locator('input.num')).toHaveValue('2');
    await expect(row(page, 'grid.nx')).not.toHaveAttribute('data-locked', '');
    await expect(row(page, 'clamshell.ceilingDeg')).toHaveCount(0);
    await tile(page, 'clamshell').click();
    await expect(d.locator('tr[data-param="clamshell.ceilingDeg"]').getByTestId('switch-yours')).toHaveText('30 deg');
    await d.getByTestId('switch-transfer').click();
    await expect(row(page, 'clamshell.ceilingDeg').locator('input.num')).toHaveValue('30');

    // Collapsed, the rail shows the type, and opens the sidebar.
    await page.locator('.collapse-tab').click();
    const rail = page.getByTestId('mold-rail');
    await expect(rail).toHaveAttribute('title', 'Mold type: Two-part cover. Click to show the settings.');
    await rail.click();
    await expect(page.locator('.sidebar')).not.toHaveClass(/collapsed/);
    await expect(rail).toHaveCount(0);
  });

  test('collapsed, the rail sits under the tab that shows the sidebar, clear of the Diagnostics card with a warning at its tallest', async ({ page, browserName }) => {
    await openApp(page);
    test.skip(!canDraw(page), 'the Diagnostics card is the 3D view\'s');
    await page.locator('[data-section="model"] input[type="file"]').setInputFiles({ name: 'cube.stl', mimeType: 'model/stl', buffer: Buffer.from(CUBE) });
    const card = page.getByTestId('diagnostics');
    await expect(card).toBeVisible();
    await page.locator('.collapse-tab').click();
    const rail = page.getByTestId('mold-rail');
    await expect(rail).toBeVisible();
    // The card where a warning puts it, the view's top right corner, as tall as it may grow.
    await card.evaluate((c) => {
      c.classList.replace('ok', 'warn');
      c.classList.remove('folded');
      (c as HTMLElement).style.height = '100vh';
    });
    const [r, tab, box] = await Promise.all([rail.boundingBox(), page.locator('.collapse-tab').boundingBox(), card.boundingBox()]);
    const apart = (a: typeof r, b: typeof r): boolean => a!.x + a!.width <= b!.x || b!.x + b!.width <= a!.x || a!.y + a!.height <= b!.y || b!.y + b!.height <= a!.y;
    expect(apart(r, box)).toBe(true);
    expect(apart(r, tab)).toBe(true);
    expect(r!.y).toBeGreaterThan(tab!.y + tab!.height);
    if (!SHOTS) return;
    mkdirSync(SHOTS_DIR, { recursive: true });
    for (const theme of ['dark', 'light']) {
      if ((await page.evaluate(() => document.documentElement.dataset.theme ?? 'dark')) !== theme) await page.getByTestId('theme').click();
      await page.screenshot({ path: join(SHOTS_DIR, `mt-rail-${browserName}-${theme}.png`) });
    }
  });

  test('a two-part project opens with its type and no window; where the type is not built yet, as the one-piece with a notice', async ({ page }) => {
    const params = defaultParams('clamshell');
    params.clamshell.ceilingDeg = 35;
    const json = projectJson(projectFile({ params, plane: DEFAULT_PLANE, pins: [], removed: [] }, 'cube.stl', { modelSha256: null, basePlane: null }));
    const moldproj = packProject(json, CUBE);
    const choose = (bytes: Uint8Array): Promise<void> => page.locator('[data-section="model"] input[type="file"]').setInputFiles({ name: 'cube.moldproj', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
    await openEnabled(page);
    await choose(moldproj);
    await expect.poll(() => app(page, (a) => a.store.pipeline.modelName)).toBe('cube.stl');
    await expect(tile(page, 'clamshell')).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog(page)).not.toBeVisible();
    expect(await hooks(page, (h) => h.params())).toEqual(params);
    await expect(row(page, 'clamshell.ceilingDeg').locator('input.num')).toHaveValue('35');
    // A reload opens as the one-piece, and the Two-part cover is not built yet there: the notice, the values kept.
    await openApp(page);
    await choose(moldproj);
    await expect.poll(() => app(page, (a) => a.store.pipeline.modelName)).toBe('cube.stl');
    await expect(tile(page, 'one-piece')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-section="model"]')).toContainText('This project is a Two-part cover, which this version does not build yet. It opened as a One-piece cover, with every other setting as saved.');
    expect(await hooks(page, (h) => [h.params().mold.type, h.params().clamshell.ceilingDeg])).toEqual(['one-piece', 35]);
  });

  test('review shots of the switch and the window, in both themes', async ({ page, browserName }) => {
    test.skip(!SHOTS, 'CFG_SHOTS=1 takes the review shots');
    mkdirSync(SHOTS_DIR, { recursive: true });
    await openEnabled(page);
    await typeIn(page, 'silicone.t', '4');
    await typeIn(page, 'grid.nx', '2');
    for (const theme of ['dark', 'light']) {
      if ((await page.evaluate(() => document.documentElement.dataset.theme ?? 'dark')) !== theme) await page.getByTestId('theme').click();
      await page.screenshot({ path: join(SHOTS_DIR, `mt-switch-${browserName}-${theme}.png`), clip: (await page.locator('.mold-type').boundingBox())! });
      await tile(page, 'clamshell').click();
      await expect(dialog(page)).toBeVisible();
      await page.screenshot({ path: join(SHOTS_DIR, `mt-window-${browserName}-${theme}.png`) });
      await dialog(page).getByTestId('switch-cancel').click();
    }
  });
});
