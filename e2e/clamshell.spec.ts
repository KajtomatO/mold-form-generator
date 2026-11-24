import { mkdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { Pipeline } from '../src/app/pipeline';
import { hashMesh } from '../src/app/hash';
import { weld } from '../src/core/mesh/weld';
import { defaultParams } from '../src/core/params/defaults';
import type { Params } from '../src/core/params/schema';
import { parseStl } from '../src/core/stl/parse';
import { inProcessField, inProcessSolid } from '../test/fixtures/inProcessWorker';
import { EXAMPLE_FILES, hasExample } from '../test/fixtures/loadExamples';
import { app, canDraw, hooks, idle, openApp } from './appHarness';
import { NO_FIREFOX_WEBGL } from './firefox';

/**
 * MP5 (docs/PLAN.md, MP5; G13.13 to G13.16): the two-part cover in the app. The switch builds the halves, the explode
 * moves them along the pull and the clips along b, an opening drags along P only, the Seam fasteners rows and their
 * lines show under the rows they name, the corner bolts' toggle is held off with its reason, and the export ZIP and the
 * fit-test ZIP hold Node's bytes. Every test needs the 3D view, so in Firefox with no display they skip.
 */
const SHOTS = process.env.CFG_SHOTS === '1';
const SHOTS_DIR = process.env.CFG_SHOTS_DIR ?? join(import.meta.dirname, '..', 'test-results', 'shots');
const SPHERE = new Uint8Array(readFileSync(join(import.meta.dirname, '..', 'public', 'gallery', 'sphere.stl')));

const tile = (page: Page, id: string): Locator => page.locator(`.mold-tile[data-type="${id}"]`);
const row = (page: Page, path: string): Locator => page.locator(`.sidebar [data-param="${path}"]`);

/** Opens the app on the sphere, the help model, and switches to the Two-part cover by its tile, with `change` after. */
async function twoPart(page: Page, change: Partial<Record<string, unknown>> = {}): Promise<void> {
  test.skip(!canDraw(page), NO_FIREFOX_WEBGL);
  await openApp(page, '&model=sphere');
  await expect.poll(() => app(page, (a) => a.store.pipeline.modelName)).toBe('sphere.stl');
  await idle(page);
  await tile(page, 'clamshell').click();
  for (const [path, value] of Object.entries(change)) await hooks(page, (h, pair: [string, unknown]) => h.setParam(pair[0] as never, pair[1]), [path, value]);
  await idle(page);
}

/** The same mold in Node, by the same stage code, for the bytes of its export. */
async function inNode(bytes: Uint8Array, name: string, change: (params: Params) => void, read: (p: Pipeline) => Promise<Record<string, Uint8Array>>): Promise<Record<string, Uint8Array>> {
  const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true });
  try {
    p.load(bytes, name);
    p.setParams((params) => {
      Object.assign(params, defaultParams('clamshell'));
      change(params);
    });
    await p.idle();
    return await read(p);
  } finally {
    p.dispose();
  }
}

const meshHash = (stl: Uint8Array): string => {
  const mesh = weld(parseStl(stl).positions);
  return hashMesh(mesh.positions, mesh.indices);
};

async function downloaded(page: Page, testId: string): Promise<Record<string, Uint8Array>> {
  const download = page.waitForEvent('download', { timeout: 300_000 });
  await page.getByTestId(testId).click();
  return unzipSync(await readFile(await (await download).path()));
}

test.describe('MP5: the two-part cover', () => {
  test('@smoke the switch builds the halves on the sphere, split along x, with P drawn and no one-piece cover', async ({ page }) => {
    await twoPart(page);
    const shown = await app(page, (a) => {
      const p = a.store.pipeline;
      return { halves: p.cover?.value.halves?.map((h) => h.indices.length / 3) ?? null, axis: p.field?.value.clam?.axis, xs: p.field?.value.clam?.xs, error: p.error, stale: p.status().stale };
    });
    expect(shown.error).toBeNull();
    expect(shown.stale).toBe(false);
    expect(shown.axis).toBe('x');
    expect(shown.halves).toHaveLength(2);
    for (const triangles of shown.halves!) expect(triangles).toBeGreaterThan(1000);
    // The sidebar's line names the seam bolts the fine pair placed, and the tile what it saves once the reports are in.
    await expect(page.getByTestId('seam-hold')).toContainText(/^Held by 4 M3 x 10 mm seam bolts, 2 on each end: 200 N together, against the \d+ N the seam needs\.$/);
    // The card carries the same line.
    await expect(page.locator('[data-testid="diagnostics"] [data-code="seam-hold"]')).toContainText((await page.getByTestId('seam-hold').textContent())!);
    await expect(page.getByTestId('two-part-estimate')).toContainText(/Saves about [\d.]+ ml \(\d+%\)/);
    // The Cover button saves both halves, and Export ZIP says what it holds.
    await expect(page.getByTestId('export-cover')).toHaveText('Halves');
    await expect(page.getByTestId('export-zip')).toHaveAttribute('title', /^The two halves, base, funnel and model, with a README/);
  });

  test('the explode moves each half along its pull, the base down, the funnel up, and with Clips each clip out along b', async ({ page }) => {
    await twoPart(page, { 'clamshell.fastener': 'clips' });
    await app(page, (a) => a.store.setExplode({ on: true, distance: 10 }));
    await expect.poll(() => app(page, (a) => a.scene.splitOffsets().neg)).toEqual([-10, 0, 0]);
    const offsets = { ...(await app(page, (a) => a.scene.explodeOffsets())), ...(await app(page, (a) => a.scene.splitOffsets())) };
    expect(offsets.pos).toEqual([10, 0, 0]);
    expect(offsets.base).toBe(-10);
    expect(offsets.funnel).toBe(20);
    // The openings' rings stay on P, so the cover's own root does not move.
    expect(offsets.cover).toBe(0);
    // Each clip out from its own end face along y, the b of an x split: half of them each way.
    expect(offsets.clips.length).toBeGreaterThan(0);
    for (const [x, y, z] of offsets.clips) expect([x, Math.abs(y), z]).toEqual([0, 15, 0]);
    expect(offsets.clips.filter(([, y]) => y > 0)).toHaveLength(offsets.clips.length / 2);
    // The clips are a layer of their own, listed with Clips only: its eye hides and shows them.
    const clips = page.locator('[data-part="clips"]');
    await expect(clips).toHaveCount(1);
    expect(await app(page, (a) => a.scene.partStyles().clips?.visible)).toBe(true);
    await clips.locator('.eye').click();
    await expect.poll(() => app(page, (a) => a.scene.partStyles().clips?.visible)).toBe(false);
    expect(await app(page, (a) => a.scene.partStyles().cover?.visible)).toBe(true);
    await clips.locator('.eye').click();
    await expect.poll(() => app(page, (a) => a.scene.partStyles().clips?.visible)).toBe(true);
    await hooks(page, (h) => h.setParam('clamshell.fastener', 'bolts'));
    await idle(page);
    await expect(clips).toHaveCount(0);
  });

  test('an opening dragged off P is held to it, and its drop moves it along P only, its pin keeping the stored a', async ({ page }) => {
    await twoPart(page);
    const first = await app(page, (a) => a.store.pipeline.placement!.value.placement.openings.find((o) => o.kind === 'vent')!);
    const xs = await app(page, (a) => a.store.pipeline.field!.value.clam!.xs);
    // Pinned with an a off P, as the one-piece cover would have stored it: on P it stands at (xs, b).
    const storedA = xs + 3;
    await app(page, (a, pin: [string, number, number]) => a.store.pipeline.setPins([{ id: pin[0], kind: 'vent', x: pin[1], y: pin[2] }]), [first.id, storedA, first.y]);
    await idle(page);
    const vent = await app(page, (a, id) => a.store.pipeline.placement!.value.placement.openings.find((o) => o.id === id)!, first.id);
    expect(vent.x).toBeCloseTo(xs, 6);
    // Dragged 6 mm off P and 2 mm along it, away from the pour: the ring stays on P.
    const held = await app(page, (a, at: [string, number, number]) => {
      a.store.dragOpening(at[0], at[1] + 6, at[2] + 2, { x: 0, y: 0 });
      return { x: a.store.drag.value!.x, y: a.store.drag.value!.y };
    }, [vent.id, vent.x, vent.y]);
    expect(held.x).toBeCloseTo(xs, 6);
    expect(held.y).toBeCloseTo(vent.y + 2, 6);
    await app(page, (a) => a.store.dropDrag());
    await idle(page);
    const after = await hooks(page, (h, id) => h.openings().find((o) => o.id === id)!, vent.id);
    expect(after.x).toBeCloseTo(xs, 6);
    expect(after.pinned).toBe(true);
    expect(Math.abs(after.y - vent.y)).toBeGreaterThan(0.1);
    // The pin keeps the stored a, and only b moved.
    const pin = await hooks(page, (h, id) => h.project().pins.find((p) => p.id === id)!, vent.id);
    expect(pin.y).toBeCloseTo(after.y, 6);
    expect(pin.x).toBeCloseTo(storedA, 6);
    // From the keyboard: the split's axis is held, with why, and the lead says so; Y moves it along P.
    const rowOf = page.locator(`[data-opening="${vent.id}"]`);
    await expect(rowOf.locator('input[data-axis="x"]')).toHaveAttribute('readonly', '');
    await expect(rowOf.locator('input[data-axis="x"]')).toHaveAttribute('title', 'On the seam: it moves along Y only.');
    await expect(page.locator('.drag-lead')).toContainText('On the Two-part cover the openings sit on the seam and move along it only.');
    const y = rowOf.locator('input[data-axis="y"]');
    await y.fill((after.y - 1).toFixed(2));
    await y.press('Enter');
    await idle(page);
    const typed = await hooks(page, (h, id) => h.openings().find((o) => o.id === id)!, vent.id);
    expect(typed.x).toBeCloseTo(xs, 6);
    expect(typed.y).not.toBeCloseTo(after.y, 1);
  });

  test('the Seam fasteners row with its three values; with Bolts the shared rows under Seam bolts, with their lines inline; with Clips the Clips rows; the corner bolts held off', async ({ page }) => {
    await twoPart(page);
    const fasteners = row(page, 'clamshell.fastener');
    for (const name of ['Bolts', 'Clips', 'None']) await expect(fasteners.getByRole('button', { name })).toBeVisible();
    await expect(page.getByTestId('two-part-group')).toHaveText('Two-part cover');
    await expect(page.getByTestId('seam-bolts-group')).toHaveText('Seam bolts');
    for (const path of ['bolts.size', 'bolts.length', 'bolts.holeClearance', 'bolts.nutClearance', 'bolts.minWall']) await expect(row(page, path)).toHaveCount(1);
    // fit_test/README.txt names them "under Two-part cover, Seam bolts", as they are drawn: each row below the block's heading.
    const order = await page.evaluate(() => {
      const at = (selector: string): number => [...document.querySelectorAll('.sidebar *')].indexOf(document.querySelector(selector)!);
      return { block: at('[data-testid="two-part-group"]'), bolts: at('[data-testid="seam-bolts-group"]'), nut: at('[data-param="bolts.nutClearance"]'), hole: at('[data-param="bolts.holeClearance"]') };
    });
    expect(order.block).toBeLessThan(order.bolts);
    expect(order.bolts).toBeLessThan(order.hole);
    expect(order.bolts).toBeLessThan(order.nut);
    await expect(row(page, 'bolts.length').locator('option[value="auto"]')).toHaveText('Auto, 10 mm');
    // The corner bolts' toggle, held off with its reason, as the only row left under Bolts.
    await expect(row(page, 'bolts.enabled')).toContainText('The halves print on their backs, so corner bolts would lie sideways');
    // A 6 mm screw is short of the head's plate: seam-bolt-short under Bolt length, the row it names drawn.
    await hooks(page, (h) => h.setParam('bolts.length', 6));
    await idle(page);
    await expect(row(page, 'bolts.length').locator('[data-code="seam-bolt-short"]')).toBeVisible();
    expect(await hooks(page, (h) => h.diagnostics().map((d) => d.code))).toContain('seam-bolt-short');
    await hooks(page, (h) => h.setParam('bolts.length', null));
    // An M4 nut slot at a nut clearance of 1.6 bridges 10.2 mm, past the 10 mm limit: bolt-bridge under Nut clearance.
    await hooks(page, (h) => {
      h.setParam('bolts.size', 'M4');
      h.setParam('bolts.nutClearance', 1.6);
    });
    await idle(page);
    expect(await hooks(page, (h) => h.diagnostics().map((d) => d.code))).toContain('bolt-bridge');
    await expect(row(page, 'bolts.nutClearance').locator('[data-code="bolt-bridge"]')).toBeVisible();
    await hooks(page, (h) => {
      h.setParam('bolts.size', 'M3');
      h.setParam('bolts.nutClearance', 0.15);
    });
    // With Clips the bolt rows go and the clips' come, under Seam clips.
    await fasteners.getByRole('button', { name: 'Clips' }).click();
    await idle(page);
    await expect(page.getByTestId('seam-bolts-group')).toHaveCount(0);
    await expect(row(page, 'bolts.size')).toHaveCount(0);
    await expect(page.getByTestId('clips-group')).toHaveText('Seam clips');
    await expect(row(page, 'clips.clearance')).toHaveCount(1);
    await expect(row(page, 'clips.rows')).toHaveCount(1);
    await expect(page.getByTestId('seam-hold')).toContainText(/^Held by \d+ printed clips, \d+ on each end: about \d+ N together \(40 N each, an estimate for printed plastic\), against the \d+ N the seam needs\.$/);
  });

  for (const fastener of ['bolts', 'clips'] as const) {
    test(`the export ZIP and the fit-test ZIP with ${fastener} hold Node's bytes`, async ({ page }) => {
      test.setTimeout(600_000);
      await twoPart(page, { 'clamshell.fastener': fastener });
      const node = inNode(SPHERE, 'sphere.stl', (p) => (p.clamshell.fastener = fastener), async (p) => ({ ...(await p.exportParts()).files, ...(await p.exportParts(() => {}, undefined, { want: 'fit-test', fitTest: false })).files }));
      const zip = await downloaded(page, 'export-zip');
      const fit = await downloaded(page, 'export-fit-test');
      const ours = await node;
      const stls = Object.keys(zip).filter((name) => name.endsWith('.stl')).sort();
      expect(stls).toEqual(fastener === 'clips' ? ['base.stl', 'clips.stl', 'cover_left.stl', 'cover_right.stl', 'funnel.stl', 'model_oriented.stl'] : ['base.stl', 'cover_left.stl', 'cover_right.stl', 'funnel.stl', 'model_oriented.stl']);
      for (const name of stls) expect(meshHash(zip[name]), name).toBe(meshHash(ours[name]));
      const coupons = Object.keys(fit).filter((name) => name.includes('_coupon')).sort();
      expect(coupons).toEqual(fastener === 'clips' ? ['fit_test/clip_coupon_block.stl', 'fit_test/clip_coupon_keys.stl'] : ['fit_test/seam_bolt_coupon_neg.stl', 'fit_test/seam_bolt_coupon_pos.stl']);
      for (const name of coupons) expect(meshHash(fit[name]), name).toBe(meshHash(ours[name]));
      const report = JSON.parse(new TextDecoder().decode(zip['report.json']));
      expect(report.moldType).toBe('clamshell');
      expect(report[fastener === 'bolts' ? 'seamBolts' : 'clips']).not.toBeNull();
    });
  }

  test('a section through a lug cuts both halves and fills the cover\'s cut', async ({ page }) => {
    await twoPart(page);
    const z = await app(page, (a) => a.store.pipeline.field!.value.clam!.bolts!.zs[0]);
    await app(page, (a, at) => a.store.setSection({ on: true, axis: 'z', at: at as number }), z);
    await expect.poll(() => app(page, (a) => a.scene.capParts())).toContain('cover');
    // The cover's cut is counted from both halves, each cut through its lug at that height.
    expect(await app(page, (a) => a.scene.capSources('cover'))).toBe(2);
    const spans = await app(page, (a) => a.store.pipeline.cover!.value.halves!.map((h) => {
      let lo = Infinity, hi = -Infinity;
      for (let i = 2; i < h.positions.length; i += 3) {
        lo = Math.min(lo, h.positions[i]);
        hi = Math.max(hi, h.positions[i]);
      }
      return [lo, hi];
    }));
    expect(spans).toHaveLength(2);
    for (const [lo, hi] of spans) {
      expect(lo).toBeLessThan(z);
      expect(hi).toBeGreaterThan(z);
    }
    // The silicone's cut is left unfilled on this type, which the Section tool says.
    await expect(page.getByTestId('section-two-part-note')).toBeVisible();
  });

  test('budgets on Goddess and VIS-35 (G13.16): preview and export within the one-piece cover\'s times by the spike\'s ratio plus 20%', async ({ page, browserName }) => {
    test.skip(!canDraw(page), NO_FIREFOX_WEBGL);
    test.skip(browserName !== 'chromium' && process.env.CFG_BUDGETS !== '1', 'The budgets run in Chromium here, and in Firefox with CFG_BUDGETS=1 where it has a display');
    test.setTimeout(1_800_000);
    // The spike's ratio of the two-part cover's time to the one-piece's (G13.16, MP2: 13.3 s against 2.5 s on VIS-35 x),
    // plus 20%, holds the export; the preview gets the same.
    const RATIO = (13.3 / 2.5) * 1.2;
    for (const id of ['goddess', 'vis35'] as const) {
      if (!hasExample(id)) continue;
      await openApp(page);
      await hooks(page, (h, name) => h.load(name as string), EXAMPLE_FILES[id]);
      const t0 = Date.now();
      await idle(page);
      const onePreview = Date.now() - t0;
      const one = await hooks(page, (h) => h.exportParts());
      const t1 = Date.now();
      await tile(page, 'clamshell').click();
      await idle(page);
      const twoPreview = Date.now() - t1;
      const two = await hooks(page, (h) => h.exportParts());
      expect(two.report!.moldType, id).toBe('clamshell');
      expect(twoPreview, `${id} preview, against ${onePreview} ms`).toBeLessThanOrEqual(Math.max(onePreview, 2000) * RATIO);
      expect(two.ms, `${id} export, against ${one.ms} ms`).toBeLessThanOrEqual(one.ms * RATIO);
    }
  });

  test('review shots of the halves, exploded, a section through a lug and the card, in both themes', async ({ page, browserName }) => {
    test.skip(!SHOTS, 'CFG_SHOTS=1 takes the review shots');
    mkdirSync(SHOTS_DIR, { recursive: true });
    await twoPart(page);
    for (const theme of ['dark', 'light']) {
      if ((await page.evaluate(() => document.documentElement.dataset.theme ?? 'dark')) !== theme) await page.getByTestId('theme').click();
      await page.screenshot({ path: join(SHOTS_DIR, `mp-halves-${browserName}-${theme}.png`) });
      await app(page, (a) => a.store.setExplode({ on: true, distance: 15 }));
      await page.screenshot({ path: join(SHOTS_DIR, `mp-exploded-${browserName}-${theme}.png`) });
      await app(page, (a) => a.store.setExplode({ on: false }));
      const z = await app(page, (a) => a.store.pipeline.field!.value.clam!.bolts!.zs[0]);
      await app(page, (a, at) => a.store.setSection({ on: true, axis: 'z', at: at as number }), z);
      await page.screenshot({ path: join(SHOTS_DIR, `mp-section-lug-${browserName}-${theme}.png`) });
      await app(page, (a) => a.store.setSection({ on: false }));
      await page.screenshot({ path: join(SHOTS_DIR, `mp-card-${browserName}-${theme}.png`), clip: (await page.locator('.mold-type').boundingBox())! });
    }
  });
});
