import { expect, test, type Locator, type Page } from '@playwright/test';
import { previewSilicone } from '../src/app/derived';
import type { OpeningPin } from '../src/core/analysis/placement';
import { exportPlan, fieldSettings } from '../src/core/field/grid';
import { weld } from '../src/core/mesh/weld';
import { defaultParams } from '../src/core/params/defaults';
import { PARAM_SCHEMA, type ParamDef } from '../src/core/params/schema';
import { deriveRim, moldBounds, type Rim } from '../src/core/parts/rim';
import { parseStl } from '../src/core/stl/parse';
import { formatCount, formatNumber, formatSize } from '../src/ui/format';
import { coplanarTriangles } from '../src/view/picking';
import { orientedExample } from '../test/fixtures/fieldRuns';
import { exampleBytes, EXAMPLE_FILES, type ExampleId } from '../test/fixtures/loadExamples';
import { SOLID_GOLDEN } from '../test/regression/golden';
import { app, canDraw, canvasColour, canvasPixels, dropAndWait, dropExample, hooks, idle, openApp, tealPixels, type PageWatch } from './appHarness';
import { NO_FIREFOX_WEBGL } from './firefox';
import { inNode, nodeHash } from './nodeRuns';

const FULL = process.env.CFG_FULL === '1';
const PATHS = Object.entries(PARAM_SCHEMA).flatMap(([group, defs]) => Object.keys(defs as Record<string, ParamDef>).map((key) => `${group}.${key}`));

const row = (page: Page, path: string): Locator => page.locator(`[data-param="${path}"]`);
const numberBox = (page: Page, path: string): Locator => row(page, path).locator('input.num');

/** A slider set as a drag would leave it, with the input event the app listens to. */
async function setRange(slider: Locator, value: number): Promise<void> {
  await slider.evaluate((el, v) => {
    (el as HTMLInputElement).value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function typeValue(box: Locator, value: string): Promise<void> {
  await box.click();
  await box.fill(value);
  await box.press('Enter');
}

/** The plan's box, from the rim's own fields: the cover's outer box O, by Zt + Tb from the base's underside. */
const boxOf = (rim: Rim): [number, number, number] => [rim.O.x1 - rim.O.x0, rim.O.y1 - rim.O.y0, rim.Zt + rim.Tb];

/**
 * What the status strip must say for an example at defaults, from core in Node: parse, orient,
 * moldBounds and deriveRim, and the box as M3's solids measured it.
 */
function expectedStatus(id: ExampleId): { file: string; triangles: string; size: string; box: string; golden: string } {
  const params = defaultParams();
  const { mesh, bounds } = orientedExample(id);
  const rim = deriveRim(moldBounds(mesh, bounds, fieldSettings(params, bounds)), params);
  const size = [0, 1, 2].map((k) => bounds.max[k] - bounds.min[k]);
  const golden = SOLID_GOLDEN[id];
  return {
    file: EXAMPLE_FILES[id],
    triangles: `${formatCount(parseStl(exampleBytes(id)).triangleCount)} triangles`,
    size: formatSize(size),
    box: `box ${formatSize(boxOf(rim))}`,
    golden: `box ${formatSize([golden.boxX, golden.boxY, golden.Zt + params.base.thickness])}`,
  };
}

/** The silicone the preview gives in Node, which test/unit/derived.test.ts pins to the M6 figures. */
const nodeSilicone = (id: ExampleId): Promise<number> => inNode(id, () => {}, (p) => previewSilicone(p)!.ml);

async function checkStatus(page: Page, id: ExampleId, ml: number): Promise<void> {
  const want = expectedStatus(id);
  await expect(page.getByTestId('status-file')).toHaveText(want.file);
  await expect(page.getByTestId('status-triangles')).toHaveText(want.triangles);
  await expect(page.getByTestId('status-size')).toHaveText(want.size);
  expect(want.box).toBe(want.golden);
  await expect(page.getByTestId('status-box')).toHaveText(want.box);
  await expect(page.getByTestId('status-silicone')).toHaveText(`${ml.toFixed(1)} ml silicone`);
  await expect(page.getByTestId('silicone-figure')).toContainText(`About ${ml.toFixed(1)} ml, ${(ml * 1.1).toFixed(0)} g`);
  await expect(page.getByTestId('status-clearance')).toHaveText('clearance ≥ 3.00 mm, planned');
  // A load ends on its first full build of the solids, which is the rebuild the strip shows.
  const rebuild = (await app(page, (a) => a.store.pipeline.lastRebuild))!;
  expect(rebuild.kind).toBe('t2');
  await expect(page.getByTestId('status-rebuild')).toHaveText(`rebuild ${Math.round(rebuild.ms)} ms`);
}

/** The layout rules of the plan's GUI section, measured on the page as it stands. */
async function checkLayout(page: Page, watch: PageWatch): Promise<void> {
  const m = await page.evaluate(() => {
    const box = (selector: string): DOMRect => document.querySelector(selector)!.getBoundingClientRect();
    const sections = document.querySelector('[data-testid="sections"]')!;
    // Opening Advanced scrolled the sidebar to it. The rule is that Export shows without any scrolling.
    sections.scrollTop = 0;
    // html and body clip what overflows them, so the page itself never scrolls whatever is too tall:
    // what must hold is that nothing is too tall or too wide for them in the first place.
    const clipped = ['html', 'body', '#app', '.shell'].map((selector) => {
      const el = document.querySelector(selector)!;
      return [selector, el.scrollWidth - el.clientWidth, el.scrollHeight - el.clientHeight, el.scrollTop, el.scrollLeft];
    });
    const exportBox = box('[data-testid="export"]');
    // clientWidth is 0 for an inline box by the CSSOM spec, and Firefox still gives such a span a
    // scrollWidth, so only boxes that have a client width of their own are measured.
    const overflowing = [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((el) => el.offsetParent !== null || el.tagName === 'CANVAS')
      .filter((el) => getComputedStyle(el).display !== 'inline')
      .filter((el) => el.scrollWidth > el.clientWidth)
      .map((el) => `${el.tagName.toLowerCase()}.${el.className} (${el.scrollWidth} > ${el.clientWidth}): ${el.textContent?.slice(0, 40)}`);
    const status = box('[data-testid="status"]');
    return {
      header: box('.header').height,
      sidebar: box('.sidebar').width,
      status: status.height,
      overflowing,
      clipped,
      scroll: [window.scrollX, window.scrollY],
      // The shell fills the window exactly, and the status strip, its lowest part, ends inside it.
      shell: [box('.shell').width - window.innerWidth, box('.shell').height - window.innerHeight],
      // Firefox lays out in 1/60 px, and its rects carry a float residue under that, such as 2^-16 px.
      statusInView: status.bottom <= window.innerHeight + 1 / 60 && status.right <= window.innerWidth + 1 / 60,
      exportInView: exportBox.top >= 0 && exportBox.bottom <= window.innerHeight && exportBox.height > 0,
    };
  });
  expect(m.header).toBe(48);
  expect(m.sidebar).toBe(380);
  expect(m.status).toBeGreaterThanOrEqual(28);
  expect(m.overflowing).toEqual([]);
  expect(m.clipped).toEqual([['html', 0, 0, 0, 0], ['body', 0, 0, 0, 0], ['#app', 0, 0, 0, 0], ['.shell', 0, 0, 0, 0]]);
  expect(m.scroll).toEqual([0, 0]);
  expect(m.shell).toEqual([0, 0]);
  expect(m.statusInView).toBe(true);
  expect(m.exportInView).toBe(true);
  expect(watch.errors).toEqual([]);
  expect(watch.foreign).toEqual([]);
}

test.describe('the app on index.html', () => {
  let watch: PageWatch;
  test.beforeEach(async ({ page }) => {
    test.skip(!canDraw(page), NO_FIREFOX_WEBGL);
    watch = await openApp(page);
  });
  test.afterEach(() => {
    expect(watch.errors).toEqual([]);
    expect(watch.foreign).toEqual([]);
  });

  test('@smoke layout at 1366 x 768 and 1920 x 1080, empty and loaded, with nothing fetched past the LAN host', async ({ page }) => {
    for (const size of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
      await page.setViewportSize(size);
      await checkLayout(page, watch);
    }
    await dropAndWait(page, EXAMPLE_FILES.jersey);
    for (const size of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
      await page.setViewportSize(size);
      await checkLayout(page, watch);
      // Advanced open, where the longest labels are.
      await page.locator('.advanced > summary').click();
      await checkLayout(page, watch);
      await page.locator('.advanced > summary').click();
    }
    // The sidebar folds away and comes back, and the view takes its room.
    const before = (await page.getByTestId('viewport').boundingBox())!.width;
    await page.locator('.collapse-tab').click();
    await expect.poll(async () => (await page.getByTestId('viewport').boundingBox())!.width).toBe(before + 380);
    await page.locator('.collapse-tab').click();
    await expect.poll(async () => (await page.getByTestId('viewport').boundingBox())!.width).toBe(before);
    // The developer pages sit at the foot of Advanced, each opening in a tab of its own, so the model stays.
    await expect(page.locator('.advanced .links')).toContainText('Developer pages');
    await expect(page.locator('.advanced a')).toHaveText(['Browser check', 'Benchmark', 'Pipeline test page']);
    for (const link of await page.locator('.advanced a').all()) await expect(link).toHaveAttribute('target', '_blank');
  });

  test('@smoke a dropped STL loads, its base is confirmed on the top candidate, and the status strip is what core gives in Node', async ({ page }) => {
    await dropAndWait(page, EXAMPLE_FILES.jersey);
    await checkStatus(page, 'jersey', await nodeSilicone('jersey'));
    const candidates = page.locator('.candidate');
    const oriented = await app(page, (a) => ({ count: a.store.pipeline.oriented!.value.candidates.length, normal: a.store.pipeline.oriented!.value.chosen.normal }));
    await expect(candidates).toHaveCount(oriented.count);
    await expect(candidates.first()).toHaveAttribute('aria-selected', 'true');
    expect(oriented.normal).toEqual([0, 0, -1]);
    expect(await hooks(page, (h) => h.geometryHash())).toEqual(await nodeHash('jersey'));
    await expect(page.getByTestId('stale')).toBeHidden();
    // A light theme is set before the first paint on the next visit, from storage.
    await page.getByTestId('theme').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    // The next visit is light before any of the app's scripts run: with them all stubbed out, only the
    // inline head script and style are left to do it.
    const bare = await page.context().newPage();
    await bare.route(/\.(js|ts|tsx)(\?.*)?$|\/@vite\//, (route) => route.fulfill({ body: '', contentType: 'text/javascript' }));
    await bare.goto('/');
    expect(await bare.evaluate(() => [document.documentElement.dataset.theme, getComputedStyle(document.documentElement).backgroundColor])).toEqual(['light', 'rgb(242, 244, 247)']);
    await bare.close();
    await page.getByTestId('theme').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('@smoke every parameter has exactly one control, double-click resets it, and the wheel steps it', async ({ page }) => {
    await dropAndWait(page, EXAMPLE_FILES.jersey);
    await page.locator('.advanced > summary').click();
    const counts = await page.evaluate((paths) => paths.map((path) => document.querySelectorAll(`[data-param="${path}"]`).length), PATHS);
    expect(Object.fromEntries(PATHS.map((path, k) => [path, counts[k]])).valueOf()).toEqual(Object.fromEntries(PATHS.map((path) => [path, 1])));
    expect(await page.locator('[data-param]').count()).toBe(PATHS.length);

    const t = numberBox(page, 'silicone.t');
    const value = (): Promise<number> => hooks(page, (h) => h.params().silicone.t);
    const zoom = (): Promise<number[]> => page.evaluate(() => [window.devicePixelRatio, window.innerWidth, window.visualViewport?.scale ?? 1]);
    const zoomBefore = await zoom();
    // A box the pointer only passes over leaves the wheel to the sidebar, which scrolls: the lower sections are reached that way.
    const sections = page.getByTestId('sections');
    await sections.evaluate((el) => (el.scrollTop = 0));
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await t.hover();
    await page.mouse.wheel(0, 100);
    await expect.poll(() => sections.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await value()).toBe(3);
    // Once picked, the box takes the wheel.
    await t.focus();
    await t.hover();
    await page.mouse.wheel(0, -100);
    await expect.poll(value).toBe(3.1);
    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Shift');
    await expect.poll(value).toBe(4.1);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 100);
    await page.keyboard.up('Control');
    await expect.poll(value).toBe(4.09);
    // Ctrl and the wheel must not have zoomed the page.
    expect(await zoom()).toEqual(zoomBefore);
    await expect(t).toHaveValue('4.09');
    // So does the slider, once it has focus.
    const slider = row(page, 'silicone.t').locator('input[type="range"]');
    await slider.focus();
    await slider.hover();
    await page.mouse.wheel(0, 100);
    await expect.poll(value).toBe(3.99);
    await slider.dblclick();
    await expect.poll(value).toBe(3);

    // Typing is validated against the schema's range, inline, and nothing is sent until it is valid.
    await typeValue(t, '25');
    await expect(row(page, 'silicone.t').locator('.note.error')).toHaveText('Enter a value from 1 to 20.');
    expect(await value()).toBe(3);
    await typeValue(t, '4.5');
    await expect.poll(value).toBe(4.5);
    await expect(row(page, 'silicone.t').locator('.note.error')).toHaveCount(0);
    await row(page, 'silicone.t').locator('label').dblclick();
    await expect.poll(value).toBe(3);

    // A quantity that must be above 0 takes no 0, though the schema states no minimum: a preview cell
    // of 0 broke the field worker, and a layer of 0 made a pocket 0 deep.
    for (const path of ['quality.cellPreview', 'print.layerHeight', 'print.nozzle', 'cover.wall', 'quality.tinTolPreview']) {
      const before = await hooks(page, (h) => JSON.stringify(h.params()));
      await typeValue(numberBox(page, path), '0');
      await expect(row(page, path).locator('.note.error')).toHaveText(/Enter a value of at least 0\.\d+\./);
      expect(await hooks(page, (h) => JSON.stringify(h.params()))).toBe(before);
      await numberBox(page, path).press('Escape');
    }

    // A cross-parameter error shows under the control it concerns, never in a dialog.
    page.on('dialog', () => {
      throw new Error('no dialog may open');
    });
    await typeValue(numberBox(page, 'seat.depth'), '4.5');
    await expect(row(page, 'seat.depth').locator('.note.error')).toContainText('leaves under 1 mm of plastic');
    await row(page, 'seat.depth').locator('label').dblclick();
    await expect(row(page, 'seat.depth').locator('.note')).toHaveCount(0);
  });

  test('@smoke mode, grid and pour count change the geometry to what Node builds', async ({ page }) => {
    await dropAndWait(page, EXAMPLE_FILES.jersey);
    const hashes = [await hooks(page, (h) => h.geometryHash().all)];
    await row(page, 'base.mode').getByRole('button', { name: 'Merged (B)' }).click();
    await idle(page);
    hashes.push(await hooks(page, (h) => h.geometryHash().all));
    await typeValue(numberBox(page, 'grid.nx'), '2');
    await idle(page);
    hashes.push(await hooks(page, (h) => h.geometryHash().all));
    // An edge under what the joint needs is raised, and says so under its control.
    await typeValue(numberBox(page, 'grid.edge'), '1');
    await expect(row(page, 'grid.edge').locator('.note')).toContainText(/Edge raised from 1\.0 to \d+\.\d mm/);
    await row(page, 'grid.edge').locator('label').dblclick();
    await expect(row(page, 'grid.edge').locator('.note')).toHaveCount(0);
    await typeValue(numberBox(page, 'pour.perModel'), '2');
    await idle(page);
    const last = await hooks(page, (h) => h.geometryHash());
    hashes.push(last.all);
    expect(new Set(hashes).size).toBe(4);
    expect(last).toEqual(await nodeHash('jersey', (p) => p.setParams((params) => {
      params.base.mode = 'merged';
      params.grid.nx = 2;
      params.pour.perModel = 2;
    })));
    // G6: the pitch shown is the export plan's, a whole number of export cells, model size plus spacing.
    const params = defaultParams();
    params.grid.nx = 2;
    const { bounds } = orientedExample('jersey');
    const plan = exportPlan(bounds, fieldSettings(params, bounds));
    expect((plan.pitchXmm / params.quality.cellFinal) % 1).toBe(0);
    expect(plan.pitchXmm).toBeGreaterThanOrEqual(bounds.max[0] - bounds.min[0] + plan.autoSpacing);
    await expect(page.getByTestId('pitch')).toHaveText(`Copies every ${formatNumber(plan.pitchXmm, 3)} × ${formatNumber(plan.pitchYmm, 3)} mm`);
  });

  test('@smoke T1: dragging t from 3 to 6 changes the box and the pixels before any solid job ends', async ({ page }) => {
    await dropAndWait(page, EXAMPLE_FILES.jersey);
    const box = page.getByTestId('status-box');
    const boxBefore = await box.textContent();
    // The silicone alone, opaque: what the height preview draws is then the teal on the canvas.
    const eyes = async (): Promise<void> => {
      for (const part of ['model', 'cover', 'base', 'funnel']) await page.locator(`[data-part="${part}"] .eye`).click();
    };
    await eyes();
    await setRange(page.locator('[data-part="silicone"] input[type="range"]'), 1);
    const tealBefore = await tealPixels(page);
    const pixelsBefore = await canvasPixels(page);
    const solidResults = (): Promise<number> => hooks(page, (h) => h.jobLog().filter((e) => e.gate === 'solid' && e.event === 'result').length);
    const resultsBefore = await solidResults();
    // T2 is held well past the drag, so whatever changes on screen came from T1.
    await hooks(page, (h) => h.armFault('solid', { kind: 'delay', ms: 8000 }));

    const slider = row(page, 'silicone.t').locator('input[type="range"]');
    await slider.scrollIntoViewIfNeeded();
    const track = (await slider.boundingBox())!;
    // The thumb's centre travels from 7 px in from each end, the thumb being 14 px wide.
    const at = (t: number): number => track.x + 7 + ((t - 1) / 19) * (track.width - 14);
    const y = track.y + track.height / 2;
    await page.mouse.move(at(3), y);
    await page.mouse.down();
    await page.mouse.move(at(6), y, { steps: 15 });
    await page.mouse.up();
    // A pixel is about a tenth of a millimetre here, so the last step is by key, as a user would nudge it.
    for (let k = 0; k < 5; k++) {
      const t = await hooks(page, (h) => h.params().silicone.t);
      if (Math.abs(t - 6) < 1e-9) break;
      await slider.press(t < 6 ? 'ArrowRight' : 'ArrowLeft');
    }
    expect(await hooks(page, (h) => h.params().silicone.t)).toBe(6);

    await expect(box).not.toHaveText(boxBefore!);
    // The view's own pixels, so neither the badge nor any other card over it can pass for the change.
    await expect.poll(async () => (await canvasPixels(page)).equals(pixelsBefore)).toBe(false);
    // And it is the field that changed: 3 mm more silicone all round covers far more of the canvas.
    expect(await tealPixels(page)).toBeGreaterThan(tealBefore * 1.15);
    await expect(page.getByTestId('stale')).toBeVisible();
    expect(await hooks(page, (h) => h.events().filter((e) => e.slot === 'field' && e.kind === 'applied').at(-1)!.t)).toBe(6);
    expect(await solidResults()).toBe(resultsBefore);
    // The box on screen is the rim's own: the one Node derives for t = 6. Until T2 lands, the cover and
    // base show as plain boxes on that rim: O from -Tb + proud to Zt, and B from -Tb to 0.
    const rim = await inNode('jersey', (p) => p.setParams((params) => (params.silicone.t = 6)), (p) => p.field!.value.rim);
    await expect(box).toHaveText(`box ${formatSize(boxOf(rim))}`);
    const proxies = await app(page, (a) => ({ cover: a.scene.proxySpan('cover'), base: a.scene.proxySpan('base'), drawn: a.scene.partStyles() }));
    const near = (span: { min: number[]; max: number[] } | null, min: number[], max: number[]): void => {
      expect(span).not.toBeNull();
      [...span!.min, ...span!.max].forEach((v, k) => expect(v).toBeCloseTo([...min, ...max][k], 6));
    };
    near(proxies.cover, [rim.O.x0, rim.O.y0, -rim.Tb + rim.proud], [rim.O.x1, rim.O.y1, rim.Zt]);
    near(proxies.base, [rim.B.x0, rim.B.y0, -rim.Tb], [rim.B.x1, rim.B.y1, 0]);
    // With their eyes on again, the proxies are what draws the cover and base, and they show.
    const hidden = await canvasPixels(page);
    await eyes();
    await expect.poll(async () => (await canvasPixels(page)).equals(hidden)).toBe(false);
    expect(await app(page, (a) => [a.scene.partStyles().cover?.visible, a.scene.partStyles().base?.visible])).toEqual([true, true]);
    expect(await solidResults()).toBe(resultsBefore);

    // Then T2 lands and its solids take the proxies' place, as Node builds them.
    await idle(page);
    expect(await solidResults()).toBeGreaterThan(resultsBefore);
    expect(await app(page, (a) => a.store.pipeline.cover!.mold === a.store.pipeline.field!.mold)).toBe(true);
    expect(await app(page, (a) => [a.scene.proxySpan('cover'), a.scene.proxySpan('base')])).toEqual([null, null]);
    await expect(page.getByTestId('stale')).toBeHidden();
    expect(await hooks(page, (h) => h.geometryHash())).toEqual(await nodeHash('jersey', (p) => p.setParams((params) => (params.silicone.t = 6))));
  });

  test('@smoke the pocket follows the layer height at 0.1, 0.2 and 0.3 until it is edited', async ({ page }) => {
    await dropAndWait(page, EXAMPLE_FILES.jersey);
    const pocket = numberBox(page, 'base.pocketDepth');
    const layer = numberBox(page, 'print.layerHeight');
    const pocketParam = (): Promise<number | null> => hooks(page, (h) => h.params().base.pocketDepth);
    for (const height of ['0.1', '0.3', '0.2']) {
      await typeValue(layer, height);
      await expect(pocket).toHaveValue(height);
      await expect(pocket).toHaveClass(/auto/);
      expect(await pocketParam()).toBeNull();
    }
    await typeValue(layer, '0.3');
    await idle(page);
    // The base is built with the pocket the layer gave it.
    const followed = await hooks(page, (h) => h.geometryHash().base);
    expect(followed).toEqual((await nodeHash('jersey', (p) => p.setParams((params) => (params.print.layerHeight = 0.3)))).base);

    await typeValue(pocket, '0.6');
    expect(await pocketParam()).toBe(0.6);
    await typeValue(layer, '0.1');
    await expect(pocket).toHaveValue('0.6');
    await expect(pocket).not.toHaveClass(/auto/);
    await expect(row(page, 'base.pocketDepth').locator('.tag')).toHaveText('set');
    // Double-click follows the layer again.
    await row(page, 'base.pocketDepth').locator('label').dblclick();
    await expect(pocket).toHaveValue('0.1');
    expect(await pocketParam()).toBeNull();
    // A pocket that is no whole number of layers says so under its control.
    await typeValue(layer, '0.2');
    await typeValue(pocket, '0.3');
    await expect(row(page, 'base.pocketDepth').locator('.note.warning')).toContainText('not a whole number');
  });

  test('@smoke a typed position pins the opening, an invalid one snaps to a valid place, and the geometry follows', async ({ page }) => {
    await dropAndWait(page, EXAMPLE_FILES.jersey);
    const openings = (): Promise<{ id: string; kind: string; x: number; y: number; pinned: boolean }[]> => hooks(page, (h) => h.openings());
    const [pour] = (await openings()).filter((o) => o.kind === 'pour');
    const [vent] = (await openings()).filter((o) => o.kind === 'vent');
    const pourRow = page.locator(`[data-opening="${pour.id}"]`);
    await expect(pourRow).toHaveAttribute('data-pinned', 'false');
    // Away from the vent beside it, so the land between them stays wide enough and the spot is valid.
    const away = Math.sign(pour.x - vent.x) || 1;
    await typeValue(pourRow.locator('input[data-axis="x"]'), (pour.x + away).toFixed(2));
    await idle(page);
    await expect(pourRow).toHaveAttribute('data-pinned', 'true');
    const moved = (await openings()).find((o) => o.id === pour.id)!;
    expect(moved.x).toBeCloseTo(pour.x + away, 2);
    const pins = await hooks(page, (h) => h.project().pins);
    expect(pins.map((pin) => pin.id)).toEqual([pour.id]);
    expect(await hooks(page, (h) => h.geometryHash())).toEqual(await nodeHash('jersey', (p) => p.setPins(pins as OpeningPin[])));
    // That rebuild only cut the openings again, and the status strip shows it, not the load's full build.
    const cut = (await app(page, (a) => a.store.pipeline.lastRebuild))!;
    expect(cut.kind).toBe('cut');
    expect(cut.ms).toBe(await app(page, (a) => a.store.pipeline.timing.cut.at(-1)));
    await expect(page.getByTestId('status-rebuild')).toHaveText(`rebuild ${Math.round(cut.ms)} ms`);
    // A second click on the chosen base face changes nothing, so the pin stays.
    await page.locator('.candidate').first().click();
    await idle(page);
    expect(await hooks(page, (h) => h.project().pins)).toEqual(pins);

    // Typing that is no number moves nothing, and says so.
    await typeValue(pourRow.locator('input[data-axis="x"]'), 'abc');
    await expect(pourRow.locator('.note.error')).toHaveText('Enter a number.');
    expect(await hooks(page, (h) => h.project().pins)).toEqual(pins);
    await pourRow.locator('input[data-axis="x"]').press('Escape');
    await expect(pourRow.locator('.note.error')).toHaveCount(0);

    // Far off the cavity: it snaps back onto valid ground, says so, and stays pinned there.
    await typeValue(pourRow.locator('input[data-axis="y"]'), '60');
    await idle(page);
    await expect(pourRow.locator('.note')).toContainText('nearest place');
    const snapped = (await openings()).find((o) => o.id === pour.id)!;
    expect(snapped.pinned).toBe(true);
    expect(snapped.y).toBeLessThan(60);
    const node = await inNode('jersey', (p) => p.setPins(pins as OpeningPin[]), async (p) => {
      const result = p.dropOpening(pour.id, moved.x, 60)!;
      await p.idle();
      return { result, hash: p.geometryHash() };
    });
    expect(node.result.snapped).toBe(true);
    expect([snapped.x, snapped.y]).toEqual([node.result.x, node.result.y]);
    expect(await hooks(page, (h) => h.geometryHash())).toEqual(node.hash);

    // Unpinned, placement puts it back where it was.
    await pourRow.getByRole('button', { name: /Unpin/ }).click();
    await idle(page);
    const back = (await openings()).find((o) => o.id === pour.id)!;
    expect([back.x, back.y, back.pinned]).toEqual([pour.x, pour.y, false]);

    // An automatic vent can be removed, and restored.
    await page.locator(`[data-opening="${vent.id}"]`).getByRole('button', { name: /Remove/ }).click();
    await idle(page);
    expect((await openings()).map((o) => o.id)).not.toContain(vent.id);
    await page.getByRole('button', { name: 'Restore' }).click();
    await idle(page);
    expect((await openings()).map((o) => o.id)).toContain(vent.id);
  });

  test('@smoke base confirmation: hovering a candidate highlights its plane, a click on the model picks a face, and Esc leaves pick mode', async ({ page }) => {
    await dropAndWait(page, EXAMPLE_FILES.jersey);
    const info = await app(page, (a) => {
      const o = a.store.pipeline.oriented!.value;
      return { candidates: o.candidates.map((c) => ({ normal: c.normal, triangles: c.members.length })), chosen: o.chosen.members.length, bounds: o.bounds };
    });
    // Hovering row 2 shows the chosen plane in orange and that one in yellow, every coplanar triangle of each.
    await page.locator('.candidate').nth(1).hover();
    await expect.poll(() => app(page, (a) => a.scene.highlightCounts())).toEqual([info.chosen, info.candidates[1].triangles]);
    await page.mouse.move(5, 300);
    await expect.poll(() => app(page, (a) => a.scene.highlightCounts())).toEqual([]);

    // Pick mode, then a click on the model's top: the +Z face of the file, as the model stands on -Z.
    const top = info.candidates.findIndex((c) => c.normal[2] === 1);
    expect(top).toBeGreaterThan(0);
    await page.getByTestId('pick-face').click();
    const { min, max } = info.bounds;
    const point = await hooks(page, (h, b: { min: number[]; max: number[] }) => {
      const centre: [number, number, number] = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]];
      h.setCamera({ position: [centre[0] + 1, centre[1] - 25, centre[2] + 120], target: centre });
      return h.worldToScreen(centre);
    }, { min, max });
    await page.mouse.move(point.x, point.y);
    // Inside a ranked plane, the whole plane lights up, as a click there means all of it.
    await expect.poll(() => app(page, (a) => a.scene.highlightCounts())).toEqual([info.chosen, info.candidates[top].triangles]);
    await page.mouse.click(point.x, point.y);
    await idle(page);
    const plane = await hooks(page, (h) => h.project().plane);
    expect('pick' in plane).toBe(true);
    expect(await app(page, (a) => a.store.pipeline.oriented!.value.chosen.normal)).toEqual([0, 0, 1]);
    expect(await app(page, (a) => a.store.pickMode.value)).toBe(false);
    await expect(page.locator('.candidate[aria-selected="true"]')).toHaveCount(0);
    expect(await hooks(page, (h) => h.geometryHash())).toEqual(await nodeHash('jersey', (p) => p.setPlane(plane)));

    // A face in no ranked plane: the barrier's sloped long side, seen from -y. Its highlight is every
    // triangle on that triangle's plane and facing its way, as coplanarTriangles finds them in Node.
    await page.getByTestId('pick-face').click();
    const side = await hooks(page, (h, b: { min: number[]; max: number[] }) => {
      const centre: [number, number, number] = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
      h.setCamera({ position: [centre[0], centre[1] - 150, centre[2]], target: centre });
      return h.worldToScreen(centre);
    }, { min, max });
    await page.mouse.move(side.x, side.y);
    const hovered = await app(page, (a, at: { x: number; y: number }) => {
      const o = a.store.pipeline.oriented!.value;
      const t = a.scene.pickAt(at.x, at.y)!;
      return { t, ranked: o.candidates.some((c) => c.members.includes(t)), chosen: o.chosen.members.length, planeTol: o.planeTol };
    }, side);
    expect(hovered.ranked).toBe(false);
    const welded = weld(parseStl(exampleBytes('jersey')).positions);
    const coplanar = coplanarTriangles(welded, hovered.t, hovered.planeTol);
    expect(coplanar.length).toBeGreaterThan(1);
    await expect.poll(() => app(page, (a) => a.scene.highlightCounts())).toEqual([hovered.chosen, coplanar.length]);

    // A pick names a triangle of the mesh the pipeline holds, even when a lighter proxy is what is drawn
    // (G1.8). A proxy with the same triangles in the reverse order would name another index if it were picked.
    const picks = await app(page, (a, at: { x: number; y: number }) => {
      const real = a.store.pipeline.modelMesh()!;
      const n = real.indices.length / 3;
      const reversed = new Uint32Array(real.indices.length);
      for (let t = 0; t < n; t++) reversed.set(real.indices.subarray((n - 1 - t) * 3, (n - t) * 3), t * 3);
      const plain = a.scene.pickAt(at.x, at.y);
      a.scene.setModel(real, { positions: real.positions, indices: reversed });
      const proxied = a.scene.pickAt(at.x, at.y);
      a.scene.setModel(real, a.store.pipeline.displayProxy ?? real);
      return [plain, proxied];
    }, side);
    expect(picks).toEqual([hovered.t, hovered.t]);

    // A click on a card over the model is the card's, never a pick of what lies behind it. From just
    // over the top, the model fills the view, so any point of the canvas would pick its top face.
    await hooks(page, (h, b: { min: number[]; max: number[] }) => {
      const centre: [number, number, number] = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]];
      h.setCamera({ position: [centre[0], centre[1] - 0.01, centre[2] + 4], target: centre });
    }, { min, max });
    const eye = page.locator('[data-part="base"] .eye');
    const behind = (await eye.boundingBox())!;
    expect(await app(page, (a, at: { x: number; y: number }) => a.scene.pickAt(at.x, at.y), { x: behind.x + behind.width / 2, y: behind.y + behind.height / 2 })).not.toBeNull();
    await eye.click();
    await idle(page);
    expect(await app(page, (a) => a.scene.partStyles().base!.visible)).toBe(false);
    expect(await hooks(page, (h) => h.project().plane)).toEqual(plane);
    expect(await app(page, (a) => a.store.pickMode.value)).toBe(true);
    await eye.click();
    await page.keyboard.press('Escape');

    // Esc leaves pick mode without picking.
    await page.getByTestId('pick-face').click();
    expect(await app(page, (a) => a.store.pickMode.value)).toBe(true);
    await page.keyboard.press('Escape');
    expect(await app(page, (a) => a.store.pickMode.value)).toBe(false);
    // And a ranked row sets the plane back.
    await page.locator('.candidate').first().click();
    await idle(page);
    expect(await hooks(page, (h) => h.project().plane)).toEqual({ rank: 0, upper: false });
  });

  test('@smoke VIS-35 warns of its two levels, and "Use upper level" moves the plane to 0.41 mm as Node does', async ({ page }) => {
    await dropAndWait(page, EXAMPLE_FILES.vis35);
    const warning = page.getByTestId('upper-level');
    // G2.6: a 764 mm2 face 0.41 mm up. It measures 769 mm2, the M1 golden, within M1's 1%.
    await expect(warning).toContainText('A 769 mm² flat level sits 0.41 mm above this plane');
    await expect(page.locator('.diagnostic[data-code="upper-level"]')).toHaveCount(1);
    await expect(page.locator('.diagnostic[data-code="upper-level"]')).toContainText('769 mm² flat level');
    // A warning sends the card to the top right.
    await expect(page.getByTestId('diagnostics')).toHaveClass(/warn/);
    const offered = (await app(page, (a) => a.store.pipeline.footprint!.value.levels.useUpper))!;
    expect(Math.abs(offered.exposedArea / 764 - 1)).toBeLessThan(0.01);
    await warning.getByRole('button', { name: 'Use upper level' }).click();
    await idle(page);
    await expect(warning).toHaveCount(0);
    await expect(page.getByTestId('on-upper-level')).toContainText('the level 0.41 mm up');
    // The plane names the level the warning offered, which is what stands on it.
    expect(await hooks(page, (h) => h.project().plane)).toEqual({ rank: 0, upper: offered.offset });
    expect(await app(page, (a) => a.store.pipeline.oriented!.value.chosen.offset)).toBe(offered.offset);
    expect(await hooks(page, (h) => h.diagnostics().map((d) => d.code))).not.toContain('upper-level');
    expect(await hooks(page, (h) => h.geometryHash())).toEqual(await nodeHash('vis35', (p) => p.setPlane({ rank: 0, upper: offered.offset })));
  });

  test('@smoke wolf: the footprint islands it drops are listed in Diagnostics, and its long vent has a place to show', async ({ page }) => {
    await dropAndWait(page, EXAMPLE_FILES.wolf);
    // G2.5: 9 footprint components, of which 3 are kept.
    await expect(page.locator('.diagnostic[data-code="footprint-islands"]')).toContainText('6 footprint islands smaller than 5 mm² were dropped');
    // Its control is in Advanced, which is closed: the summary says a row inside has a note.
    await expect(page.locator('.advanced')).not.toHaveAttribute('open');
    await expect(page.getByTestId('advanced-notes')).toHaveText('1');
    await page.locator('.advanced > summary').click();
    await expect(row(page, 'base.minIsland').locator('.note')).toContainText('6 footprint islands smaller than 5 mm²');
    const vent = page.locator('.diagnostic[data-code="long-vent"]');
    await expect(vent).toHaveCount(1);
    await vent.getByRole('button', { name: 'Show' }).click();
    await expect.poll(() => app(page, (a) => a.scene.diagnosticMarkers.group.children.length)).toBeGreaterThan(0);
  });

  test('@smoke diagnostics: the card moves to the top right on a warning, Show marks the place in 3D, and the grid\'s walls are checked at the export cell', async ({ page }) => {
    await dropAndWait(page, EXAMPLE_FILES.jersey);
    const card = page.getByTestId('diagnostics');
    await expect(card).toHaveClass(/ok/);
    const cardBox = (await card.boundingBox())!, view = (await page.getByTestId('viewport').boundingBox())!;
    expect(cardBox.x - view.x).toBeLessThan(30);
    expect(view.y + view.height - (cardBox.y + cardBox.height)).toBeLessThan(30);

    // The pour pinned where it is.
    const pour = (await hooks(page, (h) => h.openings())).find((o) => o.kind === 'pour')!;
    await hooks(page, async (h, p: { id: string; x: number; y: number }) => {
      h.drop(p.id, p.x, p.y);
      await h.idle();
    }, pour);
    // A pour this wide no longer fits the pinned spot: a later change made it invalid, so it is flagged.
    await hooks(page, async (h) => {
      h.setParam('pour.diameter', 30);
      await h.idle();
    });
    const invalid = page.locator('.diagnostic[data-code="opening-invalid"]');
    await expect(invalid).toHaveCount(1);
    await expect(card).toHaveClass(/warn/);
    const moved = (await card.boundingBox())!;
    expect(view.x + view.width - (moved.x + moved.width)).toBeLessThan(30);
    expect(moved.y - view.y).toBeLessThan(30);
    const before = await canvasPixels(page);
    await invalid.getByRole('button', { name: 'Show' }).click();
    await expect.poll(() => app(page, (a) => a.scene.diagnosticMarkers.group.children.length)).toBeGreaterThan(0);
    await expect.poll(async () => (await canvasPixels(page)).equals(before)).toBe(false);
    // The marker stands over the place the message names, and the view draws it there, in orange.
    const [, x, y] = /\((-?[\d.]+), (-?[\d.]+)\)/.exec((await invalid.textContent())!)!.map(Number);
    const head = await app(page, (a) => a.scene.diagnosticMarkers.group.children[0].position.toArray());
    const top = await app(page, (a) => a.store.pipeline.field!.value.rim.Zt);
    expect([head[0], head[1]]).toEqual([x, y]);
    expect(head[2]).toBeGreaterThan(top);
    const spot = await hooks(page, (h, at: number[]) => h.worldToScreen(at as [number, number, number]), head);
    expect(spot.visible).toBe(true);
    const [r, g, b] = await canvasColour(page, spot);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(70);
    expect(g).toBeLessThan(160);
    expect(b).toBeLessThan(90);
    await invalid.getByRole('button', { name: 'Show' }).click();
    await expect.poll(() => app(page, (a) => a.scene.diagnosticMarkers.group.children.length)).toBe(0);
    await hooks(page, async (h) => {
      h.setParam('pour.diameter', 10);
      await h.idle();
    });

    // Two barriers 2 mm apart: the preview says nothing of the wall (G6), the export cell's check does.
    await hooks(page, async (h) => {
      h.setParam('grid.nx', 2);
      h.setParam('grid.spacing', 2);
      await h.idle();
    });
    await expect(page.getByTestId('wall-check')).toContainText('full export detail');
    await expect.poll(() => hooks(page, (h) => h.walls().result !== null), { timeout: 30_000 }).toBe(true);
    const walls = await hooks(page, (h) => h.diagnostics().filter((d) => d.code === 'thin-tile-wall' || d.code === 'tiles-merged'));
    expect(walls).toHaveLength(1);
    expect(walls[0].exportCell).toBe(true);
    await expect(page.locator(`.diagnostic[data-code="${walls[0].code}"] .where`)).toHaveText('Checked at full export detail');
    await expect(row(page, 'grid.spacing').locator('.note.warning')).toHaveCount(1);
  });

  test('@smoke the view: parts hide and fade, the wireframe and projection toggles redraw, and a software renderer is named', async ({ page }) => {
    await dropAndWait(page, EXAMPLE_FILES.jersey);
    const renderer = await app(page, (a) => a.scene.rendererName());
    // Both browsers on this server draw WebGL in software, so the card shows here.
    if (/swiftshader|llvmpipe/i.test(renderer)) {
      await expect(page.getByTestId('software-renderer')).toBeVisible();
      await page.getByTestId('software-renderer').getByRole('button', { name: 'Dismiss' }).click();
      await expect(page.getByTestId('software-renderer')).toHaveCount(0);
    }
    expect(await app(page, (a) => a.scene.heightMode)).toBe('gpu');
    let previous = await canvasPixels(page);
    const redraws = async (act: () => Promise<void>): Promise<void> => {
      await act();
      await expect.poll(async () => (await canvasPixels(page)).equals(previous)).toBe(false);
      previous = await canvasPixels(page);
    };
    // Every part's eye and opacity: what draws it follows, and so do the view's own pixels.
    const drawn = (part: string): Promise<{ visible: boolean; opacity: number } | null> => app(page, (a, name: string) => a.scene.partStyles()[name as 'model'], part);
    for (const part of ['model', 'silicone', 'cover', 'base', 'funnel']) {
      const eye = page.locator(`[data-part="${part}"] .eye`);
      const start = (await drawn(part))!;
      expect(start.visible, part).toBe(true);
      await redraws(() => eye.click());
      expect((await drawn(part))!.visible, part).toBe(false);
      await redraws(() => eye.click());
      expect((await drawn(part))!.visible, part).toBe(true);
      await redraws(() => setRange(page.locator(`[data-part="${part}"] input[type="range"]`), 0.75));
      expect((await drawn(part))!.opacity, part).toBe(0.75);
    }
    await redraws(() => page.getByTestId('wireframe').check());
    await redraws(() => page.getByTestId('perspective').uncheck());
    expect(await app(page, (a) => a.scene.perspective)).toBe(false);
    await redraws(() => page.getByTestId('perspective').check());
    expect(await app(page, (a) => a.scene.perspective)).toBe(true);

    // After a pan (right-drag) and a turn (drag), switching the projection keeps the view: the camera
    // stays where it was, the point the orbit turns about stays in the middle, and a point beside it in
    // the plane both projections agree on stays where it was on screen. OrbitControls' own target is
    // that point: it is what a pan moves.
    type Posed = { controls: { target: { toArray(): number[] } }; camera: { position: { toArray(): number[] }; matrixWorld: { elements: number[] } } };
    const view = (await page.getByTestId('viewport').boundingBox())!;
    const framed = await app(page, (a) => (a.scene as unknown as Posed).controls.target.toArray());
    const from = { x: view.x + view.width * 0.55, y: view.y + view.height * 0.6 };
    for (const button of ['right', 'left'] as const) {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down({ button });
      await page.mouse.move(from.x + 90, from.y - 40, { steps: 6 });
      await page.mouse.up({ button });
    }
    const pose = await app(page, (a) => {
      const scene = a.scene as unknown as Posed;
      const pivot = scene.controls.target.toArray();
      const right = scene.camera.matrixWorld.elements.slice(0, 3);
      return { pivot, beside: pivot.map((v, k) => v + 10 * right[k]), position: scene.camera.position.toArray() };
    });
    const screen = (at: number[]): Promise<{ x: number; y: number }> => hooks(page, (h, p: number[]) => h.worldToScreen(p as [number, number, number]), at);
    const middle = { x: view.x + view.width / 2, y: view.y + view.height / 2 };
    const apart = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
    // The pan moved the pivot off the box's centre, where the frame put it: that is what used to throw a toggle off.
    expect(Math.hypot(...pose.pivot.map((v, k) => v - framed[k]))).toBeGreaterThan(2);
    expect(apart(await screen(pose.pivot), middle)).toBeLessThan(1);
    const beside = await screen(pose.beside);
    for (const on of [false, true]) {
      await page.getByTestId('perspective').setChecked(on);
      await expect.poll(() => app(page, (a) => a.scene.perspective)).toBe(on);
      expect(apart(await screen(pose.pivot), middle), `pivot, perspective ${on}`).toBeLessThan(1);
      expect(apart(await screen(pose.beside), beside), `beside, perspective ${on}`).toBeLessThan(1.5);
    }
    const back = await app(page, (a) => a.scene.camera.position.toArray());
    back.forEach((v, k) => expect(v).toBeCloseTo(pose.position[k], 3));
  });

  test('@smoke the height preview falls back to the CPU and draws the same field', async ({ page }) => {
    /** Where the silicone shows, alone and opaque, from one fixed camera: the teal pixels as a mask. */
    const siliconeMask = async (p: Page): Promise<string> => {
      for (const part of ['model', 'cover', 'base', 'funnel']) await p.locator(`[data-part="${part}"] .eye`).click();
      await setRange(p.locator('[data-part="silicone"] input[type="range"]'), 1);
      await hooks(p, (h) => h.setCamera({ position: [20, -70, 60], target: [0, 0, 8], fov: 35 }));
      return p.evaluate(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const canvas = document.querySelector('[data-testid="viewport"] canvas') as HTMLCanvasElement;
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        const ctx = copy.getContext('2d')!;
        ctx.drawImage(canvas, 0, 0);
        const { data } = ctx.getImageData(0, 0, copy.width, copy.height);
        let mask = '';
        for (let i = 0; i < data.length; i += 4) mask += data[i + 1] > data[i] + 40 && data[i + 2] > data[i] + 30 ? '1' : '0';
        return mask;
      });
    };
    await dropAndWait(page, EXAMPLE_FILES.jersey);
    expect(await app(page, (a) => a.scene.heightMode)).toBe('gpu');
    const gpu = await siliconeMask(page);

    const cpuPage = await page.context().newPage();
    const cpuWatch = await openApp(cpuPage, '&heights=cpu');
    await dropAndWait(cpuPage, EXAMPLE_FILES.jersey);
    expect(await app(cpuPage, (a) => a.scene.heightMode)).toBe('cpu');
    const cpu = await siliconeMask(cpuPage);
    await cpuPage.close();
    expect(cpuWatch.errors).toEqual([]);

    // The same field from the same camera covers the same pixels, but for a few along its edges.
    expect(cpu.length).toBe(gpu.length);
    const teal = [...gpu].filter((bit) => bit === '1').length;
    let differ = 0;
    for (let i = 0; i < gpu.length; i++) if (gpu[i] !== cpu[i]) differ++;
    expect(teal).toBeGreaterThan(20_000);
    expect(differ / teal).toBeLessThan(0.01);
  });

  test('@smoke a drop anywhere on the page loads, and a file that is no STL says why next to Open STL', async ({ page }) => {
    // On the sidebar: the page takes the drop, so the browser neither opens nor saves the file.
    expect(await dropExample(page, EXAMPLE_FILES.jersey, { on: '[data-testid="sections"]' })).toBe(true);
    await expect.poll(() => app(page, (a) => a.store.pipeline.modelName)).toBe(EXAMPLE_FILES.jersey);
    await idle(page);
    await expect(page.getByTestId('parts')).toBeVisible();
    await expect(page.getByTestId('model-error')).toHaveCount(0);

    // Not an STL: the parser's reason, under the file row, with no parts to show and no badge waiting for nothing.
    expect(await dropExample(page, 'notes.stl', { text: 'hello' })).toBe(true);
    await expect.poll(() => app(page, (a) => a.store.pipeline.modelName)).toBe('notes.stl');
    await idle(page);
    await expect(page.getByTestId('model-error')).toHaveText('This does not look like an STL file: it is too small.');
    await expect(page.getByTestId('file-name')).toHaveText('notes.stl');
    await expect(page.getByTestId('parts')).toHaveCount(0);
    await expect(page.getByTestId('stale')).toHaveCount(0);
    await expect(page.locator('.diagnostic[data-code="pipeline-error"]')).toHaveCount(1);
  });
});

test.describe('all seven examples, dropped into the app', () => {
  test.skip(!FULL, 'all 7 run with CFG_FULL=1');
  for (const id of Object.keys(EXAMPLE_FILES) as ExampleId[]) {
    test(`${id}: base confirmed on -z, status strip as Node, geometry as Node`, async ({ page }, info) => {
      test.skip(info.project.name === 'dev', 'the dev server serves the same code; preview and firefox cover it');
      test.skip(!canDraw(page), NO_FIREFOX_WEBGL);
      const watch = await openApp(page);
      await dropAndWait(page, EXAMPLE_FILES[id]);
      const node = await inNode(id, () => {}, (p) => ({ hash: p.geometryHash(), ml: previewSilicone(p)!.ml }));
      await checkStatus(page, id, node.ml);
      await expect(page.locator('.candidate').first()).toHaveAttribute('aria-selected', 'true');
      expect(await app(page, (a) => a.store.pipeline.oriented!.value.chosen.normal)).toEqual([0, 0, -1]);
      expect(await hooks(page, (h) => h.geometryHash())).toEqual(node.hash);
      expect(watch.errors).toEqual([]);
      expect(watch.foreign).toEqual([]);
    });
  }

  test('x8 3 x 3: the export cell\'s wall check runs after the preview settles, and its time is recorded', async ({ page }, info) => {
    test.skip(info.project.name === 'dev', 'measures a worker, which runs the same on the dev server');
    test.skip(!canDraw(page), NO_FIREFOX_WEBGL);
    test.setTimeout(300_000);
    const watch = await openApp(page);
    await hooks(page, (h) => {
      h.setParam('grid.nx', 3);
      h.setParam('grid.ny', 3);
    });
    await dropAndWait(page, EXAMPLE_FILES.x8);
    await expect.poll(() => hooks(page, (h) => h.walls().result !== null), { timeout: 120_000 }).toBe(true);
    await expect(page.locator('.diagnostic[data-code="tile-walls"] .where')).toHaveText('Checked at full export detail');
    const times = await hooks(page, (h) => h.wallTimes());
    const result = await hooks(page, (h) => h.walls().result!);
    console.log(`${info.project.name} x8 3 x 3 wall check: ${Math.round(times.at(-1)!)} ms at cell ${result.cell}, thinnest wall ${result.minWall?.toFixed(2)} mm, merged ${result.merged}`);
    // M6's record: the export cell, a thinnest wall of 2.50 mm, and no merge, as the card says.
    expect(result.cell).toBe(0.125);
    expect(result.merged).toBe(false);
    expect(result.minWall!).toBeCloseTo(2.5, 2);
    await expect(page.locator('.diagnostic[data-code="tile-walls"]')).toContainText('The thinnest wall between models is 2.50 mm');
    expect(times).toHaveLength(1);
    expect(watch.errors).toEqual([]);
  });
});
