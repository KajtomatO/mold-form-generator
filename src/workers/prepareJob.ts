import type { ManifoldToplevel } from 'manifold-3d';
import { sha256 } from '../app/hash';
import { unpackProject } from '../app/projectArchive';
import type { OriginalFacts, OriginalSource, SimplifiedRecord } from '../app/simplified';
import { auditEdges } from '../core/mesh/audit';
import { importSolid } from '../core/mesh/shells';
import { MAX_ROUNDS, simplifyModel, type MeshSimplifier } from '../core/mesh/simplify';
import { weld, type WeldedMesh } from '../core/mesh/weld';
import { parseStl, StlError } from '../core/stl/parse';
import { writeBinaryStl } from '../core/stl/write';
import { withArena } from '../core/solid/arena';
import { InlineError } from './fieldStages';
import { STL_AGAIN } from './projectJob';

/**
 * MM2: the job that prepares a model before it loads, in a fresh solid.worker of its own, terminated when it
 * answers: today it makes the simplified copy of a large model (R42, D24). The mesh repair planned for 0.2.0
 * joins it as a step of its own, on the same welded mesh, before the copy is made, as it needs Manifold and
 * meshoptimizer too. Pure apart from `readBlob`, so Node tests run the same code: the worker reads the maker's
 * file itself, with FileReaderSync, so main never holds its bytes.
 */
export interface PrepareJob {
  /** The file, unread: the maker's File, or for a load by bytes a Blob of them. */
  source: OriginalSource;
  /** The STL's name, which a .moldproj's project.json gives. */
  name: string;
  simplify: { target: number; maxErrorMm: number };
}

export interface Prepared {
  /** The copy as a binary STL, which loads as any STL does. */
  stl: Uint8Array;
  from: OriginalFacts;
  record: SimplifiedRecord;
  rounds: number;
  timings: Record<string, number>;
}

/**
 * The steps a prepare job reports, in order: 'simplify' and 'measure' are the two halves of each round of the lock
 * loop, which carry the round in `done`; 'check' is Manifold's check of the copy.
 */
export type PrepareStep = 'read' | 'parse' | 'simplify' | 'measure' | 'check' | 'write';
export type PrepareProgress = (step: PrepareStep, done: number, total: number) => void;

/** Why a file could not be read again: moved, renamed or changed on disk since it was chosen. */
export function unreadable(name: string, error: unknown): InlineError {
  const reason = error instanceof Error ? error.message : String(error);
  return Object.assign(new InlineError('original-unreadable', `${name} could not be read again: it may have been moved, renamed or changed since you opened it. Open it again.`), { details: reason });
}

/** The STL a source holds: the file itself, or a .moldproj's model.stl. */
export function originalBytes(source: OriginalSource, name: string, readBlob: (blob: Blob) => Uint8Array): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = readBlob(source.blob);
  } catch (error) {
    throw unreadable(name, error);
  }
  if (source.kind === 'stl') return bytes;
  const { stl } = unpackProject(bytes, name);
  if (!stl) throw new InlineError('original-unreadable', `${name} is damaged: the model saved inside it is missing.`);
  return stl;
}

/**
 * Reads, parses and welds the file, makes the copy (simplifyModel), checks that Manifold still takes it as a
 * solid where it took the file, and writes it. `holding` is given what the job keeps at each step, one slot
 * each step replaces, so the memory meter counts nothing the job has let go (MM1's rule for the export).
 */
export function runPrepareJob(api: ManifoldToplevel, simplifier: MeshSimplifier, job: PrepareJob, readBlob: (blob: Blob) => Uint8Array, progress: PrepareProgress, now: () => number, holding: unknown[] = []): Prepared {
  const timings: Record<string, number> = {};
  const timed = <T>(step: string, run: () => T): T => {
    const t0 = now();
    const value = run();
    timings[step] = (timings[step] ?? 0) + now() - t0;
    return value;
  };
  const slot = holding.push(null) - 1;
  const { name } = job;

  progress('read', 0, 1);
  let bytes: Uint8Array | null = timed('read', () => originalBytes(job.source, name, readBlob));
  holding[slot] = bytes;

  progress('parse', 0, 1);
  const hash = timed('sha256', () => sha256(bytes!));
  const parsed = timed('parse', () => {
    try {
      return parseStl(bytes!);
    } catch (error) {
      if (error instanceof StlError) throw new InlineError('stl', `${name} cannot be opened: ${error.message} ${STL_AGAIN}`);
      throw error;
    }
  });
  const from: OriginalFacts = { name, bytes: bytes.length, sha256: hash, format: parsed.format, trianglesInFile: parsed.rawTriangleCount, triangles: parsed.triangleCount };
  bytes = null;
  holding[slot] = parsed.positions;
  const mesh: WeldedMesh = timed('weld', () => weld(parsed.positions));
  holding[slot] = mesh;
  const before = timed('audit', () => auditEdges(mesh));
  const triangles = mesh.indices.length / 3;
  const target = job.simplify.target;
  if (!(target >= 1) || target >= triangles) throw new InlineError('simplify-nothing', `${name} has ${triangles.toLocaleString('en-US')} triangles, no more than the ${target.toLocaleString('en-US')} asked for, so there is nothing to simplify.`);

  // Each half of each round says what it holds, so the meter follows the lock loop, which holds the most.
  const simplified = timed('simplify', () =>
    simplifyModel(
      mesh,
      simplifier,
      target,
      job.simplify.maxErrorMm,
      (round, step) => progress(step === 'simplify' ? 'simplify' : 'measure', round, MAX_ROUNDS),
      (arrays) => {
        holding[slot] = [mesh, arrays];
      },
    ),
  );
  holding[slot] = [mesh, simplified.mesh];

  progress('check', 0, 1);
  const closed = before.openEdges === 0 && before.misorientedEdges === 0;
  const route = timed('check', () => withArena(api, (arena) => importSolid(arena, simplified.mesh, auditEdges(simplified.mesh)).report.route));
  // A closed file whose copy Manifold takes only as an open surface would lose merged mode and the measured clearance.
  if (closed && route === 'soup') throw new InlineError('simplify-holes', `Simplifying ${name} would open holes in it, so it was not simplified. Load it anyway, or simplify it in the program that made it.`);

  progress('write', 0, 1);
  holding[slot] = simplified.mesh;
  const stl = timed('write', () => writeBinaryStl(simplified.mesh.positions, simplified.mesh.indices));
  holding[slot] = stl;
  const record: SimplifiedRecord = {
    triangles: simplified.mesh.indices.length / 3,
    target: job.simplify.target,
    maxErrorMm: job.simplify.maxErrorMm,
    errorMm: simplified.errorMm,
    stoppedBy: simplified.stoppedBy,
    sha256: timed('sha256', () => sha256(stl)),
  };
  return { stl, from, record, rounds: simplified.rounds, timings };
}
