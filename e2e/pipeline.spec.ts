import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { OpeningPin } from '../src/core/analysis/placement';
import { Pipeline } from '../src/app/pipeline';
import { hashBytes, hashMesh } from '../src/app/hash';
import { weld } from '../src/core/mesh/weld';
import { parseStl } from '../src/core/stl/parse';
import { exampleBytes, EXAMPLE_FILES, type ExampleId } from '../test/fixtures/loadExamples';
import { budgetFromNode, PLAN_TARGETS, tableBudgetMs } from '../src/app/budgets';
import { withRows } from '../test/fixtures/benchmarks';
import { NO_FIREFOX_WEBGL } from './firefox';
import { inNode, nodeHash } from './nodeRuns';
import { canDraw, hooks, loadAndWait, openPipeline } from './pipelineHarness';

const FULL = process.env.CFG_FULL === '1';
/**
 * The soak and the timings measure the workers, which the dev server serves as the build does, so they
 * run on the build in Chromium and in Firefox. Run on the dev server too they would take --full past its
 * time limit, and the dev server's timings are not the user's.
 */
const DEV_SKIP = 'measures the workers, which run the same on the dev server: see DEV_SKIP';


const logCount = (page: Page, gate: string, event: string): Promise<number> => hooks(page, (h, a: [string, string]) => h.jobLog().filter((e) => e.gate === a[0] && e.event === a[1]).length, [gate, event]);

async function waitForDispatch(page: Page, gate: string, after: number): Promise<void> {
  await expect.poll(() => logCount(page, gate, 'dispatch'), { timeout: 30_000, intervals: [5] }).toBeGreaterThan(after);
}

test.describe('the worker pipeline on pipeline.html', () => {
  let errors: string[];
  test.beforeEach(async ({ page }) => {
    errors = [];
    await openPipeline(page, errors);
  });
  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test('@smoke the TIN and tool builder run in the browser and give Node\'s geometry, and the hooks have meaning', async ({ page }) => {
    test.skip(!canDraw(page), NO_FIREFOX_WEBGL);
    await loadAndWait(page, EXAMPLE_FILES.jersey);
    const browser = await hooks(page, (h) => ({ hash: h.geometryHash(), status: h.status(), frozen: h.budgets().frozen }));
    expect(browser.status).toMatchObject({ stale: false, busy: false, error: null });
    expect(browser.frozen).toBe(true);
    expect(browser.hash.cover).not.toBeNull();
    expect(browser.hash).toEqual(await nodeHash('jersey'));
    await expect(page.locator('#badge')).toBeHidden();

    // The camera can be set exactly, and points of the mold land where the hook says. The camera looks
    // level at the cover's front lower left corner from in front, so that corner is the middle of the
    // view and the front face, which is all the cover shows from there, fills only the upper right. A
    // flipped axis, a stale aspect or a wrong field of view would put the probes elsewhere.
    const probes = await hooks(page, (h) => {
      const { min, max } = h.partBounds('cover')!;
      const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
      const across = Math.max(...size);
      // Not the camera's default of 35, so a field of view that is not applied shows.
      h.setCamera({ position: [min[0], min[1] - 3 * across, min[2]], target: [min[0], min[1], min[2]], fov: 50 });
      const front = (x: number, z: number): [number, number, number] => [min[0] + x * size[0], min[1], min[2] + z * size[2]];
      return {
        // Where a pinhole camera puts the face's centre, worked out here: offsets over distance, over tan(fov / 2).
        expected: { dx: (0.5 * size[0]) / (3 * across * Math.tan((25 * Math.PI) / 180)), dz: (0.5 * size[2]) / (3 * across * Math.tan((25 * Math.PI) / 180)) },
        corner: h.worldToScreen(front(0, 0)),
        // On the front face, away from its edges.
        onFace: h.worldToScreen(front(0.5, 0.5)),
        nearRight: h.worldToScreen(front(0.92, 0.5)),
        nearTop: h.worldToScreen(front(0.5, 0.92)),
        // Just past its right and top edges, where only the background is.
        pastRight: h.worldToScreen(front(1.12, 0.5)),
        pastTop: h.worldToScreen(front(0.5, 1.12)),
      };
    });
    const view = (await page.locator('#view').boundingBox())!;
    const { expected, ...points } = probes;
    // The corner the camera looks at is the middle of the view; that alone holds for any projection.
    expect(points.corner.x).toBeCloseTo(view.x + view.width / 2, 0);
    expect(points.corner.y).toBeCloseTo(view.y + view.height / 2, 0);
    // The face's centre is where the pinhole formula puts it, up and to the right, in the view's own aspect.
    expect(Math.abs(points.onFace.x - (view.x + view.width / 2 + expected.dx * (view.height / 2)))).toBeLessThan(1);
    expect(Math.abs(points.onFace.y - (view.y + view.height / 2 - expected.dz * (view.height / 2)))).toBeLessThan(1);
    for (const point of Object.values(points)) expect(point.visible).toBe(true);
    const png = await page.locator('#view').screenshot();
    const pixels = await page.evaluate(async ([b64, points]) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const view = document.querySelector('#view')!.getBoundingClientRect();
      const pixel = (p: { x: number; y: number }): number[] => Array.from(ctx.getImageData(Math.round(p.x - view.left), Math.round(p.y - view.top), 1, 1).data.slice(0, 3));
      return Object.fromEntries(Object.entries(points).map(([name, p]) => [name, pixel(p)]));
    }, [png.toString('base64'), points] as const);
    const BACKGROUND = [0x10, 0x14, 0x18];
    // The cover, light grey at 35% over the dark background, reads lighter than it in every channel.
    for (const name of ['onFace', 'nearRight', 'nearTop']) for (let c = 0; c < 3; c++) expect(pixels[name][c], `${name} is the cover`).toBeGreaterThan(BACKGROUND[c] + 20);
    for (const name of ['pastRight', 'pastTop']) expect(pixels[name], `${name} is background`).toEqual(BACKGROUND);
  });

  test('@smoke a burst of 50 t changes coalesces, applies results in order with the badge, and ends on the last value', async ({ page }) => {
    await loadAndWait(page, EXAMPLE_FILES.x8);
    const values = Array.from({ length: 50 }, (_, k) => Math.round((3 + (k + 1) * 0.02) * 100) / 100);
    const before = await logCount(page, 'field', 'dispatch');
    // After the page has drawn each change: whether the badge shows, and whether the field on screen came
    // in out of date. The page subscribed first, so the badge is already up to date when this runs.
    await hooks(page, (h) => {
      const seen: { badge: boolean; staleField: boolean }[] = [];
      (window as unknown as { __seen: typeof seen }).__seen = seen;
      h.subscribe(() => {
        const field = h.events().filter((e) => e.kind === 'applied' && e.slot === 'field').at(-1);
        seen.push({ badge: document.querySelector('#badge')!.classList.contains('on'), staleField: field?.stale ?? false });
      });
    });
    // A pause longer than T2's debounce half way, so a T2 runs inside the burst as well as after it.
    await hooks(page, async (h, v: number[]) => {
      await h.burst('silicone.t', v.slice(0, 25), 10);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await h.burst('silicone.t', v.slice(25), 10);
    }, values);
    await hooks(page, (h) => h.idle());
    const run = await hooks(page, (h) => ({ events: h.events(), status: h.status(), hash: h.geometryHash(), t: h.params().silicone.t }));
    const seen = await page.evaluate(() => (window as unknown as { __seen: { badge: boolean; staleField: boolean }[] }).__seen);
    const dispatched = (await logCount(page, 'field', 'dispatch')) - before;
    console.log(`burst: ${dispatched} field jobs for 50 changes`);
    expect(dispatched).toBeLessThan(25);
    expect(dispatched).toBeGreaterThanOrEqual(2);
    for (const slot of ['field', 'placement', 'cover'] as const) {
      // The first is the load's.
      const applied = run.events.filter((e) => e.kind === 'applied' && e.slot === slot).slice(1);
      expect(applied.length, slot).toBeGreaterThanOrEqual(2);
      for (let k = 1; k < applied.length; k++) expect(applied[k].rev, slot).toBeGreaterThan(applied[k - 1].rev);
      expect(applied.at(-1)!.t, slot).toBe(values.at(-1));
    }
    // Out-of-date fields showed while the burst ran, always under the badge, and it cleared at the end.
    expect(seen.some((s) => s.staleField && s.badge)).toBe(true);
    expect(seen.filter((s) => s.staleField && !s.badge)).toEqual([]);
    expect(run.status).toMatchObject({ stale: false, busy: false, error: null });
    await expect(page.locator('#badge')).toBeHidden();
    expect(run.t).toBe(values.at(-1));
    expect(run.hash).toEqual(await hooks(page, (h) => h.freshHash()));
  });

  test('@smoke t changed while busy, then an opening dragged: the drag cuts on the new cover, and the end is a fresh build, in the browser and in Node', async ({ page }) => {
    await loadAndWait(page, EXAMPLE_FILES.x8);
    const solidBefore = await logCount(page, 'solid', 'dispatch');
    // The T2 for the new t is held up, so the drag surely begins while it runs.
    await hooks(page, (h) => {
      h.armFault('solid', { kind: 'delay', ms: 1500 });
      h.setParam('silicone.t', 3.5);
    });
    await waitForDispatch(page, 'solid', solidBefore);
    const start = await hooks(page, (h) => {
      const last = h.jobLog().filter((e) => e.gate === 'solid').at(-1)!;
      const pour = h.openings().find((o) => o.kind === 'pour')!;
      h.drag(pour.id, pour.x + 0.2, pour.y);
      return { last: last.event, busy: h.status().busy, pour };
    });
    expect(start.last).toBe('dispatch');
    expect(start.busy).toBe(true);
    const { pour } = start;
    // Each step waits until its own provisional cover is what shows. The first can only come once the T2
    // has landed, and is cut into the cover body that T2 left.
    const current = (): Promise<boolean> => hooks(page, (h) => h.shownCover()?.provisional === true && !h.status().stale);
    for (let k = 1; k <= 5; k++) {
      if (k > 1) await hooks(page, (h, a: { id: string; x: number; y: number }) => h.drag(a.id, a.x, a.y), { id: pour.id, x: pour.x + k * 0.2, y: pour.y });
      await expect.poll(current, { timeout: 30_000, intervals: [5] }).toBe(true);
    }
    expect((await hooks(page, (h) => h.timing().drag)).length).toBeGreaterThanOrEqual(5);
    const pins = [{ id: pour.id, kind: pour.kind as OpeningPin['kind'], x: pour.x + 1, y: pour.y }];
    await hooks(page, async (h, a: { id: string; x: number; y: number }) => {
      h.drop(a.id, a.x, a.y);
      await h.idle();
    }, pins[0]);
    const run = await hooks(page, (h) => ({ status: h.status(), hash: h.geometryHash(), openings: h.openings(), cover: h.shownCover() }));
    expect(run.status).toMatchObject({ stale: false, error: null });
    expect(run.cover!.provisional).toBe(false);
    const pinned = run.openings.filter((o) => o.pinned);
    expect(pinned.map((o) => o.id)).toEqual(pins.map((p) => p.id));
    expect(run.hash).toEqual(await hooks(page, (h) => h.freshHash()));
    const asPins: OpeningPin[] = pinned.map(({ id, kind, x, y }) => ({ id, kind: kind as OpeningPin['kind'], x, y }));
    expect(run.hash).toEqual(await nodeHash('x8', (p) => {
      p.setParams((params) => (params.silicone.t = 3.5));
      p.setPins(asPins);
    }));
  });

  test('@smoke file B loaded while a job from A runs: A\'s result is rejected and B shows', async ({ page }) => {
    await hooks(page, (h, name: string) => h.load(name), EXAMPLE_FILES.x8);
    await waitForDispatch(page, 'solid', 1);
    await loadAndWait(page, EXAMPLE_FILES.jersey);
    const run = await hooks(page, (h) => ({ events: h.events(), status: h.status(), hash: h.geometryHash() }));
    expect(run.events.filter((e) => e.kind === 'rejected' && e.reason === 'model').length).toBeGreaterThan(0);
    expect(run.status).toMatchObject({ stale: false, error: null });
    expect(run.hash).toEqual(await nodeHash('jersey'));
  });

  test('@smoke T2b straight after a recycle misses, re-sends with its inputs, and recovers', async ({ page }) => {
    await loadAndWait(page, EXAMPLE_FILES.jersey);
    await hooks(page, (h) => {
      const [opening] = h.openings();
      h.recycleSolid();
      h.drag(opening.id, opening.x + 0.5, opening.y);
    });
    await hooks(page, (h) => h.idle());
    expect(await logCount(page, 'solid', 'miss')).toBe(1);
    expect(await hooks(page, (h) => h.status())).toMatchObject({ stale: false, error: null });
    await hooks(page, async (h) => {
      const [opening] = h.openings();
      h.drop(opening.id, opening.x + 0.5, opening.y);
      await h.idle();
    });
    expect(await hooks(page, (h) => h.geometryHash())).toEqual(await hooks(page, (h) => h.freshHash()));
  });

  test('@smoke a job forced past its budget is terminated for a newer request, respawns and recovers', async ({ page }) => {
    await loadAndWait(page, EXAMPLE_FILES.jersey);
    const before = await logCount(page, 'solid', 'dispatch');
    const t0 = Date.now();
    await hooks(page, (h) => {
      h.freezeBudgets({ terminateFloorMs: 1000 });
      h.armFault('solid', { kind: 'delay', ms: 60_000 });
      h.setParam('silicone.t', 3.5);
    });
    await waitForDispatch(page, 'solid', before);
    await hooks(page, async (h) => {
      h.setParam('silicone.t', 3.6);
      await h.idle();
    });
    const log = await hooks(page, (h) => h.jobLog());
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(log.filter((e) => e.gate === 'solid' && e.event === 'terminated')).toHaveLength(1);
    expect(log.some((e) => e.gate === 'solid' && e.event === 'respawned' && e.detail === 'terminated')).toBe(true);
    expect(await hooks(page, (h) => h.status())).toMatchObject({ stale: false, error: null });
    expect(await hooks(page, (h) => h.geometryHash())).toEqual(await hooks(page, (h) => h.freshHash()));
  });

  test('@smoke an injected out-of-bounds recovers once at twice the cell, then gives a clean inline error', async ({ page }) => {
    await loadAndWait(page, EXAMPLE_FILES.jersey);
    await hooks(page, async (h) => {
      h.armFault('solid', { kind: 'oob' });
      h.setParam('silicone.t', 3.5);
      await h.idle();
    });
    expect(await logCount(page, 'solid', 'crashed')).toBe(1);
    expect(await hooks(page, (h) => h.status())).toMatchObject({ stale: false, error: null });
    expect((await hooks(page, (h) => h.diagnostics())).map((d) => d.code)).toContain('preview-coarser');
    expect(await hooks(page, (h) => h.cellScale())).toBe(2);

    // At the doubled cell a crash is not retried again, and the cell does not grow.
    await hooks(page, async (h) => {
      h.armFault('solid', { kind: 'oob' });
      h.setParam('silicone.t', 3.6);
      await h.idle();
    });
    expect(await logCount(page, 'solid', 'crashed')).toBe(2);
    expect((await hooks(page, (h) => h.status())).error).toMatch(/coarser cell/);
    await expect(page.locator('#error')).toContainText('coarser cell');
    expect(await hooks(page, (h) => h.cellScale())).toBe(2);

    // Clean: the next change builds again, at the cell that stays doubled until the next load.
    await hooks(page, async (h) => {
      h.setParam('silicone.t', 3.7);
      await h.idle();
    });
    expect(await hooks(page, (h) => h.status())).toMatchObject({ stale: false, error: null });
    await expect(page.locator('#error')).toBeEmpty();
    expect(await hooks(page, (h) => h.cellScale())).toBe(2);
    expect(await hooks(page, (h) => h.geometryHash())).toEqual(await hooks(page, (h) => h.freshHash()));
  });

  test('@smoke T3 exports in a fresh worker and its files are byte for byte those Node writes', async ({ page }) => {
    await loadAndWait(page, EXAMPLE_FILES.jersey);
    const browser = await hooks(page, (h) => h.exportParts());
    const node = await inNode('jersey', () => {}, async (p) => {
      const outputs = await p.exportParts();
      const files: Record<string, { bytes: number; hash: string; meshHash: string }> = {};
      for (const [name, bytes] of Object.entries(outputs.files)) {
        const mesh = weld(parseStl(bytes).positions);
        files[name] = { bytes: bytes.length, hash: hashBytes(bytes), meshHash: hashMesh(mesh.positions, mesh.indices) };
      }
      return { files, clearance: outputs.clearance };
    });
    console.log(`export: clearance ${JSON.stringify(browser.clearance)}, ${Math.round(browser.ms)} ms, ${browser.zipBytes} bytes zipped`);
    expect(Object.keys(browser.files).sort()).toEqual(['base.stl', 'cover.stl', 'funnel.stl', 'model_oriented.stl']);
    expect(browser.files).toEqual(node.files);
    expect(browser.clearance).toEqual(node.clearance);
    expect(browser.clearance!.measured).toBeGreaterThanOrEqual(3);
    expect(browser.progress).toContain('clearance');
    // The export worker is gone once it has answered: it was never one of the gate's.
    expect(await logCount(page, 'solid', 'dispatch')).toBe(2);
  });
});

test.describe('every example matches Node', () => {
  test.skip(!FULL, 'all 7 run with CFG_FULL=1');
  for (const id of Object.keys(EXAMPLE_FILES) as ExampleId[]) {
    test(`${id}: field, openings, cover and base hash as in Node`, async ({ page }) => {
      const errors: string[] = [];
      await openPipeline(page, errors);
      await loadAndWait(page, EXAMPLE_FILES[id]);
      const browser = await hooks(page, (h) => ({ hash: h.geometryHash(), status: h.status() }));
      expect(browser.status).toMatchObject({ stale: false, error: null });
      expect(browser.hash).toEqual(await nodeHash(id));
      expect(errors).toEqual([]);
    });
  }
});

/** Swap in use on this machine, in MB. The soak stops if it grows past the limit the server can spare. */
function swapUsedMb(): number {
  const info = readFileSync('/proc/meminfo', 'utf8');
  const read = (name: string): number => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(info)![1]) / 1024;
  return read('SwapTotal') - read('SwapFree');
}
const SWAP_LIMIT_MB = 500;

/**
 * Measured in Node over 200 rebuilds of each model, the reading wanders by up to 192 KB as the
 * allocator's free holes come and go. The extrude leak this caught was 96 KB per rebuild of Benchy.
 * Over the 90 rebuilds after warm-up, this limit sees a leak of about 6 KB per rebuild or more, which
 * the negative control below shows. A smaller leak, such as one small section per run, is heap.test's
 * to find, on the builders themselves.
 */
const HEAP_FLAT_BYTES = 512 * 1024;
/**
 * Main's JS heap and the array buffers it holds, after a collection. The job log and the events grow
 * until they reach their cap, by about 300 KB over a soak, so this allows 2 MB: a part kept per rebuild
 * would be tens of MB.
 */
const MAIN_FLAT_BYTES = 2 * 1024 * 1024;
const WARM_UP = 10;
const REBUILDS = 100;
/** A leak per rebuild for the control: a section of this many points, about 16 bytes each, and more inside Clipper. */
const LEAK_POINTS = 1000;

interface Soak {
  warm: { capacity: number | null; used: number | null; held: number };
  end: { capacity: number | null; used: number | null; held: number };
  main: [number, number] | null;
}

/** REBUILDS rebuilds by t on the model loaded, with readings after the warm-up and at the end. */
async function soak(page: Page, browser: string, leak: boolean): Promise<Soak> {
  // What is soaked is the rebuild, not the wait before it.
  await hooks(page, (h) => h.freezeBudgets({ debounceMs: 0 }));
  // Chromium alone lets a test read main's heap, through its debugging protocol.
  const cdp = browser === 'firefox' ? null : await page.context().newCDPSession(page);
  const mainHeap = async (): Promise<number | null> => {
    if (!cdp) return null;
    await cdp.send('HeapProfiler.collectGarbage');
    const usage = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number; backingStorageSize?: number };
    return usage.usedSize + (usage.backingStorageSize ?? 0);
  };
  const swap0 = swapUsedMb();
  // Two values in turn, so each rebuild replaces every cached solid.
  const rebuild = (k: number): Promise<void> => hooks(page, async (h, a: { t: number; leak: number }) => {
    if (a.leak) h.armFault('solid', { kind: 'leak', points: a.leak });
    h.setParam('silicone.t', a.t);
    await h.idle();
  }, { t: k % 2 ? 3.1 : 3, leak: leak ? LEAK_POINTS : 0 });
  for (let k = 0; k < WARM_UP; k++) await rebuild(k);
  const warm = await hooks(page, (h) => h.heap());
  const main0 = await mainHeap();
  for (let k = WARM_UP; k < REBUILDS; k++) {
    await rebuild(k);
    expect(swapUsedMb() - swap0, 'swap grew past what the server can spare').toBeLessThan(SWAP_LIMIT_MB);
  }
  const end = await hooks(page, (h) => h.heap());
  const main1 = await mainHeap();
  await cdp?.detach();
  return { warm, end, main: main0 === null || main1 === null ? null : [main0, main1] };
}

test.describe('soak', () => {
  test.skip(!FULL, 'runs with CFG_FULL=1');
  for (const id of ['benchy', 'x8'] as ExampleId[]) {
    test(`${id}: ${REBUILDS} rebuilds with a flat heap after warm-up`, async ({ page }, info) => {
      test.skip(info.project.name === 'dev', DEV_SKIP);
      test.setTimeout(600_000);
      const errors: string[] = [];
      await openPipeline(page, errors);
      await loadAndWait(page, EXAMPLE_FILES[id]);
      const { warm, end, main } = await soak(page, info.project.name, false);
      const status = await hooks(page, (h) => h.status());
      console.log(`${id} soak: solid heap capacity ${warm.capacity} -> ${end.capacity}, used ${warm.used} -> ${end.used} (${end.used! - warm.used!}), held ${warm.held} -> ${end.held}; main ${main ? `${main[0]} -> ${main[1]} (${main[1] - main[0]})` : 'not readable'}`);
      expect(status).toMatchObject({ stale: false, error: null });
      expect(warm.capacity).not.toBeNull();
      // Each reading grows the capacity by one step, so the second may sit one step above the first.
      expect(end.used! - warm.used!).toBeLessThanOrEqual(HEAP_FLAT_BYTES);
      expect(end.held).toBe(warm.held);
      if (main) expect(main[1] - main[0]).toBeLessThanOrEqual(MAIN_FLAT_BYTES);
      expect(await logCount(page, 'solid', 'respawned')).toBe(0);
      expect(errors).toEqual([]);
    });
  }

  test('negative control: a section kept for good on every rebuild shows over the same soak', async ({ page }, info) => {
    test.skip(info.project.name === 'dev', DEV_SKIP);
    test.setTimeout(600_000);
    const errors: string[] = [];
    await openPipeline(page, errors);
    await loadAndWait(page, EXAMPLE_FILES.jersey);
    const { warm, end } = await soak(page, info.project.name, true);
    console.log(`leak control: solid heap used ${warm.used} -> ${end.used} (${end.used! - warm.used!}) over ${REBUILDS - WARM_UP} rebuilds, one ${LEAK_POINTS}-point section each`);
    expect(end.used! - warm.used!).toBeGreaterThan(HEAP_FLAT_BYTES);
    expect(errors).toEqual([]);
  });
});

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2 ? sorted[sorted.length >> 1] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};
const ms = (value: number): string => (Math.round(value * 10) / 10).toString();

interface Measured {
  t1: number[];
  t2: number[];
  /** The first step of each drag, which also cuts every other opening into the cover it then holds. */
  first: number[];
  /** The steps after it, which cut only the dragged opening. */
  drag: number[];
  cut: number[];
}

type Raw = { t1: number[]; t2: number[]; drag: number[]; cut: number[] };

/**
 * Three rebuilds by t, then three drags of the pour, each of three steps and a drop, after the load,
 * with no debounce in the way. The drags go there and back, so the pour stays where placement put it.
 */
async function steps(p: { freeze(): void; timing(): Raw; set(t: number): void; idle(): Promise<void>; pour(): { id: string; x: number; y: number }; drag(id: string, x: number, y: number): void; drop(id: string, x: number, y: number): void }): Promise<Raw> {
  p.freeze();
  const from = p.timing();
  const counts = { t1: from.t1.length, t2: from.t2.length, drag: from.drag.length, cut: from.cut.length };
  for (const t of [3.2, 3.4, 3.6]) {
    p.set(t);
    await p.idle();
  }
  for (const way of [1, -1, 1]) {
    const pour = p.pour();
    for (const k of [1, 2, 3]) {
      p.drag(pour.id, pour.x + way * 0.2 * k, pour.y);
      await p.idle();
    }
    p.drop(pour.id, pour.x + way * 0.6, pour.y);
    await p.idle();
  }
  const t = p.timing();
  return { t1: t.t1.slice(counts.t1), t2: t.t2.slice(counts.t2), drag: t.drag.slice(counts.drag), cut: t.cut.slice(counts.cut) };
}

/** Each drag's first step apart from the rest. */
function split(raw: Raw): Measured {
  return { t1: raw.t1, t2: raw.t2, first: raw.drag.filter((_, k) => k % 3 === 0), drag: raw.drag.filter((_, k) => k % 3 !== 0), cut: raw.cut };
}

function measure(page: Page): Promise<Measured> {
  return hooks(page, async (h, source: string) => {
    const run = new Function(`return (${source})`)();
    return run({
      freeze: () => h.freezeBudgets({ debounceMs: 0 }),
      timing: () => ({ ...h.timing() }),
      set: (t: number) => h.setParam('silicone.t', t),
      idle: () => h.idle(),
      pour: () => h.openings().find((o) => o.kind === 'pour')!,
      drag: (id: string, x: number, y: number) => h.drag(id, x, y),
      drop: (id: string, x: number, y: number) => h.drop(id, x, y),
    });
  }, steps.toString()).then(split);
}

/** The same steps on the same code in Node, for --record to write as the fixed Node rows. */
function measureNode(id: ExampleId, nx: number, ny: number): Promise<Measured> {
  return inNode(id, (p) => p.setParams((params) => ((params.grid.nx = nx), (params.grid.ny = ny))), (p) =>
    steps({
      freeze: () => p.budgets.freeze({ debounceMs: 0 }),
      timing: () => ({ t1: [...p.timing.t1], t2: [...p.timing.t2], drag: [...p.timing.drag], cut: [...p.timing.cut] }),
      set: (t) => p.setParams((params) => (params.silicone.t = t)),
      idle: () => p.idle(),
      pour: () => p.placement!.value.placement.openings.find((o) => o.kind === 'pour')!,
      drag: (i, x, y) => p.dragOpening(i, x, y),
      drop: (i, x, y) => void p.dropOpening(i, x, y),
    }).then(split),
  );
}

interface NodeRow {
  t1: number;
  t2: number;
  first: number;
  drag: number;
  cut: number;
}

const BENCHMARKS = 'docs/BENCHMARKS.md';

/** The Node rows of the Pipeline table as recorded, by model. */
function recordedNodeRows(): Map<string, NodeRow> {
  const rows = new Map<string, NodeRow>();
  for (const line of readFileSync(BENCHMARKS, 'utf8').split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    // An empty cell would read as 0, as in a row of the older layout, which had no first drag column.
    const values = cells.slice(3, 8);
    if (cells[1] !== 'Node' || values.length < 5 || values.some((c) => c === '' || !Number.isFinite(Number(c)))) continue;
    const [t1, t2, first, drag, cut] = values.map(Number);
    rows.set(cells[2], { t1, t2, first, drag, cut });
  }
  return rows;
}

const PIPELINE_HEADER = '| Browser | Model | T1 ms | T2 ms | T2b first drag ms | T2b drag ms | T2b cut ms | T1 budget | T2 budget | T2b first drag budget | T2b drag budget | T2b cut budget |\n|---|---|---|---|---|---|---|---|---|---|---|---|';
const PIPELINE_INTRO = [
  'Written by `scripts/ci.sh --full --record`, from the production build in Chromium and from Firefox, on the server.',
  '',
  'In ms, from the job\'s dispatch on main to its result on main, after three rebuilds by t and three drags of the pour, each of three steps and a drop, with the 400 ms debounce frozen to 0. T1 is a change of t until the field arrives, and T2 the rebuild of cover and base after it. A drag\'s first step cuts every other opening into the cover, which solid.worker then holds, and the dragged one into that; each step after it cuts only the dragged one. T2b cut is the full cut after the drop, which makes the end the same as a fresh build. Each is the median of three, and T2b drag the median of six.',
  '',
  'Budgets are twice what Node takes, times the M0 ratio of 1.0, plus 50 ms for the job itself. T1, T2 and the cut come from the Node tables above: Field, then TIN to Mode A plus "Cut, preview", then "Cut, preview" alone, which is the first step\'s budget too. A drag step after the first has no row there, so its budget comes from the Node rows below, as does a grid\'s T2, which the tables do not have at the preview cell. Those rows are fixed: the check reads them as they were recorded, and only `--record` measures them again, by the same steps on the same code in Node. Node\'s worker shares main\'s thread, so its field reaches main only after placement and its T1 is no budget; a grid\'s T1 budget is the plan\'s 150 ms. A single model is also held to the plan\'s own targets, 150 ms for T1, 2000 for T2 and 200 for each T2b, as upper limits apart from its budget. The grids take longer than the plan\'s 2 s for T2, and x8 3 x 3 longer than its 200 ms for a drag step, as recorded under M5 in `docs/PLAN.md`, so they are held to their budgets alone.',
  '',
  'The page does not draw while this runs: it is opened with `draw=0`, which leaves out its 3D view. With a display, Firefox on the server has software WebGL on its main thread, and drawing the parts there holds the field\'s message back by a frame: Benchy\'s T1 goes from about 6 to 72 ms. These Firefox rows were taken headless, without WebGL at all. Chromium draws in its GPU process, and the user\'s Firefox on Windows draws on the GPU.',
].join('\n');

type Tier = keyof Measured;
const TIERS: Tier[] = ['t1', 't2', 'first', 'drag', 'cut'];

test.describe('budgets', () => {
  const MODELS: ExampleId[] = FULL ? (Object.keys(EXAMPLE_FILES) as ExampleId[]) : ['jersey', 'benchy'];
  const GRIDS: [ExampleId, number, number][] = FULL ? [['benchy', 2, 3], ['x8', 3, 3]] : [];
  const RECORD = process.env.CFG_RECORD === '1';

  test('T1, T2 and T2b measured here stay within the budgets derived from Node, and are recorded', async ({ page }, info) => {
    test.skip(info.project.name === 'dev', DEV_SKIP);
    test.setTimeout(1_500_000);
    const errors: string[] = [];
    // See PIPELINE_INTRO: drawing would measure the software renderer of this server, not the pipeline.
    await openPipeline(page, errors, '&draw=0');
    const browser = info.project.name === 'firefox' ? 'Firefox' : 'Chromium';
    const recorded = recordedNodeRows();
    const rows: string[] = [];
    const cases: [string, ExampleId, number, number][] = [...MODELS.map((id): [string, ExampleId, number, number] => [id, id, 1, 1]), ...GRIDS.map(([id, nx, ny]): [string, ExampleId, number, number] => [`${id} ${nx} x ${ny}`, id, nx, ny])];
    for (const [name, id, nx, ny] of cases) {
      // Chromium runs first and is the one to write the Node rows when recording.
      let node = recorded.get(name);
      if (RECORD && browser === 'Chromium') {
        const fresh = await measureNode(id, nx, ny);
        const row: NodeRow = { t1: median(fresh.t1), t2: median(fresh.t2), first: median(fresh.first), drag: median(fresh.drag), cut: median(fresh.cut) };
        rows.push(`| Node | ${name} | ${ms(row.t1)} | ${ms(row.t2)} | ${ms(row.first)} | ${ms(row.drag)} | ${ms(row.cut)} | | | | | |`);
        console.log(`Node ${name}: ${JSON.stringify(row)}; samples ${JSON.stringify(fresh)}`);
        // The first recording has nothing to check against yet.
        node ??= row;
      }
      if (!node) throw new Error(`docs/BENCHMARKS.md has no Node row for ${name}: run scripts/ci.sh --full --record`);
      await hooks(page, (h, grid: [number, number]) => {
        h.setParam('grid.nx', grid[0]);
        h.setParam('grid.ny', grid[1]);
      }, [nx, ny]);
      await loadAndWait(page, EXAMPLE_FILES[id]);
      const m = await measure(page);
      const got = Object.fromEntries(TIERS.map((tier) => [tier, median(m[tier])])) as Record<Tier, number>;
      const single = nx === 1 && ny === 1;
      const budget: Record<Tier, number> = {
        t1: single ? tableBudgetMs(name, 't1')! : PLAN_TARGETS.t1,
        t2: single ? tableBudgetMs(name, 't2')! : budgetFromNode(node.t2),
        first: tableBudgetMs(name, 'cut')!,
        drag: budgetFromNode(node.drag),
        cut: tableBudgetMs(name, 'cut')!,
      };
      const limit: Record<Tier, number> | null = single ? { t1: PLAN_TARGETS.t1, t2: PLAN_TARGETS.t2, first: PLAN_TARGETS.t2b, drag: PLAN_TARGETS.t2b, cut: PLAN_TARGETS.t2b } : null;
      console.log(`${browser} ${name}: ${JSON.stringify(got)}; budgets ${JSON.stringify(budget)}; samples ${JSON.stringify(m)}`);
      rows.push(`| ${browser} | ${name} | ${TIERS.map((tier) => ms(got[tier])).join(' | ')} | ${TIERS.map((tier) => Math.round(budget[tier])).join(' | ')} |`);
      expect([m.t1.length, m.t2.length, m.first.length, m.drag.length, m.cut.length], name).toEqual([3, 3, 3, 6, 3]);
      for (const tier of TIERS) {
        expect(got[tier], `${name} ${tier}`).toBeLessThanOrEqual(budget[tier]);
        if (limit) expect(got[tier], `${name} ${tier} against the plan`).toBeLessThanOrEqual(limit[tier]);
      }
    }
    expect(errors).toEqual([]);
    if (RECORD) {
      const owns = (row: string): boolean => row.startsWith(`| ${browser} |`) || (browser === 'Chromium' && row.startsWith('| Node |'));
      writeFileSync(BENCHMARKS, withRows(readFileSync(BENCHMARKS, 'utf8'), 'Pipeline', PIPELINE_INTRO, PIPELINE_HEADER, rows, owns));
    }
  });
});
