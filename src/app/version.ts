/**
 * The app's version, as package.json has it. A unit test keeps the two the same. 0.2.0 came with
 * project format 2 (M9), 0.3.0 with 3 (M10), and 1.0.0 is the first complete release (M11b), still
 * format 3. 1.0.1 joins parts that overlap or touch into one body (M11c), format 3 still.
 */
export const APP_VERSION = '1.0.1';

export const APP_NAME = 'Casting Form Generator';

/**
 * Whether a project saved by `version` numbered a model's bodies by its connected parts, as every version
 * before 1.0.1 did, so its pins and removed vents name bodies by those numbers. A version not given, or not
 * read, is taken for one of those.
 */
export function bodiesByPart(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return true;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major < 1 || (major === 1 && minor === 0 && patch < 1);
}
