import { expect, test, type Page } from '@playwright/test';
import type { OpeningPin } from '../src/core/analysis/placement';
import { asciiStl, box, engravedBlock, join as joinMeshes, toSoup, withoutTriangles } from '../test/fixtures/synthetic';
import { EXAMPLE_FILES, loadManifold } from '../test/fixtures/loadExamples';
import { benchyLetterSpots } from './spots';
import { fixed } from '../src/ui/format';
import { app, canDraw, canvasPatch, canvasPixels, checkLayout, dropAndWait, dropExample, hooks, idle, openApp, type PageWatch } from './appHarness';
import { NO_FIREFOX_WEBGL } from './firefox';
import { nodeHash } from './nodeRuns';

const FULL = process.env.CFG_FULL === '1';

type Point = [number, number, number];
type Rgb = [number, number, number];

/** The plan's part colours, which the caps are drawn in, and the share of light a hatch line keeps. */
const CAP_COLOURS: Record<string, number> = { model: 0xb9b4a7, silicone: 0x2dd4bf, cover: 0xc7ccd3, base: 0x6b7280 };
const HATCH_SHADE = 0.62;

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** A cap's colour as drawn, and on a hatch line, which darkens it in linear light. */
function capShades(hex: number): Rgb[] {
  const rgb: Rgb = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
  return [rgb, rgb.map((c) => Math.round(toSrgb(toLinear(c / 255) * HATCH_SHADE) * 255)) as Rgb];
}

/**
 * Which cap a patch of the canvas is, by the nearest part colour, lit or on a hatch line, among pixels
 * within 24 of one. The plastic greys differ in hue only a little (the model is warm, the cover cool),
 * but caps are drawn unlit, so their pixels are those colours exactly.
 */
function capOf(pixels: number[]): { part: string | null; share: number } {
  const votes = new Map<string, number>();
  for (let i = 0; i < pixels.length; i += 3) {
    let best: string | null = null, nearest = 24;
    for (const [part, hex] of Object.entries(CAP_COLOURS)) {
      for (const shade of capShades(hex)) {
        const d = Math.hypot(pixels[i] - shade[0], pixels[i + 1] - shade[1], pixels[i + 2] - shade[2]);
        if (d < nearest) {
          nearest = d;
          best = part;
        }
      }
    }
    if (best) votes.set(best, (votes.get(best) ?? 0) + 1);
  }
  const [part, count] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  return { part, share: count / (pixels.length / 3) };
}

async function capAt(page: Page, at: Point): Promise<{ part: string | null; share: number }> {
  const screen = await hooks(page, (h, p: Point) => h.worldToScreen(p), at);
  expect(screen.visible).toBe(true);
  return capOf(await canvasPatch(page, screen, 3));
}

const jobs = (page: Page): Promise<number> => hooks(page, (h) => h.jobLog().length);

/** An opening ring's place on the page: copy `tile` of the opening, on the cover's flat top as the view has it now. */
async function ringOnScreen(page: Page, id: string, tile: number): Promise<{ x: number; y: number }> {
  return app(page, (a, arg: { id: string; tile: number }) => {
    const p = a.store.pipeline;
    const placement = p.placement!.value;
    const opening = placement.placement.openings.find((o) => o.id === arg.id)!;
    const [ox, oy] = placement.space.offsets[arg.tile];
    const lift = a.scene.explodeOffsets().cover;
    return (window as unknown as { __pipeline: { worldToScreen: (p: number[]) => { x: number; y: number } } }).__pipeline.worldToScreen([opening.x + ox, opening.y + oy, p.field!.value.rim.Zt + lift]);
  }, { id, tile });
}

/** The page point of a spot on the flat top, for a pointer move. */
const topOnScreen = (page: Page, x: number, y: number): Promise<{ x: number; y: number }> =>
  app(page, (a, at: number[]) => (window as unknown as { __pipeline: { worldToScreen: (p: number[]) => { x: number; y: number } } }).__pipeline.worldToScreen([at[0], at[1], a.store.pipeline.field!.value.rim.Zt + a.scene.explodeOffsets().cover]), [x, y]);

/** The dev server serves the same UI code as the build; these run on the build only, to keep scripts/ci.sh within its time. */
const DEV_SKIP = 'the build is what the user gets, and the dev server serves the same UI code';

test.describe('section, explode, opening drag and undo on index.html', () => {
  let watch: PageWatch;
  test.beforeEach(async ({ page }, info) => {
    test.skip(info.project.name === 'dev', DEV_SKIP);
    test.skip(!canDraw(page), NO_FIREFOX_WEBGL);
    watch = await openApp(page);
  });
  test.afterEach(({}, info) => {
    // A test that beforeEach skipped, as Firefox without a display does, never opened the app.
    if (info.status === 'skipped') return;
    expect(watch.errors).toEqual([]);
    expect(watch.foreign).toEqual([]);
  });

  test('@smoke section: snaps and Flip redraw, caps read by colour at a known cut, explode starts no job and keeps markers, and an open mesh gets no cap', async ({ page }) => {
    await dropAndWait(page, EXAMPLE_FILES.jersey);
    const card = page.getByTestId('software-renderer');
    if ((await card.count()) > 0) await card.getByRole('button', { name: 'Dismiss' }).click();
    const before = await jobs(page);

    // Snaps and Flip each redraw the view.
    let previous = await canvasPixels(page);
    const redraws = async (act: () => Promise<void>): Promise<void> => {
      await act();
      await expect.poll(async () => (await canvasPixels(page)).equals(previous)).toBe(false);
      previous = await canvasPixels(page);
    };
    await redraws(() => page.getByTestId('section').check());
    await expect(page.getByTestId('section-tools')).toBeVisible();
    for (const axis of ['y', 'z', 'x']) await redraws(() => page.locator(`[data-cut="${axis}"]`).click());
    await redraws(() => page.getByTestId('section-flip').click());
    await redraws(() => page.getByTestId('section-flip').click());
    expect(await app(page, (a) => a.scene.capParts())).toEqual(['silicone', 'model', 'base', 'cover']);

    // A known cut: across X through the middle, looked at square on from +x, the side the cut faces.
    const known = await app(page, (a) => {
      const p = a.store.pipeline;
      const rim = p.field!.value.rim, bounds = p.oriented!.value.bounds, field = p.field!.value.field;
      const x = (rim.O.x0 + rim.O.x1) / 2, yc = (bounds.min[1] + bounds.max[1]) / 2;
      const node = (y: number): number => field.values[Math.round((y - field.y0) / field.cell) * field.nx + Math.round((x - field.x0) / field.cell)];
      return { x, yc, top: bounds.max[2], height: bounds.max[2] - bounds.min[2], ceiling: node(yc), Zt: rim.Zt, Tb: rim.Tb, y0: rim.O.y0, y1: rim.O.y1 };
    });
    const centre: Point = [known.x, (known.y0 + known.y1) / 2, (known.Zt - known.Tb) / 2];
    await hooks(page, (h, c: Point) => h.setCamera({ position: [c[0] + 160, c[1], c[2]], target: c, fov: 35 }), centre);
    // Through the model's middle; in the silicone over its top, under the ceiling; the cover's side wall, past the
    // cavity; and the base under it, away from the pocket.
    const samples: Record<string, Point> = {
      model: [known.x, known.yc, 0.4 * known.height],
      silicone: [known.x, known.yc, (known.top + known.ceiling) / 2],
      cover: [known.x, known.y0 + 1.5, known.Zt / 2],
      base: [known.x, known.yc + 5, -known.Tb / 2],
    };
    expect(known.ceiling - known.top).toBeGreaterThan(3);
    for (const [part, at] of Object.entries(samples)) {
      const seen = await capAt(page, at);
      expect(seen.part, `${part} at ${at.map((v) => v.toFixed(1))}`).toBe(part);
      expect(seen.share, part).toBeGreaterThan(0.6);
    }
    // With the section off, the same spots show the parts' own surfaces, and not the caps.
    await page.getByTestId('section').uncheck();
    expect((await capAt(page, samples.model)).share).toBeLessThan(0.3);
    await page.getByTestId('section').check();

    // A pick in pick mode goes through the half the cut took away, to the model on the side kept.
    const picked = await app(page, (a, at: Point) => {
      const screen = (window as unknown as { __pipeline: { worldToScreen: (p: number[]) => { x: number; y: number } } }).__pipeline.worldToScreen(at);
      const triangle = a.scene.pickAt(screen.x, screen.y);
      const mesh = a.store.pipeline.modelMesh()!, t = a.store.pipeline.oriented!.value.oriented.transform;
      const [r0, r1, r2] = t.rotation;
      // Mold x of the triangle's corners: the first row of the rigid transform.
      return triangle === null ? null : [0, 1, 2].map((c) => {
        const v = mesh.indices[triangle * 3 + c] * 3;
        return r0 * mesh.positions[v] + r1 * mesh.positions[v + 1] + r2 * mesh.positions[v + 2] + t.translation[0];
      });
    }, samples.model);
    expect(picked).not.toBeNull();
    for (const x of picked!) expect(x).toBeLessThanOrEqual(known.x + 1e-3);
    // A shown funnel is a closed part too, and gets its cap.
    await page.locator('[data-part="funnel"] .eye').click();
    await expect.poll(() => app(page, (a) => a.scene.capParts())).toEqual(['silicone', 'model', 'base', 'cover', 'funnel']);
    await page.locator('[data-part="funnel"] .eye').click();

    // The handle drags the plane along its axis, seen from an angle, as along the line of sight it cannot.
    await hooks(page, (h, c: Point) => h.setCamera({ position: [c[0] + 110, c[1] - 90, c[2] + 70], target: c, fov: 35 }), centre);
    const handle = await app(page, (a) => (window as unknown as { __pipeline: { worldToScreen: (p: number[]) => { x: number; y: number } } }).__pipeline.worldToScreen(a.scene.sectionHandle.group.position.toArray()));
    const at = (): Promise<number | null> => app(page, (a) => a.store.section.value.at);
    expect(await at()).toBeNull();
    const hot = (): Promise<boolean> => app(page, (a) => a.scene.sectionHandle.isHot);
    await page.mouse.move(handle.x - 200, handle.y - 150);
    await expect.poll(hot).toBe(false);
    // Yellow as soon as the pointer is over it, before any press.
    await page.mouse.move(handle.x, handle.y, { steps: 4 });
    await expect.poll(hot).toBe(true);
    await page.mouse.down();
    await page.mouse.move(handle.x + 60, handle.y + 20, { steps: 5 });
    await page.mouse.up();
    const moved = await at();
    expect(moved).not.toBeNull();
    expect(Math.abs(moved! - known.x)).toBeGreaterThan(2);
    await page.locator('[data-cut="x"]').click();
    expect(await at()).toBeNull();
    await hooks(page, (h, c: Point) => h.setCamera({ position: [c[0] + 160, c[1], c[2]], target: c, fov: 35 }), centre);

    // Explode: the cover and funnels up, the base down, by distance only. The caps follow the parts
    // they belong to, the rings stay on the cover's top, and a ring is still where a press finds it.
    await redraws(() => page.getByTestId('explode').check());
    await expect(page.getByTestId('explode-tools')).toBeVisible();
    // It starts at a quarter of the box's height.
    const quarter = Math.round((known.Zt + known.Tb) / 4);
    expect((await app(page, (a) => a.scene.explodeOffsets())).cover).toBe(quarter);
    await expect(page.getByTestId('explode-tools')).toContainText(`${quarter.toFixed(1)} mm`);
    await redraws(async () => {
      const slider = page.getByTestId('explode-distance');
      await slider.evaluate((el) => {
        (el as HTMLInputElement).value = '12';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    });
    expect(await app(page, (a) => a.scene.explodeOffsets())).toEqual({ cover: 12, base: -12, funnel: 24 });
    expect((await capAt(page, samples.model)).part).toBe('model');
    expect((await capAt(page, [samples.cover[0], samples.cover[1], samples.cover[2] + 12])).part).toBe('cover');
    expect((await capAt(page, [samples.base[0], samples.base[1], samples.base[2] - 12])).part).toBe('base');
    const all = await hooks(page, (h) => h.openings());
    const pour = all.find((o) => o.kind === 'pour')!;
    // The plane a little past the pour, so the ring is on the side kept, and from above the front.
    await app(page, (a, x: number) => a.store.setSection({ at: x + 5 }), pour.x);
    await hooks(page, (h, c: Point) => h.setCamera({ position: [c[0] + 30, c[1] - 90, c[2] + 120], target: c, fov: 35 }), centre);
    const ring = await ringOnScreen(page, pour.id, 0);
    expect(await app(page, (a, at: { x: number; y: number }) => a.scene.markerAt(at.x, at.y), ring)).toBe(all.indexOf(pour));
    // Section and explode are the view's alone: no job ran for any of it.
    expect(await jobs(page)).toBe(before);
    expect(await hooks(page, (h) => h.status().stale)).toBe(false);

    // The layout holds with both sets of controls showing.
    for (const size of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
      await page.setViewportSize(size);
      await checkLayout(page, watch);
    }
    await page.setViewportSize({ width: 1366, height: 768 });

    // A mesh with a hole goes to soup mode: the model, and the silicone round it, have no closed surface
    // to fill, so they get no cap, and the section says why. The cover and base still do.
    const open = asciiStl(toSoup(withoutTriangles(box([0, 0, 0], [30, 20, 12]), [8])), 'open box');
    await dropExample(page, 'open-box.stl', { text: new TextDecoder().decode(open) });
    await expect.poll(() => app(page, (a) => a.store.pipeline.modelName)).toBe('open-box.stl');
    await idle(page);
    expect(await app(page, (a) => a.store.pipeline.modelClosed())).toBe(false);
    await expect(page.getByTestId('section-open-note')).toContainText('has holes');
    await expect.poll(() => app(page, (a) => a.scene.capParts())).toEqual(['base', 'cover']);
    // Explode is still on, and the 12 mm set on jersey gave way to a quarter of this box.
    const openRim = await app(page, (a) => a.store.pipeline.field!.value.rim);
    expect((await app(page, (a) => a.scene.explodeOffsets())).cover).toBe(Math.round((openRim.Zt + openRim.Tb) / 4));
  });

  test('@smoke section caps: every tile, a hole for the hidden model, the barrel\'s sealed hollow, air the plate seals, the side kept, a box standing in for the cover, and Mode B exploded', async ({ page }) => {
    await hooks(page, (h) => h.setParam('grid.nx', 2));
    await dropAndWait(page, EXAMPLE_FILES.jersey);
    const card = page.getByTestId('software-renderer');
    if ((await card.count()) > 0) await card.getByRole('button', { name: 'Dismiss' }).click();
    await page.getByTestId('section').check();

    // Across X through the second tile's model, looked at square on from +x, the side the cut faces.
    const tile = await app(page, (a) => {
      const p = a.store.pipeline;
      const rim = p.field!.value.rim, bounds = p.oriented!.value.bounds, field = p.field!.value.field;
      const [ox] = p.field!.value.mold.offsets[1];
      const x = (bounds.min[0] + bounds.max[0]) / 2 + ox, yc = (bounds.min[1] + bounds.max[1]) / 2;
      const ceiling = field.values[Math.round((yc - field.y0) / field.cell) * field.nx + Math.round((x - field.x0) / field.cell)];
      return { x, yc, top: bounds.max[2], height: bounds.max[2] - bounds.min[2], ceiling, Zt: rim.Zt, Tb: rim.Tb, O: rim.O };
    });
    await app(page, (a, x: number) => a.store.setSection({ axis: 'x', at: x }), tile.x);
    const centre: Point = [tile.x, (tile.O.y0 + tile.O.y1) / 2, (tile.Zt - tile.Tb) / 2];
    const front = (): Promise<void> => hooks(page, (h, c: Point) => h.setCamera({ position: [c[0] + 160, c[1], c[2]], target: c, fov: 35 }), centre);
    await front();
    const model: Point = [tile.x, tile.yc, 0.4 * tile.height];
    const silicone: Point = [tile.x, tile.yc, (tile.top + tile.ceiling) / 2];
    const cover: Point = [tile.x, tile.O.y0 + 1.5, tile.Zt / 2];
    // The model is drawn at the second tile as well, and the silicone round it is cut there.
    for (const [part, at] of [['model', model], ['silicone', silicone], ['cover', cover]] as const) {
      const seen = await capAt(page, at);
      expect(seen.part, part).toBe(part);
      expect(seen.share, part).toBeGreaterThan(0.6);
    }

    // With the model hidden, its place is a hole in the silicone: neither cap is drawn there.
    await app(page, (a) => a.store.setLayer('model', { visible: false }));
    await expect.poll(async () => (await capAt(page, model)).part).not.toBe('model');
    expect((await capAt(page, model)).part).not.toBe('silicone');
    expect((await capAt(page, silicone)).part).toBe('silicone');
    await app(page, (a) => a.store.setLayer('model', { visible: true }));

    // While a box stands in for the cover, as while t is dragged, its cut is the box less the cavity:
    // it covers neither the silicone nor the model.
    await app(page, (a) => {
      const rim = a.store.pipeline.field!.value.rim;
      a.scene.setPart('cover', null);
      a.scene.setProxy('cover', { min: [rim.O.x0, rim.O.y0, -rim.Tb + 0.2], max: [rim.O.x1, rim.O.y1, rim.Zt] });
    });
    for (const [part, at] of [['model', model], ['silicone', silicone], ['cover', cover]] as const) {
      await expect.poll(async () => (await capAt(page, at)).part, { message: part }).toBe(part);
    }
    // Nor does it fill the cavity where the silicone is hidden: the box's count leaves the field's solid out.
    await app(page, (a) => a.store.setLayer('silicone', { visible: false }));
    await expect.poll(async () => (await capAt(page, silicone)).part).not.toBe('silicone');
    expect((await capAt(page, silicone)).part).not.toBe('cover');
    await app(page, (a) => a.store.setLayer('silicone', { visible: true }));
    // Exploded, the box's cavity goes up with it: just over the ceiling, inside the raised cavity, is no cover.
    await app(page, (a) => a.store.setExplode({ on: true, distance: 6 }));
    await expect.poll(async () => (await capAt(page, [cover[0], cover[1], cover[2] + 6])).part).toBe('cover');
    expect((await capAt(page, [tile.x, tile.yc, tile.ceiling + 3])).part).not.toBe('cover');
    await app(page, (a) => a.store.setExplode({ on: false, distance: null }));
    await app(page, (a) => {
      a.scene.setProxy('cover', null);
      a.scene.setPart('cover', a.store.pipeline.cover!.value);
    });

    // Flipped, the camera is on the side kept, where every count reads negated. With the cover hidden
    // and the silicone nearly clear, the silicone's cap is what shows through at its spot.
    await page.getByTestId('section-flip').click();
    await app(page, (a) => {
      a.store.setLayer('cover', { visible: false });
      a.store.setLayer('silicone', { opacity: 0.01 });
    });
    // Level with the spot, so the ray to it passes over the model's half in front of the plane.
    await hooks(page, (h, c: Point) => h.setCamera({ position: [c[0] + 160, c[1], c[2]], target: c, fov: 35 }), silicone);
    await expect.poll(async () => (await capAt(page, silicone)).part).toBe('silicone');
    expect((await capAt(page, silicone)).share).toBeGreaterThan(0.6);
    await page.getByTestId('section-flip').click();
    await app(page, (a) => {
      a.store.setLayer('cover', { visible: true });
      a.store.setLayer('silicone', { opacity: 0.5 });
    });
    await front();

    // Merged (B): the base carries the model, so exploded the model goes down with it, and the drawn one hides.
    const modelShown = (): Promise<boolean | undefined> => app(page, (a) => a.scene.partStyles().model?.visible);
    await page.getByTestId('explode').check();
    expect(await modelShown()).toBe(true);
    await hooks(page, (h) => h.setParam('base.mode', 'merged'));
    await idle(page);
    expect(await modelShown()).toBe(false);
    // The caps are set as a frame is drawn, which comes after the change.
    await expect.poll(() => app(page, (a) => a.scene.capParts())).not.toContain('model');
    await page.getByTestId('explode').uncheck();
    expect(await modelShown()).toBe(true);
    await hooks(page, (h) => h.setParam('base.mode', 'glue'));
    await idle(page);

    // The barrel's sealed hollow, 16 x 23 mm inside a wall of model: no silicone reaches it.
    await dropAndWait(page, EXAMPLE_FILES.barrel);
    const hollow = await app(page, (a) => {
      const domain = a.store.pipeline.reports!.value.air.sealed.find((d) => d.inModel)!;
      return domain.min.map((v, k) => (v + domain.max[k]) / 2) as Point;
    });
    await app(page, (a, x: number) => a.store.setSection({ axis: 'x', at: x }), hollow[0]);
    await hooks(page, (h, c: Point) => h.setCamera({ position: [c[0] + 120, c[1], c[2]], target: c, fov: 35 }), hollow);
    await expect.poll(() => app(page, (a) => a.scene.capParts())).toContain('silicone');
    const inside = await capAt(page, hollow);
    expect(inside.part === 'silicone' ? inside.share : 0, `hollow read ${inside.part} at ${inside.share}`).toBeLessThan(0.1);
    // The model's wall round it is cut as model, and the silicone outside it as silicone.
    const ring = await app(page, (a) => {
      const b = a.store.pipeline.oriented!.value.bounds, field = a.store.pipeline.field!.value.field;
      const x = (b.min[0] + b.max[0]) / 2, y = (b.min[1] + b.max[1]) / 2;
      const ceiling = field.values[Math.round((y - field.y0) / field.cell) * field.nx + Math.round((x - field.x0) / field.cell)];
      return { top: b.max[2], ceiling, y };
    });
    expect((await capAt(page, [hollow[0], ring.y, (ring.top + ring.ceiling) / 2])).part).toBe('silicone');

    // Air the plate seals under the model is no silicone either. A ring engraved 0.5 mm into a block's
    // underside round an island, as the inside of a letter under Benchy's hull, shows no silicone cap;
    // with a channel out to the side, silicone reaches the ring, and it does. With CFG_FULL, beside
    // Benchy's own lettering below: the quick suite holds plateSealedAir to its winding in Node.
    if (!FULL) return;
    const api = await loadManifold();
    // Both blocks in one model, 10 mm apart, the open one at +x, so one load and one base face serve both.
    const open = engravedBlock(api, true);
    const pair = joinMeshes(engravedBlock(api, false), { positions: open.positions.map((v, k) => (k % 3 === 0 ? v + 40 : v)), indices: open.indices });
    await dropExample(page, 'engraved.stl', { text: new TextDecoder().decode(asciiStl(toSoup(pair), 'engraved')) });
    await expect.poll(() => app(page, (a) => a.store.pipeline.modelName)).toBe('engraved.stl');
    await idle(page);
    // Their tops are the larger face, so the engraved undersides are chosen as the base, as a maker would.
    await app(page, (a) => a.store.setPlane({ rank: a.store.pipeline.oriented!.value.candidates.findIndex((c) => c.normal[2] < -0.99), upper: false }));
    await idle(page);
    const min = await app(page, (a) => a.store.pipeline.oriented!.value.bounds.min);
    // Close up, square on to the cut, as the recess is 0.5 mm tall.
    const closeCap = async (at: Point): Promise<{ part: string | null; share: number }> => {
      await hooks(page, (h, c: Point) => h.setCamera({ position: [c[0] + 12, c[1], c[2] + 1], target: c, fov: 35 }), at);
      return capAt(page, at);
    };
    for (const channel of [false, true]) {
      // In the ring's band beside the island, half way up its 0.5 mm.
      const air: Point = [min[0] + 11.5 + (channel ? 40 : 0), min[1] + 10, 0.25];
      await app(page, (a, x: number) => a.store.setSection({ axis: 'x', at: x }), air[0]);
      const seen = await closeCap(air);
      // One recess sealed, the one without the channel.
      await expect.poll(() => app(page, (a) => a.scene.sealedRecesses())).toBe(1);
      if (channel) {
        expect(seen.part, 'the open ring').toBe('silicone');
        expect(seen.share).toBeGreaterThan(0.6);
      } else {
        expect(seen.part === 'silicone' ? seen.share : 0, `the sealed ring read ${seen.part} at ${seen.share}`).toBeLessThan(0.1);
      }
      // The block over the ring is model either way, and the silicone beside the block silicone.
      expect((await closeCap([air[0], air[1], 1.5])).part, `block over the ring, channel ${channel}`).toBe('model');
      expect((await closeCap([air[0], min[1] - 1.5, 0.25])).part, `beside the block, channel ${channel}`).toBe('silicone');
    }
  });

  test('@smoke opening drag in 3D on a 2 x 1 grid: valid and invalid by the hard rules, T2b lands, every copy moves, the drop snaps and pins, the pin keeps through t, and Esc puts it back', async ({ page }) => {
    await hooks(page, (h) => h.setParam('grid.nx', 2));
    await dropAndWait(page, EXAMPLE_FILES.jersey);
    await page.getByTestId('top-view').click();
    const camera = (): Promise<number[]> => app(page, (a) => a.scene.camera.position.toArray());
    const view = await camera();
    const openings = await hooks(page, (h) => h.openings());
    const pour = openings.find((o) => o.kind === 'pour')!, vent = openings.find((o) => o.kind === 'vent')!;
    // Rings are listed opening by opening, a copy per tile.
    const first = openings.indexOf(pour) * 2;
    const tiles = await app(page, (a) => a.store.pipeline.placement!.value.space.offsets);
    expect(tiles.length).toBe(2);
    const frames = (): Promise<unknown> => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    // Grab the pour's copy on the second tile and move it away from the vent: the first tile's opening
    // moves by as much, and so does every copy.
    const grab = await ringOnScreen(page, pour.id, 1);
    const away = Math.sign(pour.x - vent.x) || 1;
    const target = await topOnScreen(page, pour.x + tiles[1][0] + 2 * away, pour.y + tiles[1][1]);
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await expect.poll(() => app(page, (a) => a.store.drag.value?.check.valid)).toBe(true);
    await frames();
    const moving = (await app(page, (a) => a.store.drag.value))!;
    expect(moving.id).toBe(pour.id);
    expect(moving.x).toBeCloseTo(pour.x + 2 * away, 0);
    // T2b: the cover cut for this spot arrives, provisional, and the badge clears once it has.
    await expect.poll(() => hooks(page, (h) => h.shownCover()?.provisional === true && !h.status().stale), { timeout: 30_000 }).toBe(true);
    const rings = await app(page, (a) => a.scene.markerPositions());
    expect(rings[first].x).toBeCloseTo(moving.x, 6);
    expect(rings[first + 1].x - rings[first].x).toBeCloseTo(tiles[1][0], 6);
    await expect(page.locator(`[data-opening="${pour.id}"] input[data-axis="x"]`)).toHaveValue(moving.x.toFixed(2));
    await expect(page.getByTestId('drag-tip')).toContainText('Let go to pin it here');

    // Onto the vent: invalid, with the reason, in the invalid colour on both copies.
    const onVent = await ringOnScreen(page, vent.id, 1);
    await page.mouse.move(onVent.x, onVent.y, { steps: 6 });
    await expect.poll(() => app(page, (a) => a.store.drag.value?.check.valid)).toBe(false);
    await expect(page.getByTestId('drag-reason')).toContainText('too close to another opening');
    expect((await app(page, (a) => a.scene.markerPositions())).slice(first, first + 2).map((r) => r.valid)).toEqual([false, false]);
    // Where the drop would put it: said in the tip, and a faint ring at that spot on both tiles, after the rest.
    await frames();
    const lands = (await app(page, (a) => a.store.drag.value!.check.lands))!;
    await expect(page.getByTestId('drag-reason')).toContainText(`lands at ${fixed(lands.x, 1)}, ${fixed(lands.y, 1)} mm`);
    const ghosts = (await app(page, (a) => a.scene.markerPositions())).filter((r) => r.ghost);
    expect(ghosts.map((r) => [r.x, r.y])).toEqual(tiles.map(([ox, oy]) => [lands.x + ox, lands.y + oy]));
    expect((await app(page, (a) => a.scene.markerPositions())).slice(-2).every((r) => r.ghost)).toBe(true);
    // The camera has not moved with the drag.
    expect(await camera()).toEqual(view);

    // The drop snaps to the nearest valid place and pins it there, as one step of the history, where the
    // faint ring was, and the view says so.
    await page.mouse.up();
    await idle(page);
    const last = (await app(page, (a) => a.store.lastMove.value))!;
    expect(last.result.snapped).toBe(true);
    expect(last.result.valid).toBe(true);
    expect([last.result.x, last.result.y]).toEqual([lands.x, lands.y]);
    await expect(page.getByTestId('drop-note')).toContainText('moved to the nearest valid place');
    expect((await app(page, (a) => a.scene.markerPositions())).some((r) => r.ghost)).toBe(false);
    const dropped = (await hooks(page, (h) => h.openings())).find((o) => o.id === pour.id)!;
    expect(dropped.pinned).toBe(true);
    expect([dropped.x, dropped.y]).toEqual([last.result.x, last.result.y]);
    expect(await hooks(page, (h) => h.project().pins)).toEqual([{ id: pour.id, kind: 'pour', x: dropped.x, y: dropped.y }]);
    await expect(page.locator(`[data-opening="${pour.id}"] .note`)).toContainText('nearest place');
    expect(await app(page, (a) => a.store.history.undoLabel)).toBe('moving Pour 1');
    expect(await app(page, (a) => a.store.history.depth.undo)).toBe(1);
    expect(await hooks(page, (h) => h.shownCover()!.provisional)).toBe(false);
    expect(await hooks(page, (h) => h.geometryHash())).toEqual(await hooks(page, (h) => h.freshHash()));

    // A change of t places the openings again, and the pin stays where it was dropped.
    await hooks(page, (h) => h.setParam('silicone.t', 3.5));
    await idle(page);
    const kept = (await hooks(page, (h) => h.openings())).find((o) => o.id === pour.id)!;
    expect([kept.x, kept.y, kept.pinned]).toEqual([dropped.x, dropped.y, true]);

    // A vent too: a short move along y, on its first-tile copy this time, past the 5 px a click may wander.
    const ventNow = (await hooks(page, (h) => h.openings())).find((o) => o.kind === 'vent')!;
    const ventRing = await ringOnScreen(page, ventNow.id, 0);
    const ventTo = await topOnScreen(page, ventNow.x, ventNow.y + 1.5);
    await page.mouse.move(ventRing.x, ventRing.y);
    await page.mouse.down();
    await page.mouse.move(ventTo.x, ventTo.y, { steps: 5 });
    await expect.poll(() => app(page, (a) => a.store.drag.value?.id)).toBe(ventNow.id);
    await page.mouse.up();
    await idle(page);
    const ventPinned = (await hooks(page, (h) => h.openings())).find((o) => o.id === ventNow.id)!;
    expect(ventPinned.pinned).toBe(true);
    expect(ventPinned.y).toBeCloseTo(ventNow.y + 1.5, 0);
    const rings2 = await app(page, (a) => a.scene.markerPositions());
    const ventIndex = (await hooks(page, (h) => h.openings())).findIndex((o) => o.id === ventNow.id);
    expect(rings2[ventIndex * 2 + 1].y).toBeCloseTo(ventPinned.y, 6);
    const pinsNow = await hooks(page, (h) => h.project().pins);
    expect(pinsNow.map((p) => p.id).sort()).toEqual([pour.id, ventNow.id].sort());
    const settled = await hooks(page, (h) => h.geometryHash());

    // Esc during a drag puts the opening back, records nothing, and the cover is cut for all again.
    const again = await ringOnScreen(page, pour.id, 0);
    const elsewhere = await topOnScreen(page, dropped.x + away, dropped.y);
    await page.mouse.move(again.x, again.y);
    await page.mouse.down();
    await page.mouse.move(elsewhere.x, elsewhere.y, { steps: 5 });
    await expect.poll(() => app(page, (a) => a.store.drag.value !== null)).toBe(true);
    await page.keyboard.press('Escape');
    expect(await app(page, (a) => a.store.drag.value)).toBeNull();
    await page.mouse.up();
    await idle(page);
    expect(await hooks(page, (h) => h.project().pins)).toEqual(pinsNow);
    expect(await app(page, (a) => a.store.history.depth.undo)).toBe(2);
    expect(await hooks(page, (h) => h.geometryHash())).toEqual(settled);
    expect(await camera()).toEqual(view);
  });

  test('@smoke undo and redo: 20 edits come back to the same params and geometry, slider drags group, the shortcuts work outside text boxes, and a new file clears it', async ({ page }) => {
    await dropAndWait(page, EXAMPLE_FILES.jersey);
    const start = await hooks(page, (h) => ({ project: JSON.stringify(h.project()), hash: h.geometryHash() }));
    const depth = (): Promise<{ undo: number; redo: number }> => app(page, (a) => a.store.history.depth);
    await expect(page.getByTestId('undo')).toBeDisabled();
    await expect(page.getByTestId('undo')).toHaveAttribute('title', 'Nothing to undo');

    // A slider drag is one step, however many values it passes through.
    const slider = page.locator('[data-param="silicone.t"] input[type="range"]');
    for (const value of [3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8]) {
      await slider.evaluate((el, v) => {
        (el as HTMLInputElement).value = String(v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, value);
      await page.waitForTimeout(40);
    }
    expect(await depth()).toEqual({ undo: 1, redo: 0 });
    await expect(page.getByTestId('undo')).toHaveAttribute('title', 'Undo the change to Silicone thickness (Ctrl+Z)');
    // Two changes 500 ms apart are two steps.
    const box = page.locator('[data-param="cover.wall"] input.num');
    for (const value of ['3.5', '4']) {
      await page.waitForTimeout(500);
      await box.fill(value);
      await box.press('Enter');
    }
    expect(await depth()).toEqual({ undo: 3, redo: 0 });
    // Still in the box after Enter, what it shows is the project's, so Ctrl+Z and Ctrl+Y are the app's,
    // and the box follows.
    await expect(box).toBeFocused();
    await page.keyboard.press('Control+z');
    expect(await depth()).toEqual({ undo: 2, redo: 1 });
    expect(await hooks(page, (h) => h.params().cover.wall)).toBe(3.5);
    await expect(box).toHaveValue('3.5');
    await page.keyboard.press('Control+y');
    expect(await depth()).toEqual({ undo: 3, redo: 0 });
    await expect(box).toHaveValue('4');
    // While typing, before Enter, Ctrl+Z is the browser's own undo of the text, and the project keeps its value.
    await box.pressSequentially('5');
    await page.keyboard.press('Control+z');
    expect(await depth()).toEqual({ undo: 3, redo: 0 });
    expect(await hooks(page, (h) => h.params().cover.wall)).toBe(4);
    await box.press('Escape');
    // Wheel steps on a focused box, close together, are one step too, and Ctrl+Z there takes them back.
    const cap = page.locator('[data-param="cover.topCap"] input.num');
    await cap.focus();
    await cap.hover();
    for (let k = 0; k < 3; k++) await page.mouse.wheel(0, -100);
    await expect.poll(() => hooks(page, (h) => h.params().cover.topCap)).toBeGreaterThan(5);
    expect(await depth()).toEqual({ undo: 4, redo: 0 });
    await page.keyboard.press('Control+z');
    expect(await hooks(page, (h) => h.params().cover.topCap)).toBe(5);
    await page.keyboard.press('Control+Shift+z');
    expect(await depth()).toEqual({ undo: 4, redo: 0 });
    expect(await hooks(page, (h) => h.params().cover.topCap)).toBeGreaterThan(5);

    // 16 more, each a step of its own: 20 in all.
    await app(page, (a) => {
      const s = a.store, openings = s.pipeline.placement!.value.placement.openings;
      const pour = openings.find((o) => o.kind === 'pour')!, vent = openings.find((o) => o.kind === 'vent')!;
      s.moveOpening(pour.id, pour.x + Math.sign(pour.x - vent.x || 1), pour.y);
      s.removeVent(vent.id);
      const values: [string, unknown][] = [
        ['silicone.wallDraftDeg', 2], ['base.thickness', 5], ['base.pocketDepth', 0.4], ['base.pocketEnlarge', 0.3],
        ['pour.diameter', 8], ['vents.diameter', 3], ['seat.depth', 2.5], ['funnel.topDiameter', 36], ['joint.taperDeg', 20],
        ['joint.ridgeHeight', 1.4], ['grid.nx', 2], ['base.mode', 'merged'], ['silicone.closeWidth', 1.5], ['pour.minLand', 2],
      ];
      for (const [path, value] of values) s.setParam(path as Parameters<typeof s.setParam>[0], value);
    });
    expect(await depth()).toEqual({ undo: 20, redo: 0 });
    await expect(page.getByTestId('undo')).toHaveAttribute('title', 'Undo the change to Land between openings (Ctrl+Z)');
    await idle(page);
    const end = await hooks(page, (h) => ({ project: JSON.stringify(h.project()), hash: h.geometryHash() }));
    expect(end.hash.all).not.toBe(start.hash.all);

    // Undo never touches the camera, the theme, the section or the explode slider.
    await page.getByTestId('section').check();
    await page.getByTestId('explode').check();
    await page.getByTestId('theme').click();
    await hooks(page, (h) => h.setCamera({ position: [40, -90, 70], target: [0, 0, 10], fov: 35 }));
    const look = (): Promise<unknown> => app(page, (a) => ({ camera: a.scene.camera.position.toArray(), section: a.store.section.value, explode: a.store.explode.value, theme: a.store.theme.value }));
    const looked = await look();

    // Back 20: the shortcut on a focused slider, the header button, and the shortcut on a focused
    // checkbox: on those Ctrl+Z is the app's, as they hold no text of their own.
    await slider.focus();
    for (let k = 0; k < 8; k++) await page.keyboard.press('Control+z');
    expect(await depth()).toEqual({ undo: 12, redo: 8 });
    for (let k = 0; k < 6; k++) await page.getByTestId('undo').click();
    await page.getByTestId('wireframe').focus();
    for (let k = 0; k < 6; k++) await page.keyboard.press('Control+z');
    expect(await depth()).toEqual({ undo: 0, redo: 20 });
    expect(await hooks(page, (h) => JSON.stringify(h.project()))).toBe(start.project);
    await expect(page.getByTestId('undo')).toBeDisabled();
    await expect(page.getByTestId('redo')).toHaveAttribute('title', 'Redo the change to Silicone thickness (Ctrl+Shift+Z or Ctrl+Y)');
    await idle(page);
    expect(await hooks(page, (h) => h.geometryHash())).toEqual(start.hash);
    expect(await look()).toEqual(looked);

    // And forward 20: Ctrl+Shift+Z, Ctrl+Y and the button.
    for (let k = 0; k < 7; k++) await page.keyboard.press('Control+Shift+z');
    for (let k = 0; k < 7; k++) await page.keyboard.press('Control+y');
    for (let k = 0; k < 6; k++) await page.getByTestId('redo').click();
    expect(await depth()).toEqual({ undo: 20, redo: 0 });
    expect(await hooks(page, (h) => JSON.stringify(h.project()))).toBe(end.project);
    await idle(page);
    expect(await hooks(page, (h) => h.geometryHash())).toEqual(end.hash);
    expect(await look()).toEqual(looked);
    await page.getByTestId('theme').click();

    // Esc leaves pick mode.
    await page.getByTestId('pick-face').click();
    expect(await app(page, (a) => a.store.pickMode.value)).toBe(true);
    await page.keyboard.press('Escape');
    expect(await app(page, (a) => a.store.pickMode.value)).toBe(false);

    // A new file starts a history of its own.
    await dropAndWait(page, EXAMPLE_FILES.barrel);
    expect(await depth()).toEqual({ undo: 0, redo: 0 });
    await expect(page.getByTestId('undo')).toBeDisabled();
    await expect(page.getByTestId('redo')).toBeDisabled();
  });
});

test.describe('section caps through Benchy\'s lettering', () => {
  test.skip(!FULL, 'runs with CFG_FULL=1');
  let watch: PageWatch;
  test.beforeEach(async ({ page }, info) => {
    test.skip(!canDraw(page), NO_FIREFOX_WEBGL);
    test.skip(info.project.name === 'dev', DEV_SKIP);
    watch = await openApp(page);
  });
  test.afterEach(({}, info) => {
    if (info.status === 'skipped') return;
    expect(watch.errors).toEqual([]);
    expect(watch.foreign).toEqual([]);
  });

  test('the 0.30 mm recess of a letter under the hull is air, and the silicone at the plate beside the hull is silicone', async ({ page }) => {
    await dropAndWait(page, EXAMPLE_FILES.benchy);
    const card = page.getByTestId('software-renderer');
    if ((await card.count()) > 0) await card.getByRole('button', { name: 'Dismiss' }).click();
    const { air, open } = benchyLetterSpots();
    await page.getByTestId('section').check();
    await app(page, (a, x: number) => a.store.setSection({ axis: 'x', at: x }), air[0]);
    const close = (at: Point): Promise<void> => hooks(page, (h, c: Point) => h.setCamera({ position: [c[0] + 10, c[1], c[2] + 1], target: c, fov: 35 }), at);
    await close(air);
    await expect.poll(() => app(page, (a) => a.scene.sealedRecesses())).toBe(8);
    const letter = await capAt(page, air);
    expect(letter.part === 'silicone' ? letter.share : 0, `the letter read ${letter.part} at ${letter.share}`).toBeLessThan(0.1);
    // The hull over the letter is model, and outside the hull at the same height silicone reaches the plate.
    expect((await capAt(page, [air[0], air[1], 0.9])).part).toBe('model');
    await close(open);
    const beside = await capAt(page, open);
    expect(beside.part).toBe('silicone');
    expect(beside.share).toBeGreaterThan(0.6);
  });
});

test.describe('opening drag on x8 3 x 3', () => {
  test.skip(!FULL, 'runs with CFG_FULL=1');
  let watch: PageWatch;
  test.beforeEach(async ({ page }, info) => {
    test.skip(!canDraw(page), NO_FIREFOX_WEBGL);
    test.skip(info.project.name === 'dev', DEV_SKIP);
    watch = await openApp(page);
  });
  test.afterEach(({}, info) => {
    if (info.status === 'skipped') return;
    expect(watch.errors).toEqual([]);
    expect(watch.foreign).toEqual([]);
  });

  test('a copy dragged on the middle tile moves all 9, T2b lands, and the drop equals a fresh build and Node', async ({ page }) => {
    test.setTimeout(300_000);
    await hooks(page, (h) => {
      h.setParam('grid.nx', 3);
      h.setParam('grid.ny', 3);
    });
    await dropAndWait(page, EXAMPLE_FILES.x8);
    await page.getByTestId('top-view').click();
    const openings = await hooks(page, (h) => h.openings());
    const pour = openings.find((o) => o.kind === 'pour')!;
    const index = openings.indexOf(pour);
    const grab = await ringOnScreen(page, pour.id, 4);
    // Along the barrier, by 4 mm: about 10 px from this far up, past the 5 px a click may wander.
    const [ox, oy] = await app(page, (a) => a.store.pipeline.placement!.value.space.offsets[4]);
    const to = await topOnScreen(page, pour.x + ox + 4, pour.y + oy);
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await expect.poll(() => app(page, (a) => a.store.drag.value?.id)).toBe(pour.id);
    await expect.poll(() => hooks(page, (h) => h.shownCover()?.provisional === true && !h.status().stale), { timeout: 60_000 }).toBe(true);
    const drag = (await app(page, (a) => a.store.drag.value))!;
    const { rings, offsets } = await app(page, (a) => ({ rings: a.scene.markerPositions(), offsets: a.store.pipeline.placement!.value.space.offsets }));
    offsets.forEach(([ox, oy], k) => {
      expect(rings[index * 9 + k].x).toBeCloseTo(drag.x + ox, 6);
      expect(rings[index * 9 + k].y).toBeCloseTo(drag.y + oy, 6);
    });
    await page.mouse.up();
    await idle(page);
    // T0 on main for a pointer move: the hard rules on all 9 copies, the drop's soft rules where it lands,
    // the drag's state, and the pipeline's keys for the T2b request; on a spot that is not valid, also the
    // drop's snap, which the faint ring shows. Its median must stay within a frame either way; the cuts it
    // asks for are T2b's.
    const t0 = await app(page, (a, id: string) => {
      const p = a.store.pipeline, openings = p.placement!.value.placement.openings;
      const opening = openings.find((o) => o.id === id)!;
      const other = openings.filter((o) => o.id !== id).sort((u, v) => Math.hypot(u.x - opening.x, u.y - opening.y) - Math.hypot(v.x - opening.x, v.y - opening.y))[0];
      const median = (at: (k: number) => [number, number]): { ms: number; valid: boolean } => {
        const times: number[] = [];
        for (let k = 0; k < 21; k++) {
          const start = performance.now();
          a.store.dragOpening(id, ...at(k), { x: 0, y: 0 });
          times.push(performance.now() - start);
        }
        const valid = a.store.drag.value!.check.valid;
        a.store.cancelDrag();
        return { ms: times.sort((x, y) => x - y)[10], valid };
      };
      return { valid: median((k) => [opening.x + (k % 2) * 0.5, opening.y]), invalid: median((k) => [other.x + (k % 2) * 0.5, other.y]) };
    }, pour.id);
    await idle(page);
    const drags = await hooks(page, (h) => h.timing().drag);
    console.log(`x8 3 x 3: a drag move takes ${t0.valid.ms.toFixed(2)} ms on main on a valid spot and ${t0.invalid.ms.toFixed(2)} ms on one that snaps (median of 21); T2b drag cuts ${drags.map((ms) => Math.round(ms)).join(', ')} ms`);
    expect([t0.valid.valid, t0.invalid.valid]).toEqual([true, false]);
    expect(t0.valid.ms).toBeLessThan(16);
    expect(t0.invalid.ms).toBeLessThan(16);
    const pins = await hooks(page, (h) => h.project().pins);
    expect(pins.map((p) => p.id)).toEqual([pour.id]);
    const hash = await hooks(page, (h) => h.geometryHash());
    expect(hash).toEqual(await hooks(page, (h) => h.freshHash()));
    expect(hash).toEqual(await nodeHash('x8', (p) => {
      p.setParams((params) => {
        params.grid.nx = 3;
        params.grid.ny = 3;
      });
      p.setPins(pins as OpeningPin[]);
    }));
  });
});
