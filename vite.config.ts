import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin, type UserConfig } from 'vite';

const root = import.meta.dirname;

// Nothing here imports the app's own code, so Vite loads this file the same with every config loader.
/** Where a build is published, as src/app/buildInfo.ts reads it: the release site, the beta site, or anything else. */
export type Channel = 'stable' | 'beta' | 'local';

export interface BuildConstants {
  /** package.json's version, the only place the app's version is written. */
  version: string;
  channel: Channel;
  commit: string;
  /** In UTC, as 2026-11-09T10:15:42Z. */
  date: string;
}

/** CFG_CHANNEL's value: unset is a local build, and anything but the three names stops the build. */
export function readChannel(value: string | undefined): Channel {
  if (value === undefined || value === '') return 'local';
  if (value !== 'stable' && value !== 'beta' && value !== 'local') throw new Error(`CFG_CHANNEL must be stable, beta or local, not "${value}".`);
  return value;
}

/** A git command's output in this checkout, or null where git or the repository is missing. */
function runGit(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function packageVersion(): string {
  return (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string }).version;
}

/**
 * What a build says about itself (src/app/buildInfo.ts): package.json's version; the channel from
 * CFG_CHANNEL, local by default; the commit from CFG_COMMIT, which scripts/build-pages.sh sets, or else this
 * checkout's HEAD with -dirty when the tree has changes, or unknown without git; and a date in UTC, from
 * CFG_BUILD_DATE or else the time of the build. build-pages.sh passes the commit's own date, so building the
 * same commit again gives the same files, with the same names, and a page already open still finds its workers.
 */
export function buildConstants(env: Record<string, string | undefined>, git: (args: string[]) => string | null = runGit, now = new Date(), version = packageVersion()): BuildConstants {
  // It is the start of the version string, which must stay a plain number.
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`package.json's version must be three numbers, such as 0.1.0, not "${version}".`);
  const channel = readChannel(env.CFG_CHANNEL);
  let commit = env.CFG_COMMIT ?? '';
  if (commit === '') {
    const head = git(['rev-parse', '--short=7', 'HEAD']);
    commit = head ? (git(['status', '--porcelain']) === '' ? head : `${head}-dirty`) : 'unknown';
  }
  // It ends up in the version string, whose build part takes only these characters.
  if (!/^[0-9A-Za-z-]+$/.test(commit)) throw new Error(`CFG_COMMIT must be letters, digits and dashes, such as a short commit, not "${commit}".`);
  let date = now;
  if (env.CFG_BUILD_DATE) {
    date = new Date(env.CFG_BUILD_DATE);
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(env.CFG_BUILD_DATE) || Number.isNaN(date.getTime())) throw new Error(`CFG_BUILD_DATE must be a date and time such as 2026-11-09T10:15:42+02:00, not "${env.CFG_BUILD_DATE}".`);
  }
  return { version, channel, commit, date: `${date.toISOString().slice(0, 19)}Z` };
}

/** The constants buildInfo.ts reads, for Vite's and Vitest's `define`. */
export function buildDefines(build: BuildConstants): Record<string, string> {
  return {
    __CFG_VERSION__: JSON.stringify(build.version),
    __CFG_CHANNEL__: JSON.stringify(build.channel),
    __CFG_COMMIT__: JSON.stringify(build.commit),
    __CFG_BUILD_DATE__: JSON.stringify(build.date),
  };
}

/** Beta pages stay out of search results, which should show the stable site only. */
export function noindex(): Plugin {
  return {
    name: 'cfg-noindex',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'robots', content: 'noindex' }, injectTo: 'head-prepend' }],
  };
}

export default defineConfig((): UserConfig => {
  const build = buildConstants(process.env);
  return {
    // Relative, so one build works at the root, at /mold-form-generator/ and at /mold-form-generator/beta/.
    base: './',
    define: buildDefines(build),
    plugins: build.channel === 'beta' ? [noindex()] : [],
    oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
    worker: { format: 'es' },
    server: { host: true },
    preview: { host: true },
    build: {
      target: 'es2022',
      // Every browser the app supports preloads modules itself. Vite's polyfill for those that do not is
      // adapted from es-module-shims, and Vite ships it without that project's notice, so it stays out.
      modulePreload: { polyfill: false },
      rolldownOptions: {
        input: {
          index: resolve(root, 'index.html'),
          diag: resolve(root, 'diag.html'),
          bench: resolve(root, 'bench.html'),
          pipeline: resolve(root, 'pipeline.html'),
        },
      },
    },
  };
});
