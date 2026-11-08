import { sha256 } from '../app/hash';
import { projectJson, type ProjectFile } from '../app/project';
import { MAX_JSON_BYTES, PROJECT_EXTENSION, packProject, unpackProject } from '../app/projectArchive';
import { MIGRATIONS, OPEN_AGAIN, OPEN_INSTEAD, ProjectError, readProjectJson, type ProjectNote } from '../app/projectFile';
import { parseStl, StlError } from '../core/stl/parse';

/**
 * project.worker's jobs, apart from `self` so Node tests run the same code. Each runs in a worker of
 * its own, terminated when it answers, as hashing and zipping a large STL would hold main for seconds:
 * the plan's 3 million triangles are 150 MB, which SHA-256 alone takes 1.1 s for on this server.
 */

/** Save: project.json with the STL's hash, which is worked out here when main does not know it yet. */
export interface PackJob {
  t: 'pack';
  id: number;
  file: ProjectFile;
  stl: ArrayBuffer;
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
  let json: string, stl: Uint8Array | null = null;
  if (job.kind === 'zip') {
    ({ json, stl } = unpackProject(bytes, job.name));
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
  if (stl) {
    stlSha256 = sha256(stl);
    if (read.file.modelSha256 === null) notes.push({ severity: 'info', message: `${job.name} does not record its model's contents, so it could not be checked that the model inside is the one its settings were made for.` });
    else if (read.file.modelSha256 !== stlSha256) throw new ProjectError(`${job.name} is damaged or was changed: the model inside it is not the one its settings were saved for. ${OPEN_AGAIN}`, `The SHA-256 of model.stl is ${stlSha256}, where project.json records ${read.file.modelSha256}.`);
    // Read here first, so an STL that cannot be read never replaces the model on screen.
    try {
      parseStl(stl);
    } catch (error) {
      if (error instanceof StlError) throw new ProjectError(`${job.name} is damaged: the model inside it cannot be read. ${OPEN_AGAIN}`, `model.stl: ${error.message}`);
      throw error;
    }
  }
  return { file: read.file, from: read.from, notes, stl, stlSha256, loadedSha256: job.loaded ? sha256(new Uint8Array(job.loaded)) : null };
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

/** One job to its reply, with what the reply can hand over without a copy. A failure is always a reply, never a throw. */
export function runProjectJob(job: ProjectJob): { reply: ProjectReply; transfer: ArrayBuffer[] } {
  try {
    if (job.t === 'pack') {
      const stl = new Uint8Array(job.stl);
      const hash = job.file.modelSha256 ?? sha256(stl);
      const zip = packProject(projectJson({ ...job.file, modelSha256: hash }), stl);
      return { reply: { t: 'packed', id: job.id, zip, sha256: hash }, transfer: [zip.buffer as ArrayBuffer] };
    }
    if (job.t === 'check') {
      const read = readStl(new Uint8Array(job.bytes), job.name, job.loaded);
      return { reply: { t: 'checked', id: job.id, bytes: job.bytes, ...read }, transfer: [job.bytes] };
    }
    const opened = openFile(job);
    return { reply: { t: 'opened', id: job.id, opened }, transfer: opened.stl ? [opened.stl.buffer as ArrayBuffer] : [] };
  } catch (error) {
    if (error instanceof ProjectError) return { reply: { t: 'project-error', id: job.id, message: error.message, details: error.details }, transfer: [] };
    const message = job.t === 'pack' ? 'The project could not be saved.' : `${job.name} could not be opened. Try again.`;
    return { reply: { t: 'project-error', id: job.id, message, details: error instanceof Error ? error.message : String(error) }, transfer: [] };
  }
}
