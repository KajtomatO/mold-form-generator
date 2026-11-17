/**
 * MM2: what a simplified model carries (R42, D24). The mold is made from a copy of a large model with fewer
 * triangles; model_oriented.stl, the model the maker prints and glues in, is still their own file (the user's
 * answer of 2026-11-16, question 1), so the file itself is kept, unread, to be read again where it is needed.
 */

/**
 * The maker's own file a model was made from, kept unread on main: the File as chosen or dropped, which is on
 * disk, or for a load by bytes (the test hooks) a Blob of them. Workers read it with FileReaderSync, so main
 * never holds its bytes. A .moldproj's model is its model.stl.
 */
export interface OriginalSource {
  kind: 'stl' | 'moldproj';
  blob: Blob;
}

/** The original as parsed: its name, size, hash and counts, with collapsed triangles dropped from `triangles`. */
export interface OriginalFacts {
  name: string;
  bytes: number;
  sha256: string;
  format: 'binary' | 'ascii';
  trianglesInFile: number;
  triangles: number;
}

/** The copy: what was asked, what it came to, and its STL's hash. project.json and report.json keep it. */
export interface SimplifiedRecord {
  triangles: number;
  target: number;
  /** The bound asked for, in mm. */
  maxErrorMm: number;
  /** How far the original's surface lies from the copy's at most, in mm, proved over all of it (MM2's review). */
  errorMm: number;
  stoppedBy: 'target' | 'error';
  /** SHA-256 of the copy's STL, as Save simplified STL and a .moldproj's simplified.stl hold it. */
  sha256: string;
}

/** project.json's record of a copy: the original's counts, which its hash and name are kept beside, and the copy's own. */
export interface SimplifiedEntry extends SimplifiedRecord {
  from: Pick<OriginalFacts, 'format' | 'trianglesInFile' | 'triangles'>;
}

/** The model on screen is a copy of the maker's file, made on opening or by Simplify… (and, later, repaired). */
export interface ModelOrigin {
  kind: 'simplified';
  original: OriginalSource;
  from: OriginalFacts;
  record: SimplifiedRecord;
}

/** The entry project.json writes for a model of this origin. */
export function simplifiedEntry(origin: Pick<ModelOrigin, 'from' | 'record'>): SimplifiedEntry {
  const { format, trianglesInFile, triangles } = origin.from;
  return { from: { format, trianglesInFile, triangles }, ...origin.record };
}

const count = (n: number): string => n.toLocaleString('en-US');

/** "0.050 mm", as every message gives the proved error. */
export const errorText = (mm: number): string => `${mm.toFixed(3)} mm`;

/**
 * The diagnostics row says this: what the copy is, how far it lies from the file, and what model_oriented.stl is,
 * which in merged mode is not in the ZIP at all, and where the base face's plane cuts the model is the file
 * trimmed there, as a model loaded as it is would be (MM2's review).
 */
export function simplifiedMessage(origin: Pick<ModelOrigin, 'from' | 'record'>, merged: boolean, trimmed = false): string {
  const { from, record } = origin;
  const within = record.errorMm > record.maxErrorMm ? `within ${errorText(record.errorMm)} of your file's, as close as the copy could keep to it` : `within ${errorText(record.errorMm)} of your file's`;
  const last = merged
    ? 'In merged mode the base carries that copy, so the silicone takes its shape.'
    : trimmed
      ? 'model_oriented.stl is your own file, trimmed where the base face cuts it, as a model loaded as it is would be.'
      : `model_oriented.stl is your own file, with all its ${count(from.triangles)} triangles.`;
  return `The mold is made from a copy of ${from.name} simplified from ${count(from.triangles)} to ${count(record.triangles)} triangles, whose surface lies ${within}, proved over all of it; the safety margin is wider by that much. ${last}`;
}

/**
 * The view's note on a heavy model drawn lighter. A simplified copy is itself the whole mesh the mold is built
 * from, which the row above it says, so its note does not call it the whole mesh (MM2's review).
 */
export function displayProxyMessage(drawn: number, triangles: number, simplified: boolean): string {
  const whole = count(triangles);
  return `The view draws this model simplified to ${count(drawn)} of its ${whole} triangles, to keep it quick to turn; the mold is built from ${simplified ? `all ${whole} of them` : 'the whole mesh'}.`;
}
