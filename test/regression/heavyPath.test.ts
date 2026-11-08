import { unzipSync } from 'fflate';
import type { ManifoldToplevel } from 'manifold-3d';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allDiagnostics, DIAGNOSTIC_PARAM } from '../../src/app/derived';
import { Pipeline } from '../../src/app/pipeline';
import { auditEdges } from '../../src/core/mesh/audit';
import { importSolid } from '../../src/core/mesh/shells';
import type { HeavyLimits } from '../../src/core/mesh/simplify';
import { weld, type WeldedMesh } from '../../src/core/mesh/weld';
import { withArena } from '../../src/core/solid/arena';
import { parseStl } from '../../src/core/stl/parse';
import type { ExportReport } from '../../src/workers/exportJob';
import type { ToWorker, WorkerLike } from '../../src/workers/protocol';
import { heightBlockMesh, HEAVY_BLOCK } from '../fixtures/heavy';
import { inProcessField, inProcessSolid } from '../fixtures/inProcessWorker';
import { loadManifold } from '../fixtures/loadExamples';
import { asciiStl, box, inverted, join, toSoup } from '../fixtures/synthetic';

/**
 * M11's paths for a mesh past G1.8's limit, through the real pipeline and workers in Node, at a limit of
 * 4,000 triangles and a copy of 2,000 in place of 2 million and 1 million, so a block of 7,920 reaches
 * them in seconds: the preview's import that checks the whole mesh and the fresh worker that builds the
 * copy alone, the export told that import's report, and an export that must trim, which cannot use it.
 */
const LIMITS: HeavyLimits = { limit: 4000, target: 2000 };
const BLOCK = { ...HEAVY_BLOCK, n: 60 };
/** A sealed hollow inside the block, as the barrel has: the model's volume leaves it out. */
const VOID: [[number, number, number], [number, number, number]] = [
  [30, 30, 5],
  [70, 60, 15],
];
const VOID_MM3 = 40 * 30 * 10;

let api: ManifoldToplevel;
const pipelines: Pipeline[] = [];
beforeAll(async () => {
  api = await loadManifold();
});
afterAll(() => pipelines.splice(0).forEach((p) => p.dispose()));

/** A pipeline whose solid workers have the test's limits, recording each worker spawned and every message sent to one. */
function heavyPipeline(): { p: Pipeline; spawned: () => number; sent: ToWorker[] } {
  let spawned = 0;
  const sent: ToWorker[] = [];
  const spawnSolid = (): WorkerLike => {
    spawned++;
    const worker = inProcessSolid(LIMITS);
    const post = worker.postMessage.bind(worker);
    worker.postMessage = (message: ToWorker, transfer?: Transferable[]) => {
      sent.push(message);
      post(message, transfer);
    };
    return worker;
  };
  const p = new Pipeline({ spawnField: inProcessField, spawnSolid, frozen: true, manifoldLimit: LIMITS.limit });
  pipelines.push(p);
  return { p, spawned: () => spawned, sent };
}

/** The block with its void, which the import finds as a solid of 200,000 mm3 less the void's. */
function hollowBlock(): WeldedMesh {
  return join(heightBlockMesh(BLOCK, weld), inverted(box(...VOID)));
}

/** The block with a cone 0.5 mm under its floor, a stray vertex the base plane keeps and the export trims. */
function spikedBlock(): WeldedMesh {
  const block = heightBlockMesh(BLOCK, weld);
  return withArena(api, (arena) => {
    const solid = arena.manifold(new api.Mesh({ numProp: 3, vertProperties: block.positions, triVerts: block.indices }));
    const cone = arena.track(arena.track(api.Manifold.cylinder(1.5, 0, 0.5, 16)).translate([50, 50, -0.5]));
    const mesh = arena.track(solid.add(cone)).getMesh();
    return { positions: mesh.vertProperties, indices: mesh.triVerts };
  });
}

const solidJobs = (sent: ToWorker[]) => sent.filter((m): m is Extract<ToWorker, { t: 'solid' }> => m.t === 'solid');
const exportJobs = (sent: ToWorker[]) => sent.filter((m): m is Extract<ToWorker, { t: 'export' }> => m.t === 'export');

describe('a mesh past G1.8\'s limit in the pipeline (limits of 4,000 and 2,000 triangles)', () => {
  it('the preview checks it whole once, then a fresh worker builds the copy alone, whose warning shows under Mode in both modes; the export, told that import, needs no other, and reports the whole model with its void left out', async () => {
    const mesh = hollowBlock();
    expect(mesh.indices.length / 3).toBeGreaterThan(LIMITS.limit);
    const whole = withArena(api, (arena) => importSolid(arena, mesh, auditEdges(mesh)));
    expect(whole.report.voidVolume).toBeCloseTo(VOID_MM3, 0);
    const wholeVolume = whole.report.solidVolume - whole.report.voidVolume;

    const { p, spawned, sent } = heavyPipeline();
    p.load(asciiStl(toSoup(mesh), 'hollow block'), 'hollow-block.stl');
    await p.idle();
    expect(p.status().error).toBeNull();
    // The import checked the whole mesh, and its worker went straight after: the next one was told that import.
    const jobs = solidJobs(sent);
    const first = jobs.findIndex((m) => m.inputs.model !== null);
    expect(jobs[first].inputs.model!.known).toBeNull();
    const told = jobs.filter((m) => m.inputs.model?.known);
    expect(told.length).toBeGreaterThan(0);
    expect(told[0].inputs.model!.known).toMatchObject({ route: 'manifold', voidVolume: whole.report.voidVolume });
    expect(p.log.some((e) => e.gate === 'solid' && e.event === 'respawned' && e.detail === 'recycled')).toBe(true);
    // The copy's warning comes with the base, and belongs under Mode.
    const simplified = (): string | undefined => allDiagnostics(p).find((d) => d.code === 'mode-b-simplified')?.message;
    expect(simplified()).toMatch(/^This model has [\d,]+ triangles, too many for the geometry engine, so merged mode, and the pocket in glue mode, use a copy simplified to [\d,]+ triangles, with up to \d+\.\d+ mm of error\./);
    expect(DIAGNOSTIC_PARAM['mode-b-simplified']).toBe('base.mode');
    p.setParams((params) => (params.base.mode = 'merged'));
    await p.idle();
    expect(p.base!.value.merged).toBe(true);
    expect(simplified()).toBeDefined();
    p.setParams((params) => (params.base.mode = 'glue'));
    await p.idle();

    // Before the export, the preview's worker goes, so two heaps never stand at once.
    const before = spawned();
    const outputs = await p.exportParts();
    expect(spawned()).toBe(before + 2);
    const [job] = exportJobs(sent);
    expect(job.inputs!.importReport).toMatchObject({ route: 'manifold', voidVolume: whole.report.voidVolume });
    const report = JSON.parse(new TextDecoder().decode(outputs.files['report.json'])) as ExportReport;
    // The whole model less its void, not the sum of its bodies, as model_oriented.stl holds.
    expect(report.model.volumeMm3!).toBeCloseTo(wholeVolume, 3);
    expect(report.parts['model_oriented.stl'].volumeMm3!).toBeCloseTo(wholeVolume, 3);
    expect(Math.abs(report.model.volumeMm3! - whole.report.solidVolume)).toBeGreaterThan(VOID_MM3 * 0.99);
    expect(parseStl(outputs.files['model_oriented.stl']).rawTriangleCount).toBe(mesh.indices.length / 3);
    // The model is under 60,000 triangles, so minGap measured the copy itself, which gives up the copy's error.
    const copyError = Number(/with up to (\d+\.\d+) mm of error/.exec(simplified()!)![1]);
    expect(outputs.clearance!.error).toBeGreaterThan(0);
    expect(outputs.clearance!.error.toFixed(3)).toBe(copyError.toFixed(3));
    expect(report.clearance.minGap! - report.clearance.measured!).toBeCloseTo(outputs.clearance!.error, 9);
    expect(outputs.clearance!.measured).toBeGreaterThanOrEqual(p.params.silicone.t);
    expect(outputs.diagnostics.map((d) => d.code)).toContain('mode-b-simplified');
  }, 300_000);

  it('an export that trims the model imports it whole, reads the trimmed model_oriented.stl and the volume from it, and builds on the copy', async () => {
    const mesh = spikedBlock();
    expect(mesh.indices.length / 3).toBeGreaterThan(LIMITS.limit);
    const { p, sent } = heavyPipeline();
    p.load(asciiStl(toSoup(mesh), 'spiked block'), 'spiked-block.stl');
    await p.idle();
    expect(p.status().error).toBeNull();
    expect(p.oriented!.value.chosen.normal[2]).toBeLessThan(-0.99);
    expect(p.oriented!.value.oriented.needsTrim).toBe(true);
    expect(allDiagnostics(p).find((d) => d.code === 'below-plane')).toBeDefined();

    const outputs = await p.exportParts();
    // A trim needs the whole solid, so the export, though told the preview's import, imports it whole.
    expect(exportJobs(sent)[0].inputs).toMatchObject({ needsTrim: true, importReport: { route: 'manifold' } });
    const report = JSON.parse(new TextDecoder().decode(outputs.files['report.json'])) as ExportReport;
    // The cone above the floor lies inside the block, so trimmed, the model is the block alone.
    expect(report.model.volumeMm3!).toBeCloseTo(200_000, 0);
    const model = parseStl(outputs.files['model_oriented.stl']);
    let lowest = Infinity;
    for (let k = 2; k < model.positions.length; k += 3) lowest = Math.min(lowest, model.positions[k]);
    expect(lowest).toBeGreaterThanOrEqual(-1e-4);
    expect(auditEdges(weld(model.positions))).toMatchObject({ openEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 });
    // The trimmed whole mesh, not the copy: it keeps every triangle of the block's top.
    expect(model.triangleCount).toBeGreaterThan(2 * BLOCK.n * BLOCK.n);
    expect(outputs.diagnostics.map((d) => d.code)).toContain('mode-b-simplified');
    expect(outputs.clearance!.measured).toBeGreaterThanOrEqual(p.params.silicone.t);
    for (const name of ['cover.stl', 'base.stl']) expect(unzipSync(outputs.zip)[name], name).toBeDefined();
  }, 300_000);
});

/** 308,880 triangles take 6 s through the pipeline, so they run with CFG_FULL, as the browser's 3 million do with CFG_SOAK. */
const FULL = process.env.CFG_FULL === '1';

describe('past the display proxy\'s limit (300,000 triangles)', () => {
  it.skipIf(!FULL)('the view draws a copy and says so in Diagnostics, and S2 leaves the sealed air of the cut alone', async () => {
    const mesh = heightBlockMesh({ ...HEAVY_BLOCK, n: 390 }, weld);
    expect(mesh.indices.length / 3).toBe(308_880);
    const p = new Pipeline({ spawnField: inProcessField, spawnSolid: () => inProcessSolid(), frozen: true });
    pipelines.push(p);
    p.load(asciiStl(toSoup(mesh), 'rippled block'), 'rippled-block.stl');
    await p.idle();
    expect(p.status().error).toBeNull();
    const drawn = p.displayProxy!.indices.length / 3;
    expect(drawn).toBeLessThanOrEqual(300_000);
    const note = allDiagnostics(p).find((d) => d.code === 'display-proxy')!;
    expect(note).toMatchObject({ severity: 'info', message: `The view draws this model simplified to ${drawn.toLocaleString('en-US')} of its 308,880 triangles, to keep it quick to turn; the mold is built from the whole mesh.` });
    expect(p.oriented!.value.sealedAir).toEqual({ surface: null, recesses: null });
  }, 300_000);
});
