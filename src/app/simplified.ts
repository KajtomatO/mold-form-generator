import type { RepairFigures } from '../core/mesh/repairImport';
import { OUTSIDE_MEASURE_LIMIT } from '../core/mesh/repair';
import type { WeldedMesh } from '../core/mesh/weld';

/**
 * MM2: what a simplified model carries (R42, D24), and RM: what a repaired one carries (R43, D26). The mold is made
 * from a copy of the maker's file: a large model's with fewer triangles, or a broken mesh's made a closed solid.
 * model_oriented.stl, the model the maker prints and glues in, is still their own file (the user's answers of
 * 2026-11-16), so the file itself is kept, unread, to be read again where it is needed.
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

/**
 * RM: how the app imports the maker's file as it is, which model_oriented.stl of a repaired model follows (decision
 * C): its route, whether the import turned the whole mesh over, and whether it turned an inside-out separate body.
 */
export interface OriginalImport {
  route: 'manifold' | 'merged' | 'soup';
  flipped: boolean;
  inverted: boolean;
}

/** RM: the repaired copy, as the repair's figures give it, with what the job adds. project.json and report.json keep it. */
export interface RepairRecord extends RepairFigures {
  /** How the file itself imports, which model_oriented.stl follows. */
  original: OriginalImport;
  /** MM2's copy of a filled model, made as the model on screen was a simplified copy (decision F); null otherwise. */
  simplified: Omit<SimplifiedRecord, 'sha256'> | null;
  /** Where Show marks the repair, in the file's coordinates: each closed hole's rim, or each part left out; at most 20. */
  marks: [number, number, number][];
  /** SHA-256 of the repaired copy's STL, as Save repaired STL and a .moldproj's repaired.stl hold it. */
  sha256: string;
}

/** project.json's record of a repaired copy: the original's counts, which its hash and name are kept beside, and the repair's own. */
export interface RepairedEntry extends RepairRecord {
  from: Pick<OriginalFacts, 'format' | 'trianglesInFile' | 'triangles'>;
}

/** RM: a repaired model: the record, and the file's parts the repair left out (O_far), in the file's coordinates. */
export interface RepairedOrigin {
  record: RepairRecord;
  outside: WeldedMesh | null;
}

/**
 * The model on screen is a copy of the maker's file: simplified, made on opening or by Simplify… (MM2), or repaired,
 * by Repair mesh (RM). A repaired filled file on screen as a simplified copy is simplified again inside the repair,
 * whose record says so, so a model has one record and one copy beside model.stl.
 */
export interface ModelOrigin {
  original: OriginalSource;
  from: OriginalFacts;
  /** MM2: a copy of the file with fewer triangles; null for a repaired model. */
  record: SimplifiedRecord | null;
  /** RM: the file repaired into a closed solid; null for a copy that is only simplified. */
  repair: RepairedOrigin | null;
}

/** The entry project.json writes for a simplified copy. */
export function simplifiedEntry(origin: { from: OriginalFacts; record: SimplifiedRecord }): SimplifiedEntry {
  const { format, trianglesInFile, triangles } = origin.from;
  return { from: { format, trianglesInFile, triangles }, ...origin.record };
}

/** RM: the entry project.json writes for a repaired copy. */
export function repairedEntry(from: OriginalFacts, record: RepairRecord): RepairedEntry {
  const { format, trianglesInFile, triangles } = from;
  return { from: { format, trianglesInFile, triangles }, ...record };
}

const count = (n: number): string => n.toLocaleString('en-US');

/** "0.050 mm", as every message gives the proved error. */
export const errorText = (mm: number): string => `${mm.toFixed(3)} mm`;

/**
 * The diagnostics row says this: what the copy is, how far it lies from the file, and what model_oriented.stl is,
 * which in merged mode is not in the ZIP at all, and where the base face's plane cuts the model is the file
 * trimmed there, as a model loaded as it is would be (MM2's review).
 */
export function simplifiedMessage(origin: { from: OriginalFacts; record: SimplifiedRecord }, merged: boolean, trimmed = false): string {
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

/** RM: "1 hole of 3.1 mm2" or "4 holes of 12.0 mm2 in all", as Repair mesh's offer says a file's holes (mm2 in plain text). */
export function holesText(holes: number, area: number): string {
  return holes === 1 ? `1 hole of ${area.toFixed(1)} mm2` : `${count(holes)} holes of ${area.toFixed(1)} mm2 in all`;
}

/** RM: what a fill did to the file: its holes closed, and faces turned the right way. */
export function filledWords(record: Pick<RepairRecord, 'holes' | 'holeArea' | 'turned'>): string {
  const closed = record.holes > 0 ? `${record.holes === 1 ? `its hole of ${record.holeArea.toFixed(1)} mm2` : `its ${count(record.holes)} holes, ${record.holeArea.toFixed(1)} mm2 in all,`} closed` : '';
  const turned = record.turned > 0 ? `${count(record.turned)} ${record.turned === 1 ? 'face' : 'faces'} turned the right way` : '';
  return [closed, turned].filter(Boolean).join(' and ');
}

/** RM: a rebuild's grid, "0.20 mm" and whether auto chose it. */
export const gridText = (record: Pick<RepairRecord, 'cell' | 'cellAsked'>): string => `${(record.cell ?? 0).toFixed(2)} mm`;

/** RM: the parts of the file a rebuild left out, "2 triangles", or null with none. */
function leftOut(record: RepairRecord): string | null {
  const far = record.outside;
  return far ? `${count(far.triangles)} ${far.triangles === 1 ? 'triangle' : 'triangles'}` : null;
}

/** RM: what a rebuild may leave out of a file, as the texts name it. */
export const LEFT_OUT_KINDS = 'such as a fin, a wall thinner than the grid, a fold or a sharp edge';

/** RM: where a rebuilt copy's file lies: inside it or within e_near of it, which may be 0 (all of it inside). */
export function nearWords(record: Pick<RepairRecord, 'nearMm'>): string {
  return record.nearMm > 0 ? `inside the copy or within ${errorText(record.nearMm)} of it` : 'inside the copy';
}

/**
 * RM: the diagnostics row of a repaired model (R43): what the copy is, how far the file lies from it, what the mold
 * does for the parts it left out, and what model_oriented.stl is. In merged mode the base carries the copy, and the
 * row is a warning when the cast will lack parts of the file. `trimmed`: model_oriented.stl, the file, is cut at the
 * base face (Pipeline.fileCut).
 */
export function repairedMessage(name: string, record: RepairRecord, merged: boolean, trimmed = false): { severity: 'info' | 'warning'; message: string } {
  const yours = `model_oriented.stl is your own file${trimmed ? ', trimmed where the base face cuts it' : ''}.`;
  if (record.method === 'filled') {
    const simplified = record.simplified ? `, then simplified to ${count(record.simplified.triangles)} triangles within ${errorText(record.simplified.errorMm)} of it` : '';
    const holds = record.simplified
      ? merged
        ? ''
        : '; the safety margin is wider by that much, so the silicone thickness measured on the copy holds for your file'
      : ', so the silicone thickness measured on the copy holds for your file';
    return { severity: 'info', message: `The mold is made from a repaired copy of ${name}: ${filledWords(record)}, every triangle of your file kept${simplified}${holds}. ${merged ? 'In merged mode the base carries that copy.' : yours}` };
  }
  const far = leftOut(record), grid = gridText(record);
  if (merged) {
    const without = far ? `, but for ${far} up to ${record.outside!.farthestMm.toFixed(2)} mm away that it left out, ${LEFT_OUT_KINDS}, which the cast will not have` : '';
    return { severity: far ? 'warning' : 'info', message: `The mold is made from a copy of ${name} rebuilt as one closed solid on a ${grid} grid. Your file lies ${nearWords(record)}, proved over all of it${without}. In merged mode the base carries that copy, so the silicone takes its shape.` };
  }
  // Past OUTSIDE_MEASURE_LIMIT the export holds the left-out parts but cannot measure them (RM's review).
  const measured = record.outside && record.outside.triangles > OUTSIDE_MEASURE_LIMIT
    ? 'but they are too many to measure the silicone round them, so it is planned there, not checked'
    : 'and the silicone thickness round them is measured on its own';
  const parts = far ? ` The repair left out ${far} of your file, up to ${record.outside!.farthestMm.toFixed(2)} mm from the copy, ${LEFT_OUT_KINDS}: the mold leaves room for them, ${measured}.` : '';
  const widened = record.nearMm > 0 ? ' The safety margin is wider by that much.' : '';
  return { severity: 'info', message: `The mold is made from a copy of ${name} rebuilt as one closed solid on a ${grid} grid. Your file lies ${nearWords(record)}, proved over all of it${far ? ' but the parts below' : ''}.${widened}${parts} ${yours}` };
}
