import { sha256 } from '../app/hash';
import { projectJson, type ProjectFile } from '../app/project';
import { isLarge, type LargeLimits } from '../app/largeModel';
import { MAX_JSON_BYTES, PROJECT_EXTENSION, packProject, unpackProject } from '../app/projectArchive';
import { MIGRATIONS, OPEN_AGAIN, OPEN_INSTEAD, ProjectError, readProjectJson, repairedDropped, simplifiedDropped, type ProjectNote } from '../app/projectFile';
import type { OriginalSource, RepairedEntry, SimplifiedEntry } from '../app/simplified';
import { fromRuns, subMesh } from '../core/mesh/outside';
import { weld, type WeldedMesh } from '../core/mesh/weld';
import { estimateTriangles } from '../core/stl/estimate';
import { parseStl, StlError } from '../core/stl/parse';

/**
 * project.worker's jobs, apart from `self` so Node tests run the same code. Each runs in a worker of
 * its own, terminated when it answers, as hashing and zipping a large STL would hold main for seconds:
 * the plan's 3 million triangles are 150 MB, which SHA-256 alone takes 1.1 s for on this server.
 */

/**
 * Save: project.json with the STL's hash, which is worked out here when main does not know it yet. MM2: for a
 * simplified model, `stl` is null: the worker reads the maker's file from `original` itself, checks it against
 * project.json's hash and packs it as model.stl, with the copy main holds as simplified.stl.
 */
export interface PackJob {
  t: 'pack';
  id: number;
  file: ProjectFile;
  stl: ArrayBuffer | null;
  original?: OriginalSource;
  simplified?: ArrayBuffer;
  /** RM: a repaired model's copy, packed as repaired.stl beside the maker's file, which `original` gives. */
  repaired?: ArrayBuffer;
}

/**
 * Open: a .moldproj, an export ZIP or a lone project.json. `loaded` is the model on screen, sent only
 * when main does not know its hash, to tell whether settings without a model belong to it.
 */
export interface OpenJob {
  t: 'open';
  id: number;
  bytes: ArrayBuffer;
  name: string;
  kind: 'zip' | 'json';
  loaded: ArrayBuffer | null;
  /**
   * MM2: past these limits a .moldproj's model is not handed over but counted, so main can ask first (R42). Null
   * opens it whatever its size. A simplified project's copy is opened without asking.
   */
  large?: LargeLimits | null;
  /** MM2: the maker's file itself, model.stl, whatever copy the project holds: Use the original. */
  original?: boolean;
}

/**
 * M11: an STL read here before it replaces the model on screen, so one that cannot be read leaves that
 * model as it was. The bytes come over and go back, so main makes no copy of a large file.
 */
export interface CheckJob {
  t: 'check';
  id: number;
  bytes: ArrayBuffer;
  name: string;
  /** A model is on screen, which a file that cannot be read leaves as it was, as the reason then says. */
  loaded: boolean;
}

export type ProjectJob = PackJob | OpenJob | CheckJob;

export interface Opened {
  file: ProjectFile;
  /** The project format the file was written in. */
  from: number;
  notes: ProjectNote[];
  /** The STL inside a .moldproj, its hash checked against project.json. Null for settings alone. */
  stl: Uint8Array | null;
  /** SHA-256 of that STL. */
  stlSha256: string | null;
  /** SHA-256 of the loaded model, when it was sent. */
  loadedSha256: string | null;
  /**
   * MM2: `stl` is the project's simplified copy, checked against its record, which the mold is made from; the
   * file itself, model.stl, was checked by its hash, and is `bytes` long. `stlSha256` is still model.stl's.
   */
  simplified?: { entry: SimplifiedEntry; bytes: number } | null;
  /**
   * RM: `stl` is the project's repaired copy, checked against its record, which the mold is made from; model.stl was
   * checked by its hash, and is `bytes` long. `outside` is the file's parts the copy left out, cut from model.stl by
   * the record's runs, in the file's coordinates, or null. `stlSha256` is still model.stl's.
   */
  repaired?: { entry: RepairedEntry; bytes: number; outside: WeldedMesh | null } | null;
  /** MM2: model.stl is past the limits asked about, so `stl` is null and main asks first: its figures. */
  large?: { triangles: number; exact: boolean; format: 'binary' | 'ascii'; bytes: number } | null;
}

export type ProjectReply =
  | { t: 'packed'; id: number; zip: Uint8Array; sha256: string }
  | { t: 'opened'; id: number; opened: Opened }
  /**
   * The STL reads: its bytes back, what the reading warned of, such as a count in the header its size does
   * not fit, and for a large file its SHA-256, which main then knows and need not send an export (null below).
   */
  | { t: 'checked'; id: number; bytes: ArrayBuffer; sha256: string | null; triangles: number; warnings: string[] }
  | { t: 'project-error'; id: number; message: string; details: string | null };

/**
 * From this size an STL's hash is worked out where it is read first. The export hashes a file it is not
 * told the hash of, from a copy of it, which for 150 MB is memory the page cannot spare (M11); below this,
 * the 134 MB/s it costs would only delay every load, and the export or a save hashes it as before.
 */
export const HASH_ON_READ_BYTES = 32 * 1024 * 1024;

/** What to do about an STL that cannot be read, after its own reason. */
export const STL_AGAIN = 'Export the STL again from the program that made it.';
/** Said before that while a model is on screen: on an empty page there is none to keep. */
export const MODEL_STAYS = 'The model on screen stays as it was.';

function openFile(job: OpenJob): Opened {
  const bytes = new Uint8Array(job.bytes);
  let json: string, stl: Uint8Array | null = null, copy: Uint8Array | null = null;
  if (job.kind === 'zip') {
    let repairedCopy: Uint8Array | null;
    ({ json, stl, simplified: copy, repaired: repairedCopy } = unpackProject(bytes, job.name, !job.original));
    copy ??= repairedCopy;
    // An export ZIP holds settings alone; a .moldproj must hold its model too.
    if (!stl && job.name.toLowerCase().endsWith(PROJECT_EXTENSION)) throw new ProjectError(`${job.name} is damaged: the model saved inside it is missing. ${OPEN_AGAIN}`, 'It has no model.stl.');
    // A short view would hand over, and keep, the whole buffer it is in.
    if (stl && stl.byteLength !== stl.buffer.byteLength) stl = stl.slice();
  } else {
    if (bytes.length > MAX_JSON_BYTES) throw new ProjectError(`${job.name} is too large to be a project's settings. ${OPEN_INSTEAD}`);
    try {
      json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new ProjectError(`${job.name} is not a project's settings, as it is not text. ${OPEN_INSTEAD}`);
    }
  }
  const read = readProjectJson(json, MIGRATIONS, job.name);
  const notes = [...read.notes];
  let stlSha256: string | null = null;
  let simplified: Opened['simplified'] = null;
  let repaired: Opened['repaired'] = null;
  let large: Opened['large'] = null;
  const loadedSha256 = job.loaded ? sha256(new Uint8Array(job.loaded)) : null;
  if (stl) {
    stlSha256 = sha256(stl);
    if (read.file.modelSha256 === null) notes.push({ severity: 'info', message: `${job.name} does not record its model's contents, so it could not be checked that the model inside is the one its settings were made for.` });
    else if (read.file.modelSha256 !== stlSha256) throw new ProjectError(`${job.name} is damaged or was changed: the model inside it is not the one its settings were saved for. ${OPEN_AGAIN}`, `The SHA-256 of model.stl is ${stlSha256}, where project.json records ${read.file.modelSha256}.`);
    // MM2: a simplified project opens its copy, checked by its own hash; the file's hash proves it is the one that
    // was simplified, so it is not read further. A copy that cannot be used opens the file itself, with a warning.
    const entry = read.file.simplified;
    // RM: a repaired one the same, its left-out parts cut from the file by the record's runs (parsed and welded as a
    // load does: about 1.4 s for 3 million triangles, which only a project with such parts pays).
    const fixed = read.file.repaired;
    if (fixed && !job.original) {
      const outside = copy && read.file.modelSha256 !== null && sha256(copy) === fixed.sha256 ? outsideOf(stl, fixed) : undefined;
      if (outside !== undefined) {
        repaired = { entry: fixed, bytes: stl.length, outside };
        stl = copy!;
      } else {
        notes.push({ severity: 'warning', message: repairedDropped(read.file.model) });
        delete read.file.repaired;
      }
    } else if (fixed) {
      delete read.file.repaired;
    }
    if (entry && !job.original) {
      if (copy && read.file.modelSha256 !== null && sha256(copy) === entry.sha256) {
        simplified = { entry, bytes: stl.length };
        stl = copy!;
      } else {
        notes.push({ severity: 'warning', message: simplifiedDropped(read.file.model) });
        delete read.file.simplified;
      }
    } else if (entry) {
      delete read.file.simplified;
    }
    // MM2: a model past the limits is counted, not handed over, so main asks before anything holds it.
    if (!simplified && !repaired && job.large) {
      const estimate = estimateTriangles(stl, stl.length);
      if (isLarge(estimate.triangles, stl.length, job.large)) {
        large = { triangles: estimate.triangles, exact: estimate.exact, format: estimate.format, bytes: stl.length };
        return { file: read.file, from: read.from, notes, stl: null, stlSha256, loadedSha256, simplified: null, repaired: null, large };
      }
    }
    // Read here first, so an STL that cannot be read never replaces the model on screen.
    try {
      parseStl(stl);
    } catch (error) {
      if (error instanceof StlError) throw new ProjectError(`${job.name} is damaged: the ${simplified ? 'simplified model' : repaired ? 'repaired model' : 'model'} inside it cannot be read. ${OPEN_AGAIN}`, `${simplified ? 'simplified.stl' : repaired ? 'repaired.stl' : 'model.stl'}: ${error.message}`);
      throw error;
    }
  }
  return { file: read.file, from: read.from, notes, stl, stlSha256, loadedSha256, ...(simplified ? { simplified } : {}), ...(repaired ? { repaired } : {}) };
}

/**
 * RM: a repaired project's left-out parts, cut from model.stl by its record's runs: null where it has none, and
 * undefined where the file cannot give them, as one whose runs reach past its triangles, so the copy is not used.
 */
function outsideOf(stl: Uint8Array, entry: RepairedEntry): WeldedMesh | null | undefined {
  if (!entry.outside) return null;
  let welded: WeldedMesh;
  try {
    welded = weld(parseStl(stl).positions);
  } catch {
    return undefined;
  }
  const triangles = fromRuns(entry.outside.runs);
  if (triangles.length !== entry.outside.triangles || triangles.some((t) => t >= welded.indices.length / 3)) return undefined;
  return subMesh(welded, triangles);
}

/** Below this an STL is read on main, which takes a few ms where a worker of its own would take tens. */
export const READ_IN_WORKER_BYTES = 4 * 1024 * 1024;

/**
 * M11: an STL read before it replaces the model on screen: its triangles, the reader's warnings, and for
 * a large file its hash. One that cannot be read is a ProjectError in the reader's own words, naming the file.
 */
export function readStl(bytes: Uint8Array, name: string, loaded: boolean): { triangles: number; warnings: string[]; sha256: string | null } {
  try {
    const parsed = parseStl(bytes);
    return { triangles: parsed.triangleCount, warnings: parsed.diagnostics.map((d) => d.message), sha256: bytes.length >= HASH_ON_READ_BYTES ? sha256(bytes) : null };
  } catch (error) {
    if (error instanceof StlError) throw new ProjectError(`${name} cannot be opened: ${error.message} ${loaded ? `${MODEL_STAYS} ` : ''}${STL_AGAIN}`);
    throw error;
  }
}

const noReader = (): Uint8Array => {
  throw new Error('This worker cannot read files.');
};

/**
 * MM2: the maker's own file for a simplified model's .moldproj, read from where it was opened and checked against
 * the hash project.json records: a file changed since stops the save with the reason.
 */
function originalFor(job: PackJob, readBlob: (blob: Blob) => Uint8Array): Uint8Array {
  const { original, file } = job;
  let bytes: Uint8Array;
  try {
    bytes = readBlob(original!.blob);
    if (original!.kind === 'moldproj') bytes = unpackProject(bytes, file.model).stl ?? new Uint8Array();
  } catch (error) {
    throw new ProjectError(`${file.model} could not be read again for the project, so nothing was saved: it may have been moved, renamed or changed since you opened it. Open it again, then save.`, error instanceof Error ? error.message : String(error));
  }
  const hash = sha256(bytes);
  if (hash !== file.modelSha256) throw new ProjectError(`${file.model} has changed since you opened it, so the project was not saved: it would hold another model than the one the mold was made from. Open it again, then save.`, `The SHA-256 of ${file.model} is ${hash}, where the model on screen was made from ${file.modelSha256}.`);
  return bytes;
}

/** A save that failed for no reason of the maker's, which main words itself. */
export const PACK_FAILED = 'The project could not be saved.';

/** One job to its reply, with what the reply can hand over without a copy. A failure is always a reply, never a throw. */
export function runProjectJob(job: ProjectJob, readBlob: (blob: Blob) => Uint8Array = noReader): { reply: ProjectReply; transfer: ArrayBuffer[] } {
  try {
    if (job.t === 'pack') {
      const stl = job.original ? originalFor(job, readBlob) : new Uint8Array(job.stl!);
      const hash = job.file.modelSha256 ?? sha256(stl);
      const zip = packProject(projectJson({ ...job.file, modelSha256: hash }), stl, job.simplified ? new Uint8Array(job.simplified) : null, job.repaired ? new Uint8Array(job.repaired) : null);
      return { reply: { t: 'packed', id: job.id, zip, sha256: hash }, transfer: [zip.buffer as ArrayBuffer] };
    }
    if (job.t === 'check') {
      const read = readStl(new Uint8Array(job.bytes), job.name, job.loaded);
      return { reply: { t: 'checked', id: job.id, bytes: job.bytes, ...read }, transfer: [job.bytes] };
    }
    const opened = openFile(job);
    const far = opened.repaired?.outside;
    return { reply: { t: 'opened', id: job.id, opened }, transfer: [...(opened.stl ? [opened.stl.buffer as ArrayBuffer] : []), ...(far ? [far.positions.buffer as ArrayBuffer, far.indices.buffer as ArrayBuffer] : [])] };
  } catch (error) {
    if (error instanceof ProjectError) return { reply: { t: 'project-error', id: job.id, message: error.message, details: error.details }, transfer: [] };
    const message = job.t === 'pack' ? PACK_FAILED : `${job.name} could not be opened. Try again.`;
    return { reply: { t: 'project-error', id: job.id, message, details: error instanceof Error ? error.message : String(error) }, transfer: [] };
  }
}
