/**
 * The app's name, as every page, export and the notices give it. The version is package.json's alone:
 * the build reads it from there (vite.config.ts) and buildInfo.ts holds it as BUILD.version.
 *
 * Public versioning starts at 0.1.0, the first release on GitHub Pages (R1). Before it, internal builds on
 * the LAN server were numbered 0.2.0 (project format 2, M9), 0.3.0 (format 3, M10), 1.0.0 (M11b) and 1.0.1
 * (M11c, which joined parts that overlap or touch into one body), so these numbers say nothing about order:
 * never compare them.
 */
export const APP_NAME = 'Mold Form Generator';

/** The one internal build whose project files, still format 3, already numbered bodies as joined parts. */
export const JOINED_PARTS_BUILD = '1.0.1';

/** Who wrote a project file: its format as written, before any migration, and the app version it names. */
export interface SavedBy {
  format: number;
  appVersion: string;
}

/**
 * Whether a project numbered a model's bodies by its connected parts, as every internal build before 1.0.1
 * did, so its pins and removed vents name bodies by those numbers. Format 4 says bodies are joined parts;
 * of format 3, only build 1.0.1 already had that rule. The format decides, as public versions restarted at
 * 0.1.0 and a version number cannot.
 */
export function bodiesByPart(saved: SavedBy): boolean {
  if (saved.format >= 4) return false;
  return !(saved.format === 3 && saved.appVersion === JOINED_PARTS_BUILD);
}
