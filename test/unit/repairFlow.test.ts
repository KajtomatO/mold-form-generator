import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { MeshoptSimplifier } from 'meshoptimizer';
import type { ManifoldToplevel } from 'manifold-3d';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { arrayBytes, MemoryLedger, type WorkerMemory } from '../../src/app/memory';
import { ModelSimplifier } from '../../src/app/modelSimplifier';
import { Pipeline } from '../../src/app/pipeline';
import type { ProjectFile } from '../../src/app/project';
import { MODEL_ENTRY, PROJECT_ENTRY, REPAIRED_ENTRY } from '../../src/app/projectArchive';
import { ProjectFiles } from '../../src/app/projectFiles';
import { repairedDropped } from '../../src/app/projectFile';
import { Store } from '../../src/app/store';
import { auditEdges } from '../../src/core/mesh/audit';
import { repairMesh } from '../../src/core/mesh/repairImport';
import { weld, type WeldedMesh } from '../../src/core/mesh/weld';
import { parseStl } from '../../src/core/stl/parse';
import { writeBinaryStl } from '../../src/core/stl/write';
import type { FromWorker, WorkerLike } from '../../src/workers/protocol';
import { inProcessField, inProcessProject, inProcessSolid } from '../fixtures/inProcessWorker';
import { exampleBytes, EXAMPLE_FILES, hasExample, loadManifold } from '../fixtures/loadExamples';
import { finnedBox, foldedBox, openTopBox } from '../fixtures/synthetic';

/**
 * RM: the repair as the maker uses it (R43, D26), through the store with every worker in this process: the offer only
 * on a problem (decision B), the click and the repaired model with its project carried (A), Use the original, Save
 * repaired STL, the .moldproj, Cancel, a newer file, and the memory meter's 'repair' (G).
 */
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const files = new ProjectFiles(inProcessProject);
const pipelines: Pipeline[] = [];
const examples = join(import.meta.dirname, '..', '..', 'test-models');
const OIL = 'N Scale Oil Barrel.stl';
const oil = new Uint8Array(readFileSync(join(examples, OIL)));
const stlOf = (mesh: WeldedMesh): Uint8Array => writeBinaryStl(mesh.positions, mesh.indices);

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

interface Said {
  t: string;
  step?: string;
  memory?: WorkerMemory;
}

/**
 * A store with every worker in this process. The preparer's spawns are counted, what each says is kept, and `hold`
 * delays each job to it by that many ms, so a test can act while it waits.
 */
function setup(hold = 0): { store: Store; p: Pipeline; spawned: { terminated: boolean }[]; said: Said[] } {
  const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true });
  pipelines.push(p);
  const spawned: { terminated: boolean }[] = [];
  const said: Said[] = [];
  const preparer = new ModelSimplifier(() => {
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
    return new Proxy(worker, {
      set(target, key, value) {
        if (key === 'onmessage' && value) {
          target.onmessage = (event: { data: FromWorker }) => {
            said.push({ t: event.data.t, step: 'step' in event.data ? event.data.step : undefined, memory: 'memory' in event.data ? event.data.memory : undefined });
            value(event);
          };
          return true;
        }
        return Reflect.set(target, key, value);
      },
    }) as WorkerLike;
  }, p.memory);
  return { store: new Store(p, () => 0, files, preparer), p, spawned, said };
}

async function open(store: Store, bytes: Uint8Array, name: string): Promise<void> {
  await store.openFile(new File([bytes as BlobPart], name));
  await store.pipeline.idle();
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

describe('RM: when Repair mesh is offered (decision B)', () => {
  it('on a soup, the oil barrel and the open-top box, with the fill expected, and on finnedBox with a rebuild', async () => {
    const { store } = setup();
    await open(store, oil, OIL);
    expect(store.repairOffer()).toEqual({ kind: 'open', holes: 1, holeArea: expect.closeTo(3.106, 3), openEdges: 24, nonManifold: 0, misoriented: 0, fill: true });
    await open(store, stlOf(openTopBox()), 'open-top.stl');
    expect(store.repairOffer()).toMatchObject({ kind: 'open', holes: 1, holeArea: 600, fill: true });
    await open(store, stlOf(finnedBox()), 'finned.stl');
    expect(store.repairOffer()).toMatchObject({ kind: 'open', nonManifold: 1, fill: false });
  }, 120_000);

  it('on a closed mesh that folds through itself, with the mesh-folds warning that names it', async () => {
    const { store, p } = setup();
    await open(store, stlOf(foldedBox()), 'folded.stl');
    expect(p.imported!.value.route).toBe('manifold');
    expect(store.repairOffer()).toEqual({ kind: 'folds', folds: 1, fill: false });
    const row = p.diagnostics.find((d) => d.code === 'mesh-folds')!;
    expect(row.message).toBe('The mesh folds through itself in 1 place, where its surface turns inside out, so its volume and a merged base may be wrong. Use Repair mesh in the Model section to rebuild it as one closed solid.');
    expect(row.markers).toHaveLength(1);
  }, 120_000);

  it('never on a closed solid, nor on one Manifold took by merging its edges: jersey, war-barricade and the medieval barrel', async () => {
    const { store, p } = setup();
    await open(store, exampleBytes('jersey'), EXAMPLE_FILES.jersey);
    expect(store.repairOffer()).toBeNull();
    await open(store, new Uint8Array(readFileSync(join(examples, 'war-barricade.stl'))), 'war-barricade.stl');
    expect(p.imported!.value.route).toBe('manifold');
    expect(p.parsed!.value.audit.nonManifoldEdges).toBeGreaterThan(0);
    expect(store.repairOffer()).toBeNull();
    if (hasExample('barrel')) {
      await open(store, exampleBytes('barrel'), EXAMPLE_FILES.barrel);
      expect(p.parsed!.value.audit.nonManifoldEdges).toBeGreaterThan(0);
      expect(store.repairOffer()).toBeNull();
    }
  }, 120_000);
});

describe('RM: the repair, loaded as the model (decision A)', () => {
  it('carries the project onto the repaired copy, finds its plane again, clears the history, and Reset keeps the copy', async () => {
    const { store, p, spawned } = setup();
    await open(store, oil, OIL);
    // A project on the barrel's second candidate, with t changed: one undo step each.
    store.setPlane({ rank: 1, upper: false });
    store.setParam('silicone.t', 4);
    await p.idle();
    const normal = p.oriented!.value.chosen.normal;
    expect(store.history.depth.undo).toBe(2);
    await store.repairMesh();
    await p.idle();
    const origin = p.modelOrigin()!;
    expect(origin.repair!.record).toMatchObject({ method: 'filled', holes: 1, turned: 0, nearMm: 0, outside: null, original: { route: 'soup', flipped: false, inverted: false }, simplified: null });
    expect(origin.record).toBeNull();
    expect(origin.repair!.record.sha256).toBe(sha(p.stlBytes!));
    expect(origin.from).toMatchObject({ name: OIL, sha256: sha(oil), triangles: 11_842 });
    expect(p.modelSha256).toBe(sha(oil));
    expect(p.imported!.value.route).toBe('manifold');
    expect(p.params.silicone.t).toBe(4);
    expect(p.oriented!.value.chosen.normal.map((v) => v.toFixed(6))).toEqual(normal.map((v) => v.toFixed(6)));
    expect(store.history.depth).toEqual({ undo: 0, redo: 0 });
    expect(store.repairOffer()).toBeNull();
    // The preparer's worker is ended, and its figure gone from the meter.
    expect(spawned.every((w) => w.terminated)).toBe(true);
    expect(p.memory.parts().repair).toBeUndefined();
    const row = p.diagnostics.find((d) => d.code === 'model-repaired')!;
    expect(row.message).toBe(`The mold is made from a repaired copy of ${OIL}: its hole of 3.1 mm2 closed, every triangle of your file kept, so the silicone thickness measured on the copy holds for your file. model_oriented.stl is your own file.`);
    expect(row.markers).toHaveLength(1);
    expect(p.diagnostics.some((d) => d.code === 'soup-mode')).toBe(false);
    // Reset is settings only (D22): the model stays the repaired copy.
    store.resetAll();
    await p.idle();
    expect(p.params.silicone.t).toBe(3);
    expect(p.modelOrigin()?.repair).toBeTruthy();
  }, 120_000);

  it('rebuilds finnedBox on the grid typed, leaving the fin out, and Use the original brings the file back with the offer', async () => {
    const { store, p } = setup();
    const bytes = stlOf(finnedBox());
    await open(store, bytes, 'finned.stl');
    store.setRepairCell(0.05);
    expect(store.repairCellProblem()).toMatch(/^A 0\.05 mm grid cannot be used|^A grid of 0\.05 mm cannot be used/);
    store.setRepairCell(0.5);
    expect(store.repairCellProblem()).toBeNull();
    await store.repairMesh();
    await p.idle();
    const { record, outside } = p.modelOrigin()!.repair!;
    expect(record).toMatchObject({ method: 'rebuilt', cell: 0.5, cellAsked: 0.5, outside: { runs: [[12, 2]], triangles: 2 } });
    expect(outside!.indices.length).toBe(6);
    expect(p.outsideTier()).toBe('glue');
    p.setParams((params) => (params.base.mode = 'merged'));
    await p.idle();
    expect(p.outsideTier()).toBe('');
    expect(p.diagnostics.find((d) => d.code === 'model-repaired')).toMatchObject({ severity: 'warning' });
    await store.useOriginal();
    await p.idle();
    expect(p.modelOrigin()).toBeNull();
    expect(p.stlBytes).toEqual(bytes);
    expect(p.imported!.value.route).toBe('soup');
    expect(p.params.base.mode).toBe('merged');
    expect(store.repairOffer()).toMatchObject({ kind: 'open' });
  }, 120_000);

  it('Save repaired STL saves the copy the mold is made from', async () => {
    const saved = captureSaves();
    const { store, p } = setup();
    await open(store, oil, OIL);
    await store.repairMesh();
    await p.idle();
    store.saveRepaired();
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('N Scale Oil Barrel-repaired.stl');
    expect(sha(await saved[0].bytes)).toBe(p.modelOrigin()!.repair!.record.sha256);
  }, 120_000);

  it('refuses with its own sentence where nothing is enclosed, and the offer stays', async () => {
    const { store, p } = setup();
    // A flat tetrahedron: closed, of no volume, so Manifold takes it as no solid.
    const flat = { positions: Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0, 3, 3, 0]), indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]) };
    await open(store, stlOf(flat), 'flat.stl');
    expect(store.repairOffer()).toMatchObject({ kind: 'open' });
    await store.repairMesh();
    expect(store.fileNotice.value).toMatchObject({ severity: 'warning', message: 'flat.stl could not be repaired: the rebuild could not tell inside from outside, as its surface encloses no space or its holes face each other across it.' });
    expect(p.modelOrigin()).toBeNull();
    expect(store.repairOffer()).not.toBeNull();
  }, 120_000);
});

describe('RM: a large model (decision F)', () => {
  it('repairs the file, not the simplified copy on screen, and a filled file is simplified again to the copy\'s count, its proved error the margin\'s', async () => {
    const { store, p, said } = setup();
    // Jersey with one triangle taken out: a soup with one hole, past a warning point lowered to 1,000 triangles.
    const welded = weld(parseStl(exampleBytes('jersey')).positions);
    const holed = { positions: welded.positions, indices: welded.indices.slice(3) };
    const bytes = stlOf(holed);
    store.largeLimits = { triangles: 1_000, bytes: 1e12 };
    await store.openFile(new File([bytes as BlobPart], 'holed.stl'));
    expect(store.large.value).toMatchObject({ triangles: 1_339 });
    await store.answerLarge('simplify', 900);
    await p.idle();
    const copy = p.modelOrigin()!;
    expect(copy.record).toMatchObject({ target: 900 });
    expect(p.imported!.value.route).toBe('soup');
    expect(store.repairOffer()).toMatchObject({ kind: 'open', holes: 1, fill: true });
    said.length = 0;
    await store.repairMesh();
    await p.idle();
    const origin = p.modelOrigin()!;
    expect(origin.record).toBeNull();
    // The file, read again: its own count and hash, not the copy's.
    expect(origin.from).toMatchObject({ name: 'holed.stl', triangles: 1_339, sha256: sha(bytes) });
    const { record } = origin.repair!;
    expect(record).toMatchObject({ method: 'filled', holes: 1, outside: null, simplified: { target: 900, maxErrorMm: 0.05 } });
    expect(record.triangles).toBe(record.simplified!.triangles);
    expect(record.triangles).toBeLessThanOrEqual(1_000);
    expect(record.nearMm).toBe(record.simplified!.errorMm);
    expect(record.nearMm).toBeGreaterThan(0);
    expect(p.imported!.value.route).toBe('manifold');
    // The meter: the repair's own steps under Repair, then MM2's copy under Simplify.
    expect(said.filter((m) => m.t === 'progress').map((m) => m.step)).toEqual(expect.arrayContaining(['read', 'parse', 'fill', 'check', 'simplify', 'measure', 'write']));
    expect(p.memory.parts().repair).toBeUndefined();
    expect(p.memory.parts().simplify).toBeUndefined();
    // In glue mode the margin is wider by how far the file lies from the copy, and in merged mode not.
    expect(p.modelErrorMm()).toBe(record.nearMm);
    expect(p.outsideTier()).toBe('glue');
    p.setParams((params) => (params.base.mode = 'merged'));
    expect(p.modelErrorMm()).toBe(0);
    expect(p.outsideTier()).toBe('');
    expect(store.canSimplify()).toBe(false);
  }, 120_000);
});

describe('RM: what the review found in the flow', () => {
  it('lets go of the last model\'s grid facts, and its STL with them, once another model loads', async () => {
    const { store, p } = setup();
    const bytes = stlOf(finnedBox());
    await open(store, bytes, 'finned.stl');
    expect(store.repairCellFacts()!.auto).toBe(0.1);
    const held = (): unknown => (store as unknown as { cellFor: unknown }).cellFor;
    expect(held()).not.toBeNull();
    store.setRepairCell(0.5);
    await store.repairMesh();
    await p.idle();
    expect(p.modelOrigin()?.repair).toBeTruthy();
    expect(held()).toBeNull();
  }, 120_000);

  it('offers no repair while a file is read, a file is held back or the project is saved, as the repair would drop it', async () => {
    const { store, p } = setup();
    await open(store, oil, OIL);
    expect(store.repairOffer()).not.toBeNull();
    for (const busy of [() => (store.fileBusy.value = 'Reading x.stl…'), () => (store.replacing.value = { name: 'x.stl', model: OIL }), () => (store.saving.value = true)]) {
      busy();
      expect(store.repairOffer()).toBeNull();
      store.fileBusy.value = null;
      store.replacing.value = null;
      store.saving.value = false;
      expect(store.repairOffer()).not.toBeNull();
    }
    expect(p.modelOrigin()).toBeNull();
  }, 120_000);

  it('drops the last model\'s diagnostics as soon as another loads, and words the plane found again for a repaired copy', async () => {
    const { store, p } = setup();
    await open(store, oil, OIL);
    expect(p.diagnostics.some((d) => d.code === 'soup-mode')).toBe(true);
    p.load(stlOf(finnedBox()), 'finned.stl');
    expect(p.diagnostics.some((d) => d.code === 'soup-mode')).toBe(false);
    await p.idle();
    await open(store, stlOf(openTopBox()), 'open.stl');
    await store.repairMesh();
    await p.idle();
    const found = p.diagnostics.find((d) => d.code === 'plane-found');
    expect(found!.message).toMatch(/^The base face the model stood on, facing /);
    expect(p.diagnostics.map((d) => d.message).join('\n')).not.toContain('you chose');
  }, 120_000);

  it('offers no upper level in glue mode that is only a rebuilt copy\'s grid facets, and does in merged mode, where the copy is printed', async () => {
    const { store, p } = setup();
    await open(store, stlOf(finnedBox()), 'finned.stl');
    // The auto grid, 0.1 mm: the copy's foot has a facet of about 4 mm2 0.06 mm above its bottom.
    await store.repairMesh();
    await p.idle();
    expect(p.modelOrigin()!.repair!.record.cell).toBe(0.1);
    expect(p.footprint!.value.levels.useUpper?.gap).toBeLessThan(0.1);
    expect(p.upperLevel()).toBeNull();
    expect(p.diagnostics.some((d) => d.code === 'upper-level')).toBe(false);
    store.setParam('base.mode', 'merged');
    await p.idle();
    expect(p.upperLevel()).not.toBeNull();
    expect(p.diagnostics.some((d) => d.code === 'upper-level')).toBe(true);
  }, 180_000);
});

describe('RM: Cancel and a newer file', () => {
  it('Cancel ends the job and leaves the page as it was; a newer file drops the repair it superseded', async () => {
    const { store, p, spawned } = setup(300);
    await open(store, oil, OIL);
    const before = p.geometryHash().all;
    const job = store.repairMesh();
    expect(store.repairing.value).toMatchObject({ name: OIL, step: 'read' });
    store.cancelRepair();
    await job;
    expect(store.repairing.value).toBeNull();
    expect(spawned.at(-1)!.terminated).toBe(true);
    expect(p.modelOrigin()).toBeNull();
    expect(p.geometryHash().all).toBe(before);
    expect(p.memory.parts().repair).toBeUndefined();
    expect(store.fileNotice.value).toBeNull();
    // A newer file while it repairs: the repair is ended, and the newer file is the model.
    const again = store.repairMesh();
    await open(store, exampleBytes('jersey'), EXAMPLE_FILES.jersey);
    await again;
    await p.idle();
    expect(p.modelName).toBe(EXAMPLE_FILES.jersey);
    expect(p.modelOrigin()).toBeNull();
    expect(spawned.at(-1)!.terminated).toBe(true);
  }, 120_000);
});

describe('RM: the .moldproj of a repaired model (decision A)', () => {
  it('holds the file as model.stl and the copy as repaired.stl, and opens again with no repair, the left-out parts cut from the file', async () => {
    const saved = captureSaves();
    const { store, p } = setup();
    const bytes = stlOf(finnedBox());
    await open(store, bytes, 'finned.stl');
    store.setRepairCell(0.5);
    await store.repairMesh();
    await p.idle();
    const record = p.modelOrigin()!.repair!.record;
    const hash = p.geometryHash().all;
    await store.saveProject();
    const zip = await saved[0].bytes;
    expect(saved[0].name).toBe('finned.moldproj');
    const inside = unzipSync(zip);
    expect(Object.keys(inside)).toEqual([PROJECT_ENTRY, MODEL_ENTRY, REPAIRED_ENTRY]);
    expect(sha(inside[MODEL_ENTRY])).toBe(sha(bytes));
    expect(sha(inside[REPAIRED_ENTRY])).toBe(record.sha256);
    const json = JSON.parse(strFromU8(inside[PROJECT_ENTRY])) as ProjectFile;
    expect(Object.keys(json)).toEqual(['schemaVersion', 'appVersion', 'model', 'modelSha256', 'basePlane', 'repaired', 'params', 'plane', 'pins', 'removed']);
    expect(json.schemaVersion).toBe(6);
    const { from, ...rest } = json.repaired!;
    expect(from).toEqual({ format: 'binary', trianglesInFile: 14, triangles: 14 });
    expect(rest).toEqual(record);
    // Opened again in a fresh store: no prepare job, the same copy, record and left-out parts, the same mold.
    const next = setup();
    await open(next.store, zip, 'finned.moldproj');
    expect(next.spawned).toHaveLength(0);
    const origin = next.p.modelOrigin()!;
    expect(origin.repair!.record).toEqual(record);
    expect(origin.repair!.outside).toEqual(p.modelOrigin()!.repair!.outside);
    expect(next.p.geometryHash().all).toBe(hash);
    // Saved again, the same bytes.
    await next.store.saveProject();
    expect(sha(await saved[1].bytes)).toBe(sha(zip));
    // A copy that does not match its record opens the file itself, with the warning.
    const damaged = zipSync({ [PROJECT_ENTRY]: inside[PROJECT_ENTRY], [MODEL_ENTRY]: inside[MODEL_ENTRY], [REPAIRED_ENTRY]: strToU8('solid nothing\nendsolid nothing\n') });
    const third = setup();
    await open(third.store, damaged, 'finned.moldproj');
    expect(third.p.modelOrigin()).toBeNull();
    expect(third.store.fileNotice.value!.notes).toContainEqual({ severity: 'warning', message: repairedDropped('finned.stl') });
    expect(third.store.repairOffer()).not.toBeNull();
  }, 120_000);
});

describe('RM: what repairing holds, for the memory meter (decision G)', () => {
  it('the preparer reports under Repair at least every array each step of the repair holds, meshoptimizer\'s heap as estimated, and drops it at the end', async () => {
    const { store, p, said } = setup();
    const bytes = stlOf(finnedBox());
    await open(store, bytes, 'finned.stl');
    store.setRepairCell(0.25);
    const seen: (WorkerMemory | undefined)[] = [];
    p.memory.subscribe((source) => source === 'repair' && seen.push(p.memory.parts().repair));
    await store.repairMesh();
    // The same repair in this process, with what each step holds as its own arrays and meshoptimizer's estimate.
    // The file and its audit's loops, which the job keeps throughout, are counted once beside them.
    const welded = weld(parseStl(bytes).positions);
    const audit = auditEdges(welded);
    let step = '';
    const peak: Record<string, number> = {};
    repairMesh(api, MeshoptSimplifier, welded, audit, {
      name: 'finned.stl',
      cell: 0.25,
      progress: (s) => (step = s),
      hold: (arrays, meshopt) => (peak[step] = Math.max(peak[step] ?? 0, arrayBytes([welded, audit, arrays]) + meshopt)),
    });
    const reported = (s: string): number => Math.max(...said.filter((m) => m.step === s && m.memory).map((m) => m.memory!.arrays));
    for (const s of ['rebuild', 'reduce', 'compare']) {
      expect(peak[s], s).toBeGreaterThan(welded.positions.byteLength + welded.indices.byteLength);
      expect(reported(s), s).toBeGreaterThanOrEqual(peak[s]);
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBeUndefined();
    expect(p.memory.parts().repair).toBeUndefined();
    expect(new MemoryLedger().parts()).toEqual({});
  }, 120_000);
});
