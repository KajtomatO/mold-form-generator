import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { MeshoptSimplifier } from 'meshoptimizer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LARGE_MODEL, minBytesToLook } from '../../src/app/largeModel';
import type { ManifoldToplevel } from 'manifold-3d';
import { ModelSimplifier } from '../../src/app/modelSimplifier';
import { Pipeline } from '../../src/app/pipeline';
import { projectJson, type ProjectFile } from '../../src/app/project';
import { MODEL_ENTRY, packProject, PROJECT_ENTRY, SIMPLIFIED_ENTRY } from '../../src/app/projectArchive';
import { ProjectFiles } from '../../src/app/projectFiles';
import { simplifiedEntry } from '../../src/app/simplified';
import { Store } from '../../src/app/store';
import { SCHEMA_VERSION } from '../../src/core/params/schema';
import { PLANE_MATCH_MM } from '../../src/core/base/storedPlane';
import { transformPositions } from '../../src/core/base/orient';
import { weld } from '../../src/core/mesh/weld';
import { parseStl } from '../../src/core/stl/parse';
import { writeBinaryStl } from '../../src/core/stl/write';
import { runPrepareJob } from '../../src/workers/prepareJob';
import type { WorkerLike } from '../../src/workers/protocol';
import type { ExportReport } from '../../src/workers/exportJob';
import { inProcessField, inProcessProject, inProcessSolid } from '../fixtures/inProcessWorker';
import { exampleBytes, EXAMPLE_FILES, loadManifold } from '../fixtures/loadExamples';

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const files = new ProjectFiles(inProcessProject);
const pipelines: Pipeline[] = [];
/** The warning point lowered, so jersey's 1,340 triangles reach it: the flow is the same at any size. */
const LOW = { triangles: 1_000, bytes: 1e12 };

let api: ManifoldToplevel;
beforeAll(async () => {
  await MeshoptSimplifier.ready;
  api = await loadManifold();
});
afterEach(() => {
  pipelines.splice(0).forEach((p) => p.dispose());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * A store with every worker in this process, the simplifier's spawns counted, and the warning point `limits`.
 * `hold` delays each job to the simplifier's worker by that many ms, so a test can act while it waits.
 */
function setup(limits = LOW, hold = 0): { store: Store; p: Pipeline; simplifier: ModelSimplifier; spawned: { terminated: boolean }[] } {
  const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true });
  pipelines.push(p);
  const spawned: { terminated: boolean }[] = [];
  const simplifier = new ModelSimplifier(() => {
    const worker = inProcessSolid();
    const record = { terminated: false };
    spawned.push(record);
    const end = worker.terminate.bind(worker);
    worker.terminate = () => {
      record.terminated = true;
      end();
    };
    if (hold > 0) {
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (message, transfer) => void setTimeout(() => post(message, transfer), hold);
    }
    return worker;
  }, p.memory);
  const store = new Store(p, () => 0, files, simplifier);
  store.largeLimits = limits;
  return { store, p, simplifier, spawned };
}

/** A File whose reads are counted: the first bytes by slice, and the whole by arrayBuffer. */
function counted(bytes: Uint8Array, name: string): { file: File; reads: { slice: number; whole: number } } {
  const file = new File([bytes as BlobPart], name);
  const reads = { slice: 0, whole: 0 };
  const slice = file.slice.bind(file), whole = file.arrayBuffer.bind(file);
  file.slice = (...args: Parameters<File['slice']>) => {
    reads.slice++;
    return slice(...args);
  };
  file.arrayBuffer = () => {
    reads.whole++;
    return whole();
  };
  return { file, reads };
}

/** saveBytes in Node: the anchor's click records the file it would save. */
function captureSaves(): { name: string; bytes: Promise<Uint8Array> }[] {
  const saved: { name: string; bytes: Promise<Uint8Array> }[] = [];
  let blob: Blob | null = null;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
    blob = b as Blob;
    return 'blob:test/1';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const anchor = { href: '', download: '', style: {}, click: () => saved.push({ name: anchor.download, bytes: blob!.arrayBuffer().then((b) => new Uint8Array(b)) }), remove: () => {} };
  vi.stubGlobal('document', { createElement: () => anchor, body: { append: () => {} } });
  return saved;
}

const jersey = exampleBytes('jersey');
const JERSEY = EXAMPLE_FILES.jersey;

/** The SHA-256 of jersey's file as model_oriented.stl writes it on this pipeline's plane: welded, turned, rewritten. */
function orientedFileSha(p: Pipeline, bytes: Uint8Array = jersey): string {
  const welded = weld(parseStl(bytes).positions);
  return sha(writeBinaryStl(transformPositions(welded.positions, p.oriented!.value.oriented.transform), welded.indices));
}

/** What the store carries onto another mesh: the plane itself, the openings moved and the vents removed. */
function carriedOf(p: Pipeline): { normal: number[]; offset: number; pins: unknown; removed: unknown } {
  const plane = p.storedPlane()!;
  return { normal: plane.normal.map((v) => Math.round(v * 1e4) / 1e4), offset: plane.offset, pins: structuredClone(p.project().pins), removed: structuredClone(p.project().removed) };
}

function expectCarried(after: ReturnType<typeof carriedOf>, before: ReturnType<typeof carriedOf>): void {
  expect(after.normal).toEqual(before.normal);
  expect(Math.abs(after.offset - before.offset)).toBeLessThanOrEqual(PLANE_MATCH_MM);
  expect(after.pins).toEqual(before.pins);
  expect(after.removed).toEqual(before.removed);
}

/** Jersey on its second base face, its pour moved and a vent removed: a project with something of each to carry. */
async function edited(store: Store, p: Pipeline): Promise<void> {
  store.setPlane({ rank: 1, upper: false });
  await p.idle();
  const pour = p.placement!.value.placement.openings.find((o) => o.kind === 'pour')!;
  store.moveOpening(pour.id, pour.x + 1, pour.y + 0.5);
  await p.idle();
  const vent = p.placement!.value.placement.openings.find((o) => o.kind === 'vent')!;
  store.removeVent(vent.id);
  await p.idle();
  expect(p.project().pins).not.toEqual([]);
  expect(p.project().removed).not.toEqual([]);
}

describe('MM2: the question before a large model loads', () => {
  it('asks before the file is read: one look at its first bytes, none at the whole; Cancel leaves the page; Load anyway loads exactly its bytes', async () => {
    const { store, p } = setup();
    const { file, reads } = counted(jersey, JERSEY);
    await store.openFile(file);
    expect(reads).toEqual({ slice: 1, whole: 0 });
    // 300,000 by default, brought under jersey's own 1,340.
    expect(store.large.value).toEqual({ kind: 'stl', name: JERSEY, model: JERSEY, size: jersey.length, triangles: 1340, exact: true, format: 'binary', target: 1339 });
    expect(p.modelName).toBeNull();
    expect(p.log).toEqual([]);
    await store.answerLarge('cancel');
    expect(store.large.value).toBeNull();
    expect(p.modelName).toBeNull();
    expect(reads.whole).toBe(0);
    await store.openFile(file);
    await store.answerLarge('load');
    await p.idle();
    expect(reads.whole).toBe(1);
    expect(p.modelName).toBe(JERSEY);
    expect(Buffer.compare(Buffer.from(p.stlBytes!), Buffer.from(jersey))).toBe(0);
    expect(p.modelOrigin()).toBeNull();
  });

  it('at the real warning point no example is looked at first: doomedmarine, the largest, is read whole at once', async () => {
    const { store, p } = setup(LARGE_MODEL);
    const { readFileSync } = await import('node:fs');
    const bytes = new Uint8Array(readFileSync(new URL('../../examples/doomedmarine.stl', import.meta.url)));
    expect(bytes.length).toBeLessThan(minBytesToLook(LARGE_MODEL));
    const { file, reads } = counted(bytes, 'doomedmarine.stl');
    await store.openFile(file);
    expect(reads).toEqual({ slice: 0, whole: 1 });
    expect(store.large.value).toBeNull();
    expect(p.modelName).toBe('doomedmarine.stl');
  });

  it('Simplify makes the copy in a worker of its own, which goes as it answers, and the copy loads named after the file, with its record; its figure is on the meter only while it runs', async () => {
    const { store, p, spawned } = setup();
    const { file } = counted(jersey, JERSEY);
    await store.openFile(file);
    const figures: (number | null)[] = [];
    const off = p.memory.subscribe((source) => source === 'simplify' && figures.push(p.memory.parts().simplify ? 1 : null));
    await store.answerLarge('simplify', 900);
    off();
    await p.idle();
    expect(spawned).toEqual([{ terminated: true }]);
    expect(store.simplifying.value).toBeNull();
    expect(figures.at(0)).toBe(1);
    expect(figures.at(-1)).toBeNull();
    expect(p.memory.parts().simplify).toBeUndefined();
    const origin = p.modelOrigin()!;
    expect(origin.from).toEqual({ name: JERSEY, bytes: jersey.length, sha256: sha(jersey), format: 'binary', trianglesInFile: 1340, triangles: 1340 });
    expect(origin.record).toMatchObject({ target: 900, maxErrorMm: 0.05, sha256: sha(p.stlBytes!) });
    expect(origin.record.triangles).toBe(p.parsed!.value.triangles);
    expect(origin.record.errorMm).toBeLessThanOrEqual(0.05);
    expect(origin.original.blob).toBe(file);
    expect(p.modelName).toBe(JERSEY);
    expect(p.modelSha256).toBe(sha(jersey));
    expect(p.diagnostics.some((d) => d.code === 'model-simplified')).toBe(true);
    expect(store.history.depth).toEqual({ undo: 0, redo: 0 });
  });

  it('Cancel ends the copy being made and its worker at once, and a newer file drops a question that waits', async () => {
    const { store, p, spawned } = setup(LOW, 5_000);
    await store.openFile(new File([jersey as BlobPart], JERSEY));
    const running = store.answerLarge('simplify', 900);
    expect(store.simplifying.value).toMatchObject({ name: JERSEY, target: 900, step: 'read' });
    // Once its worker has said what it holds, so the figure Cancel must take off the meter is there.
    await expect.poll(() => p.memory.parts().simplify).toBeDefined();
    store.cancelSimplify();
    await running;
    expect(spawned).toEqual([{ terminated: true }]);
    expect(store.simplifying.value).toBeNull();
    expect(p.modelName).toBeNull();
    expect(p.memory.parts().simplify).toBeUndefined();
    expect(store.fileNotice.value).toBeNull();
    // A question waits; another file comes: the question goes, and the file opens.
    await store.openFile(new File([jersey as BlobPart], JERSEY));
    expect(store.large.value).not.toBeNull();
    store.largeLimits = LARGE_MODEL;
    await store.openFile(new File([jersey as BlobPart], 'other.stl'));
    expect(store.large.value).toBeNull();
    expect(p.modelName).toBe('other.stl');
  });

  it('Use the original opens the file again with the project carried and no question, and Save simplified STL saves the copy', async () => {
    const saves = captureSaves();
    const { store, p } = setup();
    await store.openFile(new File([jersey as BlobPart], JERSEY));
    await store.answerLarge('simplify', 900);
    await p.idle();
    const copy = p.stlBytes!;
    store.saveSimplified();
    expect(saves.map((s) => s.name)).toEqual(['jersey-barrier-simplified.stl']);
    expect(sha(await saves[0].bytes)).toBe(sha(copy));
    store.setParam('silicone.t', 4);
    const [vent] = p.placement!.value.placement.openings.filter((o) => o.kind === 'vent');
    store.removeVent(vent.id);
    await p.idle();
    const project = structuredClone(p.project());
    expect(store.history.depth.undo).toBe(2);
    await store.useOriginal();
    await p.idle();
    expect(store.large.value).toBeNull();
    expect(p.modelOrigin()).toBeNull();
    expect(Buffer.compare(Buffer.from(p.stlBytes!), Buffer.from(jersey))).toBe(0);
    expect(p.params).toEqual(project.params);
    expect(p.project().removed).toEqual(project.removed);
    expect(store.history.depth).toEqual({ undo: 0, redo: 0 });
  });

  it('Simplify… for a model loaded anyway: only past the warning point, its question without Load anyway, and the project carried', async () => {
    const { store, p } = setup();
    store.largeLimits = LARGE_MODEL;
    store.load(jersey, JERSEY);
    await p.idle();
    expect(store.canSimplify()).toBe(false);
    store.largeLimits = LOW;
    expect(store.canSimplify()).toBe(true);
    store.setParam('silicone.t', 3.5);
    await p.idle();
    store.simplifyLoaded();
    expect(store.large.value).toMatchObject({ kind: 'loaded', model: JERSEY, triangles: 1340 });
    // Past its own count less one, a count is brought down to it.
    store.setLargeTarget(5_000);
    expect(store.large.value!.target).toBe(1339);
    store.setLargeTarget(900);
    await store.answerLarge('simplify');
    await p.idle();
    expect(p.modelOrigin()!.record.target).toBe(900);
    expect(p.params.silicone.t).toBe(3.5);
    expect(store.history.depth).toEqual({ undo: 0, redo: 0 });
    // A copy is no model to simplify again.
    expect(store.canSimplify()).toBe(false);
  });
});

describe('MM2 review: what the copy carries, and what ends it', () => {
  it('an edit made while the copy is made, or while Use the original reads the file, is kept, not the project as it was when asked', async () => {
    const { store, p } = setup(LOW, 1_000);
    store.largeLimits = LARGE_MODEL;
    store.load(jersey, JERSEY);
    await p.idle();
    store.largeLimits = LOW;
    store.simplifyLoaded();
    const running = store.answerLarge('simplify', 900);
    expect(store.simplifying.value).not.toBeNull();
    store.setParam('silicone.t', 4.2);
    await running;
    await p.idle();
    expect(p.modelOrigin()).not.toBeNull();
    expect(p.params.silicone.t).toBe(4.2);
    const back = store.useOriginal();
    store.setParam('silicone.t', 4.4);
    await back;
    await p.idle();
    expect(p.modelOrigin()).toBeNull();
    expect(p.params.silicone.t).toBe(4.4);
  });

  it('Simplify… and Use the original carry the base face, the moved pour and the removed vent, and clear the history', async () => {
    const { store, p } = setup();
    store.largeLimits = LARGE_MODEL;
    store.load(jersey, JERSEY);
    await p.idle();
    store.largeLimits = LOW;
    await edited(store, p);
    const before = carriedOf(p);
    store.simplifyLoaded();
    await store.answerLarge('simplify', 900);
    await p.idle();
    expect(p.modelOrigin()).not.toBeNull();
    expectCarried(carriedOf(p), before);
    expect(store.history.depth).toEqual({ undo: 0, redo: 0 });
    store.setParam('silicone.t', 3.5);
    await store.useOriginal();
    await p.idle();
    expect(p.modelOrigin()).toBeNull();
    expectCarried(carriedOf(p), before);
    expect(store.history.depth).toEqual({ undo: 0, redo: 0 });
  });

  it('a face picked on the file becomes the plane it is found on in the copy', async () => {
    const { store, p } = setup();
    store.largeLimits = LARGE_MODEL;
    store.load(jersey, JERSEY);
    await p.idle();
    store.largeLimits = LOW;
    store.pickFace(p.oriented!.value.candidates[1].members[0]);
    await p.idle();
    expect('pick' in p.project().plane).toBe(true);
    const before = carriedOf(p);
    store.simplifyLoaded();
    await store.answerLarge('simplify', 900);
    await p.idle();
    expect('rank' in p.project().plane).toBe(true);
    expectCarried(carriedOf(p), before);
  });

  it('a .moldproj past the warning point, simplified at its question, keeps its base face, moved pour and removed vent', async () => {
    const { store, p } = setup(LARGE_MODEL);
    store.load(jersey, JERSEY);
    await p.idle();
    await edited(store, p);
    const before = carriedOf(p);
    const saves = captureSaves();
    await store.saveProject();
    const zip = await saves[0].bytes;
    const second = setup();
    await second.store.openFile(new File([zip as BlobPart], 'jersey-barrier.moldproj'));
    expect(second.store.large.value).toMatchObject({ kind: 'moldproj' });
    await second.store.answerLarge('simplify', 900);
    await second.p.idle();
    expect(second.p.modelOrigin()).not.toBeNull();
    expectCarried(carriedOf(second.p), before);
    expect(second.store.history.depth).toEqual({ undo: 0, redo: 0 });
  });

  it('Use the original after reopening a simplified .moldproj opens its model.stl, the file itself, which its export writes', async () => {
    const saves = captureSaves();
    const { store, p } = setup();
    await store.openFile(new File([jersey as BlobPart], JERSEY));
    await store.answerLarge('simplify', 900);
    await p.idle();
    await store.saveProject();
    const zip = await saves[0].bytes;
    const second = setup();
    await second.store.openFile(new File([zip as BlobPart], 'jersey-barrier.moldproj'));
    await second.p.idle();
    expect(second.p.modelOrigin()!.original.kind).toBe('moldproj');
    await second.store.useOriginal();
    await second.p.idle();
    expect(second.store.fileNotice.value).toBeNull();
    expect(second.p.modelOrigin()).toBeNull();
    expect(Buffer.compare(Buffer.from(second.p.stlBytes!), Buffer.from(jersey))).toBe(0);
    const out = unzipSync((await second.p.exportParts()).zip);
    expect(sha(out['model_oriented.stl'])).toBe(orientedFileSha(second.p));
  });

  it('a newer file opened while a copy is made ends the copy and its worker at once, takes its figure off the meter, and opens or asks', async () => {
    const { store, p, spawned } = setup(LOW, 5_000);
    await store.openFile(new File([jersey as BlobPart], JERSEY));
    const running = store.answerLarge('simplify', 900);
    await expect.poll(() => p.memory.parts().simplify).toBeDefined();
    // A newer file past the point too: it asks, and loads nothing, so only its opening can end the copy.
    await store.openFile(new File([jersey as BlobPart], 'other.stl'));
    expect(spawned).toEqual([{ terminated: true }]);
    expect(store.simplifying.value).toBeNull();
    expect(p.memory.parts().simplify).toBeUndefined();
    expect(store.large.value).toMatchObject({ kind: 'stl', name: 'other.stl' });
    await running;
    expect(p.modelName).toBeNull();
    // One under the point opens at once.
    store.largeLimits = LARGE_MODEL;
    await store.openFile(new File([jersey as BlobPart], 'third.stl'));
    await p.idle();
    expect(p.modelName).toBe('third.stl');
    expect(p.modelOrigin()).toBeNull();
  });

  it('Save project of a copy whose file changed since it was opened says so, and saves nothing', async () => {
    const saves = captureSaves();
    const { store, p } = setup();
    const changed = jersey.slice();
    changed[84 + 12 + 1] ^= 1;
    const prepared = runPrepareJob(api, MeshoptSimplifier, { source: { kind: 'stl', blob: new Blob([jersey as BlobPart]) }, name: JERSEY, simplify: { target: 900, maxErrorMm: 0.05 } }, () => jersey, () => {}, () => performance.now());
    p.load(prepared.stl, JERSEY, { kind: 'simplified', original: { kind: 'stl', blob: new Blob([changed as BlobPart]) }, from: prepared.from, record: prepared.record });
    await p.idle();
    await store.saveProject();
    expect(saves).toEqual([]);
    expect(store.fileNotice.value).toMatchObject({ severity: 'error', message: `${JERSEY} has changed since you opened it, so the project was not saved: it would hold another model than the one the mold was made from. Open it again, then save.` });
  });

  it('a copy the job refuses brings the question back with its reason, offering only Load anyway and Cancel, and Load anyway still loads the file', async () => {
    const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true });
    pipelines.push(p);
    const reason = `Simplifying ${JERSEY} would open holes in it, so it was not simplified. Load it anyway, or simplify it in the program that made it.`;
    const refusing = (): WorkerLike => {
      const worker: WorkerLike = {
        onmessage: null,
        onerror: null,
        terminate: () => {},
        postMessage: (message) => void setTimeout(() => worker.onmessage?.({ data: { t: 'error', id: (message as { id: number }).id, name: 'InlineError', message: reason, inline: true, cached: {} } })),
      };
      return worker;
    };
    const store = new Store(p, () => 0, files, new ModelSimplifier(refusing, p.memory));
    store.largeLimits = LOW;
    await store.openFile(new File([jersey as BlobPart], JERSEY));
    await store.answerLarge('simplify', 900);
    expect(store.large.value).toMatchObject({ kind: 'stl', model: JERSEY, refused: reason });
    expect(p.modelName).toBeNull();
    await store.answerLarge('load');
    await p.idle();
    expect(p.modelName).toBe(JERSEY);
    expect(p.modelOrigin()).toBeNull();
  });
});

describe('MM2: the .moldproj of a simplified model', () => {
  it('keeps the file as model.stl and the copy as simplified.stl in format 6; reopened, the copy loads with no question and its export writes the file itself', async () => {
    const saves = captureSaves();
    const { store, p } = setup();
    await store.openFile(new File([jersey as BlobPart], JERSEY));
    await store.answerLarge('simplify', 900);
    await p.idle();
    const origin = p.modelOrigin()!;
    const before = { project: structuredClone(p.project()), hash: p.geometryHash() };
    await store.saveProject();
    expect(store.fileNotice.value).toMatchObject({ severity: 'info', message: 'Saved jersey-barrier.moldproj.' });
    const zip = await saves[0].bytes;
    const inside = unzipSync(zip);
    expect(Object.keys(inside)).toEqual([PROJECT_ENTRY, MODEL_ENTRY, SIMPLIFIED_ENTRY]);
    expect(sha(inside[MODEL_ENTRY])).toBe(sha(jersey));
    expect(sha(inside[SIMPLIFIED_ENTRY])).toBe(origin.record.sha256);
    const json = JSON.parse(text(inside[PROJECT_ENTRY])) as ProjectFile;
    expect(json.schemaVersion).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(6);
    expect(json.modelSha256).toBe(sha(jersey));
    expect(json.simplified).toEqual(simplifiedEntry(origin));

    // Another page, with the warning point lowered still: the copy loads, and nothing asks.
    const second = setup();
    await second.store.openFile(new File([zip as BlobPart], 'jersey-barrier.moldproj'));
    await second.p.idle();
    expect(second.store.large.value).toBeNull();
    expect(second.p.modelOrigin()!.record).toEqual(origin.record);
    expect(second.p.modelOrigin()!.from).toEqual(origin.from);
    expect(second.p.project()).toEqual(before.project);
    expect(second.p.geometryHash()).toEqual(before.hash);
    const out = unzipSync((await second.p.exportParts()).zip);
    expect(parseStl(out['model_oriented.stl']).rawTriangleCount).toBe(1340);
    expect((JSON.parse(text(out['report.json'])) as ExportReport).model.simplified).toEqual(origin.record);
    // The file packed as model.stl, as the copy is not the model project.json's hash names, is refused.
    const wrong = packProject(projectJson(json), inside[SIMPLIFIED_ENTRY]);
    await second.store.openFile(new File([wrong as BlobPart], 'wrong.moldproj'));
    expect(second.store.fileNotice.value).toMatchObject({ severity: 'error', message: expect.stringContaining('the model inside it is not the one its settings were saved for') });
  });

  it('a simplified.stl that does not match its record opens the file itself, with a warning, and past the warning point asks', async () => {
    const { store, p } = setup();
    await store.openFile(new File([jersey as BlobPart], JERSEY));
    await store.answerLarge('simplify', 900);
    await p.idle();
    const origin = p.modelOrigin()!;
    const json = projectJson({ ...(JSON.parse(projectJson({ schemaVersion: 6, appVersion: 'x', model: JERSEY, modelSha256: sha(jersey), basePlane: null, simplified: simplifiedEntry(origin), ...p.project() })) as ProjectFile) });
    const bad = p.stlBytes!.slice();
    bad[100] ^= 1;
    const zip = packProject(json, jersey, bad);
    const second = setup(LARGE_MODEL);
    await second.store.openFile(new File([zip as BlobPart], 'j.moldproj'));
    await second.p.idle();
    expect(second.p.modelOrigin()).toBeNull();
    expect(second.p.parsed!.value.triangles).toBe(1340);
    expect(second.store.fileNotice.value!.notes).toContainEqual({ severity: 'warning', message: `The simplified copy saved with this project could not be used, so ${JERSEY} opened as it is. Use Simplify… in the Model section to simplify it again.` });
    const third = setup();
    await third.store.openFile(new File([zip as BlobPart], 'j.moldproj'));
    expect(third.store.large.value).toMatchObject({ kind: 'moldproj', name: 'j.moldproj', model: JERSEY, triangles: 1340 });
  });

  it('a .moldproj past the warning point asks once it is opened; Load anyway opens it as before, and Simplify keeps its settings', async () => {
    const { store, p } = setup(LARGE_MODEL);
    store.load(jersey, JERSEY);
    await p.idle();
    store.setParam('silicone.t', 4.5);
    await p.idle();
    const saves = captureSaves();
    await store.saveProject();
    const zip = await saves[0].bytes;
    const second = setup();
    await second.store.openFile(new File([zip as BlobPart], 'jersey-barrier.moldproj'));
    expect(second.store.large.value).toMatchObject({ kind: 'moldproj', name: 'jersey-barrier.moldproj', model: JERSEY, triangles: 1340, exact: true });
    expect(second.p.modelName).toBeNull();
    await second.store.answerLarge('load');
    await second.p.idle();
    expect(second.p.modelOrigin()).toBeNull();
    expect(second.p.params.silicone.t).toBe(4.5);
    expect(second.store.projectName.value).toBe('jersey-barrier.moldproj');
    const third = setup();
    await third.store.openFile(new File([zip as BlobPart], 'jersey-barrier.moldproj'));
    await third.store.answerLarge('simplify', 900);
    await third.p.idle();
    expect(third.p.modelOrigin()!.original.kind).toBe('moldproj');
    expect(third.p.params.silicone.t).toBe(4.5);
    expect(third.store.projectName.value).toBe('jersey-barrier.moldproj');
    // Its export still reads model.stl out of the .moldproj for model_oriented.stl: the file itself, turned.
    const out = unzipSync((await third.p.exportParts()).zip);
    expect(sha(out['model_oriented.stl'])).toBe(orientedFileSha(third.p));
    expect(parseStl(out['model_oriented.stl']).rawTriangleCount).toBe(1340);
  });

  it('settings from the ZIP of a simplified model, opened onto the file as it is, say so', async () => {
    const { store, p } = setup();
    await store.openFile(new File([jersey as BlobPart], JERSEY));
    await store.answerLarge('simplify', 900);
    await p.idle();
    const out = unzipSync((await p.exportParts()).zip);
    const second = setup(LARGE_MODEL);
    second.store.load(jersey, JERSEY);
    await second.p.idle();
    await second.store.openFile(new File([out['project.json'] as BlobPart], 'project.json'));
    expect(second.store.fileNotice.value!.notes).toContainEqual({ severity: 'info', message: `These settings were made on a copy of ${JERSEY} simplified to ${p.modelOrigin()!.record.triangles.toLocaleString('en-US')} triangles; the model on screen is ${JERSEY} as it is, so check the base face and the openings before you export.` });
  });
});
