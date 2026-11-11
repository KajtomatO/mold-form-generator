import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import type { TestHooks } from '../src/app/testHooks';
import { missingExampleFiles } from '../test/fixtures/loadExamples';
import { firefoxHasDisplay } from './firefox';

const examples = join(import.meta.dirname, '..', 'examples');

/** Firefox has WebGL only on a display, which scripts/ci.sh gives it with xvfb-run when it can. */
export function canDraw(page: Page): boolean {
  return page.context().browser()?.browserType().name() !== 'firefox' || firefoxHasDisplay;
}

/**
 * Opens pipeline.html with the test hooks. Vite's dev server serves /examples from the project root, and
 * the preview server serves only the build, so there the test answers /examples itself from disk. On
 * every server an example not in this checkout gets a 404, as from a clone's server. Where the browser
 * cannot draw, the page opens without its 3D view, which only the view's own test needs.
 */
export async function openPipeline(page: Page, errors: string[] = [], query = ''): Promise<void> {
  if (!canDraw(page) && !query.includes('draw=0')) query += '&draw=0';
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  // The preview server answers an unknown path with index.html, so a 200 alone does not mean it is served.
  const probe = await page.request.get('/examples/jersey-barrier.stl');
  const serveExamples = !probe.ok() || (probe.headers()['content-type'] ?? '').includes('html');
  const missing = missingExampleFiles();
  if (serveExamples || missing.length > 0) {
    await page.route('**/examples/*', async (route) => {
      const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop()!);
      if (missing.includes(name)) await route.fulfill({ status: 404, body: `${name} is not in this checkout` });
      else if (serveExamples) await route.fulfill({ body: await readFile(join(examples, name)), contentType: 'model/stl' });
      else await route.continue();
    });
  }
  await page.goto(`/pipeline.html?test=1${query}`);
  await expect(page).toHaveTitle(/pipeline/);
  await page.waitForFunction(() => '__pipeline' in window);
}

/** Runs a hook in the page. */
export function hooks<R>(page: Page, run: (h: TestHooks, arg: never) => R | Promise<R>, arg?: unknown): Promise<R> {
  return page.evaluate(
    ([source, a]) => {
      const fn = new Function(`return (${source})`)() as (h: TestHooks, arg: unknown) => unknown;
      return fn((window as unknown as { __pipeline: TestHooks }).__pipeline, a);
    },
    [run.toString(), arg] as const,
  ) as Promise<R>;
}

export async function loadAndWait(page: Page, name: string): Promise<void> {
  await hooks(page, async (h, n: string) => {
    await h.load(n);
    await h.idle();
  }, name);
}
