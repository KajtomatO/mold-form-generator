import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import type { ManifoldToplevel } from 'manifold-3d';
import { MeshoptSimplifier } from 'meshoptimizer';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { moldBox } from '../../src/app/derived';
import { Pipeline } from '../../src/app/pipeline';
import { displayProxyMessage, simplifiedEntry, type ModelOrigin } from '../../src/app/simplified';
import { orientSolid, transformPositions, trimToBase } from '../../src/core/base/orient';
import { auditEdges } from '../../src/core/mesh/audit';
import { maxDeviation, SurfaceIndex } from '../../src/core/mesh/deviation';
import { simplifyForManifold } from '../../src/core/mesh/simplify';
import { importSolid } from '../../src/core/mesh/shells';
import { weld, type WeldedMesh } from '../../src/core/mesh/weld';
import { coverPose } from '../../src/core/parts/poses';
import { withArena } from '../../src/core/solid/arena';
import { parseStl } from '../../src/core/stl/parse';
import { writeBinaryStl } from '../../src/core/stl/write';
import { exportSteps, measuredError, MIN_GAP_TRIANGLES, type ExportJob, type ExportReport } from '../../src/workers/exportJob';
import { runPrepareJob } from '../../src/workers/prepareJob';
import type { ToWorker, WorkerLike } from '../../src/workers/protocol';
import { inProcessField, inProcessSolid } from '../fixtures/inProcessWorker';
import { exampleBytes, EXAMPLE_FILES, loadExample, loadManifold } from '../fixtures/loadExamples';
import { readPart, unpose } from '../fixtures/solidChecks';
import { box, signedVolume } from '../fixtures/synthetic';

let api: ManifoldToplevel;
beforeAll(async () => {
  api = await loadManifold();
  await MeshoptSimplifier.ready;
});
const pipelines: Pipeline[] = [];
afterEach(() => {
  pipelines.splice(0).forEach((p) => p.dispose());
});

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const flat = (bytes: Uint8Array): string => text(bytes).replace(/\r\n\s*/g, ' ');
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The copy of `bytes` the prepare job makes, as the store loads it: the copy's STL, named after the file, with its origin. */
function simplified(bytes: Uint8Array, name: string, target: number, maxErrorMm = 0.05, original: Uint8Array = bytes): { stl: Uint8Array; origin: ModelOrigin } {
  const prepared = runPrepareJob(api, MeshoptSimplifier, { source: { kind: 'stl', blob: new Blob([bytes as BlobPart]) }, name, simplify: { target, maxErrorMm } }, () => bytes, () => {}, () => performance.now());
  return { stl: prepared.stl, origin: { kind: 'simplified', original: { kind: 'stl', blob: new Blob([original as BlobPart]) }, from: prepared.from, record: prepared.record } };
}

/** A pipeline whose solid workers' messages are kept, so a test can see what an export was sent. */
async function loaded(stl: Uint8Array, name: string, origin: ModelOrigin | null, sent: ToWorker[] = []): Promise<Pipeline> {
  const spawnSolid = (): WorkerLike => {
    const worker = inProcessSolid();
    const post = worker.postMessage.bind(worker);
    worker.postMessage = (message, transfer) => {
      sent.push(message);
      post(message, transfer);
    };
    return worker;
  };
  const p = new Pipeline({ spawnField: inProcessField, spawnSolid, frozen: true });
  pipelines.push(p);
  p.load(stl, name, origin);
  await p.idle();
  expect(p.status().error).toBeNull();
  return p;
}

const exportJobs = (sent: ToWorker[]): ExportJob[] => sent.filter((m): m is ToWorker & ExportJob => m.t === 'export');

describe('MM2: a simplified model\'s export', () => {
  it('Benchy simplified to 50,000, glue mode: the mold from the copy, model_oriented.stl the file itself as the plan turns it, and every file says so', async () => {
    const bytes = exampleBytes('benchy');
    const { stl, origin } = simplified(bytes, EXAMPLE_FILES.benchy, 50_000);
    const sent: ToWorker[] = [];
    const p = await loaded(stl, EXAMPLE_FILES.benchy, origin, sent);
    expect(p.modelName).toBe(EXAMPLE_FILES.benchy);
    expect(p.modelSha256).toBe(sha(bytes));
    expect(p.parsed!.value.triangles).toBe(49_998);
    const row = p.diagnostics.find((d) => d.code === 'model-simplified')!;
    expect(row.severity).toBe('info');
    expect(row.message).toBe(`The mold is made from a copy of 3dbenchy.stl simplified from 225,154 to 49,998 triangles, whose surface lies within ${origin.record.errorMm.toFixed(3)} mm of your file's, proved over all of it; the safety margin is wider by that much. model_oriented.stl is your own file, with all its 225,154 triangles.`);
    const steps: string[] = [];
    const outputs = await p.exportParts((s) => steps.push(s.step));
    // The file is read after the clearance, as the plane does not trim it, so its STL is never held through the build.
    expect(steps).toEqual(exportSteps({ want: 'zip', fitTest: false }, 'after'));
    expect(steps.indexOf('original')).toBe(steps.indexOf('clearance') + 1);
    expect(exportJobs(sent)[0].inputs!.original).toMatchObject({ sha256: sha(bytes), facts: origin.from });
    const files = unzipSync(outputs.zip);
    // The maker's file, its 225,154 triangles less none, welded and turned by the plan's transform, by the same writer.
    const model = parseStl(files['model_oriented.stl']);
    expect(model.rawTriangleCount).toBe(225_154);
    const welded = weld(parseStl(bytes).positions);
    const transform = p.oriented!.value.oriented.transform;
    expect(sha(files['model_oriented.stl'])).toBe(sha(writeBinaryStl(transformPositions(welded.positions, transform), welded.indices)));
    const report = JSON.parse(text(files['report.json'])) as ExportReport;
    expect(report.model).toMatchObject({ file: EXAMPLE_FILES.benchy, trianglesInFile: 225_706, triangles: 225_154, simplified: origin.record });
    expect(report.parts['model_oriented.stl'].triangles).toBe(225_154);
    expect(Math.abs(report.parts['model_oriented.stl'].volumeMm3! / signedVolume(welded) - 1)).toBeLessThan(1e-6);
    const { clearance } = report;
    expect(clearance.simplifyErrorMm).toBe(origin.record.errorMm);
    expect(clearance.minGap).toBeCloseTo(clearance.measured! + clearance.decimationError! + clearance.simplifyErrorMm!, 12);
    expect(outputs.clearance!.simplify).toBe(origin.record.errorMm);
    const project = JSON.parse(text(files['project.json']));
    expect(project.simplified).toEqual(simplifiedEntry(origin));
    expect(project.modelSha256).toBe(sha(bytes));
    expect(Object.keys(project)).toEqual(['schemaVersion', 'appVersion', 'model', 'modelSha256', 'basePlane', 'simplified', 'params', 'plane', 'pins', 'removed']);
    const readme = flat(files['README.txt']);
    const error = origin.record.errorMm.toFixed(3);
    expect(readme).toContain(`Your model, 3dbenchy.stl as you opened it, with all its 225,154 triangles, turned so that its base face lies flat at the bottom, ready to glue into the pocket of the base. The mold was made from a copy simplified to 49,998 triangles within ${error} mm of it, and the silicone thickness was checked to hold for this file: measured on the copy, less the copy's error.`);
    expect(readme).toContain(`Simplified: 3dbenchy.stl has 225,154 triangles, and the mold was made from a copy of 49,998 (asked for 50,000), whose surface lies within ${error} mm of your file's, proved over all of it; the safety margin was widened by that much.`);
    // 49,998 triangles are under G4's 60,000, so minGap measured the copy's own solid, and only the copy's error is taken off.
    expect(clearance.decimationError).toBe(0);
    expect(readme).toContain(`at the thinnest point between the model and the cover, measured on the copy the mold was made from, less its error of ${error} mm.`);
    expect(readme).toContain('Save project in the app keeps the simplified copy, so the same mold comes back from the .moldproj. To make it again from 3dbenchy.stl, open it in this version of the app and simplify it to 50,000 triangles, which gives the same copy');
    expect(readme).toContain(`Notes`.toUpperCase());
    expect(report.clearance.measured!).toBeGreaterThanOrEqual(p.params.silicone.t);
  }, 120_000);

  it('merged mode never reads the file, its base carries the copy, and its box is wider by the copy\'s error on each side', async () => {
    const bytes = exampleBytes('jersey');
    const { stl, origin } = simplified(bytes, EXAMPLE_FILES.jersey, 200, 0.3);
    expect(origin.record.errorMm).toBeGreaterThan(0.15);
    const sent: ToWorker[] = [];
    const p = await loaded(stl, EXAMPLE_FILES.jersey, origin, sent);
    p.setParams((params) => (params.base.mode = 'merged'));
    await p.idle();
    expect(p.diagnostics.find((d) => d.code === 'model-simplified')!.message).toMatch(/In merged mode the base carries that copy, so the silicone takes its shape\.$/);
    const steps: string[] = [];
    const outputs = await p.exportParts((s) => steps.push(s.step));
    expect(steps).toEqual(exportSteps({ want: 'zip', fitTest: false }));
    expect(steps).not.toContain('original');
    expect(exportJobs(sent)[0].inputs!.original).toBeUndefined();
    expect(exportJobs(sent)[0].inputs!.modelErrorMm).toBe(origin.record.errorMm);
    const files = unzipSync(outputs.zip);
    expect(files['model_oriented.stl']).toBeUndefined();
    const readme = flat(files['README.txt']);
    expect(readme).toContain(`The base plate with your model built onto it, a copy of jersey-barrier.stl simplified to ${origin.record.triangles.toLocaleString('en-US')} triangles, within ${origin.record.errorMm.toFixed(3)} mm of your file, so the silicone takes that copy's shape, and a ridge`);
    expect(readme).toContain('at the thinnest point between the simplified model the base carries and the cover');
    const report = JSON.parse(text(files['report.json'])) as ExportReport;
    expect(report.clearance.simplifyErrorMm).toBeUndefined();
    // The copy loaded as a plain STL, with no origin: the same box but for the widened margin.
    const plain = await loaded(stl, EXAMPLE_FILES.jersey, null);
    plain.setParams((params) => (params.base.mode = 'merged'));
    await plain.idle();
    const wide = moldBox(p.field!.value.rim), narrow = moldBox(plain.field!.value.rim);
    const cell = p.params.quality.cellFinal;
    for (const axis of [0, 1]) {
      expect(wide[axis] - narrow[axis]).toBeGreaterThan(2 * origin.record.errorMm - cell);
      expect(wide[axis] - narrow[axis]).toBeLessThan(2 * origin.record.errorMm + cell);
    }
    expect(report.box.x).toBe(wide[0]);
  }, 120_000);

  it('the file reassembled with the cover keeps t, and report.json never says more than the file\'s own gap: a copy 0.2 mm off, to show it', async () => {
    const bytes = exampleBytes('jersey');
    // A test-only bound of 0.3 mm and 200 triangles, so the copy lies far enough off the file to matter.
    const { stl, origin } = simplified(bytes, EXAMPLE_FILES.jersey, 200, 0.3);
    expect(origin.record.errorMm).toBeGreaterThan(0.15);
    const p = await loaded(stl, EXAMPLE_FILES.jersey, origin);
    const outputs = await p.exportParts();
    const files = unzipSync(outputs.zip);
    const report = JSON.parse(text(files['report.json'])) as ExportReport;
    const t = p.params.silicone.t;
    const gap = withArena(api, (arena) => {
      const cover = unpose(arena, files['cover.stl'], coverPose(outputs.rim!));
      const { mesh, audit } = readPart(files['model_oriented.stl']);
      const model = importSolid(arena, mesh, audit).solid!;
      return model.minGap(cover, t + 2);
    });
    expect(gap).toBeGreaterThanOrEqual(t - 1e-6);
    expect(report.clearance.measured!).toBeLessThanOrEqual(gap + 1e-3);
    // The copy's error was taken off: what was measured is the copy's own gap less it (MM2's review).
    const copyGap = withArena(api, (arena) => {
      const cover = unpose(arena, files['cover.stl'], coverPose(outputs.rim!));
      const copy = weld(parseStl(stl).positions);
      const posed = { positions: transformPositions(copy.positions, p.oriented!.value.oriented.transform), indices: copy.indices };
      return importSolid(arena, posed, auditEdges(posed)).solid!.minGap(cover, t + 2);
    });
    expect(report.clearance.decimationError).toBe(0);
    expect(report.clearance.measured!).toBeCloseTo(copyGap - origin.record.errorMm, 6);
  }, 180_000);

  it('where the file lies outside its copy, nearer the cover, the cover still leaves t to the file, and report.json says no more than the file\'s own gap', async () => {
    // A copy cut 0.2 mm inside the file on its sides and top, which no simplifier makes but any copy may do in places.
    const file = withArena(api, (arena) => {
      const m = arena.track(arena.track(api.Manifold.cube([20, 20, 10])).refine(4)).getMesh();
      return { positions: m.vertProperties, indices: m.triVerts } as WeldedMesh;
    });
    const copy = box([0.2, 0.2, 0], [19.8, 19.8, 9.8]);
    const bytes = writeBinaryStl(file.positions, file.indices), stl = writeBinaryStl(copy.positions, copy.indices);
    const welded = weld(parseStl(bytes).positions), copied = weld(parseStl(stl).positions);
    const errorMm = new SurfaceIndex(copied, 1).bound(welded, null).bound;
    // The file's corners lie 0.2 x sqrt(3) mm off the copy's, its faces 0.2.
    expect(errorMm).toBeCloseTo(0.2 * Math.sqrt(3), 3);
    const origin: ModelOrigin = {
      kind: 'simplified',
      original: { kind: 'stl', blob: new Blob([bytes as BlobPart]) },
      from: { name: 'block.stl', bytes: bytes.length, sha256: sha(bytes), format: 'binary', trianglesInFile: welded.indices.length / 3, triangles: welded.indices.length / 3 },
      record: { triangles: 12, target: 12, maxErrorMm: 0.5, errorMm, stoppedBy: 'target', sha256: sha(stl) },
    };
    const p = await loaded(stl, 'block.stl', origin);
    const outputs = await p.exportParts();
    const files = unzipSync(outputs.zip);
    const report = JSON.parse(text(files['report.json'])) as ExportReport;
    const t = p.params.silicone.t;
    const [fileGap, copyGap] = withArena(api, (arena) => {
      const cover = unpose(arena, files['cover.stl'], coverPose(outputs.rim!));
      const { mesh, audit } = readPart(files['model_oriented.stl']);
      const posed = { positions: transformPositions(copied.positions, p.oriented!.value.oriented.transform), indices: copied.indices };
      return [importSolid(arena, mesh, audit).solid!.minGap(cover, t + 2), importSolid(arena, posed, auditEdges(posed)).solid!.minGap(cover, t + 2)];
    });
    expect(readPart(files['model_oriented.stl']).mesh.indices.length).toBe(welded.indices.length);
    expect(fileGap).toBeGreaterThanOrEqual(t - 1e-6);
    // The file stands nearer the cover than the copy, so the copy's gap alone would say too much.
    expect(copyGap - fileGap).toBeGreaterThan(0.15);
    expect(report.clearance.measured!).toBeLessThanOrEqual(fileGap + 1e-3);
  }, 120_000);

  it('a separate body inside out in the file is flipped in model_oriented.stl as a load flips it, and report.json gives the volume of both bodies', async () => {
    const file = withArena(api, (arena) => {
      const a = arena.track(arena.track(api.Manifold.cube([20, 20, 10])).refine(10)).getMesh();
      const b = arena.track(arena.track(arena.track(api.Manifold.cube([8, 8, 6])).refine(10)).translate([40, 0, 0])).getMesh();
      const off = a.vertProperties.length / 3;
      // The second block wound inside out.
      const back = Uint32Array.from(b.triVerts, (v) => v + off);
      for (let k = 0; k < back.length; k += 3) [back[k + 1], back[k + 2]] = [back[k + 2], back[k + 1]];
      return { positions: Float32Array.from([...a.vertProperties, ...b.vertProperties]), indices: Uint32Array.from([...a.triVerts, ...back]) } as WeldedMesh;
    });
    const bytes = writeBinaryStl(file.positions, file.indices);
    const { stl, origin } = simplified(bytes, 'inverted.stl', Math.round(file.indices.length / 6));
    const sent: ToWorker[] = [];
    const p = await loaded(stl, 'inverted.stl', origin, sent);
    expect(p.diagnostics.some((d) => d.code === 'shell-inverted')).toBe(true);
    const steps: string[] = [];
    const files = unzipSync((await p.exportParts((s) => steps.push(s.step))).zip);
    // The whole solid of the file is read before the build, as for a trim.
    expect(exportJobs(sent)[0].inputs!.original!.wholeSolid).toBe(true);
    expect(steps.indexOf('original')).toBe(1);
    const model = readPart(files['model_oriented.stl']);
    const pieces = withArena(api, (arena) => arena.trackAll(importSolid(arena, model.mesh, model.audit).solid!.decompose()).map((part) => part.volume()));
    expect(pieces.sort((a, b) => a - b).map((v) => Math.round(v))).toEqual([384, 4000]);
    const report = JSON.parse(text(files['report.json'])) as ExportReport;
    expect(report.parts['model_oriented.stl'].volumeMm3!).toBeCloseTo(4384, 3);
    expect(signedVolume(model.mesh)).toBeCloseTo(4384, 3);
  }, 120_000);

  it('the decimated copy minGap measures is proved within its error too: Benchy against its 60,000 triangle copy, never under dense sampling of it, and a copy farther off than the first reach', () => {
    const { welded } = loadExample('benchy');
    const decimated = simplifyForManifold(welded, MeshoptSimplifier, MIN_GAP_TRIANGLES)!;
    const proved = measuredError(welded, decimated.mesh);
    // Every triangle at a grid of 3 steps, its corners among them: points of the surface, so never above the bound.
    const P = welded.positions, I = welded.indices, T = I.length / 3, points = new Float32Array(T * 10 * 3);
    let o = 0;
    for (let t = 0; t < T; t++) {
      for (let i = 0; i <= 3; i++) {
        for (let j = 0; i + j <= 3; j++) {
          const u = i / 3, v = j / 3, w = 1 - u - v;
          for (let d = 0; d < 3; d++) points[o++] = u * P[I[t * 3] * 3 + d] + v * P[I[t * 3 + 1] * 3 + d] + w * P[I[t * 3 + 2] * 3 + d];
        }
      }
    }
    const dense = maxDeviation(decimated.mesh, [points], 0.25);
    expect(dense).toBeLessThanOrEqual(proved);
    expect(proved - dense).toBeLessThan(0.01);
    // meshoptimizer's own figure, which G4 takes for a model loaded as it is, is several times under it.
    expect(decimated.errorMm * 2).toBeLessThan(proved);
    // A copy farther off than the first reach of 0.5 mm, with no triangle of it in the buckets the surface looks in:
    // the reach grows until the bound holds.
    const low: WeldedMesh = { positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0), indices: Uint32Array.of(0, 1, 2) };
    const high: WeldedMesh = { positions: Float32Array.of(0, 0, 1.5, 1, 0, 1.5, 0, 1, 1.5), indices: Uint32Array.of(0, 1, 2) };
    expect(new SurfaceIndex(high, 0.5).bound(low, null).beyond).toBe(true);
    expect(measuredError(low, high)).toBeCloseTo(1.5, 6);
  }, 120_000);

  it('the view\'s note on a copy drawn lighter says the mold is built from all of the copy\'s triangles, and on a file loaded as it is, as before', () => {
    expect(displayProxyMessage(297_400, 752_814, true)).toBe('The view draws this model simplified to 297,400 of its 752,814 triangles, to keep it quick to turn; the mold is built from all 752,814 of them.');
    expect(displayProxyMessage(297_400, 3_011_040, false)).toBe('The view draws this model simplified to 297,400 of its 3,011,040 triangles, to keep it quick to turn; the mold is built from the whole mesh.');
  });

  it('a file changed since it was opened stops the ZIP with the reason, and nothing is saved', async () => {
    const bytes = exampleBytes('jersey');
    const changed = bytes.slice();
    // One byte of a coordinate, so the file still reads as an STL.
    changed[84 + 12 + 1] ^= 1;
    const { stl, origin } = simplified(bytes, EXAMPLE_FILES.jersey, 600, 0.05, changed);
    const p = await loaded(stl, EXAMPLE_FILES.jersey, origin);
    await expect(p.exportParts()).rejects.toThrow(`${EXAMPLE_FILES.jersey} could not be read again for model_oriented.stl, so nothing was saved: it may have been moved, renamed or changed since you opened it. Open it again, then export.`);
    // The single parts need no file: their clearance goes through the copy.
    await expect(p.exportParts(() => {}, undefined, { want: 'cover', fitTest: false })).resolves.toMatchObject({ want: 'cover' });
  }, 120_000);

  it('a plane that trims the model trims the file by the whole-solid path, read before the build', async () => {
    const mesh = withArena(api, (arena) => {
      // A block of many small triangles with a thin spike 2 mm under its floor, which the floor's plane trims off.
      const block = arena.track(api.Manifold.cube([20, 20, 10]).refine(8));
      const spike = arena.track(arena.track(api.Manifold.cylinder(3, 0, 0.5, 16)).translate([10, 10, -2]));
      const m = arena.track(block.add(spike)).getMesh();
      return { positions: m.vertProperties, indices: m.triVerts } as WeldedMesh;
    });
    const bytes = writeBinaryStl(mesh.positions, mesh.indices);
    const { stl, origin } = simplified(bytes, 'spiked.stl', Math.round(mesh.indices.length / 3 / 2));
    const p = await loaded(stl, 'spiked.stl', origin);
    const floor = p.oriented!.value.candidates.findIndex((c) => c.normal[2] < -0.99 && c.area > 300);
    p.setPlane({ rank: floor, upper: false });
    await p.idle();
    expect(p.oriented!.value.oriented.needsTrim).toBe(true);
    const steps: string[] = [];
    const files = unzipSync((await p.exportParts((s) => steps.push(s.step))).zip);
    expect(steps.indexOf('original')).toBe(1);
    const model = readPart(files['model_oriented.stl']).mesh;
    let low = Infinity;
    for (let v = 2; v < model.positions.length; v += 3) low = Math.min(low, model.positions[v]);
    expect(low).toBeGreaterThan(-1e-3);
    const trimmed = withArena(api, (arena) => {
      const welded = weld(parseStl(bytes).positions);
      const whole = importSolid(arena, welded, auditEdges(welded)).solid!;
      return trimToBase(arena, orientSolid(arena, whole, p.oriented!.value.oriented.transform)).volume();
    });
    const report = JSON.parse(text(files['report.json'])) as ExportReport;
    expect(Math.abs(report.parts['model_oriented.stl'].volumeMm3! / trimmed - 1)).toBeLessThan(1e-6);
    // The words say the file is trimmed, with the count written, not all its triangles (MM2's review).
    const written = model.indices.length / 3;
    expect(report.parts['model_oriented.stl'].triangles).toBe(written);
    expect(p.diagnostics.find((d) => d.code === 'model-simplified')!.message).toMatch(/model_oriented\.stl is your own file, trimmed where the base face cuts it, as a model loaded as it is would be\.$/);
    const readme = flat(files['README.txt']);
    expect(readme).toContain(`Your model, spiked.stl as you opened it, trimmed where the base face cuts it, ${written.toLocaleString('en-US')} triangles as written, turned so that`);
    expect(readme).not.toContain('with all its');
  }, 120_000);
});
