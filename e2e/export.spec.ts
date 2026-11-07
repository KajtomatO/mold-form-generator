import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { expect, test, type Page } from '@playwright/test';
import Module, { type ManifoldToplevel } from 'manifold-3d';
import type { Pipeline } from '../src/app/pipeline';
import type { WorkerRecord } from '../src/app/testHooks';
import type { ParamPath } from '../src/app/stages';
import { auditEdges } from '../src/core/mesh/audit';
import { importSolid } from '../src/core/mesh/shells';
import { defaultParams } from '../src/core/params/defaults';
import { basePose, coverPose } from '../src/core/parts/poses';
import { withArena } from '../src/core/solid/arena';
import { parseStl } from '../src/core/stl/parse';
import type { ExportOutputs, ExportReport } from '../src/workers/exportJob';
import { orientedExample } from '../test/fixtures/fieldRuns';
import { exampleBytes, EXAMPLE_FILES, EXAMPLE_IDS, loadExample, type ExampleId } from '../test/fixtures/loadExamples';
import { readPart, unpose } from '../test/fixtures/solidChecks';
import { app, canDraw, canvasPixels, checkLayout, dropAndWait, hooks, idle, openApp, type PageWatch } from './appHarness';
import { checkPieces } from './fitChecks';
import { NO_FIREFOX_WEBGL } from './firefox';
import { inNode } from './nodeRuns';

const FULL = process.env.CFG_FULL === '1';
const SIZES = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
];
const BUTTONS = ['export-zip', 'export-cover', 'export-base', 'export-funnel', 'export-fit-test'];
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** Clicks an Export box button and returns the file the browser saved, by its name and bytes. */
async function saveFrom(page: Page, testId: string): Promise<{ name: string; bytes: Uint8Array }> {
  const download = page.waitForEvent('download', { timeout: 240_000 });
  await page.getByTestId(testId).click();
  const file = await download;
  return { name: file.suggestedFilename(), bytes: new Uint8Array(await readFile(await file.path())) };
}

/** Volume enclosed by an STL's triangles, from the bytes alone. */
function stlVolume(bytes: Uint8Array): number {
  const p = parseStl(bytes).positions;
  let sum = 0;
  for (let i = 0; i < p.length; i += 9) {
    sum += p[i] * (p[i + 4] * p[i + 8] - p[i + 5] * p[i + 7]) - p[i + 1] * (p[i + 3] * p[i + 8] - p[i + 5] * p[i + 6]) + p[i + 2] * (p[i + 3] * p[i + 7] - p[i + 4] * p[i + 6]);
  }
  return sum / 6;
}

let manifold: ManifoldToplevel | null = null;
async function api(): Promise<ManifoldToplevel> {
  if (!manifold) {
    manifold = await Module();
    manifold.setup();
  }
  return manifold;
}

/** Sets parameters in the page before a model is dropped, and the same in Node. */
type Settings = [ParamPath, unknown][];
const applyInNode = (settings: Settings) => (p: Pipeline): void =>
  p.setParams((params) => {
    for (const [path, value] of settings) {
      const [group, key] = path.split('.');
      (params as unknown as Record<string, Record<string, unknown>>)[group][key] = value;
    }
  });

/**
 * The M6 checks on a downloaded ZIP, all in Node: every STL binary with a header that is no "solid" and
 * 0 open edges, volumes as a Node build of the same parameters makes them within 0.1%, report.json and
 * README.txt as Node writes them, the parts put back together from their print poses with
 * minGap(model, cover) >= t, the base on the shelf and no cover-base overlap, the clearance report.json
 * measured at least t, README.txt with the workflow and the sprue rule, and model_oriented.stl with the
 * input's triangles less the collapsed ones.
 */
async function checkZip(id: ExampleId, files: Record<string, Uint8Array>, node: ExportOutputs, extra: string[] = []): Promise<ExportReport> {
  const report = JSON.parse(text(files['report.json'])) as ExportReport;
  const want = node.report!;
  expect(report.params).toEqual(want.params);
  const { t } = report.params.silicone;
  const glue = report.params.base.mode === 'glue';
  const names = ['README.txt', 'base.stl', 'cover.stl', 'project.json', 'report.json', ...(report.params.funnel.generate ? ['funnel.stl'] : []), ...(glue ? ['model_oriented.stl'] : []), ...extra];
  expect(Object.keys(files).sort()).toEqual(names.sort());

  // model_oriented.stl is the file's own triangles, so its edges are the input's: the barrel's file has 12
  // non-manifold ones. Every part the app builds has none of any kind.
  const input = loadExample(id).audit;
  for (const name of Object.keys(node.files).filter((n) => n.endsWith('.stl'))) {
    const bytes = files[name];
    expect(text(bytes.subarray(0, 5)).toLowerCase(), name).not.toBe('solid');
    expect(parseStl(bytes).format, name).toBe('binary');
    const edges = name === 'model_oriented.stl' ? { openEdges: 0, nonManifoldEdges: input.nonManifoldEdges, misorientedEdges: input.misorientedEdges } : { openEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 };
    expect(readPart(bytes).audit, name).toMatchObject(edges);
    const volume = stlVolume(bytes), expected = stlVolume(node.files[name]);
    expect(Math.abs(volume - expected) / expected, `${name}: ${volume} against ${expected} in Node`).toBeLessThanOrEqual(0.001);
  }
  if (glue) expect(parseStl(files['model_oriented.stl']).rawTriangleCount).toBe(parseStl(exampleBytes(id)).triangleCount);

  expect(report.clearance.measured!).toBeGreaterThanOrEqual(t);
  // Every figure of report.json as Node has it (box, openings, silicone, clearance, parts, diagnostics,
  // model and plane), all but the timings, which differ from run to run; and README.txt, made from them.
  const { timings: _browserTimings, ...browserReport } = report;
  const { timings: _nodeTimings, ...nodeReport } = want;
  expect(browserReport).toEqual(nodeReport);
  expect(text(files['README.txt'])).toBe(text(node.files['README.txt']));

  // Reassembly, on what a user would print: the parts taken back from their print poses to the mold.
  withArena(await api(), (arena) => {
    const rim = node.rim!;
    const cover = unpose(arena, files['cover.stl'], coverPose(rim));
    const base = unpose(arena, files['base.stl'], basePose(rim));
    const mesh = glue ? readPart(files['model_oriented.stl']).mesh : orientedExample(id).mesh;
    const model = importSolid(arena, mesh, auditEdges(mesh)).solid!;
    const copies = arena.track(arena.api.Manifold.compose(report.tiles.map(([x, y]) => arena.track(model.translate([x, y, 0])))));
    // Past t, so a gap below it reads as it is; the full model, not the export's decimated copy.
    const search = t + 0.5;
    const gap = copies.minGap(cover, search);
    expect(gap, `${id}: minGap of the model and the cover`).toBeGreaterThanOrEqual(t);
    // minGap returns no more than its search, so a cover put back far from the model would read t + 0.5.
    // The full model lies within the decimation's error of the copy the export measured, and both
    // files carry float32 corners, so the gap is the export's to that and a float step.
    expect(gap, `${id}: minGap within its search`).toBeLessThan(search);
    expect(gap, `${id}: minGap against the export's own`).toBeGreaterThanOrEqual(report.clearance.measured! - 0.002);
    expect(gap, `${id}: minGap against the export's own`).toBeLessThanOrEqual(report.clearance.minGap! + report.clearance.decimationError! + 0.002);
    // The base rests on the cover's shelf: in contact, and not in each other.
    expect(base.minGap(cover, 0.05), `${id}: the base on the cover's shelf`).toBeLessThan(0.01);
    expect(arena.track(cover.intersect(base)).volume(), `${id}: cover and base overlap`).toBeLessThan(0.1);
  });

  const readme = text(files['README.txt']);
  expect(/[^\r]\n/.test(readme)).toBe(false);
  // Plain ASCII in lines of at most 76, which Notepad shows as they are.
  expect([...readme].filter((c) => c.charCodeAt(0) > 126 || (c.charCodeAt(0) < 32 && c !== '\r' && c !== '\n'))).toEqual([]);
  expect(readme.split('\r\n').filter((line) => line.length > 76)).toEqual([]);
  const flat = readme.replace(/\r\n\s*/g, ' ');
  for (const phrase of ['POURING', 'Fit the base into the cover', 'Tape the joint all round', 'until silicone shows at every vent', 'DEMOLDING', 'Cut the sprues', 'slide the silicone out of the cover with the model still inside it', 'Put the silicone back into the cover', 'The sprue rule', 'Cut that sprue at the floor of the seat', 'Cure-inhibition test', 'Leak test']) {
    expect(flat, phrase).toContain(phrase);
  }
  expect(flat).toContain(`Measured clearance: ${report.clearance.measured!.toFixed(2)} mm`);
  return report;
}

test.describe('the Export box on index.html', () => {
  let watch: PageWatch;
  let dialogs: string[];
  test.beforeEach(async ({ page }) => {
    test.skip(!canDraw(page), NO_FIREFOX_WEBGL);
    dialogs = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    watch = await openApp(page);
  });
  test.afterEach(() => {
    expect(watch.errors).toEqual([]);
    expect(watch.foreign).toEqual([]);
    expect(dialogs).toEqual([]);
  });

  test('@smoke Export ZIP: Cancel mid-export terminates its worker and leaves no download, the box recovers, the next export checks out in Node, and the strip shows its clearance while current', async ({ page }) => {
    test.setTimeout(240_000);
    await dropAndWait(page, EXAMPLE_FILES.jersey);
    const downloads: string[] = [];
    page.on('download', (d) => downloads.push(d.suggestedFilename()));
    const workers = (): Promise<WorkerRecord[]> => hooks(page, (h) => h.solidWorkers());
    const spawned = (await workers()).length;

    // Held at its clearance step, the stage bar takes the button's place, and the layout still holds.
    await hooks(page, (h) => h.armFault('export', { kind: 'delay', ms: 120_000, at: 'clearance' }));
    await page.getByTestId('export-zip').click();
    await expect(page.getByTestId('stage-bar')).toHaveAttribute('data-step', 'clearance');
    await expect(page.getByTestId('stage-label')).toHaveText('Measuring the silicone clearance…');
    await expect(page.getByTestId('stage-bar').locator('[role="progressbar"]')).toHaveAttribute('aria-valuenow', '5');
    await expect(page.getByTestId('export-zip')).toHaveCount(0);
    for (const id of BUTTONS.slice(1)) await expect(page.getByTestId(id)).toBeDisabled();
    expect(await hooks(page, (h) => h.exporting())).toEqual({ active: true, worker: true });
    expect((await workers()).slice(spawned)).toEqual([expect.objectContaining({ terminated: false })]);
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await checkLayout(page, watch);
    }
    await page.setViewportSize(SIZES[0]);
    await page.getByTestId('export-cancel').click();
    await expect(page.getByTestId('stage-bar')).toHaveCount(0);
    await expect(page.getByTestId('export-outcome')).toHaveText('Export cancelled. Nothing was saved.');
    for (const id of BUTTONS) await expect(page.getByTestId(id)).toBeEnabled();
    expect(await hooks(page, (h) => h.exporting())).toEqual({ active: false, worker: false });
    // The worker itself was terminated, not just let go by the pipeline.
    expect((await workers()).slice(spawned)).toEqual([expect.objectContaining({ terminated: true, afterTerminate: 0 })]);
    await expect(page.getByTestId('status-clearance')).toHaveText('clearance ≥ 3.00 mm, planned');

    // Held for a moment only, so a worker that Cancel left running would finish within the wait below
    // and answer. Cancel is clicked once its guard against a double-click's second click has passed.
    await hooks(page, (h) => h.armFault('export', { kind: 'delay', ms: 1_500, at: 'clearance' }));
    const clicked = Date.now();
    await page.getByTestId('export-zip').click();
    await expect(page.getByTestId('stage-bar')).toHaveAttribute('data-step', 'clearance');
    await page.waitForTimeout(Math.max(0, 500 - (Date.now() - clicked)));
    await page.getByTestId('export-cancel').click();
    await expect(page.getByTestId('export-outcome')).toHaveText('Export cancelled. Nothing was saved.');
    const held = (await workers()).at(-1)!;
    // The hold, plus several times what the rest of jersey's export takes here.
    await page.waitForTimeout(1_500 + 2_000);
    expect(downloads).toEqual([]);
    expect((await workers()).at(-1)).toEqual({ ...held, terminated: true, afterTerminate: 0 });
    expect((await workers()).length).toBe(spawned + 2);

    // A double-click on the right end of Export ZIP puts its second click on Cancel, which does not take it.
    // The second click comes 80 ms after the first, as a hand makes it, on Cancel. (Here the box also
    // loses its outcome line as the bar comes, which moves the bar down, so the click goes where Cancel is now.)
    const zipBox = (await page.getByTestId('export-zip').boundingBox())!;
    const doubled = page.waitForEvent('download');
    await page.mouse.move(zipBox.x + zipBox.width - 12, zipBox.y + zipBox.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(80);
    const cancelBox = (await page.getByTestId('export-cancel').boundingBox())!;
    await page.mouse.move(cancelBox.x + cancelBox.width / 2, cancelBox.y + cancelBox.height / 2);
    await page.mouse.down({ clickCount: 2 });
    await page.mouse.up({ clickCount: 2 });
    await expect(page.getByTestId('stage-bar')).toBeVisible();
    expect((await doubled).suggestedFilename()).toBe('jersey-barrier-mold.zip');
    await expect(page.getByTestId('export-outcome')).toHaveText(/^Saved jersey-barrier-mold\.zip\./);
    downloads.length = 0;
    // From the keyboard, Cancel takes the focus while the bar shows, and Export ZIP gets it back after.
    await page.getByTestId('export-zip').focus();
    const keyed = page.waitForEvent('download');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('export-cancel')).toBeFocused();
    await keyed;
    await expect(page.getByTestId('export-zip')).toBeFocused();
    downloads.length = 0;

    // The next export runs to the end, with the fit-test pieces as fit_test/, built in Node meanwhile.
    await page.getByTestId('export-fit-option').check();
    const node = inNode('jersey', () => {}, (p) => p.exportParts(() => {}, undefined, { want: 'zip', fitTest: true }));
    const saved = await saveFrom(page, 'export-zip');
    expect(saved.name).toBe('jersey-barrier-mold.zip');
    const files = unzipSync(saved.bytes);
    const fit = Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith('fit_test/')));
    const report = await checkZip('jersey', files, await node, Object.keys(fit));
    await checkPieces(fit, defaultParams());
    expect(text(files['README.txt'])).toContain('fit_test/');
    const measured = `clearance measured ${report.clearance.measured!.toFixed(2)} mm`;
    await expect(page.getByTestId('status-clearance')).toHaveText(measured);
    await expect(page.getByTestId('export-outcome')).toHaveText(`Saved jersey-barrier-mold.zip. Measured clearance ${report.clearance.measured!.toFixed(2)} mm.`);
    expect(downloads).toEqual(['jersey-barrier-mold.zip']);

    // A change while an export runs does not end it. The clearance it measured then holds only while
    // the geometry is the one it measured.
    await hooks(page, (h) => h.armFault('export', { kind: 'delay', ms: 1_500, at: 'cover' }));
    const later = page.waitForEvent('download');
    await page.getByTestId('export-zip').click();
    await expect(page.getByTestId('stage-bar')).toHaveAttribute('data-step', 'cover');
    await hooks(page, (h) => h.setParam('silicone.t', 3.5));
    expect((await later).suggestedFilename()).toBe('jersey-barrier-mold.zip');
    await idle(page);
    await expect(page.getByTestId('status-clearance')).toHaveText('clearance ≥ 3.50 mm, planned');
    // The box says the file it saved is not the mold on screen, until the screen is that mold again.
    const outdated = 'Saved jersey-barrier-mold.zip, made with the settings before your last change. Export again for the current ones.';
    await expect(page.getByTestId('export-outcome')).toHaveText(outdated);
    await expect(page.getByTestId('export-outcome')).toHaveClass(/warning/);
    await hooks(page, async (h) => {
      h.setParam('silicone.t', 3);
      await h.idle();
    });
    await expect(page.getByTestId('status-clearance')).toHaveText(measured);
    await expect(page.getByTestId('export-outcome')).toHaveText(`Saved jersey-barrier-mold.zip. Measured clearance ${report.clearance.measured!.toFixed(2)} mm.`);
    // Any later change says so too.
    await hooks(page, (h) => h.setParam('cover.wall', 3.5));
    await expect(page.getByTestId('export-outcome')).toHaveText(outdated);
    expect(downloads).toHaveLength(2);
  });

  test('@smoke single parts save the ZIP\'s own files in print pose, the fit test is a ZIP at the user\'s taper clearance, and the funnel starts hidden', async ({ page }) => {
    test.setTimeout(240_000);
    await dropAndWait(page, EXAMPLE_FILES.jersey);

    // The funnel is a print of its own: hidden at first, its eye shows one on each pour.
    const eye = page.locator('[data-part="funnel"] .eye');
    const funnelShown = (): Promise<boolean> => app(page, (a) => a.scene.partStyles().funnel!.visible);
    await expect(eye).toHaveAttribute('aria-pressed', 'false');
    expect(await funnelShown()).toBe(false);
    const pours = await hooks(page, (h) => h.openings().filter((o) => o.kind === 'pour').length);
    expect(await app(page, (a) => (a.scene as unknown as { funnels: { children: unknown[] } }).funnels.children.length)).toBe(pours);
    const hidden = await canvasPixels(page);
    await eye.click();
    await expect.poll(async () => (await canvasPixels(page)).equals(hidden)).toBe(false);
    expect(await funnelShown()).toBe(true);
    await eye.click();
    expect(await funnelShown()).toBe(false);

    // Before any ZIP, each part runs an export of its own.
    const singles = { cover: await saveFrom(page, 'export-cover'), base: await saveFrom(page, 'export-base'), funnel: await saveFrom(page, 'export-funnel') };
    expect(Object.values(singles).map((s) => s.name)).toEqual(['jersey-barrier-cover.stl', 'jersey-barrier-base.stl', 'jersey-barrier-funnel.stl']);
    const zip = unzipSync((await saveFrom(page, 'export-zip')).bytes);
    for (const [part, saved] of Object.entries(singles)) expect(saved.bytes, part).toEqual(zip[`${part}.stl`]);
    // After the ZIP, a part comes from the files it holds, with no worker started.
    const spawned = (await hooks(page, (h) => h.solidWorkers())).length;
    const reused = await saveFrom(page, 'export-cover');
    expect(reused.name).toBe('jersey-barrier-cover.stl');
    expect(reused.bytes).toEqual(zip['cover.stl']);
    expect((await hooks(page, (h) => h.solidWorkers())).length).toBe(spawned);
    // Each in its print pose: the cover's flat top, the base's underside and the funnel's rim on the bed.
    const report = JSON.parse(text(zip['report.json'])) as ExportReport;
    const params = report.params;
    const bed = (bytes: Uint8Array): { min: number; max: number; area: number; reach: number } => {
      const p = parseStl(bytes).positions;
      let min = Infinity, max = -Infinity, area = 0, reach = 0;
      for (let i = 0; i < p.length; i += 9) {
        for (let k = 0; k < 9; k += 3) {
          min = Math.min(min, p[i + k + 2]);
          max = Math.max(max, p[i + k + 2]);
          if (Math.abs(p[i + k + 2]) < 1e-4) reach = Math.max(reach, Math.hypot(p[i + k], p[i + k + 1]));
        }
        const flat = [2, 5, 8].every((k) => Math.abs(p[i + k]) < 1e-4);
        const nz = (p[i + 3] - p[i]) * (p[i + 7] - p[i + 1]) - (p[i + 4] - p[i + 1]) * (p[i + 6] - p[i]);
        if (flat && nz < 0) area -= nz / 2;
      }
      return { min, max, area, reach };
    };
    const cover = bed(singles.cover.bytes), base = bed(singles.base.bytes), funnel = bed(singles.funnel.bytes);
    const top = report.box.x * report.box.y;
    expect(cover.min).toBeCloseTo(0, 4);
    expect(cover.max).toBeCloseTo(report.box.Zt + report.box.Tb - params.joint.baseProud, 3);
    // The flat top, less the openings in it and the chamfer round its edge.
    expect(cover.area / top).toBeGreaterThan(0.85);
    expect(base.min).toBeCloseTo(0, 4);
    expect(base.area / top).toBeGreaterThan(0.6);
    expect(funnel.min).toBeCloseTo(0, 4);
    expect(funnel.reach).toBeCloseTo(params.funnel.topDiameter / 2, 1);

    // The fit test: its own ZIP, with the groove series at the taper clearance the user has.
    await hooks(page, (h) => h.setParam('joint.taperClearance', 0.2));
    const fit = await saveFrom(page, 'export-fit-test');
    expect(fit.name).toBe('jersey-barrier-fit-test.zip');
    const files = unzipSync(fit.bytes);
    const chosen = defaultParams();
    chosen.joint.taperClearance = 0.2;
    await checkPieces(files, chosen);
    expect(Object.keys(files)).toContain('fit_test/groove-0.35-taper-0.20_cover.stl');
  });

  test('@smoke the buttons say why they are off with no model or a hard error, look off in both themes, and what only the export finds shows inline and in Diagnostics', async ({ page }) => {
    /** How far the Export ZIP button's fill stands out from the panel under it, as a contrast ratio, opacity included. */
    const standout = (): Promise<number> =>
      page.evaluate(() => {
        const rgb = (colour: string): number[] => colour.match(/[\d.]+/g)!.map(Number);
        const lum = ([r, g, b]: number[]): number => [r, g, b].map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)).reduce((sum, v, k) => sum + v * [0.2126, 0.7152, 0.0722][k], 0);
        const button = getComputedStyle(document.querySelector('[data-testid="export-zip"]')!);
        const panel = rgb(getComputedStyle(document.querySelector('[data-testid="export"]')!).backgroundColor);
        const fill = rgb(button.backgroundColor);
        const alpha = (fill[3] ?? 1) * Number(button.opacity);
        const seen = panel.slice(0, 3).map((v, k) => fill[k] * alpha + v * (1 - alpha));
        const [a, b] = [lum(seen), lum(panel)].sort((x, y) => y - x);
        return (a + 0.05) / (b + 0.05);
      });
    const reason = 'Load a model to export its mold.';
    for (const theme of ['dark', 'light']) {
      if (theme === 'light') await page.getByTestId('theme').click();
      for (const id of BUTTONS) {
        await expect(page.getByTestId(id)).toBeDisabled();
        await expect(page.getByTestId(id)).toHaveAttribute('title', reason);
      }
      await expect(page.getByTestId('export-reason')).toHaveText(reason);
      expect(await standout(), `disabled in the ${theme} theme`).toBeLessThan(1.5);
    }
    await dropAndWait(page, EXAMPLE_FILES.jersey);
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') await page.getByTestId('theme').click();
      for (const id of BUTTONS) await expect(page.getByTestId(id)).toBeEnabled();
      await expect(page.getByTestId('export-reason')).toHaveCount(0);
      expect(await standout(), `enabled in the ${theme} theme`).toBeGreaterThan(3);
    }

    // A hard error turns them off, with the error as the reason, until it is fixed.
    await hooks(page, async (h) => {
      h.setParam('seat.depth', 4.5);
      await h.idle();
    });
    for (const id of BUTTONS) await expect(page.getByTestId(id)).toBeDisabled();
    await expect(page.getByTestId('export-reason')).toContainText('Fix this first: A seat 4.5 mm deep');
    await hooks(page, async (h) => {
      h.setParam('seat.depth', 3);
      await h.idle();
    });
    for (const id of BUTTONS) await expect(page.getByTestId(id)).toBeEnabled();
    // Generating no funnel leaves nothing for its button to save, which a line under the buttons says too.
    await hooks(page, (h) => h.setParam('funnel.generate', false));
    await expect(page.getByTestId('export-funnel')).toBeDisabled();
    await expect(page.getByTestId('export-funnel')).toHaveAttribute('title', 'The funnel is turned off under Pour & funnel.');
    await expect(page.getByTestId('export-reason-funnel')).toHaveText('The funnel is turned off under Pour & funnel.');
    await hooks(page, async (h) => {
      h.setParam('funnel.generate', true);
      await h.idle();
    });
    await expect(page.getByTestId('export-reason-funnel')).toHaveCount(0);

    // An engine crash at export is retried at a coarser cell. Only the export knows, and it says so in
    // the Export box and in Diagnostics, never in an alert.
    await hooks(page, (h) => h.armFault('export', { kind: 'oob' }));
    const saved = await saveFrom(page, 'export-zip');
    expect(saved.name).toBe('jersey-barrier-mold.zip');
    await expect(page.locator('.export-note.warning[data-code="export-coarser"]')).toContainText('built again at half the detail, on a 0.25 mm grid instead of 0.125 mm');
    await expect(page.locator('.diagnostic[data-code="export-coarser"] .where')).toHaveText('Found by the last export');
    const report = JSON.parse(text(unzipSync(saved.bytes)['report.json'])) as ExportReport;
    expect(report.diagnostics.map((d) => d.code)).toContain('export-coarser');
    expect(text(unzipSync(saved.bytes)['README.txt']).replace(/\r\n\s*/g, ' ')).toContain('Warning: The geometry engine failed at full detail, so the export was built again at half the detail');
    // A change of the mold leaves it behind, along with the clearance that export measured.
    await hooks(page, async (h) => {
      h.setParam('silicone.t', 3.2);
      await h.idle();
    });
    await expect(page.locator('[data-code="export-coarser"]')).toHaveCount(0);

    // A file saved although the export found an error in it says so in its outcome, in the error style.
    // No example makes one, so the export's reply gains one on its way to the box.
    await app(page, (a) => {
      const pipeline = a.store.pipeline;
      const real = pipeline.exportParts.bind(pipeline);
      pipeline.exportParts = async (...args) => {
        pipeline.exportParts = real;
        const outputs = await real(...args);
        return { ...outputs, diagnostics: [...outputs.diagnostics, { code: 'clearance-short', severity: 'error', message: 'Even after a wider safety margin, the silicone is only 2.95 mm thick at its thinnest.' }] };
      };
    });
    await saveFrom(page, 'export-zip');
    await expect(page.getByTestId('export-outcome')).toHaveText('Saved jersey-barrier-mold.zip, but the export found an error: Even after a wider safety margin, the silicone is only 2.95 mm thick at its thinnest.');
    await expect(page.getByTestId('export-outcome')).toHaveClass(/error/);
  });
});

interface ZipCase {
  name: string;
  id: ExampleId;
  settings: Settings;
  projects: string[];
  /** report.json's silicone, in ml, as M6b measured it in Node: the plan's figure at the export cell. */
  ml: number;
}

/** M6b's silicone at defaults, per example. */
const ML: Record<ExampleId, number> = { benchy: 43.1771, goddess: 118.0047, vis35: 541.4064, jersey: 11.3591, x8: 87.5913, barrel: 10.2682, wolf: 203.5269 };

// All 7 in Chromium on the build; in the user's browser, jersey and the heaviest field, wolf.
const CASES: ZipCase[] = [
  ...EXAMPLE_IDS.map((id): ZipCase => ({ name: id, id, settings: [], projects: id === 'jersey' || id === 'wolf' ? ['preview', 'firefox'] : ['preview'], ml: ML[id] })),
  { name: 'barrel in Mode B', id: 'barrel', settings: [['base.mode', 'merged']], projects: ['preview'], ml: 10.2682 },
  { name: 'jersey on a 2 x 3 grid', id: 'jersey', settings: [['grid.nx', 2], ['grid.ny', 3]], projects: ['preview'], ml: 68.1545 },
];

test.describe('Export ZIP on every example, unzipped and checked in Node', () => {
  test.skip(!FULL, 'all 7 run with CFG_FULL=1');
  for (const c of CASES) {
    test(`${c.name}: the ZIP from the button checks out against a Node build`, async ({ page }, info) => {
      test.skip(!c.projects.includes(info.project.name), `runs in ${c.projects.join(' and ')}`);
      test.skip(!canDraw(page), NO_FIREFOX_WEBGL);
      test.setTimeout(420_000);
      const dialogs: string[] = [];
      page.on('dialog', (dialog) => {
        dialogs.push(dialog.message());
        void dialog.dismiss();
      });
      const watch = await openApp(page);
      await hooks(page, (h, settings: Settings) => settings.forEach(([path, value]) => h.setParam(path, value)), c.settings);
      await dropAndWait(page, EXAMPLE_FILES[c.id]);
      // A grid's walls are checked at the export cell once the preview settles, and the files carry what it found.
      const grid = c.settings.some(([path, value]) => path.startsWith('grid.') && value !== 1);
      if (grid) await expect.poll(() => hooks(page, (h) => h.walls().result !== null), { timeout: 120_000 }).toBe(true);
      // Built in Node while the browser builds its own.
      const node = inNode(c.id, applyInNode(c.settings), (p) => p.exportParts(), { checkWalls: true });
      const saved = await saveFrom(page, 'export-zip');
      expect(saved.name).toBe(`${EXAMPLE_FILES[c.id].replace(/\.stl$/i, '')}-mold.zip`);
      const report = await checkZip(c.id, unzipSync(saved.bytes), await node);
      expect(Math.abs(report.silicone.ml / c.ml - 1), `${report.silicone.ml} ml against ${c.ml}`).toBeLessThan(0.001);
      // The worker's own total: the test's clock also counts the Node build, which holds up this process.
      console.log(`${info.project.name} ${c.name}: export ${Math.round(report.timings.total)} ms in the browser's worker, clearance ${report.clearance.measured!.toFixed(4)} mm, ${report.silicone.ml.toFixed(4)} ml, ${saved.bytes.length} bytes`);
      await expect(page.getByTestId('status-clearance')).toHaveText(`clearance measured ${report.clearance.measured!.toFixed(2)} mm`);
      expect(watch.errors).toEqual([]);
      expect(watch.foreign).toEqual([]);
      expect(dialogs).toEqual([]);
    });
  }
});
