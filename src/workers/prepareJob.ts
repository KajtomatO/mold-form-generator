import type { ManifoldToplevel } from 'manifold-3d';
import { sha256 } from '../app/hash';
import { unpackProject } from '../app/projectArchive';
import type { OriginalFacts, OriginalImport, OriginalSource, RepairRecord, SimplifiedRecord } from '../app/simplified';
import { auditEdges, type MeshAudit } from '../core/mesh/audit';
import { RepairError, REPAIRED_TRIANGLE_LIMIT } from '../core/mesh/repair';
import { asLoaded, checkClosed, repairMesh, type RepairStep } from '../core/mesh/repairImport';
import { importSolid } from '../core/mesh/shells';
import { MANIFOLD_TRIANGLE_LIMIT, MAX_ROUNDS, simplifyModel, type MeshSimplifier } from '../core/mesh/simplify';
import { weld, type WeldedMesh } from '../core/mesh/weld';
import { parseStl, StlError } from '../core/stl/parse';
import { writeBinaryStl } from '../core/stl/write';
import { withArena } from '../core/solid/arena';
import { InlineError } from './fieldStages';
import { STL_AGAIN } from './projectJob';

/**
 * MM2: the job that prepares a model before it loads, in a fresh solid.worker of its own, terminated when it
 * answers: the simplified copy of a large model (R42, D24), and RM: the mesh repair (R43, D26), a step of its own on
 * the same welded mesh, before any copy is made, as it needs Manifold and meshoptimizer too. Pure apart from
 * `readBlob`, so Node tests run the same code: the worker reads the maker's file itself, with FileReaderSync, so
 * main never holds its bytes.
 */
export interface PrepareJob {
  /** The file, unread: the maker's File, or for a load by bytes a Blob of them. */
  source: OriginalSource;
  /** The STL's name, which a .moldproj's project.json gives. */
  name: string;
  /**
   * MM2: the copy with fewer triangles. With `repair`, the count a repaired copy keeps to, as the model on screen was
   * a simplified copy (decision F): a rebuild is reduced to it, and a filled file past it is simplified to it.
   */
  simplify: { target: number; maxErrorMm: number } | null;
  /** RM: repair the file into a closed solid, on a grid of `cell` mm for a rebuild (null for auto); `facts` say how the file imports. */
  repair?: { cell: number | null; facts: OriginalImport } | null;
}

export interface Prepared {
  /** The copy as a binary STL, which loads as any STL does. */
  stl: Uint8Array;
  from: OriginalFacts;
  /** MM2's copy of the file, or null for a repair. */
  record: SimplifiedRecord | null;
  /** RM: the repaired copy's record, or null for a copy only simplified. */
  repair: RepairRecord | null;
  /** RM: the file's parts the repaired copy left out, in the file's coordinates, or null. */
  outside: WeldedMesh | null;
  rounds: number;
  timings: Record<string, number>;
}

/**
 * The steps a prepare job reports, in order: 'simplify' and 'measure' are the two halves of each round of the lock
 * loop, which carry the round in `done`; 'check' is Manifold's check of the copy. RM: a repair's own steps, from
 * repairMesh, come after 'parse': 'orient', 'fill' (a fill only), 'rebuild' (z-slabs in `done` of `total`), 'reduce' (rounds), 'check' and
 * 'compare', then MM2's two for a filled copy simplified again, then 'write'.
 */
export type PrepareStep = 'read' | 'parse' | RepairStep | 'simplify' | 'measure' | 'check' | 'write';
export type PrepareProgress = (step: PrepareStep, done: number, total: number) => void;

/**
 * RM: the memory meter's own hooks into a repair, which grows its arrays inside its steps: `held` asks for a reading
 * now, with what `holding` holds, and `extra` says how many bytes meshoptimizer's own heap holds, which no array shows.
 */
export interface PrepareMeter {
  held(): void;
  extra(bytes: number): void;
}

/** Why a file could not be read again: moved, renamed or changed on disk since it was chosen. */
export function unreadable(name: string, error: unknown): InlineError {
  const reason = error instanceof Error ? error.message : String(error);
  return Object.assign(new InlineError('original-unreadable', `${name} could not be read again: it may have been moved, renamed or changed since you opened it. Open it again.`), { details: reason });
}

/** The STL a source holds: the file itself, a gallery model's, or a .moldproj's model.stl. */
export function originalBytes(source: OriginalSource, name: string, readBlob: (blob: Blob) => Uint8Array): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = readBlob(source.blob);
  } catch (error) {
    throw unreadable(name, error);
  }
  if (source.kind !== 'moldproj') return bytes;
  const { stl } = unpackProject(bytes, name);
  if (!stl) throw new InlineError('original-unreadable', `${name} is damaged: the model saved inside it is missing.`);
  return stl;
}

/**
 * Reads, parses and welds the file, makes the copy (simplifyModel), checks that Manifold still takes it as a
 * solid where it took the file, and writes it. `holding` is given what the job keeps at each step, one slot
 * each step replaces, so the memory meter counts nothing the job has let go (MM1's rule for the export).
 */
export function runPrepareJob(api: ManifoldToplevel, simplifier: MeshSimplifier, job: PrepareJob, readBlob: (blob: Blob) => Uint8Array, progress: PrepareProgress, now: () => number, holding: unknown[] = [], meter: PrepareMeter | null = null): Prepared {
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
  if (job.repair) return repairJob(api, simplifier, job, mesh, before, from, progress, now, timed, timings, holding, slot, meter);
  const asked = job.simplify;
  if (!asked) throw new Error('A prepare job needs a copy or a repair to make.');
  const triangles = mesh.indices.length / 3;
  const target = asked.target;
  if (!(target >= 1) || target >= triangles) throw new InlineError('simplify-nothing', `${name} has ${triangles.toLocaleString('en-US')} triangles, no more than the ${target.toLocaleString('en-US')} asked for, so there is nothing to simplify.`);

  // Each half of each round says what it holds, so the meter follows the lock loop, which holds the most.
  const simplified = timed('simplify', () =>
    simplifyModel(
      mesh,
      simplifier,
      target,
      asked.maxErrorMm,
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
    target: asked.target,
    maxErrorMm: asked.maxErrorMm,
    errorMm: simplified.errorMm,
    stoppedBy: simplified.stoppedBy,
    sha256: timed('sha256', () => sha256(stl)),
  };
  return { stl, from, record, repair: null, outside: null, rounds: simplified.rounds, timings };
}

/**
 * RM: the repair (repairMesh) of the welded file, then, for a filled file past the count of the simplified copy it
 * replaces on screen, MM2's copy of the filled mesh (decision F), checked closed again, whose proved error is how
 * far the file lies from the copy, as every triangle of the file is in the filled mesh. Then the copy is written.
 * A repair the file cannot be given says why in its own sentence (InlineError), which the Model section shows.
 */
function repairJob(api: ManifoldToplevel, simplifier: MeshSimplifier, job: PrepareJob, file: WeldedMesh, audit: MeshAudit, from: OriginalFacts, progress: PrepareProgress, now: () => number, timed: <T>(step: string, run: () => T) => T, timings: Record<string, number>, holding: unknown[], slot: number, meter: PrepareMeter | null): Prepared {
  const { name } = job;
  const repair = job.repair!;
  const target = job.simplify?.target ?? null;
  // Every large array of each step, beside the file and its audit's loops, which the repair keeps throughout.
  holding[slot] = [file, audit];
  let repaired;
  try {
    repaired = timed('repair', () =>
      repairMesh(api, simplifier, file, audit, {
        name,
        cell: repair.cell,
        maxTriangles: target === null ? REPAIRED_TRIANGLE_LIMIT : Math.min(REPAIRED_TRIANGLE_LIMIT, target),
        manifoldLimit: MANIFOLD_TRIANGLE_LIMIT,
        now,
        progress: (step, done, total) => progress(step, done, total),
        hold: (arrays, meshopt) => {
          holding[slot] = [file, audit, arrays];
          meter?.extra(meshopt);
          meter?.held();
        },
      }),
    );
  } catch (error) {
    if (error instanceof RepairError) throw new InlineError(error.code, error.message);
    throw error;
  }
  for (const [step, ms] of Object.entries(repaired.timings)) timings[`repair.${step}`] = ms;
  // meshoptimizer's heap stays as large as the reduction made it until the job's worker ends, so `extra` stands.
  let mesh = repaired.mesh;
  holding[slot] = [file, mesh, repaired.outside];
  meter?.held();
  let simplified: RepairRecord['simplified'] = null;
  let nearMm = repaired.figures.nearMm;
  let rounds = 0;
  if (repaired.figures.method === 'filled' && target !== null && mesh.indices.length / 3 > target && job.simplify) {
    // MM2's copy, of the filled mesh, under its own part of the meter. A fill gave meshoptimizer nothing to hold.
    const copy = timed('simplify', () =>
      simplifyModel(
        mesh,
        simplifier,
        target,
        job.simplify!.maxErrorMm,
        (round, step) => progress(step === 'simplify' ? 'simplify' : 'measure', round, MAX_ROUNDS),
        (arrays) => {
          holding[slot] = [file, mesh, arrays];
        },
      ),
    );
    progress('check', 0, 1);
    const loaded = timed('check', () => asLoaded(copy.mesh));
    if (!timed('check', () => checkClosed(api, loaded, MANIFOLD_TRIANGLE_LIMIT))) throw new InlineError('repair-failed', `${name} was repaired, but simplifying the repaired copy would open holes in it, so it was not repaired. Use the original, then Repair mesh again on the file loaded as it is.`);
    mesh = loaded;
    rounds = copy.rounds;
    nearMm = copy.errorMm;
    simplified = { triangles: mesh.indices.length / 3, target, maxErrorMm: job.simplify.maxErrorMm, errorMm: copy.errorMm, stoppedBy: copy.stoppedBy };
    holding[slot] = [file, mesh];
  }

  progress('write', 0, 1);
  const stl = timed('write', () => writeBinaryStl(mesh.positions, mesh.indices));
  holding[slot] = [stl, repaired.outside];
  const record: RepairRecord = {
    ...repaired.figures,
    triangles: mesh.indices.length / 3,
    nearMm,
    original: repair.facts,
    simplified,
    marks: repaired.marks,
    sha256: timed('sha256', () => sha256(stl)),
  };
  return { stl, from, record: null, repair: record, outside: repaired.outside, rounds, timings };
}
