import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { firefox } from '@playwright/test';

/** Where scripts/install.sh unpacks GTK when it is not installing it system-wide. */
const unpackedLibs = join(homedir(), '.cache/casting-form-generator/firefox-libs/usr/lib/x86_64-linux-gnu');

function hasSystemGtk(): boolean {
  try {
    return execSync('ldconfig -p', { encoding: 'utf8' }).includes('libgtk-3.so.0');
  } catch {
    return false;
  }
}

const systemGtk = hasSystemGtk();

/** Set as LD_LIBRARY_PATH for Firefox. Null when the system's own GTK is used. */
export const firefoxLibDir = !systemGtk && existsSync(unpackedLibs) ? unpackedLibs : null;

export const firefoxReady = existsSync(firefox.executablePath()) && (systemGtk || firefoxLibDir !== null);

/** Firefox can only create a WebGL context on a display, which scripts/ci.sh gets from xvfb-run. */
export const firefoxHasDisplay = Boolean(process.env.DISPLAY);

export const NO_FIREFOX_WEBGL = 'Firefox needs a display for WebGL: run WITH_SYSTEM_DEPS=1 scripts/install.sh to get xvfb';
