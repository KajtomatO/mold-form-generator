import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { unzipSync } from 'fflate';
import { expect, test, type Page } from '@playwright/test';
import { shownDate } from '../src/app/buildInfo';
import type { TestHooks } from '../src/app/testHooks';
import { app, canDraw, checkLayout, dropAndWait, type PageWatch } from './appHarness';
import { NO_FIREFOX_WEBGL } from './firefox';

/**
 * R1: the GitHub Pages layout, as scripts/build-pages.sh makes it and as the site serves it, under
 * /mold-form-generator/ with the beta site at /mold-form-generator/beta/. The script builds committed refs
 * only, and this checkout may hold changes not yet committed, so the test commits a snapshot of the working
 * tree (tracked and new files, ignored ones left out) into a scratch repository outside this one and builds
 * that HEAD for both sites, with the script as it is in the snapshot. With no changes the snapshot is HEAD.
 * The examples are not copied, as the build does not use them; the server below hands them out from here.
 */
const SHOTS = process.env.CFG_SHOTS === '1';
const SHOTS_DIR = process.env.CFG_SHOTS_DIR ?? join(import.meta.dirname, '..', 'test-results', 'shots');
const root = join(import.meta.dirname, '..');
const PREFIX = '/mold-form-generator/';
const PAGES = ['index.html', 'diag.html', 'bench.html', 'pipeline.html'];
const SNAPSHOT_DATE = '2026-01-02T03:04:05+01:00';
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.stl': 'model/stl',
};

interface Site {
  /** The stable site's address, ending in /mold-form-generator/. */
  url: string;
  /** The snapshot's short commit, which both sites were built from. */
  commit: string;
  /** That commit's date, as the header's tooltip shows it. */
  date: string;
  /** Every request the server answered, with its status, as GitHub Pages would answer it. */
  log: { path: string; status: number }[];
  close(): Promise<void>;
}

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

/** The working tree, committed into a scratch repository, and both sites built from it into `out`. */
function buildSite(scratch: string): { out: string; commit: string; date: string } {
  const repo = join(scratch, 'repo');
  const files = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0');
  for (const file of files.filter((f) => f && !f.startsWith('examples/') && existsSync(join(root, f)))) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    copyFileSync(join(root, file), join(repo, file));
  }
  symlinkSync(join(root, 'node_modules'), join(repo, 'node_modules'));
  git(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, '.git', 'info', 'exclude'), 'node_modules\n');
  git(repo, ['add', '-A']);
  // A date well before the build, so the tooltip shows the commit's date only if the script passes it on.
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'snapshot of the working tree'], { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: SNAPSHOT_DATE, GIT_COMMITTER_DATE: SNAPSHOT_DATE } });
  const out = join(scratch, 'site');
  mkdirSync(join(scratch, 'tmp'));
  try {
    execFileSync('bash', [join(repo, 'scripts', 'build-pages.sh'), 'HEAD', 'HEAD', out], { cwd: repo, env: { ...process.env, TMPDIR: join(scratch, 'tmp') }, stdio: 'pipe' });
  } catch (error) {
    // Vite's warnings would fill the test's output on every run, so the script's are shown only when it fails.
    throw new Error(`scripts/build-pages.sh failed: ${String((error as { stderr?: Buffer }).stderr ?? error)}`);
  }
  // The script wrote nowhere but `out`: the snapshot is as committed, with no worktree left, and the site
  // has the file that keeps a copy served from a branch away from Jekyll.
  expect(git(repo, ['status', '--porcelain'])).toBe('');
  expect(git(repo, ['worktree', 'list', '--porcelain']).split('\n').filter((line) => line.startsWith('worktree '))).toEqual([`worktree ${repo}`]);
  expect(existsSync(join(out, '.nojekyll'))).toBe(true);
  expect(git(repo, ['show', '-s', '--format=%cI', 'HEAD'])).toBe(SNAPSHOT_DATE);
  return { out, commit: git(repo, ['rev-parse', '--short=7', 'HEAD']), date: shownDate(new Date(SNAPSHOT_DATE).toISOString()) };
}

/** A static server as GitHub Pages is one: the site under its prefix, a folder to its index.html, a 404 for anything else. */
function serve(out: string, host: string, log: Site['log']): Promise<Server> {
  const examples = join(root, 'examples');
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
    const answer = (status: number, body: Buffer | string = '', type = 'text/plain; charset=utf-8', headers: Record<string, string> = {}): void => {
      log.push({ path, status });
      // GitHub Pages lets browsers keep files for 10 minutes. Here every load reaches the server, so the log
      // holds every file each page asks for, also one an earlier page of the test already loaded.
      response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
      response.end(body);
    };
    // The test hooks fetch the examples from the host's root, so they are answered there.
    let base: string, rest: string;
    if (path.startsWith('/examples/')) [base, rest] = [examples, path.slice('/examples/'.length)];
    else if (path.startsWith(PREFIX)) [base, rest] = [out, path.slice(PREFIX.length)];
    else if (path === PREFIX.slice(0, -1)) return answer(301, '', undefined, { location: PREFIX });
    else return answer(404, 'Not found');
    let file = normalize(join(base, rest));
    if (file !== base && !file.startsWith(base + sep)) return answer(404, 'Not found');
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!path.endsWith('/')) return answer(301, '', undefined, { location: `${path}/` });
      file = join(file, 'index.html');
    }
    if (!existsSync(file)) return answer(404, 'Not found');
    answer(200, readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream');
  });
  return new Promise((resolve) => server.listen(0, host, () => resolve(server)));
}

/** Opens a page of the site with the test hooks, watching for errors, failed loads and requests that leave the site. */
async function open(page: Page, site: Site, path: string, query = '?test=1'): Promise<PageWatch> {
  const watch: PageWatch = { errors: [], foreign: [] };
  const origin = new URL(site.url).origin;
  // Loads the page before still has under way would be cut off by this navigation and counted against it,
  // so that page finishes loading first, then the blank page leaves nothing of it running.
  await page.waitForLoadState('load');
  await page.goto('about:blank');
  page.on('pageerror', (e) => watch.errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') watch.errors.push(m.text());
  });
  page.on('requestfailed', (r) => watch.errors.push(`failed: ${r.url()} (${r.failure()?.errorText})`));
  page.on('response', (r) => {
    if (r.status() >= 400) watch.errors.push(`${r.status()}: ${r.url()}`);
  });
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return;
    if (url.origin !== origin || !(url.pathname.startsWith(PREFIX) || url.pathname.startsWith('/examples/'))) watch.foreign.push(url.href);
  });
  await page.goto(`${site.url}${path}${query}`);
  return watch;
}

/** The robots meta tags of each page of a site, read from the files as served. */
async function robots(page: Page, base: string): Promise<string[][]> {
  return Promise.all(PAGES.map(async (name) => {
    const html = await (await page.request.get(`${base}${name}`)).text();
    return [...html.matchAll(/<meta name="robots" content="([^"]*)"/g)].map((m) => m[1]);
  }));
}

/** diag.html under the sub-path: its worker boots Manifold's WebAssembly and answers the jobs posted before. */
async function checkDiag(page: Page, site: Site, path: string): Promise<void> {
  const watch = await open(page, site, `${path}diag.html`, '');
  await expect(page).toHaveTitle('Mold Form Generator: diagnostics');
  const diag = await page.evaluate(() => (window as unknown as { __diag: { done: Promise<{ error: string | null; jobsBeforeReady: { id: number }[]; secureContext: boolean }> } }).__diag.done);
  expect(diag.error).toBeNull();
  expect(diag.secureContext).toBe(false);
  expect(diag.jobsBeforeReady.map((j) => j.id)).toEqual([0, 1, 2]);
  expect(watch.errors.filter((e) => !/WebGL|webgl/.test(e))).toEqual([]);
  expect(watch.foreign).toEqual([]);
}

/** What the server sent from the site's assets with a 200 since entry `from` of its log, as names without their hashes. */
function assetsSince(site: Site, from: number, path: string): string[] {
  const assets = `${PREFIX}${path}assets/`;
  return [...new Set(site.log.slice(from).filter((e) => e.status === 200 && e.path.startsWith(assets)).map((e) => e.path.slice(assets.length).replace(/-[\w-]{8}\./, '.')))].sort();
}

/** bench.html under the sub-path: its script runs, and its worker and the WebAssembly the worker boots come from there. */
async function checkBench(page: Page, site: Site, path: string): Promise<void> {
  const from = site.log.length;
  const watch = await open(page, site, `${path}bench.html`, '');
  await expect(page).toHaveTitle('Mold Form Generator: benchmark');
  await page.waitForFunction(() => '__bench' in window);
  // The benchmark itself takes up to a minute, which the app's own tests do not need to wait for.
  await expect.poll(() => assetsSince(site, from, path).filter((name) => /worker|wasm/.test(name))).toEqual(['diag.worker.js', 'manifold.wasm']);
  await expect(page.locator('#status')).toHaveText('Running. This takes up to a minute.');
  expect(watch.errors).toEqual([]);
  expect(watch.foreign).toEqual([]);
}

/** pipeline.html under the sub-path, without its 3D view: a model goes through both workers to a cover. */
async function checkPipeline(page: Page, site: Site, path: string): Promise<void> {
  const from = site.log.length;
  const watch = await open(page, site, `${path}pipeline.html`, '?test=1&draw=0');
  await expect(page).toHaveTitle('Mold Form Generator: pipeline');
  await page.waitForFunction(() => '__pipeline' in window);
  const status = await page.evaluate(async () => {
    const hooks = (window as unknown as { __pipeline: TestHooks }).__pipeline;
    await hooks.load('jersey-barrier.stl');
    await hooks.idle();
    return hooks.status();
  });
  expect(status).toMatchObject({ error: null, busy: false, stale: false });
  expect(assetsSince(site, from, path).filter((name) => /worker|wasm/.test(name))).toEqual(['field.worker.js', 'manifold.wasm', 'solid.worker.js']);
  expect(watch.errors).toEqual([]);
  expect(watch.foreign).toEqual([]);
}

/** The brand at the header's left: what it says, in order, and the version's colour beside the muted ink's. */
function brand(page: Page): Promise<{ text: string[]; version: string; ink2: string }> {
  return page.locator('.brand').evaluate((el) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--ink-2)';
    el.append(probe);
    const ink2 = getComputedStyle(probe).color;
    probe.remove();
    return {
      text: [...el.children].map((child) => child.textContent?.trim() ?? '').filter(Boolean),
      version: getComputedStyle(el.querySelector('[data-testid="app-version"]')!).color,
      ink2,
    };
  });
}

test.describe('the GitHub Pages site under /mold-form-generator/', () => {
  test.describe.configure({ mode: 'serial' });
  let site: Site;
  let scratch: string | null = null;

  test.beforeAll(async ({}, info) => {
    test.skip(info.project.name === 'dev', 'the preview project runs it in Chromium');
    test.setTimeout(180_000);
    scratch = mkdtempSync(join(tmpdir(), 'cfg-pages-e2e-'));
    const { out, commit, date } = buildSite(scratch);
    const log: Site['log'] = [];
    const host = new URL(info.project.use.baseURL!).hostname;
    const server = await serve(out, host, log);
    const { port } = server.address() as AddressInfo;
    expect([5173, 5183, 5184]).not.toContain(port);
    site = { url: `http://${host}:${port}${PREFIX}`, commit, date, log, close: () => new Promise((resolve) => server.close(() => resolve())) };
  });

  test.afterAll(async () => {
    await site?.close();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  test('@smoke the root is the release: its version alone, no BETA chip, no noindex, and every page, worker, the WebAssembly, the notices and the links load under the sub-path', async ({ page }) => {
    test.skip(!canDraw(page), NO_FIREFOX_WEBGL);
    test.setTimeout(120_000);
    const watch = await open(page, site, '');
    await expect(page).toHaveTitle('Mold Form Generator');
    await expect(page.getByTestId('app-version')).toHaveText(`v${pkg.version}`);
    await expect(page.getByTestId('app-version')).toHaveText(/^v\d+\.\d+\.\d+$/);
    await expect(page.getByTestId('beta-chip')).toHaveCount(0);
    await expect(page.getByTestId('stable-link')).toHaveCount(0);
    const title = await page.getByTestId('app-version').getAttribute('title');
    // The date is the commit's, so the same release built again says the same.
    expect(title).toBe(`Mold Form Generator ${pkg.version}\nThe released version, built from the code of ${site.date} (commit ${site.commit}).`);
    expect(await robots(page, site.url)).toEqual([[], [], [], []]);

    // A model previews, which loads field.worker, solid.worker and the WebAssembly from the sub-path.
    await dropAndWait(page, 'jersey-barrier.stl');
    await expect(page.getByTestId('file-name')).toContainText('jersey-barrier.stl');
    await checkLayout(page, watch);
    const shown = await brand(page);
    expect(shown.text).toEqual(['Mold Form Generator', `v${pkg.version}`]);
    expect(shown.version).toBe(shown.ink2);
    // The links at the foot of Advanced resolve under the sub-path, and each answers.
    await page.locator('.advanced > summary').click();
    const links = await page.locator('.advanced a[href]').evaluateAll((anchors) => anchors.map((a) => (a as HTMLAnchorElement).href));
    expect(links.map((href) => href.slice(site.url.length))).toEqual(['diag.html', 'bench.html', 'pipeline.html', 'third-party-notices.txt']);
    for (const href of links) expect((await page.request.get(href)).status(), href).toBe(200);
    const notices = await page.request.get(links[3]);
    expect(notices.headers()['content-type']).toMatch(/^text\/plain/);
    expect(Buffer.from(await notices.body()).equals(readFileSync(join(root, 'public', 'third-party-notices.txt')))).toBe(true);
    // Save project starts project.worker, the one worker a preview and an export leave out.
    const download = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByTestId('save-project').click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe('jersey-barrier.moldproj');
    expect(JSON.parse(text(unzipSync(new Uint8Array(readFileSync(await saved.path())))['project.json']))).toMatchObject({ schemaVersion: 5, appVersion: pkg.version });
    expect(watch.errors).toEqual([]);
    expect(watch.foreign).toEqual([]);

    await checkDiag(page, site, '');
    await checkBench(page, site, '');
    await checkPipeline(page, site, '');
    // Nothing the pages asked for under the prefix was missing.
    expect(site.log.filter((entry) => entry.path.startsWith(PREFIX) && entry.status >= 400)).toEqual([]);
  });

  test('@smoke /beta/ is the beta: the BETA chip, the version with its commit, noindex on every page, and Stable version goes to the root', async ({ page }) => {
    test.skip(!canDraw(page), NO_FIREFOX_WEBGL);
    test.setTimeout(180_000);
    const beta = `${site.url}beta/`;
    const version = `${pkg.version}-beta+${site.commit}`;
    const watch = await open(page, site, 'beta/');
    await expect(page.getByTestId('beta-chip')).toHaveText('BETA');
    await expect(page.getByTestId('app-version')).toHaveText(`v${version}`);
    const title = `Mold Form Generator ${version}\nBeta: the newest changes, not released yet, so they may have mistakes. Built from the code of ${site.date} (commit ${site.commit}).`;
    for (const id of ['app-version', 'beta-chip']) expect(await page.getByTestId(id).getAttribute('title'), id).toBe(title);
    expect(await robots(page, beta)).toEqual([['noindex'], ['noindex'], ['noindex'], ['noindex']]);
    expect(await page.locator('meta[name="robots"]').getAttribute('content')).toBe('noindex');
    // With a model open the header holds the most it ever does, in both themes: the brand in its order, the
    // version in the muted ink, the chip in the warning colours, still 48 px and nothing clipped.
    await dropAndWait(page, 'jersey-barrier.stl');
    for (const theme of ['dark', 'light']) {
      if ((await page.evaluate(() => document.documentElement.dataset.theme ?? 'dark')) !== theme) await page.getByTestId('theme').click();
      const colours = await page.getByTestId('beta-chip').evaluate((chip) => {
        const style = getComputedStyle(chip), root = getComputedStyle(document.documentElement);
        return [style.color, style.backgroundColor, root.getPropertyValue('--warn').trim(), root.getPropertyValue('--warn-bg').trim()];
      });
      const hex = (rgb: string): string => `#${rgb.match(/\d+/g)!.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
      expect([hex(colours[0]), hex(colours[1])], theme).toEqual([colours[2], colours[3]]);
      const shown = await brand(page);
      expect(shown.text, theme).toEqual(['Mold Form Generator', 'BETA', `v${version}`, 'Stable version']);
      expect(shown.version, theme).toBe(shown.ink2);
      await checkLayout(page, watch);
    }
    await page.getByTestId('theme').click();

    const link = page.getByTestId('stable-link');
    await expect(link).toHaveText('Stable version');
    expect(await link.evaluate((a) => (a as HTMLAnchorElement).href)).toBe(site.url);
    await link.click();
    await expect(page).toHaveURL(site.url);
    await page.waitForLoadState('load');
    await expect(page.getByTestId('app-version')).toHaveText(`v${pkg.version}`);
    await expect(page.getByTestId('beta-chip')).toHaveCount(0);
    expect(watch.errors).toEqual([]);
    expect(watch.foreign).toEqual([]);

    await checkDiag(page, site, 'beta/');
    await checkBench(page, site, 'beta/');
    await checkPipeline(page, site, 'beta/');
    expect((await page.request.get(`${beta}third-party-notices.txt`)).status()).toBe(200);
    expect(site.log.filter((entry) => entry.path.startsWith(PREFIX) && entry.status >= 400)).toEqual([]);
  });

  test('@smoke a model dropped on /beta/ previews, and its Export ZIP says the beta version in project.json, README.txt and report.json', async ({ page }) => {
    test.skip(!canDraw(page), NO_FIREFOX_WEBGL);
    test.setTimeout(240_000);
    const version = `${pkg.version}-beta+${site.commit}`;
    const watch = await open(page, site, 'beta/');
    await dropAndWait(page, 'jersey-barrier.stl');
    expect(await app(page, (a) => a.store.pipeline.diagnostics.filter((d) => d.severity === 'error').length)).toBe(0);
    await expect(page.getByTestId('export-zip')).toBeEnabled();
    const download = page.waitForEvent('download', { timeout: 200_000 });
    await page.getByTestId('export-zip').click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe('jersey-barrier-mold.zip');
    const files = unzipSync(new Uint8Array(readFileSync(await saved.path())));
    expect(JSON.parse(text(files['project.json']))).toMatchObject({ schemaVersion: 5, appVersion: version });
    expect(JSON.parse(text(files['report.json']))).toMatchObject({ app: 'Mold Form Generator', appVersion: version });
    // README.txt is wrapped at 76 columns, so its lines are joined first.
    expect(text(files['README.txt']).replace(/\r\n\s*/g, ' ')).toContain(`Made by Mold Form Generator ${version} from jersey-barrier.stl.`);
    expect(text(files['cover.stl'].subarray(0, 80)).replace(/\0+$/, '')).toBe('binary STL, mold-form-generator');
    expect(watch.errors).toEqual([]);
    expect(watch.foreign).toEqual([]);
    expect(site.log.filter((entry) => entry.path.startsWith(PREFIX) && entry.status >= 400)).toEqual([]);
  });

  test('review shots of the header on the release and on beta, with a model open', async ({ page, browserName }) => {
    test.skip(!SHOTS, 'CFG_SHOTS=1 takes them');
    test.skip(!canDraw(page), NO_FIREFOX_WEBGL);
    test.setTimeout(180_000);
    mkdirSync(SHOTS_DIR, { recursive: true });
    const themes = browserName === 'firefox' ? ['dark'] : ['dark', 'light'];
    for (const [name, path] of [['stable', ''], ['beta', 'beta/']] as const) {
      await open(page, site, path);
      await dropAndWait(page, 'jersey-barrier.stl');
      for (const theme of themes) {
        if ((await page.evaluate(() => document.documentElement.dataset.theme ?? 'dark')) !== theme) await page.getByTestId('theme').click();
        await page.mouse.move(683, 400);
        const stem = join(SHOTS_DIR, `r1-header-${name}-${browserName}-${theme}`);
        await page.screenshot({ path: `${stem}.png` });
        await page.screenshot({ path: `${stem}-strip.png`, clip: { x: 0, y: 0, width: 1366, height: 48 } });
      }
      // The next page starts in the dark theme, as a first visit does.
      if ((await page.evaluate(() => document.documentElement.dataset.theme ?? 'dark')) !== 'dark') await page.getByTestId('theme').click();
    }
  });
});
