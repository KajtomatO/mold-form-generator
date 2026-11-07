import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Store } from '../src/app/store';
import type { PreviewScene } from '../src/view/scene';
import { canDraw, hooks } from './pipelineHarness';

const examples = join(import.meta.dirname, '..', 'examples');

/** What a test learns about a page while it runs: errors, and every request that left for another host. */
export interface PageWatch {
  errors: string[];
  foreign: string[];
}

/**
 * Opens the app with the test hooks. Every request goes through a route, so one to any host but the
 * LAN address is refused and recorded: the app must work with no network past this server. The preview
 * server serves only the build, so there the route answers /examples from disk, as pipelineHarness does.
 */
export async function openApp(page: Page, query = ''): Promise<PageWatch> {
  const watch: PageWatch = { errors: [], foreign: [] };
  const host = new URL(test.info().project.use.baseURL!).hostname;
  page.on('pageerror', (e) => watch.errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') watch.errors.push(m.text());
  });
  const probe = await page.request.get('/examples/jersey-barrier.stl');
  const serveExamples = !probe.ok() || (probe.headers()['content-type'] ?? '').includes('html');
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol !== 'data:' && url.protocol !== 'blob:' && url.hostname !== host) {
      watch.foreign.push(url.href);
      await route.abort();
      return;
    }
    if (serveExamples && url.pathname.startsWith('/examples/')) {
      const name = decodeURIComponent(url.pathname.split('/').pop()!);
      await route.fulfill({ body: await readFile(join(examples, name)), contentType: 'model/stl' });
      return;
    }
    await route.continue();
  });
  await page.goto(`/?test=1${query}`);
  await expect(page).toHaveTitle('Casting Form Generator');
  await page.waitForFunction(() => '__pipeline' in window && '__app' in window);
  return watch;
}

/**
 * A real drop: the file fetched in the page, or the text given, wrapped in a DataTransfer and dropped on
 * the viewport or another element. Returns whether the page cancelled the drop, which keeps the browser
 * from opening or saving the file itself.
 */
export async function dropExample(page: Page, name: string, options: { on?: string; text?: string } = {}): Promise<boolean> {
  return page.evaluate(async ({ file, on, text }) => {
    const bytes = text !== undefined ? new TextEncoder().encode(text) : await (await fetch(`/examples/${encodeURIComponent(file)}`)).arrayBuffer();
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], file, { type: 'model/stl' }));
    const target = document.querySelector(on)!;
    let cancelled = true;
    for (const type of ['dragenter', 'dragover', 'drop']) {
      const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
      target.dispatchEvent(event);
      if (type !== 'dragenter') cancelled &&= event.defaultPrevented;
    }
    return cancelled;
  }, { file: name, on: options.on ?? '[data-testid="viewport"]', text: options.text });
}

export async function idle(page: Page): Promise<void> {
  await hooks(page, (h) => h.idle());
}

export async function dropAndWait(page: Page, name: string): Promise<void> {
  await dropExample(page, name);
  // The file is read before it reaches the pipeline, so wait for the pipeline to hold it first.
  await expect.poll(() => app(page, (a) => a.store.pipeline.modelName)).toBe(name);
  await idle(page);
}

/** Hides these parts by their eyes, clicking only the ones that show: the funnel starts hidden. */
export async function hideParts(page: Page, parts: string[]): Promise<void> {
  for (const part of parts) {
    const eye = page.locator(`[data-part="${part}"] .eye`);
    if ((await eye.getAttribute('aria-pressed')) === 'true') await eye.click();
    await expect(eye).toHaveAttribute('aria-pressed', 'false');
  }
}

/** Runs code in the page against the app's store and scene, as `hooks` does against the pipeline. */
export function app<R>(page: Page, run: (a: { store: Store; scene: PreviewScene }, arg: never) => R | Promise<R>, arg?: unknown): Promise<R> {
  return page.evaluate(
    ([source, a]) => {
      const fn = new Function(`return (${source})`)() as (x: unknown, arg: unknown) => unknown;
      return fn((window as unknown as { __app: unknown }).__app, a);
    },
    [run.toString(), arg] as const,
  ) as Promise<R>;
}

/**
 * What the 3D view itself drew, as a PNG of the canvas's own pixels, to compare two moments. Not a
 * screenshot of the page: the floating cards over the canvas would be in that, and a card that changes,
 * such as a pressed eye or the out-of-date badge, would pass for a change in the view.
 */
export async function canvasPixels(page: Page): Promise<Buffer> {
  const url = await page.evaluate(async () => {
    // The view draws on the next frame after a change; two frames make sure that one is on the canvas.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const canvas = document.querySelector('[data-testid="viewport"] canvas') as HTMLCanvasElement;
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext('2d')!.drawImage(canvas, 0, 0);
    return copy.toDataURL('image/png');
  });
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
}

/** How many of the canvas's own pixels are the silicone's teal, or near it. */
export async function tealPixels(page: Page): Promise<number> {
  return page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const canvas = document.querySelector('[data-testid="viewport"] canvas') as HTMLCanvasElement;
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext('2d')!;
    context.drawImage(canvas, 0, 0);
    const { data } = context.getImageData(0, 0, copy.width, copy.height);
    let count = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 1] > data[i] + 40 && data[i + 2] > data[i] + 30) count++;
    return count;
  });
}

/** The canvas pixel's colour at a point on the page, in CSS pixels, as the view drew it. */
export async function canvasColour(page: Page, at: { x: number; y: number }): Promise<[number, number, number]> {
  return page.evaluate(async ({ x, y }) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const canvas = document.querySelector('[data-testid="viewport"] canvas') as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext('2d')!;
    context.drawImage(canvas, 0, 0);
    const px = Math.round(((x - rect.left) / rect.width) * canvas.width), py = Math.round(((y - rect.top) / rect.height) * canvas.height);
    const [r, g, b] = context.getImageData(px, py, 1, 1).data;
    return [r, g, b] as [number, number, number];
  }, at);
}

/** The layout rules of the plan's GUI section, measured on the page as it stands. */
export async function checkLayout(page: Page, watch: PageWatch): Promise<void> {
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

export { canDraw, hooks };
