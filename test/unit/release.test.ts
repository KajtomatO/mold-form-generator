import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { HtmlTagDescriptor, Plugin, UserConfig, UserConfigFnObject } from 'vite';
import config, { buildConstants, buildDefines, noindex, readChannel } from '../../vite.config';
import { BUILD, buildInfo, buildTitle, shownDate, versionString } from '../../src/app/buildInfo';
import { readTheme, THEME_KEY } from '../../src/app/store';
import { APP_NAME } from '../../src/app/version';
import { writeBinaryStl } from '../../src/core/stl/write';

/** R1: the name, the version and build on the page, and the GitHub Pages build of the two sites. */
const root = join(import.meta.dirname, '..', '..');
const doc = (path: string): string => readFileSync(join(root, path), 'utf8');
const git = (args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const gitIn = (cwd: string) => (...args: string[]): string => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

describe('the version and the build', () => {
  it('the version string is the release number on stable, with the channel and commit on beta and local builds', () => {
    expect(versionString('0.1.0', 'stable', 'a1b2c3d')).toBe('0.1.0');
    expect(versionString('0.2.0', 'beta', 'a1b2c3d')).toBe('0.2.0-beta+a1b2c3d');
    expect(versionString('0.1.0', 'local', 'a1b2c3d')).toBe('0.1.0-local+a1b2c3d');
    expect(versionString('0.1.0', 'local', 'a1b2c3d-dirty')).toBe('0.1.0-local+a1b2c3d-dirty');
    const beta = buildInfo('0.2.0', 'beta', 'a1b2c3d', '2026-11-09T10:15:42Z');
    expect(beta).toEqual({ channel: 'beta', commit: 'a1b2c3d', date: '2026-11-09T10:15:42Z', version: '0.2.0-beta+a1b2c3d' });
  });

  it('the tooltip says in plain words what kind of build it is, the date of its code and its commit', () => {
    expect(shownDate('2026-11-09T10:15:42Z')).toBe('9 Nov 2026, 10:15 UTC');
    expect(shownDate('2027-01-31T23:05:00Z')).toBe('31 Jan 2027, 23:05 UTC');
    expect(buildTitle(buildInfo('0.1.0', 'stable', 'a1b2c3d', '2026-11-09T10:15:42Z'))).toBe('Mold Form Generator 0.1.0\nThe released version, built from the code of 9 Nov 2026, 10:15 UTC (commit a1b2c3d).');
    expect(buildTitle(buildInfo('0.2.0', 'beta', 'a1b2c3d', '2026-11-09T10:15:42Z'))).toBe('Mold Form Generator 0.2.0-beta+a1b2c3d\nBeta: the newest changes, not released yet, so they may have mistakes. Built from the code of 9 Nov 2026, 10:15 UTC (commit a1b2c3d).');
    expect(buildTitle(buildInfo('0.1.0', 'local', 'a1b2c3d-dirty', '2026-11-09T10:15:42Z'))).toBe('Mold Form Generator 0.1.0-local+a1b2c3d-dirty\nA local build, not a published version, built on 9 Nov 2026, 10:15 UTC (commit a1b2c3d-dirty).');
    expect(buildTitle(buildInfo('0.1.0', 'local', 'unknown', null))).toContain('built on an unknown date (commit unknown)');
  });

  it('the version is package.json\'s; CFG_CHANNEL is stable, beta or local, local when unset; CFG_COMMIT wins over git, which gives -dirty for changes and unknown without a repository; CFG_BUILD_DATE wins over the time of the build', () => {
    expect([undefined, '', 'stable', 'beta', 'local'].map(readChannel)).toEqual(['local', 'local', 'stable', 'beta', 'local']);
    for (const wrong of ['Beta', 'release', 'main']) expect(() => readChannel(wrong)).toThrow(`CFG_CHANNEL must be stable, beta or local, not "${wrong}".`);
    const calls: string[][] = [];
    const repo = (status: string | null) => (args: string[]): string | null => {
      calls.push(args);
      return args[0] === 'rev-parse' ? 'a1b2c3d' : status;
    };
    const now = new Date('2026-11-09T10:15:42.123Z');
    expect(buildConstants({ CFG_CHANNEL: 'beta', CFG_COMMIT: 'f00ba47' }, repo(''), now, '0.2.0')).toEqual({ version: '0.2.0', channel: 'beta', commit: 'f00ba47', date: '2026-11-09T10:15:42Z' });
    expect(calls).toEqual([]);
    expect(buildConstants({}, repo(''), now, '0.1.0')).toEqual({ version: '0.1.0', channel: 'local', commit: 'a1b2c3d', date: '2026-11-09T10:15:42Z' });
    expect(calls).toEqual([['rev-parse', '--short=7', 'HEAD'], ['status', '--porcelain']]);
    expect(buildConstants({}, repo(' M src/app/version.ts'), now, '0.1.0').commit).toBe('a1b2c3d-dirty');
    expect(buildConstants({ CFG_COMMIT: '' }, () => null, now, '0.1.0').commit).toBe('unknown');
    expect(() => buildConstants({ CFG_COMMIT: 'a1b2c3d; rm' }, repo(''), now, '0.1.0')).toThrow('CFG_COMMIT must be letters, digits and dashes');
    // build-pages.sh passes the commit's date as git gives it, in the committer's time zone.
    expect(buildConstants({ CFG_BUILD_DATE: '2026-11-09T12:46:03+02:00' }, repo(''), now, '0.1.0').date).toBe('2026-11-09T10:46:03Z');
    for (const wrong of ['yesterday', '2026-11-09', '2026-11-09T25:00:00Z']) expect(() => buildConstants({ CFG_BUILD_DATE: wrong }, repo(''), now, '0.1.0'), wrong).toThrow('CFG_BUILD_DATE must be a date and time');
    for (const wrong of ['0.2.0-rc1', '1.0', 'v0.1.0']) expect(() => buildConstants({}, repo(''), now, wrong), wrong).toThrow("package.json's version must be three numbers");
    // Without a version given, it is package.json's.
    expect(buildConstants({}, repo(''), now).version).toBe(JSON.parse(doc('package.json')).version);
    expect(buildDefines({ version: '0.2.0', channel: 'beta', commit: 'a1b2c3d', date: '2026-11-09T10:15:42Z' })).toEqual({ __CFG_VERSION__: '"0.2.0"', __CFG_CHANNEL__: '"beta"', __CFG_COMMIT__: '"a1b2c3d"', __CFG_BUILD_DATE__: '"2026-11-09T10:15:42Z"' });
  });

  it('the tests are a local build of this checkout: its version, its commit, and when it was built', () => {
    expect(BUILD.channel).toBe(process.env.CFG_CHANNEL || 'local');
    expect(BUILD.version).toBe(versionString(JSON.parse(doc('package.json')).version, BUILD.channel, BUILD.commit));
    if (!process.env.CFG_COMMIT) {
      // vitest.config.ts read the tree once, when the run started. A test that rewrites a tracked file
      // since, as --record does to docs/BENCHMARKS.md, makes the tree dirty now where it was clean then.
      const head = git(['rev-parse', '--short=7', 'HEAD']);
      if (git(['status', '--porcelain']) === '') expect(BUILD.commit).toBe(head);
      else expect([head, `${head}-dirty`]).toContain(BUILD.commit);
    }
    expect(BUILD.date).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    if (!process.env.CFG_BUILD_DATE) expect(Math.abs(Date.parse(BUILD.date!) - Date.now())).toBeLessThan(3_600_000);
  });

  it('package.json and both root entries of package-lock.json give one name and one version, and the first public version is 0.1.0', () => {
    const pkg = JSON.parse(doc('package.json'));
    const lock = JSON.parse(doc('package-lock.json'));
    expect(pkg.name).toBe('mold-form-generator');
    expect([lock.name, lock.version]).toEqual([pkg.name, pkg.version]);
    expect([lock.packages[''].name, lock.packages[''].version]).toEqual([pkg.name, pkg.version]);
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    // The version is written nowhere in the app's code: the build takes it from package.json.
    const literal = spawnSync('git', ['grep', '-n', '-F', `'${pkg.version}'`, '--', 'src'], { cwd: root, encoding: 'utf8' }).stdout;
    expect(literal.split('\n').filter((line) => line && !line.includes('JOINED_PARTS_BUILD'))).toEqual([]);
    // R34: v0.1.0 is the first release. Until it is tagged the version must be 0.1.0; once releases are
    // tagged, the lowest of them must be v0.1.0, which build-pages.sh only builds if package.json said 0.1.0.
    const releases = git(['tag', '--list', 'v*']).split('\n').filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
    if (releases.length === 0) expect(pkg.version).toBe('0.1.0');
    else expect(git(['tag', '--list', 'v*', '--sort=v:refname']).split('\n').find((tag) => /^v\d+\.\d+\.\d+$/.test(tag))).toBe('v0.1.0');
    // Public versioning restarted at 0.1.0, so version.ts says the internal builds' numbers are not an order.
    expect(doc('src/app/version.ts')).toMatch(/Public versioning starts at 0\.1\.0/);
    for (const internal of ['0.2.0', '0.3.0', '1.0.0', '1.0.1']) expect(doc('src/app/version.ts')).toContain(internal);
  });

  it('no code compares version numbers: every line of src that tests a version is one of these, and none orders two', () => {
    // A project says what it holds by its format (version.ts). The lines below only check that a version is
    // text, pick the wording of a message, or match the one internal build that already joined parts.
    const allowed = [
      "src/app/buildInfo.ts: typeof __CFG_VERSION__ === 'string' ? __CFG_VERSION__ : 'unknown',",
      "src/app/pipeline.ts: const by = /^\\d+\\.\\d+\\.\\d+/.test(appVersion) ? `an early test build of the app (${appVersion})` : 'an early test build of the app';",
      "src/app/projectFile.ts: const by = typeof raw.appVersion === 'string' ? ` (app version ${raw.appVersion})` : '';",
      "src/app/projectFile.ts: const where = typeof raw.appVersion === 'string' && raw.appVersion.includes('-beta+') ? 'Open it on the beta site that saved it, at the app\\'s web address with beta/ at the end.' : 'Open it in the version of the app that saved it.';",
      "src/app/projectFile.ts: if (typeof appVersion !== 'string') refuse('the app version it names is not text', `\"appVersion\" must be text, not ${shown(appVersion)}.`);",
      'src/app/version.ts: return !(saved.format === 3 && saved.appVersion === JOINED_PARTS_BUILD);',
    ];
    const version = /\b(appVersion|APP_VERSION|__CFG_VERSION__|JOINED_PARTS_BUILD)\b|\b(BUILD|info|input|pkg)\.version\b/;
    const test = /===|!==|==|!=|<|>|localeCompare|\.split\(|\.test\(|\.match\(|\.includes\(|\.startsWith\(|\.sort\(|parseInt|parseFloat|Number\(|semver/i;
    const files = git(['ls-files', '-co', '--exclude-standard', 'src']).split('\n').filter((file) => /\.tsx?$/.test(file));
    const found = files.flatMap((file) => doc(file).split('\n').map((line) => line.trim())
      .filter((line) => !/^(\/\/|\/\*|\*)/.test(line) && version.test(line) && test.test(line.replace(/=>/g, '')))
      .map((line) => `${file}: ${line}`));
    expect(found).toEqual(allowed);
    expect(files.filter((file) => /semver|compare-versions/i.test(doc(file)))).toEqual([]);
  });

  it('the same commit builds the same files, so the release built again for a push to beta keeps the names an open page loads its workers by', async () => {
    const { build } = await import('vite');
    /** Every file a build makes, pages, chunks, workers and assets, by name, with a hash of its bytes. */
    const files = async (env: Record<string, string>): Promise<Map<string, string>> => {
      const out = new Map<string, string>();
      const collect = (): Plugin => ({
        name: 'release-collect',
        generateBundle(_, bundle) {
          for (const file of Object.values(bundle)) out.set(file.fileName, createHash('sha256').update(file.type === 'chunk' ? file.code : file.source).digest('hex'));
        },
      });
      // Vite builds for production only when NODE_ENV says so, and Vitest sets it to test.
      const saved = { ...process.env };
      Object.assign(process.env, env, { NODE_ENV: 'production' });
      try {
        await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'silent', plugins: [collect()], worker: { plugins: () => [collect()] }, build: { write: false, copyPublicDir: false, emptyOutDir: false, outDir: join(tmpdir(), 'cfg-release-build') } });
      } finally {
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
        Object.assign(process.env, saved);
      }
      return out;
    };
    const release = { CFG_CHANNEL: 'stable', CFG_COMMIT: 'a1b2c3d', CFG_BUILD_DATE: '2026-11-09T12:46:03+02:00' };
    const first = await files(release);
    const workers = (built: Map<string, string>): string[] => [...built.keys()].filter((name) => /\.worker-[\w-]+\.js$/.test(name)).sort();
    expect(workers(first).map((name) => name.replace(/-[\w-]+\.js$/, ''))).toEqual(['assets/diag.worker', 'assets/field.worker', 'assets/project.worker', 'assets/solid.worker']);
    // Workers are built side by side, so the files come in any order.
    const sorted = (built: Map<string, string>): string[][] => [...built].sort(([a], [b]) => a.localeCompare(b));
    expect(sorted(await files(release))).toEqual(sorted(first));
    // The date is in the workers' code, so a build stamped with the time it ran would rename them every time:
    // scripts/build-pages.sh passes the commit's date for that reason.
    expect(workers(await files({ ...release, CFG_BUILD_DATE: '2026-11-10T08:00:00Z' }))).not.toEqual(workers(first));
  });

  it('builds with a relative base, defines the build, and marks only beta pages noindex', async () => {
    const make = (channel: string | undefined): UserConfig => {
      const saved = process.env.CFG_CHANNEL;
      if (channel === undefined) delete process.env.CFG_CHANNEL;
      else process.env.CFG_CHANNEL = channel;
      try {
        return (config as UserConfigFnObject)({ command: 'build', mode: 'production' });
      } finally {
        if (saved === undefined) delete process.env.CFG_CHANNEL;
        else process.env.CFG_CHANNEL = saved;
      }
    };
    const names = (c: UserConfig): string[] => (c.plugins as Plugin[]).map((p) => p.name);
    for (const channel of [undefined, 'local', 'stable']) {
      expect(make(channel).base, String(channel)).toBe('./');
      expect(names(make(channel)), String(channel)).toEqual([]);
    }
    const beta = make('beta');
    expect(beta.base).toBe('./');
    expect(names(beta)).toEqual(['cfg-noindex']);
    expect(Object.keys(beta.define!)).toEqual(['__CFG_VERSION__', '__CFG_CHANNEL__', '__CFG_COMMIT__', '__CFG_BUILD_DATE__']);
    expect(beta.define!.__CFG_CHANNEL__).toBe('"beta"');
    expect(beta.define!.__CFG_VERSION__).toBe(JSON.stringify(JSON.parse(doc('package.json')).version));
    const tags = (noindex().transformIndexHtml as () => HtmlTagDescriptor[])();
    expect(tags).toEqual([{ tag: 'meta', attrs: { name: 'robots', content: 'noindex' }, injectTo: 'head-prepend' }]);
    expect(() => make('nightly')).toThrow('CFG_CHANNEL must be stable, beta or local');
  });
});

describe('the name', () => {
  it('Mold Form Generator in the header, every page title, the notices, the STL header and the package, and nowhere an old name a user reads', () => {
    expect(APP_NAME).toBe('Mold Form Generator');
    expect(doc('src/ui/Header.tsx')).toContain('{APP_NAME}');
    const titles = ['index', 'diag', 'bench', 'pipeline'].map((page) => /<title>([^<]*)<\/title>/.exec(doc(`${page}.html`))![1]);
    expect(titles).toEqual(['Mold Form Generator', 'Mold Form Generator: diagnostics', 'Mold Form Generator: benchmark', 'Mold Form Generator: pipeline']);
    expect(doc('public/third-party-notices.txt')).toMatch(/^Mold Form Generator: third-party notices\n={40}\n/);
    expect(doc('README.md')).toMatch(/^# Mold Form Generator\n/);
    // The STL header names the app, never starts with "solid", and carries no version.
    const stl = writeBinaryStl([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(new TextDecoder().decode(stl.subarray(0, 80)).replace(/\0+$/, '')).toBe('binary STL, mold-form-generator');
    // What a user or maker reads: the app's source, its pages, the notices and the docs about the app now.
    // PLAN.md and REQUIREMENTS.md keep the old names where they record the past, and the cache folder that
    // scripts/install.sh and e2e/firefox.ts share lies outside the repository, so it keeps its name.
    const files = git(['ls-files', '-co', '--exclude-standard', 'src', 'public', '*.html', 'README.md', 'docs/WORKFLOW.md', 'docs/DEPLOY.md', 'docs/THIRD_PARTY.md', 'docs/BENCHMARKS.md', 'docs/RELEASING.md', 'scripts', '.github']).split('\n');
    expect(files).toContain('docs/RELEASING.md');
    const old = files.flatMap((file) => doc(file).split('\n').filter((line) => /casting[ -]form|mold[ -]box[ -]gen/i.test(line) && !line.includes('.cache/casting-form-generator')).map((line) => `${file}: ${line.trim()}`));
    expect(old).toEqual([]);
  });

  it('the theme keeps the storage key it had before the renames, which index.html reads before the first paint', () => {
    const stored = new Map<string, string>();
    const storage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) };
    const global = globalThis as unknown as { localStorage?: unknown };
    global.localStorage = storage;
    try {
      // No one reads the key, so it keeps the first name: a theme chosen on the LAN server before R1 holds.
      expect(THEME_KEY).toBe('cfg-theme');
      expect(readTheme()).toBe('dark');
      stored.set('cfg-theme', 'light');
      expect(readTheme()).toBe('light');
      expect(doc('index.html')).toContain("if (localStorage.getItem('cfg-theme') === 'light') document.documentElement.dataset.theme = 'light';");
      global.localStorage = { getItem: () => { throw new Error('blocked'); } };
      expect(readTheme()).toBe('dark');
    } finally {
      delete global.localStorage;
    }
  });
});

/** The refs step's own script, as the workflow runs it. */
function refsScript(): string {
  const lines = doc('.github/workflows/pages.yml').split('\n');
  const start = lines.findIndex((line) => line.trim() === 'id: refs') + 2;
  expect(lines[start - 1].trim()).toBe('run: |');
  const end = lines.findIndex((line, k) => k > start && line.trim() === '');
  return lines.slice(start, end).map((line) => line.slice(10)).join('\n');
}

describe('the GitHub Pages build', () => {
  it('the workflow builds on a release tag, a push to beta or by hand, with Node 24, the newest tag on main and scripts/build-pages.sh, deploys with one deploy at a time and its dotfiles, and runs no tests', () => {
    const lines = doc('.github/workflows/pages.yml').split('\n');
    const block = (key: string): string[] => {
      const start = lines.indexOf(key);
      expect(start, key).toBeGreaterThanOrEqual(0);
      const end = lines.findIndex((line, k) => k > start && /^\S/.test(line));
      return lines.slice(start + 1, end < 0 ? undefined : end).filter((line) => line.trim() && !line.trim().startsWith('#'));
    };
    expect(block('on:')).toEqual(['  push:', '    tags:', "      - 'v*'", '    branches:', '      - beta', '  workflow_dispatch:']);
    expect(block('permissions:')).toEqual(['  contents: read', '  pages: write', '  id-token: write']);
    expect(block('concurrency:')).toEqual(['  group: pages', '  cancel-in-progress: false']);
    const steps = block('jobs:').map((line) => line.trim());
    expect(steps).toContain('fetch-depth: 0');
    expect(steps).toContain('node-version: 24');
    expect(steps).toContain('name: github-pages');
    const uses = steps.filter((line) => line.startsWith('uses: ')).map((line) => line.replace(/@.*/, ''));
    expect(uses).toEqual(['uses: actions/checkout', 'uses: actions/setup-node', 'uses: actions/upload-pages-artifact', 'uses: actions/deploy-pages']);
    expect(steps).toContain('STABLE: ${{ steps.refs.outputs.stable }}');
    expect(steps).toContain('BETA: ${{ steps.refs.outputs.beta }}');
    expect(steps).toContain('run: scripts/build-pages.sh "$STABLE" "$BETA" "$RUNNER_TEMP/site"');
    expect(steps).toContain('path: ${{ runner.temp }}/site');
    // upload-pages-artifact v4 and later leave out dotfiles unless told, and .nojekyll is one.
    const upload = steps.indexOf('path: ${{ runner.temp }}/site');
    expect(steps[upload + 1]).toBe('include-hidden-files: true');
    // The tests wait for the owner's decision on the example models (docs/RELEASING.md).
    expect(steps.filter((line) => /ci\.sh|vitest|playwright|npm (run )?test/.test(line))).toEqual([]);
  });

  it('the workflow picks the highest vX.Y.Z tag that main holds, by version and not by date or name, beta when the branch exists, stops with no release yet, and fails a pushed tag it does not publish', () => {
    const script = refsScript();
    const dir = mkdtempSync(join(tmpdir(), 'cfg-pages-tags-'));
    try {
      const g = gitIn(dir);
      const output = join(dir, '.output');
      const run = (env: Record<string, string> = {}) => {
        writeFileSync(output, '');
        const result = spawnSync('bash', ['-e', '-c', script], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'beta', ...env } });
        return { status: result.status, out: result.stdout, outputs: readFileSync(output, 'utf8') };
      };
      const commit = (message: string, date: string): void => {
        execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', message], { cwd: dir, env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
      };
      g('init', '-q', '-b', 'main');
      commit('first', '2026-01-01T00:00:00Z');
      g('update-ref', 'refs/remotes/origin/main', 'HEAD');
      expect(run()).toMatchObject({ status: 1, out: expect.stringContaining('::error::No release tag vX.Y.Z is on main yet.'), outputs: '' });
      // The highest version on the middle commit: a sort by date or by name, either way, picks another.
      g('tag', 'v0.1.0');
      commit('second', '2026-02-01T00:00:00Z');
      g('tag', 'v0.10.0');
      commit('third', '2026-03-01T00:00:00Z');
      for (const tag of ['v0.9.0', 'v1.0-rc', 'release-3']) g('tag', tag);
      g('update-ref', 'refs/remotes/origin/main', 'HEAD');
      // A higher tag off main is never the release.
      g('checkout', '-q', '-b', 'side');
      commit('side', '2026-04-01T00:00:00Z');
      g('tag', 'v9.9.9');
      g('checkout', '-q', 'main');
      expect(run()).toMatchObject({ status: 0, outputs: 'stable=v0.10.0\nbeta=-\n' });
      g('update-ref', 'refs/remotes/origin/beta', 'side');
      expect(run()).toMatchObject({ status: 0, outputs: 'stable=v0.10.0\nbeta=origin/beta\n' });
      // Run by the tag it publishes, or by hand, it goes on.
      expect(run({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.10.0' })).toMatchObject({ status: 0, outputs: 'stable=v0.10.0\nbeta=origin/beta\n' });
      expect(run({ GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' })).toMatchObject({ status: 0 });
      // Run by any other tag, it stops and says why, so a red run means the tag was not published.
      const refused = (tag: string) => run({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: tag });
      expect(refused('v0.9.0')).toMatchObject({ status: 1, outputs: '', out: '::error::Tag v0.9.0 was not published, as main holds a higher release, v0.10.0. The release address still shows v0.10.0.\n' });
      expect(refused('v9.9.9')).toMatchObject({ status: 1, outputs: '', out: expect.stringContaining('::error::Tag v9.9.9 was not published, as it is not on main: merge into main first') });
      expect(refused('v1.0-rc')).toMatchObject({ status: 1, outputs: '', out: expect.stringContaining('::error::Tag v1.0-rc was not published, as it is not of the form vX.Y.Z') });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('scripts/build-pages.sh, in a scratch repository', () => {
    // A repository of one page and the same packages as this checkout, so its builds take a moment.
    const scratch = mkdtempSync(join(tmpdir(), 'cfg-pages-unit-'));
    afterAll(() => rmSync(scratch, { recursive: true, force: true }));
    const repo = join(scratch, 'repo');
    const temp = join(scratch, 'tmp');
    const g = gitIn(repo);
    const page = (text: string): string => `<!doctype html>\n<html><head><title>${text}</title></head><body><p>${text}</p></body></html>\n`;
    const lock = JSON.parse(doc('package-lock.json'));
    const withVersion = (version: string) => ({ ...lock, version, packages: { ...lock.packages, '': { ...lock.packages[''], version } } });
    const writeJson = (path: string, value: unknown): void => writeFileSync(join(repo, path), `${JSON.stringify(value, null, 2)}\n`);
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    mkdirSync(temp);
    copyFileSync(join(root, 'scripts', 'build-pages.sh'), join(repo, 'scripts', 'build-pages.sh'));
    symlinkSync(join(root, 'node_modules'), join(repo, 'node_modules'));
    g('init', '-q', '-b', 'main');
    writeFileSync(join(repo, '.git', 'info', 'exclude'), 'node_modules\n');
    // main: the release 0.1.0, also tagged v0.3.0, which its package.json does not say.
    writeJson('package.json', { name: 'scratch', version: '0.1.0', private: true });
    writeJson('package-lock.json', withVersion('0.1.0'));
    writeFileSync(join(repo, 'index.html'), page('release'));
    g('add', '-A');
    g('commit', '-q', '-m', 'release');
    g('tag', 'v0.1.0');
    g('tag', 'v0.3.0');
    // Then the next version on main, which changes the lockfile's root entry and no package.
    writeJson('package.json', { name: 'scratch', version: '0.2.0', private: true });
    writeJson('package-lock.json', withVersion('0.2.0'));
    writeFileSync(join(repo, 'index.html'), page('next'));
    g('commit', '-q', '-am', 'next');
    // A branch whose page does not build, and one whose lockfile pins another package.
    g('checkout', '-q', '-b', 'broken');
    writeFileSync(join(repo, 'index.html'), `${page('broken')}<script type="module" src="./missing.js"></script>\n`);
    g('commit', '-q', '-am', 'broken');
    g('checkout', '-q', '-b', 'deps', 'main');
    writeJson('package-lock.json', { ...withVersion('0.2.0'), packages: { ...withVersion('0.2.0').packages, 'node_modules/fflate': { ...lock.packages['node_modules/fflate'], version: '0.0.1' } } });
    g('commit', '-q', '-am', 'deps');
    g('checkout', '-q', 'main');
    const run = (...args: string[]) => {
      // Offline, so the one npm ci below fails at once instead of fetching anything.
      const result = spawnSync('bash', [join(repo, 'scripts', 'build-pages.sh'), ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, TMPDIR: temp, npm_config_offline: 'true' } });
      return { status: result.status, out: result.stdout, err: result.stderr };
    };
    /** Nothing left behind: no worktree, no temporary folder, no change in the working tree. */
    const clean = (): void => {
      expect(g('worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '))).toEqual([`worktree ${repo}`]);
      // Node and Vite keep a compile cache in TMPDIR as well, which is theirs to keep.
      expect(readdirSync(temp).filter((name) => name.startsWith('cfg-pages.'))).toEqual([]);
      expect(g('status', '--porcelain')).toBe('');
    };

    it('parses, needs three arguments, an empty folder outside the repository and refs that are commits', () => {
      execFileSync('bash', ['-n', join(root, 'scripts', 'build-pages.sh')]);
      expect(run('HEAD', '-')).toMatchObject({ status: 2, err: 'Usage: scripts/build-pages.sh <stable-ref> <beta-ref or -> <out-dir>\n' });
      expect(run('HEAD', '-', join(repo, 'site'))).toMatchObject({ status: 2, err: expect.stringContaining('The output folder must be outside the repository') });
      expect(existsSync(join(repo, 'site'))).toBe(false);
      const full = join(scratch, 'full');
      mkdirSync(full);
      writeFileSync(join(full, 'old.html'), '');
      expect(run('HEAD', '-', full)).toMatchObject({ status: 2, err: expect.stringContaining('The output folder must be new or empty') });
      expect(run('no-such-ref', '-', join(scratch, 'a'))).toMatchObject({ status: 1, err: expect.stringContaining('No commit is named no-such-ref') });
      expect(run('HEAD', 'no-such-beta', join(scratch, 'b'))).toMatchObject({ status: 1, err: expect.stringContaining('No commit is named no-such-beta') });
      clean();
    });

    it('refuses a release tag whose package.json says another version', () => {
      expect(run('v0.3.0', '-', join(scratch, 'c'))).toMatchObject({ status: 1, err: expect.stringContaining('Tag v0.3.0 does not match package.json at that tag, which says 0.1.0.') });
      expect(existsSync(join(scratch, 'c'))).toBe(false);
      clean();
    });

    it('builds both sites with this checkout\'s packages when only the app\'s version differs, writes .nojekyll, and leaves nothing behind', () => {
      const out = join(scratch, 'site');
      const built = run('v0.1.0', 'main', out);
      expect(built.status, built.err).toBe(0);
      expect(built.out).toContain("The stable site uses this checkout's packages, as its package-lock.json pins the same ones.");
      expect(built.out).toContain("The beta site uses this checkout's packages, as its package-lock.json pins the same ones.");
      expect(built.out).not.toContain('npm ci');
      expect(readFileSync(join(out, 'index.html'), 'utf8')).toContain('<p>release</p>');
      expect(readFileSync(join(out, 'beta', 'index.html'), 'utf8')).toContain('<p>next</p>');
      expect(existsSync(join(out, '.nojekyll'))).toBe(true);
      expect(built.out).toContain(`The site is in ${out}: 0.1.0 at the root, 0.2.0 beta at beta/.`);
      clean();
    });

    it('when only the beta fails to build, still builds the release, puts a notice at beta/ and says so in the run', () => {
      const out = join(scratch, 'half');
      const built = run('v0.1.0', 'broken', out);
      expect(built.status, built.err).toBe(0);
      expect(readFileSync(join(out, 'index.html'), 'utf8')).toContain('<p>release</p>');
      const notice = readFileSync(join(out, 'beta', 'index.html'), 'utf8');
      expect(notice).toContain('<meta name="robots" content="noindex" />');
      expect(notice).toContain(`The newest beta change (commit ${g('rev-parse', '--short=7', 'broken')}) could not be built`);
      expect(notice).toContain('<a href="../">Open the released version</a>');
      expect(readdirSync(join(out, 'beta'))).toEqual(['index.html']);
      expect(built.out).toMatch(/^::error::The beta site did not build from broken \([0-9a-f]{7}\), so \/beta\/ says it is not available\. The release was built and is published\.$/m);
      expect(existsSync(join(out, '.nojekyll'))).toBe(true);
      clean();
    });

    it('installs with npm ci when a ref pins other packages, and stops with nothing built when the release fails', () => {
      const out = join(scratch, 'deps');
      const failed = run('deps', 'main', out);
      expect(failed.status).toBe(1);
      expect(failed.out).toContain('The stable site pins other packages than this checkout, so npm ci installs them.');
      expect(failed.err).toContain('The release deps did not build, so nothing was built.');
      expect(failed.out).not.toContain('beta');
      expect(existsSync(join(out, '.nojekyll'))).toBe(false);
      clean();
    });
  });
});
