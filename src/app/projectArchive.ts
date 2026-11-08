import { unzipSync, zipSync } from 'fflate';
import { OPEN_AGAIN, OPEN_INSTEAD, ProjectError } from './projectFile';

/**
 * The .moldproj container: a ZIP of project.json and the STL exactly as it was loaded. The same
 * reader takes the export ZIP, which has project.json and no model.stl. Pure, for project.worker and
 * for Node tests.
 */
export const PROJECT_ENTRY = 'project.json';
export const MODEL_ENTRY = 'model.stl';
export const PROJECT_EXTENSION = '.moldproj';

/** A project.json is a few kB. Past this it is not one, whatever the ZIP says. */
export const MAX_JSON_BYTES = 4 * 1024 * 1024;
/**
 * The most an STL inside may unpack to: 1 GiB, about 21 million triangles, seven times the 3 million
 * the plan's heavy input has. A ZIP that declares more is refused before anything is inflated.
 */
export const MAX_STL_BYTES = 1024 * 1024 * 1024;
/**
 * Deflate packs at most about 1032 bytes into one, so an entry declaring more per byte of the whole
 * archive is damaged or crafted. Measured against the bytes there are, not the entry's own declared
 * compressed size, which a crafted file can raise along with the rest.
 */
const MAX_RATIO = 1100;

/** The same date for every entry, so saving one project twice gives the same bytes. */
const ZIP_TIME = new Date(2026, 0, 1);

/**
 * Packs a project. The STL is deflated at level 1: on Benchy it packs to 41% in 268 ms against 40% in
 * 398 ms at the default 6, and on a 150 MB STL to 21% in 3.0 s against 7.8 s, measured in Node here.
 */
export function packProject(json: string, stl: Uint8Array): Uint8Array {
  return zipSync({ [PROJECT_ENTRY]: [new TextEncoder().encode(json), { mtime: ZIP_TIME }], [MODEL_ENTRY]: [stl, { mtime: ZIP_TIME, level: 1 }] });
}

/** 'other' is a file that is none of them, which is refused before it can replace the model on screen. */
export type FileKind = 'stl' | 'zip' | 'json' | 'other';

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/**
 * What a chosen or dropped file is: by its extension, which says what the maker meant, and by its first
 * bytes when it has none the app knows. A .moldproj or .zip that is no ZIP is then reported as such. A
 * file named otherwise counts as an STL only if it looks like one, a binary STL of the size its count
 * gives or an ASCII one, so a photo dropped by mistake leaves the model on screen alone.
 */
export function fileKind(name: string, bytes: Uint8Array): FileKind {
  const lower = name.toLowerCase();
  if (lower.endsWith('.stl')) return 'stl';
  if (lower.endsWith(PROJECT_EXTENSION) || lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.json')) return 'json';
  if (ZIP_MAGIC.every((byte, k) => bytes[k] === byte)) return 'zip';
  let k = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (k < bytes.length && (bytes[k] === 0x20 || bytes[k] === 0x0a || bytes[k] === 0x0d || bytes[k] === 0x09)) k++;
  if (bytes[k] === 0x7b) return 'json';
  const binary = bytes.length >= 84 && bytes.length === 84 + 50 * new DataView(bytes.buffer, bytes.byteOffset + 80, 4).getUint32(0, true);
  const ascii = new TextDecoder().decode(bytes.subarray(k, k + 5)).toLowerCase() === 'solid';
  return binary || ascii ? 'stl' : 'other';
}

/**
 * Whether a ZIP holds a model.stl, read from its directory alone, so nothing is inflated. Main asks this
 * before it copies the model on screen into an open job, which only settings without a model need.
 */
export function holdsModel(bytes: Uint8Array): boolean {
  let found = false;
  try {
    unzipSync(bytes, {
      filter: (entry) => {
        if (entry.name === MODEL_ENTRY) found = true;
        return false;
      },
    });
  } catch {
    // Not a ZIP that can be read: the job says why, and needs no model for that.
    return true;
  }
  return found;
}

export interface Unpacked {
  json: string;
  /** The STL inside, or null for an export ZIP, which holds only the settings. */
  stl: Uint8Array | null;
}

/**
 * Reads project.json and model.stl from a ZIP, refusing any entry whose declared size is past its
 * limit before inflating it, as fflate allocates what the directory declares. An entry that inflates
 * to more than it declared is cut at its declared size, so the declared size bounds the memory.
 */
export function unpackProject(bytes: Uint8Array, name: string): Unpacked {
  if (!ZIP_MAGIC.every((byte, k) => bytes[k] === byte)) throw new ProjectError(`${name} is not a project saved by this app, as it is no ZIP archive. ${OPEN_INSTEAD}`);
  let entries: Record<string, Uint8Array>;
  const names: string[] = [];
  const declared = new Map<string, number>();
  try {
    entries = unzipSync(bytes, {
      filter: (entry) => {
        names.push(entry.name);
        const wanted = entry.name === PROJECT_ENTRY || entry.name === MODEL_ENTRY;
        if (!wanted) return false;
        const says = entry.name === PROJECT_ENTRY ? 'the settings inside it say they unpack' : 'the model inside it says it unpacks';
        const limit = entry.name === PROJECT_ENTRY ? MAX_JSON_BYTES : MAX_STL_BYTES;
        if (entry.originalSize > limit) throw new ProjectError(`${name} is damaged or too large: ${says} to ${megabytes(entry.originalSize)}, past the ${megabytes(limit)} this app takes. ${OPEN_AGAIN}`, `${entry.name} declares ${entry.originalSize} bytes.`);
        if (entry.size > bytes.length || entry.originalSize > bytes.length * MAX_RATIO + 1024) {
          throw new ProjectError(`${name} is damaged: ${says} to ${megabytes(entry.originalSize)} from a file of ${megabytes(bytes.length)}, which no ZIP can. ${OPEN_AGAIN}`, `${entry.name} declares ${entry.size} bytes packed and ${entry.originalSize} unpacked.`);
        }
        declared.set(entry.name, entry.originalSize);
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    throw new ProjectError(`${name} is damaged and cannot be unpacked. ${OPEN_AGAIN}`, `The ZIP reader says: ${error instanceof Error ? error.message : String(error)}.`);
  }
  // fflate cuts an entry at its declared size and leaves a short one in a buffer of that size, so either
  // way an entry of another length than declared is damaged, and none is kept in a larger buffer.
  for (const [entry, size] of declared) {
    if (entries[entry]?.length !== size) throw new ProjectError(`${name} is damaged: ${entry === PROJECT_ENTRY ? 'the settings inside it are' : 'the model inside it is'} not the size the archive says. ${OPEN_AGAIN}`, `${entry} unpacks to ${entries[entry]?.length ?? 0} bytes, where ${size} are declared.`);
  }
  const json = entries[PROJECT_ENTRY];
  if (!json) throw new ProjectError(notProject(name, names));
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(json);
  } catch {
    throw new ProjectError(`${name} is damaged: its settings are not text. ${OPEN_AGAIN}`, 'project.json is not UTF-8.');
  }
  return { json: text, stl: entries[MODEL_ENTRY] ?? null };
}

/** Why a ZIP with no project.json is no project, by what it holds: a maker's ZIP of STLs, or a slicer's 3MF, says what to do instead. */
function notProject(name: string, names: string[]): string {
  if (name.toLowerCase().endsWith('.3mf') || names.includes('3D/3dmodel.model')) return `${name} is a 3MF file, which this app does not read. Export the model from your slicer as an STL, then open that.`;
  if (names.some((entry) => entry.toLowerCase().endsWith('.stl'))) return `${name} holds STL files, not a project of this app. Unzip it, then open the STL you want.`;
  return `${name} is not a project saved by this app, as it holds no project.json. ${OPEN_INSTEAD}`;
}

function megabytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB` : `${Math.ceil(bytes / 1024)} kB`;
}
