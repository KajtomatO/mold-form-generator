import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { expect, test, type FileChooser, type Page } from '@playwright/test';
import { MODEL_ENTRY, PROJECT_ENTRY } from '../src/app/projectArchive';
import { projectJson, type ProjectFile } from '../src/app/project';
import { exampleBytes, EXAMPLE_FILES, skipWithout } from '../test/fixtures/loadExamples';
import { declaredSize, handMade } from '../test/fixtures/projectFiles';
import { app, canDraw, dropAndWait, dropExample, hooks, idle, openApp, type PageWatch } from './appHarness';
import { NO_FIREFOX_WEBGL } from './firefox';

const FULL = process.env.CFG_FULL === '1';
const DEV_SKIP = 'the build is what the user gets, and the dev server serves the same UI code';
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const v1Fixture = readFileSync(join(import.meta.dirname, '..', 'test', 'fixtures', 'projects', 'v1-jersey-export.json'));

/** A file handed to Open's own input, as the chooser hands it over. */
async function choose(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await page.locator('[data-section="model"] input[type="file"]').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
}

/** A file dropped on the view, as one dragged from the desktop. */
async function dropFile(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await page.evaluate(({ file, data }) => {
    const content = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([content], file));
    const target = document.querySelector('[data-testid="viewport"]')!;
    for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { file: name, data: Buffer.from(bytes).toString('base64') });
}

/** Save project, by its button or by Ctrl+S, and the file the browser saved, by its name and bytes. */
async function saveProject(page: Page, by: 'button' | 'keys' = 'button'): Promise<{ name: string; bytes: Uint8Array }> {
  const download = page.waitForEvent('download', { timeout: 120_000 });
  if (by === 'button') await page.getByTestId('save-project').click();
  else await page.keyboard.press('Control+s');
  const file = await download;
  return { name: file.suggestedFilename(), bytes: new Uint8Array(await readFile(await file.path())) };
}

/** Whether the element is inside the sidebar's scrolled sections as they show now, and drawn at all. */
function inSight(page: Page, testId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`), box = document.querySelector('[data-testid="sections"]');
    if (!el || !box) return false;
    const at = el.getBoundingClientRect(), view = box.getBoundingClientRect();
    return at.height > 0 && at.top >= view.top - 1 && at.bottom <= view.bottom + 1;
  }, testId);
}

/** Everything a save and an open must keep, read off the page. */
function shown(page: Page) {
  return app(page, (a) => {
    const s = a.store, p = s.pipeline;
    return { project: p.project(), sha: p.modelSha256, model: p.modelName, hash: p.geometryHash(), depth: s.history.depth, projectName: s.projectName.value, unsaved: s.unsaved() };
  });
}

/** Opens a .moldproj and waits for its model and preview. */
async function openProject(page: Page, name: string, bytes: Uint8Array, by: 'choose' | 'drop' = 'choose'): Promise<void> {
  await (by === 'choose' ? choose : dropFile)(page, name, bytes);
  await expect.poll(() => app(page, (a, n: string) => a.store.projectName.value === n && a.store.fileBusy.value === null, name), { timeout: 60_000 }).toBe(true);
  await idle(page);
}

/**
 * The checks of a round trip: save, reload the page, and open the file again, which must give the same
 * project, edited flags and all, the same STL, and the same geometry, in a page that knows nothing of it.
 */
async function roundTrip(page: Page, model: string, stl: Uint8Array): Promise<ProjectFile> {
  const before = await shown(page);
  expect(before.unsaved).toBe(true);
  const saved = await saveProject(page);
  expect(saved.name).toBe(model.replace(/\.stl$/i, '.moldproj'));
  const inside = unzipSync(saved.bytes);
  expect(Object.keys(inside).sort()).toEqual([MODEL_ENTRY, PROJECT_ENTRY].sort());
  expect(Buffer.compare(Buffer.from(inside[MODEL_ENTRY]), Buffer.from(stl))).toBe(0);
  const json = JSON.parse(text(inside[PROJECT_ENTRY])) as ProjectFile;
  expect(json).toMatchObject({ schemaVersion: 6, model, modelSha256: sha(stl), ...before.project });
  expect(json.basePlane).not.toBeNull();
  const after = await shown(page);
  expect(after.sha).toBe(sha(stl));
  expect(after.unsaved).toBe(false);
  await expect(page.getByTestId('file-notice')).toHaveText(`Saved ${saved.name}.`);

  // A fresh page: nothing was unsaved, so leaving asks nothing (a dialog would fail the test), and then
  // the project alone brings everything back, with the history empty.
  await page.reload();
  await page.waitForFunction(() => '__pipeline' in window && '__app' in window);
  expect(await app(page, (a) => a.store.pipeline.modelName)).toBeNull();
  await openProject(page, saved.name, saved.bytes);
  const back = await shown(page);
  expect(back.project).toEqual(before.project);
  expect(back.model).toBe(model);
  expect(back.sha).toBe(sha(stl));
  expect(back.hash).toEqual(before.hash);
  expect(back.depth).toEqual({ undo: 0, redo: 0 });
  expect(back.unsaved).toBe(false);
  await expect(page.getByTestId('project-name')).toHaveText(saved.name);
  await expect(page.getByTestId('file-name')).toContainText(`${model}, `);
  await expect(page.getByTestId('file-notice')).toHaveCount(0);
  await expect(page.getByTestId('project-changed')).toHaveCount(0);
  expect(await hooks(page, (h) => h.diagnostics().filter((d) => d.code.startsWith('plane-')))).toEqual([]);
  return json;
}

test.describe('project files on index.html', () => {
  let watch: PageWatch;
  let dialogs: string[];
  test.beforeEach(async ({ page }, info) => {
    test.skip(info.project.name === 'dev', DEV_SKIP);
    dialogs = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    watch = await openApp(page);
  });
  test.afterEach(({}, info) => {
    if (info.status === 'skipped') return;
    expect(dialogs).toEqual([]);
    expect(watch.errors).toEqual([]);
    expect(watch.foreign).toEqual([]);
  });

  test('@smoke Save project and Open: jersey with an edited pocket, a pin and a removed vent comes back whole, by the button and by a drop, and undo after the load keeps the edited flag', async ({ page }) => {
    skipWithout(test, 'barrel');
    test.setTimeout(240_000);
    // Playwright intercepts file choosers only while a listener asks for them, and switches that on beside
    // the next action rather than before it. With the listener added just before Ctrl+O, as M9 had it, the
    // chooser was lost about once in 50 presses in Chromium, after the app's handler had clicked the input
    // with user activation: 10 of 546 on a bare page, and this test once in the M10 --full run and once in
    // 25 repeats. Added 200 ms or more before the press, 0 of 870 were lost. So it listens from the start.
    const choosers: FileChooser[] = [];
    page.on('filechooser', (chooser) => choosers.push(chooser));
    await expect(page.getByTestId('save-project')).toBeDisabled();
    await expect(page.getByTestId('open-file').first()).toHaveText('Open STL or project…');
    await dropAndWait(page, EXAMPLE_FILES.jersey);
    await expect(page.getByTestId('save-project')).toBeEnabled();
    expect((await shown(page)).unsaved).toBe(false);
    await app(page, (a) => {
      const s = a.store, openings = s.pipeline.placement!.value.placement.openings;
      const pour = openings.find((o) => o.kind === 'pour')!, vent = openings.find((o) => o.kind === 'vent')!;
      s.setParam('silicone.t', 3.5);
      s.setParam('base.pocketDepth', 0.4);
      s.moveOpening(pour.id, pour.x + Math.sign(pour.x - vent.x || 1), pour.y);
      s.removeVent(vent.id);
    });
    await idle(page);
    const before = await shown(page);
    expect(before.project.pins).toHaveLength(1);
    expect(before.project.removed).toHaveLength(1);
    await roundTrip(page, EXAMPLE_FILES.jersey, exampleBytes('jersey'));

    // The pocket's edited flag: a double-click resets it to follow the layer, and undo brings the edit back.
    // Meanwhile the opened project's name says it has changed.
    const pocket = page.locator('[data-param="base.pocketDepth"]');
    await expect(pocket.locator('.tag')).toHaveText('set');
    await pocket.locator('label').dblclick();
    await expect(pocket.locator('.tag')).toHaveText('auto');
    expect(await hooks(page, (h) => h.params().base.pocketDepth)).toBeNull();
    expect((await shown(page)).unsaved).toBe(true);
    await expect(page.getByTestId('project-changed')).toHaveText('(changed)');
    await page.getByTestId('undo').click();
    await expect(pocket.locator('.tag')).toHaveText('set');
    await expect(page.getByTestId('project-changed')).toHaveCount(0);
    expect(await hooks(page, (h) => h.params().base.pocketDepth)).toBe(0.4);
    await idle(page);
    expect((await shown(page)).hash).toEqual(before.hash);

    // Ctrl+S saves the project, not the page; the line it leaves says so once the project changes.
    const again = await saveProject(page, 'keys');
    expect(again.name).toBe('jersey-barrier.moldproj');
    const notice = page.getByTestId('file-notice');
    await expect(notice).toHaveText('Saved jersey-barrier.moldproj.');

    // Leaving asks first only with work since the last save or load: the page's own beforeunload handler.
    const leaving = (): Promise<boolean> => page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(await leaving()).toBe(false);
    await app(page, (a) => a.store.setParam('cover.wall', 4));
    expect(await leaving()).toBe(true);
    await expect(notice).toHaveText('Changed since you saved jersey-barrier.moldproj.');
    await page.getByTestId('undo').click();
    expect(await leaving()).toBe(false);
    await expect(notice).toHaveText('Saved jersey-barrier.moldproj.');

    // Ctrl+O opens the app's own chooser, and only it.
    expect(choosers).toHaveLength(0);
    await page.keyboard.press('Control+o');
    await expect.poll(() => choosers.length, { timeout: 10_000 }).toBe(1);
    expect(choosers[0].isMultiple()).toBe(false);

    // The whole view is the drop target for a project too: the same project, as a new load.
    await dropAndWait(page, EXAMPLE_FILES.barrel);
    await openProject(page, again.name, again.bytes, 'drop');
    const dropped = await shown(page);
    expect(dropped.project).toEqual(before.project);
    expect(dropped.hash).toEqual(before.hash);

    // The browser's own prompt on a real close, with a change no file holds; dismissed, the page stays.
    // A press first (a double-click resetting a control already at its default), as browsers ask only on
    // a page the user has acted on.
    await page.locator('[data-param="cover.wall"] label').dblclick();
    await app(page, (a) => a.store.setParam('cover.wall', 4.5));
    expect((await shown(page)).unsaved).toBe(true);
    const asked = page.waitForEvent('dialog');
    await page.close({ runBeforeUnload: true });
    expect((await asked).type()).toBe('beforeunload');
    expect(dialogs).toHaveLength(1);
    dialogs.length = 0;
    expect(page.isClosed()).toBe(false);
  });

  test('@smoke a corrupt or foreign project file says why under the file row, in sight, and leaves the model as it was; an export ZIP and a version 1 project.json bring their settings back', async ({ page }) => {
    skipWithout(test, 'barrel');
    test.setTimeout(240_000);
    const jersey = exampleBytes('jersey');
    await dropAndWait(page, EXAMPLE_FILES.jersey);
    // Through the store, so the change is a step of the history, which a failed open must keep.
    await app(page, (a) => a.store.setParam('silicone.t', 4));
    await idle(page);
    const before = await shown(page);
    expect(before.depth).toEqual({ undo: 1, redo: 0 });
    const good = JSON.parse(projectJson({ schemaVersion: 3, appVersion: '0.3.0', model: EXAMPLE_FILES.jersey, modelSha256: sha(jersey), basePlane: null, ...before.project })) as Record<string, unknown> & { params: { silicone: Record<string, unknown> } };
    const typed = structuredClone(good);
    typed.params.silicone.t = 'thick';
    const moldproj = handMade(JSON.stringify(good), jersey);
    const again = 'Open an earlier copy, or open the STL and set it up again.';
    const instead = 'Open a .moldproj that Save project made, the ZIP that Export ZIP made, or an STL.';
    const cases: [string, Uint8Array, string][] = [
      ['notes.moldproj', strToU8('hello'), `notes.moldproj is not a project saved by this app, as it is no ZIP archive. ${instead}`],
      ['photos.zip', zipSync({ 'a.jpg': new Uint8Array(10) }), `photos.zip is not a project saved by this app, as it holds no project.json. ${instead}`],
      ['models.zip', zipSync({ 'left.stl': new Uint8Array(84) }), 'models.zip holds STL files, not a project of this app. Unzip it, then open the STL you want.'],
      ['bare.moldproj', handMade(JSON.stringify(good), null), `bare.moldproj is damaged: the model saved inside it is missing. ${again}`],
      ['unreadable.moldproj', handMade(JSON.stringify({ ...good, modelSha256: sha(strToU8('solid')) }), strToU8('solid')), `unreadable.moldproj is damaged: the model inside it cannot be read. ${again}`],
      ['swapped.moldproj', handMade(JSON.stringify(good), exampleBytes('barrel')), `swapped.moldproj is damaged or was changed: the model inside it is not the one its settings were saved for. ${again}`],
      ['cut.moldproj', moldproj.subarray(0, moldproj.length - 40), `cut.moldproj is damaged and cannot be unpacked. ${again}`],
      ['broken.json', strToU8('{"schemaVersion": 2, "params": {'), `broken.json is damaged: its settings cannot be read. ${again}`],
      ['typed.json', strToU8(JSON.stringify(typed)), `typed.json cannot be used: its Silicone thickness must be a number, not "thick". ${again}`],
      ['bomb.moldproj', declaredSize(moldproj, MODEL_ENTRY, 0xf0000000), 'bomb.moldproj is damaged or too large: the model inside it says it unpacks to 3840 MB, past the 1024 MB this app takes.'],
      ['newer.json', strToU8(JSON.stringify({ ...good, schemaVersion: 7 })), 'newer.json was saved by a newer version of the app (app version 0.3.0), in project format 7; this one reads formats up to 6.'],
      ['photo.png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, ...new Uint8Array(100)]), `photo.png is not an STL or a project file, so it was not opened. ${instead}`],
    ];
    let by: 'choose' | 'drop' = 'choose';
    for (const [name, bytes, why] of cases) {
      await (by === 'choose' ? choose : dropFile)(page, name, bytes);
      by = by === 'choose' ? 'drop' : 'choose';
      const notice = page.getByTestId('file-notice');
      await expect(notice).toContainText(why);
      await expect(notice).toHaveAttribute('data-severity', 'error');
      await expect(page.getByTestId('file-busy')).toHaveCount(0);
      const now = await shown(page);
      expect(now.model, name).toBe(EXAMPLE_FILES.jersey);
      expect(now.project, name).toEqual(before.project);
      expect(now.depth, name).toEqual(before.depth);
    }
    // Dropped on the view with the sidebar scrolled to its foot, or folded away, the answer still shows.
    // The last case's notice brings the Model section into sight two frames after it shows (Preact runs the
    // effect after the next paint, and the effect scrolls in a frame of its own), so a scroll made before that
    // can be undone by it: in Firefox under the full suite it was, once. Scroll again until the foot holds. A
    // reveal that kept pulling the list back would never let it hold, and the poll would fail.
    await expect
      .poll(async () => {
        await page.getByTestId('sections').evaluate((el) => (el.scrollTop = el.scrollHeight));
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 0)))));
        return inSight(page, 'file-name');
      })
      .toBe(false);
    await dropFile(page, 'notes.moldproj', strToU8('hello again'));
    await expect.poll(() => inSight(page, 'file-notice')).toBe(true);
    await page.getByRole('button', { name: 'Hide settings' }).click();
    await expect(page.getByTestId('sections')).toBeHidden();
    await dropFile(page, 'cut.moldproj', moldproj.subarray(0, moldproj.length - 40));
    await expect(page.getByRole('button', { name: 'Hide settings' })).toBeVisible();
    await expect.poll(() => inSight(page, 'file-notice')).toBe(true);
    await expect(page.getByTestId('file-notice')).toContainText('cut.moldproj is damaged');
    // The reader's own words are there, folded away.
    await expect(page.getByTestId('file-notice-details')).toBeHidden();
    await page.getByTestId('file-notice').getByText('Details').click({ timeout: 10_000 });
    await expect(page.getByTestId('file-notice-details')).toHaveText(/^The ZIP reader says: /);
    // Dismissed, it goes; and the model is as it was, and still answers a change.
    await page.getByTestId('file-notice').getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByTestId('file-notice')).toHaveCount(0);
    await idle(page);
    expect((await shown(page)).hash).toEqual(before.hash);
    await hooks(page, (h) => h.setParam('silicone.t', 3.5));
    await idle(page);
    expect((await shown(page)).hash.all).not.toBe(before.hash.all);
    expect(await hooks(page, (h) => h.status())).toMatchObject({ stale: false, busy: false, error: null });

    // README.txt's promise: the export ZIP's project.json makes the same mold again on the same STL. What
    // the ZIP holds counts as saved, so leaving the page then asks nothing.
    expect((await shown(page)).unsaved).toBe(true);
    const download = page.waitForEvent('download', { timeout: 120_000 });
    await page.getByTestId('export-zip').click();
    const zip = new Uint8Array(await readFile(await (await download).path()));
    await expect(page.getByTestId('export-outcome')).toBeVisible();
    const atExport = await shown(page);
    expect(atExport.unsaved).toBe(false);
    expect(JSON.parse(text(unzipSync(zip)[PROJECT_ENTRY]))).toMatchObject({ modelSha256: sha(jersey), ...atExport.project });
    await hooks(page, (h) => h.setParam('silicone.t', 5));
    await choose(page, 'jersey-barrier-mold.zip', zip);
    await expect(page.getByTestId('file-notice')).toHaveText('Applied the settings of jersey-barrier-mold.zip to jersey-barrier.stl.');
    await idle(page);
    const restored = await shown(page);
    expect(restored.project).toEqual(atExport.project);
    expect(restored.hash).toEqual(atExport.hash);
    expect(await app(page, (a) => a.store.history.undoLabel)).toBe('opening the settings of jersey-barrier-mold.zip');

    // M8's version 1 project.json, from a real export ZIP: migrated, and matched to jersey by name.
    await choose(page, 'project.json', v1Fixture);
    const notice = page.getByTestId('file-notice');
    await expect(notice).toContainText('Applied the settings of project.json to jersey-barrier.stl.');
    await expect(notice).toContainText('Saved in project format 1 by an earlier version of the app, and brought up to format 6.');
    // FL: its funnel had no flange, and the notice says how to give it one.
    await expect(notice).toContainText('This mold was made before the funnel had a flange, so it opens with Flange width 0');
    await expect(notice).toContainText('matched to jersey-barrier.stl by the file name alone');
    const v1 = JSON.parse(v1Fixture.toString('utf8')) as ProjectFile;
    // Migrated to the current format, so with the bolts off, as every version 1 mold was taped, and no base layer.
    expect((await shown(page)).project).toEqual({ params: { ...v1.params, bolts: { enabled: false, size: 'M3', length: null, holeClearance: 0.2, nutClearance: 0.15, minWall: 1.2 }, silicone: { ...v1.params.silicone, baseLayer: 0, baseLayerSlopeDeg: 2 }, funnel: { ...v1.params.funnel, flangeWidth: 0, flangeThickness: 1.2 } }, plane: v1.plane, pins: v1.pins, removed: v1.removed });
    await idle(page);
    expect(await hooks(page, (h) => h.openings().find((o) => o.pinned))).toMatchObject({ id: v1.pins[0].id, x: v1.pins[0].x, y: v1.pins[0].y });
    // Settings applied in full open again to just this, so nothing is unsaved.
    expect((await shown(page)).unsaved).toBe(false);

    // A model with changes not saved asks before another file replaces it, in sight and in the sidebar.
    await app(page, (a) => a.store.setParam('silicone.t', 4.5));
    await page.getByTestId('sections').evaluate((el) => (el.scrollTop = el.scrollHeight));
    await dropExample(page, EXAMPLE_FILES.barrel);
    const prompt = page.getByTestId('replace-prompt');
    await expect(prompt).toContainText(`${EXAMPLE_FILES.jersey} has changes that are not saved. Opening ${EXAMPLE_FILES.barrel} replaces it`);
    await expect.poll(() => inSight(page, 'replace-prompt')).toBe(true);
    await prompt.getByRole('button', { name: 'Cancel' }).click();
    await expect(prompt).toHaveCount(0);
    expect((await shown(page)).model).toBe(EXAMPLE_FILES.jersey);
    expect(await hooks(page, (h) => h.params().silicone.t)).toBe(4.5);
    await dropExample(page, EXAMPLE_FILES.barrel);
    await prompt.getByRole('button', { name: 'Open without saving' }).click();
    await expect.poll(() => app(page, (a) => a.store.pipeline.modelName)).toBe(EXAMPLE_FILES.barrel);
    await expect(prompt).toHaveCount(0);
  });
});

test.describe('project files on the heavier examples', () => {
  test.skip(!FULL, 'runs with CFG_FULL=1');
  let watch: PageWatch;
  test.beforeEach(async ({ page }, info) => {
    test.skip(info.project.name === 'dev', DEV_SKIP);
    test.skip(!canDraw(page), NO_FIREFOX_WEBGL);
    watch = await openApp(page);
  });
  test.afterEach(({}, info) => {
    if (info.status === 'skipped') return;
    expect(watch.errors).toEqual([]);
    expect(watch.foreign).toEqual([]);
  });

  test('x8: an opening dragged in the view and pinned, and a vent removed, come back from the project', async ({ page }) => {
    test.setTimeout(300_000);
    await dropAndWait(page, EXAMPLE_FILES.x8);
    await page.getByTestId('top-view').click();
    const openings = await hooks(page, (h) => h.openings());
    const pour = openings.find((o) => o.kind === 'pour')!;
    const vent = openings.find((o) => o.kind === 'vent' && Math.hypot(o.x - pour.x, o.y - pour.y) > 5)!;
    const at = (x: number, y: number): Promise<{ x: number; y: number }> =>
      app(page, (a, p: number[]) => (window as unknown as { __pipeline: { worldToScreen: (q: number[]) => { x: number; y: number } } }).__pipeline.worldToScreen([p[0], p[1], a.store.pipeline.field!.value.rim.Zt]), [x, y]);
    const from = await at(pour.x, pour.y), to = await at(pour.x + 1.5, pour.y);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await expect.poll(() => app(page, (a) => a.store.drag.value !== null)).toBe(true);
    await page.mouse.up();
    await idle(page);
    expect(await hooks(page, (h, id: string) => h.openings().find((o) => o.id === id)!.pinned, pour.id)).toBe(true);
    await page.locator(`[data-opening="${vent.id}"]`).getByRole('button', { name: /^Remove / }).click();
    await idle(page);
    const project = await hooks(page, (h) => h.project());
    expect(project.pins.map((p) => p.id)).toEqual([pour.id]);
    expect(project.removed).toEqual([vent.id]);
    await roundTrip(page, EXAMPLE_FILES.x8, exampleBytes('x8'));
  });

  test('VIS-35 on its upper level comes back on it from the project', async ({ page }) => {
    skipWithout(test, 'vis35');
    test.setTimeout(300_000);
    await dropAndWait(page, EXAMPLE_FILES.vis35);
    await page.getByTestId('upper-level').getByRole('button', { name: 'Use upper level' }).click();
    await idle(page);
    const plane = await hooks(page, (h) => h.project().plane);
    expect(plane).toMatchObject({ rank: 0 });
    expect(plane.upper).toBeCloseTo(0.41, 2);
    const json = await roundTrip(page, EXAMPLE_FILES.vis35, exampleBytes('vis35'));
    await expect(page.getByTestId('on-upper-level')).toContainText('the level 0.41 mm up');
    // The plane saved is the level's, in the STL's coordinates: 0.41 mm above its lowest point, read from its bytes.
    const bytes = exampleBytes('vis35');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let minZ = Infinity;
    for (let at = 84; at < bytes.length; at += 50) for (let k = 0; k < 3; k++) minZ = Math.min(minZ, view.getFloat32(at + 20 + 12 * k, true));
    expect(json.basePlane!.normal).toEqual([0, 0, -1]);
    expect(json.basePlane!.upper).toBe(plane.upper);
    expect(json.basePlane!.offset).toBeCloseTo(-(minZ + 0.41), 1);
    expect(json.basePlane!.offset).toBeLessThan(-(minZ + 0.3));
  });
});

/**
 * How long Save holds the main thread, read as the longest gap between 4 ms timer ticks while it runs:
 * Benchy through the real button, and a synthetic STL of 3 million triangles (150 MB) through the same
 * project worker and the same Blob download, since loading that one would preview it too.
 */
test.describe('saving a large project', () => {
  test.skip(!FULL, 'runs with CFG_FULL=1');
  test.beforeEach(({}, info) => {
    test.skip(info.project.name === 'dev', DEV_SKIP);
  });

  test('Save project holds main for under 200 ms on Benchy and on a 150 MB STL', async ({ page }, info) => {
    test.setTimeout(300_000);
    const watch = await openApp(page);
    await dropAndWait(page, EXAMPLE_FILES.benchy);
    const monitor = (): Promise<void> => page.evaluate(() => {
      const w = window as unknown as { __gap: { worst: number; last: number; id: number } };
      w.__gap = { worst: 0, last: performance.now(), id: 0 };
      w.__gap.id = window.setInterval(() => {
        const now = performance.now();
        w.__gap.worst = Math.max(w.__gap.worst, now - w.__gap.last);
        w.__gap.last = now;
      }, 4);
    });
    const worst = (): Promise<number> => page.evaluate(() => {
      const w = window as unknown as { __gap: { worst: number; id: number } };
      clearInterval(w.__gap.id);
      return w.__gap.worst;
    });
    await monitor();
    const t0 = Date.now();
    const benchy = await saveProject(page);
    const benchyMs = Date.now() - t0;
    const benchyGap = await worst();
    expect(benchy.name).toBe('3dbenchy.moldproj');
    expect(Buffer.compare(Buffer.from(unzipSync(benchy.bytes)[MODEL_ENTRY]), Buffer.from(exampleBytes('benchy')))).toBe(0);

    const large = await page.evaluate(async () => {
      // A wavy sheet of 3 million triangles, normals and all, which deflates about as a scanned model does.
      const side = 1225, triangles = 2 * side * side;
      const stl = new Uint8Array(84 + 50 * triangles);
      const view = new DataView(stl.buffer);
      view.setUint32(80, triangles, true);
      const z = (i: number, j: number): number => 3 * Math.sin(i * 0.037) * Math.cos(j * 0.029) + 0.5 * Math.sin(i * j * 0.0001);
      let at = 84;
      const put = (x: number, y: number): void => {
        view.setFloat32(at, x * 0.1, true);
        view.setFloat32(at + 4, y * 0.1, true);
        view.setFloat32(at + 8, z(x, y), true);
        at += 12;
      };
      for (let i = 0; i < side; i++) {
        for (let j = 0; j < side; j++) {
          for (const tri of [[[i, j], [i + 1, j], [i + 1, j + 1]], [[i, j], [i + 1, j + 1], [i, j + 1]]]) {
            view.setFloat32(at + 8, 1, true);
            at += 12;
            for (const [x, y] of tri) put(x, y);
            at += 2;
          }
        }
      }
      const w = window as unknown as {
        __gap: { worst: number; last: number; id: number };
        __app: { store: { files: { pack(f: unknown, b: Uint8Array): Promise<{ zip: Uint8Array; sha256: string }> } }; saveBytes(name: string, bytes: Uint8Array, mime: string): void };
      };
      const file = { schemaVersion: 3, appVersion: '0.3.0', model: 'sheet.stl', modelSha256: null, basePlane: null, ...(window as unknown as { __pipeline: { project(): object } }).__pipeline.project() };
      w.__gap = { worst: 0, last: performance.now(), id: 0 };
      w.__gap.id = window.setInterval(() => {
        const now = performance.now();
        w.__gap.worst = Math.max(w.__gap.worst, now - w.__gap.last);
        w.__gap.last = now;
      }, 4);
      const t0 = performance.now();
      const { zip } = await w.__app.store.files.pack(file, stl);
      // The very download Save project makes, so a copy it went back to taking would show here.
      w.__app.saveBytes('sheet.moldproj', zip, 'application/octet-stream');
      const ms = performance.now() - t0;
      await new Promise((resolve) => setTimeout(resolve, 50));
      clearInterval(w.__gap.id);
      return { ms, gap: w.__gap.worst, stl: stl.length, zip: zip.length };
    });
    console.log(`${info.project.name}: Benchy save ${benchyMs} ms, main held at most ${benchyGap.toFixed(0)} ms, ${benchy.bytes.length} bytes; 150 MB save ${large.ms.toFixed(0)} ms, main held at most ${large.gap.toFixed(0)} ms, ${large.stl} to ${large.zip} bytes`);
    // 2 x 1225^2 triangles, just over the 3 million of the plan's heavy input.
    expect(large.stl).toBe(84 + 50 * 2 * 1225 ** 2);
    expect(benchyGap).toBeLessThan(200);
    expect(large.gap).toBeLessThan(200);
    expect(watch.errors).toEqual([]);
  });
});
