import { APP_NAME } from './version';

/**
 * Which build this is: the stable site's release, the beta site's newest commit, or any other build (the
 * LAN server, the tests). vite.config.ts and vitest.config.ts define the four constants below at build
 * time, from package.json, CFG_CHANNEL (checked there), CFG_COMMIT, CFG_BUILD_DATE and git;
 * docs/RELEASING.md says how each site is built.
 */
export type Channel = 'stable' | 'beta' | 'local';

declare const __CFG_VERSION__: string | undefined;
declare const __CFG_CHANNEL__: Channel | undefined;
declare const __CFG_COMMIT__: string | undefined;
declare const __CFG_BUILD_DATE__: string | undefined;

/**
 * The version the app shows and writes into project.json, README.txt and report.json. A release says only
 * its number; every other build adds its channel and commit, so a mold exported from beta can be traced to
 * the commit that made it: 0.1.0, 0.2.0-beta+a1b2c3d, 0.1.0-local+a1b2c3d.
 */
export function versionString(version: string, channel: Channel, commit: string): string {
  return channel === 'stable' ? version : `${version}-${channel}+${commit}`;
}

export interface BuildInfo {
  channel: Channel;
  /** The short commit the build was made from, with -dirty if the tree had changes, or unknown. */
  commit: string;
  /**
   * In UTC, as 2026-11-09T10:15:00Z: on the two sites the date of the commit, so the same commit always
   * builds the same files; elsewhere when it was built. Null where no build defined it.
   */
  date: string | null;
  version: string;
}

export function buildInfo(version: string, channel: Channel, commit: string, date: string | null): BuildInfo {
  return { channel, commit, date, version: versionString(version, channel, commit) };
}

// typeof keeps a context that defines nothing, such as a bare type check, from throwing.
export const BUILD: BuildInfo = buildInfo(
  typeof __CFG_VERSION__ === 'string' ? __CFG_VERSION__ : 'unknown',
  typeof __CFG_CHANNEL__ === 'string' ? __CFG_CHANNEL__ : 'local',
  typeof __CFG_COMMIT__ === 'string' ? __CFG_COMMIT__ : 'unknown',
  typeof __CFG_BUILD_DATE__ === 'string' ? __CFG_BUILD_DATE__ : null,
);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 2026-11-09T10:15:42Z as 9 Nov 2026, 10:15 UTC, the same in every browser and language. */
export function shownDate(iso: string): string {
  const [, year, month, day, time] = /^(\d{4})-(\d\d)-(\d\d)T(\d\d:\d\d)/.exec(iso) ?? [];
  return year ? `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}, ${time} UTC` : iso;
}

/**
 * The tooltip on the version and the BETA label, in a maker's words: which kind of build this is, when its
 * code is from, and the commit, which is what a bug report needs.
 */
export function buildTitle(info: BuildInfo): string {
  const commit = `(commit ${info.commit})`;
  const when = info.date ? shownDate(info.date) : 'an unknown date';
  const kind = {
    stable: `The released version, built from the code of ${when} ${commit}.`,
    beta: `Beta: the newest changes, not released yet, so they may have mistakes. Built from the code of ${when} ${commit}.`,
    local: `A local build, not a published version, built on ${when} ${commit}.`,
  }[info.channel];
  return `${APP_NAME} ${info.version}\n${kind}`;
}
