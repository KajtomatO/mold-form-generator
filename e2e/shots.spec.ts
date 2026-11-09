import { mkdirSync, readFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { ParamPath } from '../src/app/stages';
import { heightBlockStl } from '../test/fixtures/heavy';
import { EXAMPLE_FILES, loadManifold } from '../test/fixtures/loadExamples';
import { asciiStl, box, patchedL, toSoup } from '../test/fixtures/synthetic';
import { benchyLetterSpots } from './spots';
import { app, canDraw, dropAndWait, dropExample, hooks, openApp } from './appHarness';
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
  /** The sidebar section scrolled to the top, Advanced opened first; 'bolts' is the Bolts group's heading. */
  scroll?: 'base' | 'cover' | 'pour' | 'grid' | 'demold' | 'advanced' | 'bolts';
  /** M10: settings made before the model is dropped, such as the bolts turned on. */
  settings?: [ParamPath, unknown][];
  /** M10: the section across y through the front right bolt's axis, the camera close on that corner and square to the cut. */
  boltCut?: boolean;
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
  /**
   * M9: Save project pressed and the file opened again, so the row names the project; a file that is no
   * ZIP opened as a .moldproj, with its inline error; M8's version 1 project.json, with its notice; or
   * another STL dropped on a model with changes not saved, with the question it asks.
   */
  project?: 'opened' | 'corrupt' | 'migrated' | 'replace';
  /**
   * M11a: an STL that cannot be read opened over the model, with its inline error; an open mesh in soup mode,
   * standing on its underside, with the Base section's note; the 3 million triangle block in merged mode,
   * with its warning; a cut through one of Benchy's letters, close up; and jersey 20 x 1's last tile cut.
   */
  m11?: 'bad-file' | 'soup' | 'heavy' | 'lettering' | 'last-tile';
  /** M11c: the view moved clear of the Diagnostics card, which stands bottom-left when it holds no warning. */
  clearCard?: boolean;
}

// The sidebar's lower sections and the empty state, at fewer sizes: their layout does not change with the model.
const SIDEBAR_SETS = (browser: Browser, width: number, theme: Theme): boolean => (browser === 'firefox' ? width === 1366 && theme === 'dark' : (width === 1366) === (theme === 'dark'));
// The export: every size and theme in Chromium, and the user's browser at 1366 x 768 in the dark theme.
const EXPORT_SETS = (browser: Browser, width: number, theme: Theme): boolean => browser === 'chromium' || (width === 1366 && theme === 'dark');
// M7's reports take the same sets as the export, and so do M8's view tools and M9's project files.
const REPORT_SETS = EXPORT_SETS;
const VIEW_SETS = EXPORT_SETS;
const PROJECT_SETS = EXPORT_SETS;
// M10's bolts: every size and theme in Chromium, and the user's browser at 1366 x 768, dark.
const BOLT_SETS = EXPORT_SETS;
// M11a's: the export's sets, every size and theme in Chromium, and the user's browser at 1366 x 768, dark.
const M11_SETS = EXPORT_SETS;
// M11c's: 1366 x 768 in both themes in Chromium, and the user's browser at 1366 x 768, dark.
const M11C_SETS = (browser: Browser, width: number, theme: Theme): boolean => width === 1366 && (browser === 'chromium' || theme === 'dark');
const V1_PROJECT = readFileSync(join(import.meta.dirname, '..', 'test', 'fixtures', 'projects', 'v1-jersey-export.json'));

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
  // The Save and Open controls with a model loaded: the jersey shot of the Model section at the top.
  { name: 'jersey-save-open', file: EXAMPLE_FILES.jersey, grid: [1, 1], only: PROJECT_SETS },
  { name: 'jersey-project-opened', file: EXAMPLE_FILES.jersey, grid: [1, 1], project: 'opened', only: PROJECT_SETS },
  { name: 'jersey-project-corrupt', file: EXAMPLE_FILES.jersey, grid: [1, 1], project: 'corrupt', only: PROJECT_SETS },
  { name: 'jersey-project-migrated', file: EXAMPLE_FILES.jersey, grid: [1, 1], project: 'migrated', only: PROJECT_SETS },
  { name: 'jersey-replace-prompt', file: EXAMPLE_FILES.jersey, grid: [1, 1], project: 'replace', only: PROJECT_SETS },
  // M10: the Bolts group with its rows and the bolt list; a cut through a bolt, showing its countersink, holes,
  // nut slot and membrane; the parts apart; and a warning state, M4 on a 3 mm base with an 8 mm screw.
  { name: 'jersey-bolts-group', file: EXAMPLE_FILES.jersey, grid: [1, 1], settings: [['bolts.enabled', true]], scroll: 'bolts', only: BOLT_SETS },
  { name: 'jersey-bolts-section', file: EXAMPLE_FILES.jersey, grid: [1, 1], settings: [['bolts.enabled', true]], boltCut: true, scroll: 'bolts', only: BOLT_SETS },
  { name: 'jersey-bolts-exploded', file: EXAMPLE_FILES.jersey, grid: [1, 1], settings: [['bolts.enabled', true]], explode: true, only: BOLT_SETS },
  { name: 'jersey-bolts-warning', file: EXAMPLE_FILES.jersey, grid: [1, 1], settings: [['bolts.enabled', true], ['bolts.size', 'M4'], ['base.thickness', 3], ['bolts.length', 8]], scroll: 'bolts', only: BOLT_SETS },
  { name: 'jersey-bad-file', file: EXAMPLE_FILES.jersey, grid: [1, 1], m11: 'bad-file', only: M11_SETS },
  { name: 'soup-mode-note', file: null, grid: [1, 1], m11: 'soup', scroll: 'base', only: M11_SETS },
  { name: 'heavy-merged-warning', file: null, grid: [1, 1], m11: 'heavy', scroll: 'base', only: M11_SETS },
  { name: 'benchy-lettering-section', file: EXAMPLE_FILES.benchy, grid: [1, 1], m11: 'lettering', only: M11_SETS },
  { name: 'jersey-20x1-last-tile', file: EXAMPLE_FILES.jersey, grid: [20, 1], m11: 'last-tile', only: M11_SETS },
  // M11c: the user's multi-colour chick at defaults, one pour, its vent and the note on its parts, with the
  // opening rows and Export ZIP on; and a cut across x through its head, where the top part passes into the body.
  { name: 'chick-mc', file: EXAMPLE_FILES.chick, grid: [1, 1], scroll: 'pour', clearCard: true, only: M11C_SETS },
  { name: 'chick-mc-section-head', file: EXAMPLE_FILES.chick, grid: [1, 1], section: 'x', faceCut: true, only: M11C_SETS },
];

/** The soup-mode L standing on its underside, or the 3 million triangle block in merged mode, by the Open button's input. */
async function openM11(page: Page, kind: 'soup' | 'heavy', project: string): Promise<void> {
  const input = page.locator('[data-section="model"] input[type="file"]');
  if (kind === 'soup') {
    await input.setInputFiles({ name: 'patched-l.stl', mimeType: 'model/stl', buffer: Buffer.from(asciiStl(toSoup(patchedL(await loadManifold())), 'patched L')) });
    await expect.poll(() => app(page, (a) => a.store.pipeline.modelName)).toBe('patched-l.stl');
    await hooks(page, (h) => h.idle());
    await app(page, (a) => a.store.setPlane({ rank: a.store.pipeline.oriented!.value.candidates.findIndex((c) => c.normal[2] < -0.99), upper: false }));
  } else {
    const path = join(tmpdir(), `cfg-shot-heavy-${project}-${process.pid}.stl`);
    await writeFile(path, heightBlockStl());
    try {
      await input.setInputFiles(path);
      await expect(page.getByTestId('file-name')).toContainText('3,011,040 triangles', { timeout: 300_000 });
      await hooks(page, (h) => h.idle());
      await hooks(page, (h) => h.setParam('base.mode', 'merged'));
    } finally {
      await rm(path, { force: true });
    }
  }
  await hooks(page, (h) => h.idle());
}

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
          if (shot.settings) await hooks(page, (h, settings: [ParamPath, unknown][]) => settings.forEach(([path, value]) => h.setParam(path, value)), shot.settings);
          // The renderer card is what this server shows; it stays in one shot of the set to be reviewed there.
          const card = page.getByTestId('software-renderer');
          const keepCard = shot.name === 'benchy' && size.width === 1366 && theme === 'dark';
          if (shot.m11 === 'soup' || shot.m11 === 'heavy') await openM11(page, shot.m11, info.project.name);
          if (shot.file || shot.m11 === 'soup' || shot.m11 === 'heavy') {
            if (shot.file) await dropAndWait(page, shot.file);
            if (shot.grid[0] * shot.grid[1] > 1) await expect.poll(() => hooks(page, (h) => h.walls().result !== null), { timeout: 120_000 }).toBe(true);
            if (shot.name === 'vis35-two-levels') await expect(page.getByTestId('upper-level')).toBeVisible();
            const input = page.locator('[data-section="model"] input[type="file"]');
            if (shot.project === 'opened') {
              await hooks(page, (h) => h.setParam('silicone.t', 3.5));
              await hooks(page, (h) => h.idle());
              const download = page.waitForEvent('download');
              await page.getByTestId('save-project').click();
              const saved = await download;
              const bytes = await readFile(await saved.path());
              // Named as a maker might rename a copy, so the row shows the project's name beside the STL's.
              await input.setInputFiles({ name: 'jersey for the shelf.moldproj', mimeType: 'application/octet-stream', buffer: bytes });
              await expect(page.getByTestId('project-name')).toHaveText('jersey for the shelf.moldproj');
              await hooks(page, (h) => h.idle());
            } else if (shot.project === 'corrupt') {
              await input.setInputFiles({ name: 'jersey-barrier.moldproj', mimeType: 'application/octet-stream', buffer: Buffer.from('solid jersey\nendsolid jersey\n') });
              await expect(page.getByTestId('file-notice')).toHaveAttribute('data-severity', 'error');
            } else if (shot.project === 'migrated') {
              await input.setInputFiles({ name: 'project.json', mimeType: 'application/json', buffer: V1_PROJECT });
              await expect(page.getByTestId('file-notice')).toContainText('brought up to format 5');
              await hooks(page, (h) => h.idle());
            } else if (shot.m11 === 'bad-file') {
              const cube = new TextDecoder().decode(asciiStl(toSoup(box([0, 0, 0], [20, 20, 20])), 'cube'));
              await input.setInputFiles({ name: 'cube-cut-short.stl', mimeType: 'model/stl', buffer: Buffer.from(cube.slice(0, cube.lastIndexOf('vertex') + 12)) });
              await expect(page.getByTestId('file-notice')).toHaveAttribute('data-severity', 'error');
            } else if (shot.project === 'replace') {
              await hooks(page, (h) => h.setParam('silicone.t', 3.5));
              await hooks(page, (h) => h.idle());
              await dropExample(page, EXAMPLE_FILES.barrel);
              await expect(page.getByTestId('replace-prompt')).toBeVisible();
            }
            if (!keepCard && (await card.count()) > 0) await card.getByRole('button', { name: 'Dismiss' }).click();
            // The fixed camera: front right, above, at a distance set by the box. M11a's warnings move the
            // Diagnostics card to the top right, so there the view moves right and up by a share of the box,
            // which puts the mold to the left of the card and below it. A card of notes stays bottom-left, and
            // the view moves the other way (M11c).
            const clear = shot.m11 === 'soup' || shot.m11 === 'heavy' ? 1 : shot.clearCard ? -1 : 0;
            await hooks(page, (h, side: number) => {
              const { min, max } = h.partBounds('cover')!;
              const d = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
              // The screen's right, seen from (0.6, -1.4, 0.9), is (0.919, 0.394, 0); its up is near +z.
              const shift = [0.27 * 0.919 * d * side, 0.27 * 0.394 * d * side, 0.12 * d * side];
              const c = [0, 1, 2].map((k) => (min[k] + max[k]) / 2 + shift[k]);
              const far = side !== 0 ? 1.12 * d : d;
              h.setCamera({ position: [c[0] + 0.6 * far, c[1] - 1.4 * far, c[2] + 0.9 * far], target: [c[0], c[1], c[2]], fov: 35 });
            }, clear);
            expect(await app(page, (a) => a.store.pipeline.status().stale)).toBe(false);
          } else if ((await card.count()) > 0) {
            await card.getByRole('button', { name: 'Dismiss' }).click();
          }
          if (shot.show === 'hint') await page.locator('.cut-hint').first().getByRole('button', { name: 'Show' }).click();
          else if (shot.show) await page.locator(`.diagnostic[data-code="${shot.show}"]`).first().getByRole('button', { name: 'Show' }).click();
          if (shot.scroll === 'advanced') await page.locator('.advanced > summary').click();
          if (shot.scroll) {
            await page.locator(shot.scroll === 'bolts' ? '[data-testid="bolts-group"]' : `[data-section="${shot.scroll}"]`).evaluate((section) => {
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
          if (shot.boltCut) {
            await page.getByTestId('section').check();
            await page.locator('[data-cut="y"]').click();
            // The front right bolt: its slot opens through the right wall, so a cut across y shows all of it.
            const spot = await app(page, (a) => {
              const b = a.store.pipeline.field!.value.rim.bolts!;
              return { x: b.spots[1].x, y: b.spots[1].y, z: (b.bed + b.holeTop) / 2 };
            });
            await app(page, (a, y: number) => a.store.setSection({ at: y }), spot.y);
            // Close enough that the membrane, one 0.2 mm layer, shows as a band of its own.
            await hooks(page, (h, s: { x: number; y: number; z: number }) => h.setCamera({ position: [s.x + 2, s.y - 27, s.z + 6], target: [s.x + 2, s.y, s.z], fov: 35 }), spot);
          }
          if (shot.m11 === 'lettering') {
            // Across x through a letter's air, close up from the side the cut faces.
            await page.getByTestId('section').check();
            await page.locator('[data-cut="x"]').click();
            const at = benchyLetterSpots().air;
            await app(page, (a, x: number) => a.store.setSection({ at: x }), at[0]);
            // Seen from +x the screen's right is +y: the view moves right and up, so the letter sits clear of the card.
            await hooks(page, (h, v: number[]) => h.setCamera({ position: [v[0] + 12, v[1] - 0.2, v[2] + 4.3], target: [v[0], v[1] + 1.6, v[2] + 1.3], fov: 35 }), at);
          }
          if (shot.m11 === 'last-tile') {
            // Across y through the last tile's model, so the cut shows it centred, or not, along the row in its
            // cavity; the handle sits at the row's middle, out of the way.
            await page.getByTestId('section').check();
            await page.locator('[data-cut="y"]').click();
            const at = await app(page, (a) => {
              const p = a.store.pipeline, b = p.oriented!.value.bounds, [ox, oy] = p.field!.value.mold.offsets.at(-1)!;
              return [(b.min[0] + b.max[0]) / 2 + ox, (b.min[1] + b.max[1]) / 2 + oy, (b.max[2] - b.min[2]) / 2] as [number, number, number];
            });
            await app(page, (a, y: number) => a.store.setSection({ at: y }), at[1]);
            // Seen from -y the screen's right is +x: the view moves right and up, so the cut sits clear of the card.
            await hooks(page, (h, v: number[]) => h.setCamera({ position: [v[0] + 8, v[1] - 110, v[2] + 35], target: [v[0] + 28, v[1], v[2] + 10], fov: 35 }), at);
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
