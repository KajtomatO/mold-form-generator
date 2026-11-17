import { unzipSync } from 'fflate';
import type { ManifoldToplevel } from 'manifold-3d';
import { MeshoptSimplifier } from 'meshoptimizer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { allDiagnostics, DIAGNOSTIC_PARAM } from '../../src/app/derived';
import { Pipeline } from '../../src/app/pipeline';
import { transformPositions } from '../../src/core/base/orient';
import { auditEdges } from '../../src/core/mesh/audit';
import { importSolid } from '../../src/core/mesh/shells';
import { simplifyForManifold, type HeavyLimits } from '../../src/core/mesh/simplify';
import { weld, type WeldedMesh } from '../../src/core/mesh/weld';
import { coverPose } from '../../src/core/parts/poses';
import { withArena } from '../../src/core/solid/arena';
import { parseStl } from '../../src/core/stl/parse';
import { measuredError, MIN_GAP_TRIANGLES, type ExportReport } from '../../src/workers/exportJob';
import type { ToWorker, WorkerLike } from '../../src/workers/protocol';
import { heightBlockMesh, HEAVY_BLOCK } from '../fixtures/heavy';
import { inProcessField, inProcessSolid } from '../fixtures/inProcessWorker';
import { loadManifold } from '../fixtures/loadExamples';
import { unpose } from '../fixtures/solidChecks';
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
/** M11c: a part passing into the block's rippled top, as a multi-colour model's do, so the model is their union. */
const HAT: [[number, number, number], [number, number, number]] = [
  [75, 75, 10],
  [90, 90, 30],
];

let api: ManifoldToplevel;
const pipelines: Pipeline[] = [];
beforeAll(async () => {
  api = await loadManifold();
  await MeshoptSimplifier.ready;
});
afterAll(() => pipelines.splice(0).forEach((p) => p.dispose()));

/** A pipeline whose solid workers have the test's limits, recording each worker spawned and every message sent to one. */
function heavyPipeline(limits: HeavyLimits = LIMITS): { p: Pipeline; spawned: () => number; sent: ToWorker[] } {
  let spawned = 0;
  const sent: ToWorker[] = [];
  const spawnSolid = (): WorkerLike => {
    spawned++;
    const worker = inProcessSolid(limits);
    const post = worker.postMessage.bind(worker);
    worker.postMessage = (message: ToWorker, transfer?: Transferable[]) => {
      sent.push(message);
      post(message, transfer);
    };
    return worker;
  };
  const p = new Pipeline({ spawnField: inProcessField, spawnSolid, frozen: true, manifoldLimit: limits.limit });
  pipelines.push(p);
  return { p, spawned: () => spawned, sent };
}

/**
 * GC: the model as the export stands it, and G1.8's copy of it at `limits`, made as the export makes it: the
 * pipeline's welded mesh, which the import keeps as it is, turned by the plan's transform.
 */
function standing(p: Pipeline, limits: HeavyLimits = LIMITS): { model: WeldedMesh; copy: WeldedMesh } {
  const welded = p.parsed!.value.welded, transform = p.oriented!.value.oriented.transform;
  const copy = simplifyForManifold(welded, MeshoptSimplifier, limits.limit, limits.target)!.mesh;
  return { model: { positions: transformPositions(welded.positions, transform), indices: welded.indices }, copy: { positions: transformPositions(copy.positions, transform), indices: copy.indices } };
}

/** The block with its void and a part passing into its top, which the import finds as one body of the block and part less the void and their overlap. */
function hollowBlock(): WeldedMesh {
  return join(heightBlockMesh(BLOCK, weld), inverted(box(...VOID)), box(...HAT));
}

/**
 * The block with a cone from a point 0.5 mm under its floor, 4 mm in radius at the floor, a stray the base
 * plane keeps and the export trims; and a 4 x 4 post on the cone's axis from 0.3 mm under the floor to 5 mm
 * up, a part of its own, which shares about 4 mm3 with the cone under the floor and 80 mm3 with the block
 * over it (M11c review).
 */
function spikedBlock(): WeldedMesh {
  const block = heightBlockMesh(BLOCK, weld);
  const spiked = withArena(api, (arena) => {
    const solid = arena.manifold(new api.Mesh({ numProp: 3, vertProperties: block.positions, triVerts: block.indices }));
    const cone = arena.track(arena.track(api.Manifold.cylinder(1, 0, 8, 48)).translate([50, 50, -0.5]));
    const mesh = arena.track(solid.add(cone)).getMesh();
    return { positions: mesh.vertProperties, indices: mesh.triVerts };
  });
  return join(spiked, box([48, 48, -0.3], [52, 52, 5]));
}

/**
 * GC: a smooth block of 66,960 triangles, past 60,000: its 60,000 triangle decimation lies close to it, the copy of
 * 2,000 farther. Its floor is 5 mm up, so the plan moves it down to stand, as the export must move G1.8's copy too
 * (the review: a block standing as it is would pass with the copy left where the import has it). It is not laid on
 * its side: a copy left unturned would then lie 25 mm and more off, which the proof takes many minutes to bound.
 */
function smoothBlock(): WeldedMesh {
  const mesh = heightBlockMesh({ ...HEAVY_BLOCK, n: 180, size: 50, height: 10, ripple: 0.3, wavelength: 12.5 }, weld);
  const positions = mesh.positions.slice();
  for (let i = 2; i < positions.length; i += 3) positions[i] += 5;
  return { positions, indices: mesh.indices };
}

/** The smooth block loaded, standing on its own floor by a transform that moves it 5 mm down. */
async function smoothPipeline(): Promise<Pipeline> {
  const mesh = smoothBlock();
  expect(mesh.indices.length / 3).toBeGreaterThan(MIN_GAP_TRIANGLES);
  const { p } = heavyPipeline();
  p.load(asciiStl(toSoup(mesh), 'smooth block'), 'smooth-block.stl');
  await p.idle();
  expect(p.oriented!.value.oriented.transform.translation[2]).toBeCloseTo(-5, 4);
  return p;
}

const flat =(bytes: Uint8Array): string => new TextDecoder().decode(bytes).replace(/\r\n\s*/g, ' ');
const solidJobs = (sent: ToWorker[]) => sent.filter((m): m is Extract<ToWorker, { t: 'solid' }> => m.t === 'solid');
const exportJobs = (sent: ToWorker[]) => sent.filter((m): m is Extract<ToWorker, { t: 'export' }> => m.t === 'export');

describe('a mesh past G1.8\'s limit in the pipeline (limits of 4,000 and 2,000 triangles)', () => {
  it('the preview checks it whole once, then a fresh worker builds the copy alone, whose warning shows under Mode in both modes; the export, told that import, needs no other, and reports the whole model with its void left out and its parts\' overlap once', async () => {
    const mesh = hollowBlock();
    expect(mesh.indices.length / 3).toBeGreaterThan(LIMITS.limit);
    const whole = withArena(api, (arena) => importSolid(arena, mesh, auditEdges(mesh)));
    expect(whole.report.voidVolume).toBeCloseTo(VOID_MM3, 0);
    expect(whole.report.bodies).toBe(1);
    // The part's 15 x 15 mm stands in the block from 10 mm up to the ripple, about 20 mm.
    expect(whole.report.overlapVolume).toBeGreaterThan(15 * 15 * 9);
    expect(whole.report.overlapVolume).toBeLessThan(15 * 15 * 11);
    const wholeVolume = whole.report.solidVolume - whole.report.voidVolume - whole.report.overlapVolume;

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
    expect(simplified()).toMatch(/^This model has [\d,]+ triangles, too many for the geometry engine, so merged mode, and the pocket in glue mode, use a copy simplified to [\d,]+ triangles\. The cover and model_oriented\.stl come from the whole mesh\.$/);
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
    // The whole model less its void, and its parts' union, not the sum of its bodies, as a slicer prints model_oriented.stl.
    expect(report.model.volumeMm3!).toBeCloseTo(wholeVolume, 3);
    expect(report.parts['model_oriented.stl'].volumeMm3!).toBeCloseTo(wholeVolume, 3);
    expect(Math.abs(report.model.volumeMm3! - whole.report.solidVolume)).toBeGreaterThan(VOID_MM3 * 0.99);
    expect(parseStl(outputs.files['model_oriented.stl']).rawTriangleCount).toBe(mesh.indices.length / 3);
    // The model is under 60,000 triangles, so minGap measured the copy itself, which gives up how far the whole
    // mesh lies from it, proved over all of it (GC), not meshoptimizer's figure: here 0.846 mm against its 0.431.
    const { model, copy } = standing(p);
    const proved = measuredError(model, copy);
    expect(outputs.clearance!.error).toBe(proved);
    expect(proved).toBeGreaterThan(1.5 * simplifyForManifold(p.parsed!.value.welded, MeshoptSimplifier, LIMITS.limit, LIMITS.target)!.reportedMm);
    expect(report.clearance.decimationError).toBe(proved);
    expect(report.clearance.minGap! - report.clearance.measured!).toBeCloseTo(outputs.clearance!.error, 9);
    expect(flat(outputs.files['README.txt'])).toContain(`between the model and the cover, measured on a simplified copy of the model with its error of ${proved.toFixed(3)} mm taken off.`);
    expect(outputs.clearance!.measured).toBeGreaterThanOrEqual(p.params.silicone.t);
    expect(outputs.diagnostics.map((d) => d.code)).toContain('mode-b-simplified');
  }, 300_000);

  it('GC: in merged mode the base carries the copy, so the gap is the copy\'s own, measured on it with nothing taken off, and README.txt says it is the copy\'s', async () => {
    const { p } = heavyPipeline();
    p.load(asciiStl(toSoup(hollowBlock()), 'hollow block'), 'hollow-block.stl');
    await p.idle();
    p.setParams((params) => (params.base.mode = 'merged'));
    await p.idle();
    const outputs = await p.exportParts();
    const report = JSON.parse(new TextDecoder().decode(outputs.files['report.json'])) as ExportReport;
    // Under 60,000 triangles, minGap measured the copy's own solid, which is what the base carries.
    expect(outputs.clearance).toMatchObject({ error: 0, copy: true });
    expect(report.clearance.decimationError).toBe(0);
    expect(report.clearance.minGap).toBe(report.clearance.measured);
    expect(flat(outputs.files['README.txt'])).toContain(`Measured clearance: ${report.clearance.measured!.toFixed(2)} mm at the thinnest point between the simplified copy the base carries and the cover.`);
    // The copy reassembled with the cover: its gap is the one measured.
    const t = p.params.silicone.t;
    const gap = withArena(api, (arena) => {
      const cover = unpose(arena, outputs.files['cover.stl'], coverPose(outputs.rim!));
      const { copy } = standing(p);
      return importSolid(arena, copy, auditEdges(copy)).solid!.minGap(cover, t + 2);
    });
    expect(gap).toBeGreaterThanOrEqual(t - 1e-6);
    expect(Math.abs(gap - report.clearance.measured!)).toBeLessThan(1e-3);
  }, 300_000);

  it('GC: past 60,000 triangles, glue mode takes off how far the whole mesh lies from its decimated copy and merged mode how far the base\'s copy does, each proved, and neither says more than the gap it is for', async () => {
    const p = await smoothPipeline();
    const { model, copy } = standing(p);
    const decimated = simplifyForManifold(model, MeshoptSimplifier, MIN_GAP_TRIANGLES)!.mesh;
    const ofModel = measuredError(model, decimated), ofCopy = measuredError(copy, decimated);
    expect(ofCopy).toBeGreaterThan(ofModel + 0.01);
    const t = p.params.silicone.t;
    for (const mode of ['glue', 'merged'] as const) {
      p.setParams((params) => (params.base.mode = mode));
      await p.idle();
      const outputs = await p.exportParts();
      const report = JSON.parse(new TextDecoder().decode(outputs.files['report.json'])) as ExportReport;
      const proved = mode === 'glue' ? ofModel : ofCopy;
      expect(outputs.clearance!.error, mode).toBe(proved);
      expect(report.clearance.decimationError, mode).toBe(proved);
      expect(outputs.clearance!.copy, mode).toBe(mode === 'merged' ? true : undefined);
      expect(flat(outputs.files['README.txt']), mode).toContain(mode === 'merged'
        ? `at the thinnest point between the simplified copy the base carries and the cover, measured on a lighter copy of the model, less ${proved.toFixed(3)} mm for how far the base's copy lies from it.`
        : `at the thinnest point between the model and the cover, measured on a simplified copy of the model with its error of ${proved.toFixed(3)} mm taken off.`);
      // What the silicone surrounds: the whole model glued in, or the copy the base carries; its own gap is never under the figure.
      const gap = withArena(api, (arena) => {
        const cover = unpose(arena, outputs.files['cover.stl'], coverPose(outputs.rim!));
        const surface = mode === 'glue' ? model : copy;
        return importSolid(arena, surface, auditEdges(surface)).solid!.minGap(cover, t + 2);
      });
      expect(gap, mode).toBeGreaterThanOrEqual(t - 1e-6);
      expect(report.clearance.measured!, mode).toBeLessThanOrEqual(gap + 1e-3);
    }
  }, 300_000);

  it('GC: where the 60,000 triangle decimation is no solid, minGap measures G1.8\'s copy itself: glue mode takes off how far the whole mesh lies from it, proved, and merged mode, whose base carries it, nothing', async () => {
    const p = await smoothPipeline();
    const { model, copy } = standing(p);
    const proved = measuredError(model, copy);
    expect(proved).toBeGreaterThan(0.01);
    const t = p.params.silicone.t;
    // The export's decimation for minGap loses a triangle, so it is open and Manifold refuses it; G1.8's copy is whole.
    const simplify = MeshoptSimplifier.simplify;
    const decimations: number[] = [];
    const open = vi.spyOn(MeshoptSimplifier, 'simplify').mockImplementation((...args: Parameters<typeof simplify>) => {
      const [indices, error] = simplify(...args);
      if (args[3] !== MIN_GAP_TRIANGLES * 3) return [indices, error];
      decimations.push(indices.length / 3);
      return [indices.slice(3), error];
    });
    try {
      for (const mode of ['glue', 'merged'] as const) {
        p.setParams((params) => (params.base.mode = mode));
        await p.idle();
        const before = decimations.length;
        const outputs = await p.exportParts();
        expect(decimations.length, mode).toBe(before + 1);
        const report = JSON.parse(new TextDecoder().decode(outputs.files['report.json'])) as ExportReport;
        const error = mode === 'glue' ? proved : 0;
        expect(outputs.clearance!.error, mode).toBe(error);
        expect(report.clearance.decimationError, mode).toBe(error);
        expect(report.clearance.minGap! - report.clearance.measured!, mode).toBeCloseTo(error, 9);
        expect(outputs.clearance!.copy, mode).toBe(mode === 'merged' ? true : undefined);
        expect(flat(outputs.files['README.txt']), mode).toContain(mode === 'merged'
          ? `at the thinnest point between the simplified copy the base carries and the cover.`
          : `at the thinnest point between the model and the cover, measured on a simplified copy of the model with its error of ${proved.toFixed(3)} mm taken off.`);
        const gap = withArena(api, (arena) => {
          const cover = unpose(arena, outputs.files['cover.stl'], coverPose(outputs.rim!));
          const surface = mode === 'glue' ? model : copy;
          return importSolid(arena, surface, auditEdges(surface)).solid!.minGap(cover, t + 2);
        });
        expect(gap, mode).toBeGreaterThanOrEqual(t - 1e-6);
        expect(report.clearance.measured!, mode).toBeLessThanOrEqual(gap + 1e-3);
        // Merged mode measured the copy the base carries itself, so its figure is that copy's own gap.
        if (mode === 'merged') expect(Math.abs(gap - report.clearance.measured!)).toBeLessThan(1e-3);
      }
    } finally {
      open.mockRestore();
    }
    expect(MeshoptSimplifier.simplify).toBe(simplify);
  }, 300_000);

  it('an export that trims the model imports it whole, reads the trimmed model_oriented.stl and the volume from it, and builds on the copy', async () => {
    const mesh = spikedBlock();
    expect(mesh.indices.length / 3).toBeGreaterThan(LIMITS.limit);
    const whole = withArena(api, (arena) => importSolid(arena, mesh, auditEdges(mesh)));
    expect(whole.report.bodies).toBe(1);
    expect(whole.report.overlapVolume).toBeGreaterThan(82);
    expect(whole.report.overlapVolume).toBeLessThan(86);
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
    // The cone and the post above the floor lie inside the block, so trimmed, the model is the block alone:
    // the trimmed parts less what they share above the floor, 80 mm3, not the whole model's overlap.
    expect(report.model.volumeMm3!).toBeCloseTo(200_000, 0);
    expect(report.parts['model_oriented.stl'].volumeMm3!).toBeCloseTo(200_000, 0);
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
