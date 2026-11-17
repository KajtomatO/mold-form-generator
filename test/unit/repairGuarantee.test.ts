import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import type { ManifoldToplevel } from 'manifold-3d';
import { MeshoptSimplifier } from 'meshoptimizer';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { moldBox } from '../../src/app/derived';
import { ModelSimplifier } from '../../src/app/modelSimplifier';
import { Pipeline } from '../../src/app/pipeline';
import { ProjectFiles } from '../../src/app/projectFiles';
import { Store } from '../../src/app/store';
import { transformPositions } from '../../src/core/base/orient';
import { reversed } from '../../src/core/mesh/shells';
import { meshBounds, weld, type WeldedMesh } from '../../src/core/mesh/weld';
import { basePose, coverPose } from '../../src/core/parts/poses';
import { withArena } from '../../src/core/solid/arena';
import { parseStl } from '../../src/core/stl/parse';
import { writeBinaryStl } from '../../src/core/stl/write';
import type { Params } from '../../src/core/params/schema';
import { exportSteps, originalStep, type ExportInputs, type ExportReport, type ExportRequest } from '../../src/workers/exportJob';
import { inProcessField, inProcessProject, inProcessSolid } from '../fixtures/inProcessWorker';
import { loadManifold } from '../fixtures/loadExamples';
import { triangleDistance } from '../fixtures/repairChecks';
import { readPart, unpose } from '../fixtures/solidChecks';
import { heightBlockMesh } from '../fixtures/heavy';
import { finnedBox, foldedBox, join, openTopBox, thinWallBox, weldedFixture, withoutTriangles } from '../fixtures/synthetic';

/**
 * RM, decision D: the silicone is at least t thick round what the maker prints, the file itself in glue mode and the
 * repaired copy in merged mode, measured, never only planned (R43, D26). The reassembly test: the exported cover,
 * taken back from its print pose, against model_oriented.stl as written, or the copy the base carries, by the least
 * distance between every pair of their triangles, by brute force. It must be at least t, and at least what
 * report.json says it measured, so the figure never claims more than holds.
 */
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const files = new ProjectFiles(inProcessProject);
const pipelines: Pipeline[] = [];

let api: ManifoldToplevel;
beforeAll(async () => {
  await MeshoptSimplifier.ready;
  api = await loadManifold();
});
afterEach(() => {
  pipelines.splice(0).forEach((p) => p.dispose());
});

type V3 = [number, number, number];
const tri = (m: WeldedMesh, t: number): V3[] => [0, 1, 2].map((c) => Array.from(m.positions.subarray(m.indices[t * 3 + c] * 3, m.indices[t * 3 + c] * 3 + 3)) as V3);

/** The least distance between two surfaces, every pair of triangles, but pairs whose boxes are farther apart than `reach`. */
function bruteGap(A: WeldedMesh, B: WeldedMesh, reach: number): number {
  const box = (m: WeldedMesh, t: number): [V3, V3] => {
    const corners = tri(m, t);
    return [[0, 1, 2].map((d) => Math.min(...corners.map((c) => c[d]))) as V3, [0, 1, 2].map((d) => Math.max(...corners.map((c) => c[d]))) as V3];
  };
  const { min, max } = meshBounds(A.positions);
  const near: number[] = [];
  for (let t = 0; t < B.indices.length / 3; t++) {
    const [lo, hi] = box(B, t);
    if ([0, 1, 2].every((d) => lo[d] <= max[d] + reach && hi[d] >= min[d] - reach)) near.push(t);
  }
  let best = Infinity;
  for (let s = 0; s < A.indices.length / 3; s++) {
    const a = tri(A, s);
    for (const t of near) best = Math.min(best, triangleDistance(a, tri(B, t)));
  }
  return best;
}

function setup(): { store: Store; p: Pipeline } {
  const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true });
  pipelines.push(p);
  return { store: new Store(p, () => 0, files, new ModelSimplifier(inProcessSolid, p.memory)), p };
}

/** The file opened as a maker opens it, repaired on `cell` (null for auto, or a fill), with `change` made first. */
async function repaired(mesh: WeldedMesh, name: string, cell: number | null, change: (params: Params) => void = () => {}): Promise<{ store: Store; p: Pipeline; bytes: Uint8Array }> {
  const { store, p } = setup();
  const bytes = writeBinaryStl(mesh.positions, mesh.indices);
  await store.openFile(new File([bytes as BlobPart], name));
  await p.idle();
  p.setParams(change);
  await p.idle();
  expect(store.repairOffer()).not.toBeNull();
  store.setRepairCell(cell);
  await store.repairMesh();
  await p.idle();
  expect(store.fileNotice.value).toBeNull();
  expect(p.modelOrigin()?.repair).toBeTruthy();
  return { store, p, bytes };
}

/** The glue-mode ZIP: the cover taken back to where it stands, model_oriented.stl as written, and report.json. */
async function glueExport(p: Pipeline): Promise<{ cover: WeldedMesh; model: WeldedMesh; oriented: Uint8Array; report: ExportReport; readme: string }> {
  const outputs = await p.exportParts(() => {}, undefined, { want: 'zip', fitTest: false });
  const zip = unzipSync(outputs.zip);
  const cover = withArena(api, (arena) => {
    const mesh = unpose(arena, zip['cover.stl'], coverPose(outputs.rim!)).getMesh();
    return { positions: Float32Array.from(mesh.vertProperties), indices: Uint32Array.from(mesh.triVerts) };
  });
  return { cover, model: readPart(zip['model_oriented.stl']).mesh, oriented: zip['model_oriented.stl'], report: JSON.parse(text(zip['report.json'])) as ExportReport, readme: text(zip['README.txt']) };
}

/** model_oriented.stl as HEAD writes the file loaded as it is: welded, turned, and reversed where its own import reversed it. */
function fileAsWritten(p: Pipeline, bytes: Uint8Array): string {
  const welded = weld(parseStl(bytes).positions);
  const flipped = p.modelOrigin()!.repair!.record.original.flipped;
  return sha(writeBinaryStl(transformPositions(welded.positions, p.oriented!.value.oriented.transform), flipped ? reversed(welded.indices) : welded.indices));
}

const CASES: { name: string; mesh: () => WeldedMesh; cell: number | null; method: 'filled' | 'rebuilt'; far: boolean }[] = [
  { name: 'the open-top box, filled', mesh: openTopBox, cell: null, method: 'filled', far: false },
  { name: 'an open-top box wound inside out, filled', mesh: () => ({ ...openTopBox(), indices: reversed(openTopBox().indices) }), cell: null, method: 'filled', far: false },
  { name: 'finnedBox, its 5 mm fin left out', mesh: finnedBox, cell: 0.5, method: 'rebuilt', far: true },
  { name: 'a 0.15 mm wall the rebuild lost, and a 3 mm fin', mesh: () => thinWallBox(10.05, 10.2), cell: 0.5, method: 'rebuilt', far: true },
  { name: 'a 0.3 mm wall and a 3 mm fin', mesh: () => thinWallBox(10, 10.3), cell: 0.5, method: 'rebuilt', far: true },
  { name: 'a 1 mm wall the rebuild kept, and a 3 mm fin', mesh: () => thinWallBox(10, 11), cell: 0.5, method: 'rebuilt', far: true },
];

describe('RM: the silicone round what the maker prints (decision D)', () => {
  it.each(CASES)('$name: glue mode, the file against the exported cover, and merged mode, the copy', async ({ name, mesh, cell, method, far }) => {
    const { p, bytes } = await repaired(mesh(), `${name}.stl`, cell);
    const record = p.modelOrigin()!.repair!.record;
    expect(record.method).toBe(method);
    expect(record.outside !== null).toBe(far);
    const t = p.params.silicone.t;

    const glue = await glueExport(p);
    // model_oriented.stl is the maker's file, as HEAD writes it loaded as it is (decision C).
    expect(sha(glue.oriented)).toBe(fileAsWritten(p, bytes));
    // README.txt offers the closed copy instead, and says it lacks what the repair left out.
    expect(glue.readme.replace(/\s+/g, ' ').includes('which Save repaired STL in the app saves, though it lacks the parts the repair left out.')).toBe(far);
    const measured = glue.report.clearance.measured!;
    const gap = bruteGap(glue.model, glue.cover, t + 2);
    console.log(`${name}: glue ${glue.report.silicone.ml.toFixed(1)} ml, box ${glue.report.box.x.toFixed(2)} x ${glue.report.box.y.toFixed(2)} x ${glue.report.box.z.toFixed(2)}; measured ${measured.toFixed(3)} (near ${glue.report.clearance.repairNearMm?.toFixed(3)}, far ${glue.report.clearance.outsideGap?.toFixed(3) ?? '-'}), brute ${gap.toFixed(3)}`);
    expect(gap).toBeGreaterThanOrEqual(t - 1e-6);
    expect(gap).toBeGreaterThanOrEqual(measured - 1e-3);
    if (far) expect(glue.report.clearance.outsideGap).toBeGreaterThanOrEqual(measured - 1e-9);
    // The preview's box is the export's: the field and the box hold the left-out parts in both (S3, S10).
    expect(glue.report.clearance.marginRaisedBy).toBe(0);
    const shown = moldBox(p.field!.value.rim);
    expect([glue.report.box.x, glue.report.box.y, glue.report.box.z].map((v) => v.toFixed(6))).toEqual(shown.map((v) => v.toFixed(6)));

    p.setParams((params) => (params.base.mode = 'merged'));
    await p.idle();
    const outputs = await p.exportParts(() => {}, undefined, { want: 'zip', fitTest: false });
    const zip = unzipSync(outputs.zip);
    const report = JSON.parse(text(zip['report.json'])) as ExportReport;
    // A cast that lacks the parts the repair left out is a warning in README.txt, as on screen.
    expect(text(zip['README.txt']).replace(/\s+/g, ' ').includes('which the cast will not have. In merged mode the base carries that copy')).toBe(far);
    const cover = withArena(api, (arena) => {
      const m = unpose(arena, zip['cover.stl'], coverPose(outputs.rim!)).getMesh();
      return { positions: Float32Array.from(m.vertProperties), indices: Uint32Array.from(m.triVerts) };
    });
    const copy = p.parsed!.value.welded;
    const posed = { positions: transformPositions(copy.positions, p.oriented!.value.oriented.transform), indices: copy.indices };
    const merged = bruteGap(posed, cover, t + 2);
    console.log(`${name}: merged ${report.silicone.ml.toFixed(1)} ml, measured ${report.clearance.measured!.toFixed(3)}, brute ${merged.toFixed(3)}`);
    expect(merged).toBeGreaterThanOrEqual(t - 1e-6);
    expect(merged).toBeGreaterThanOrEqual(report.clearance.measured! - 1e-3);
  }, 300_000);

  it('an open file that reaches below the base plane the copy stands on is cut there in model_oriented.stl, and still keeps t (decision C)', async () => {
    // finnedBox stood on its top: the copy, the box, needs no trim, but the file's fin lies 5 mm under the plane.
    const { p, bytes } = await repaired(finnedBox(), 'finned.stl', 0.5);
    const top = p.oriented!.value.candidates.findIndex((c) => c.normal[2] > 0.99);
    p.setPlane({ rank: top, upper: false });
    await p.idle();
    expect(p.oriented!.value.oriented.needsTrim).toBe(false);
    const t = p.params.silicone.t;
    const glue = await glueExport(p);
    const { min } = meshBounds(glue.model.positions);
    expect(min[2]).toBeGreaterThanOrEqual(-1e-6);
    // The fin is cut away whole, as it stands on the plane; the box's own 12 triangles are written as the file has them.
    expect(glue.model.indices.length / 3).toBe(12);
    expect(weld(parseStl(bytes).positions).indices.length / 3).toBe(14);
    expect(glue.readme.replace(/\s+/g, ' ')).toContain('finned.stl as you opened it, trimmed where the base face cuts it, 12 triangles as written, its cut left open as the rest of your file is,');
    expect(glue.report.parts['model_oriented.stl']).toEqual({ triangles: 12, volumeMm3: null });
    expect(bruteGap(glue.model, glue.cover, t + 2)).toBeGreaterThanOrEqual(t - 1e-6);
  }, 300_000);

  it('a closed file that folds below the plane its copy stands on is trimmed there by its whole solid, clear of the base, and keeps t (RM\'s review)', async () => {
    // foldedBox's bottom face is pushed 6 mm down through it; stood on the copy's own bottom, the copy needs no trim,
    // but the file does, as HEAD trims a closed file that reaches below the plane (decision C).
    const { store, p } = await repaired(foldedBox(), 'folded.stl', 0.5);
    const bottom = p.oriented!.value.candidates.findIndex((c) => c.normal[2] < -0.99);
    store.setPlane({ rank: bottom, upper: false });
    await p.idle();
    expect(p.oriented!.value.oriented.needsTrim).toBe(false);
    const row = p.diagnostics.find((d) => d.code === 'model-repaired')!.message;
    expect(row).toContain('model_oriented.stl is your own file, trimmed where the base face cuts it.');
    // Every triangle of it was left out, so it lies within no distance of the copy, and the margin is not widened.
    expect(p.modelOrigin()!.repair!.record.nearMm).toBe(0);
    expect(row).toContain('Your file lies inside the copy, proved over all of it but the parts below. The repair left out 12 triangles');
    const t = p.params.silicone.t;
    const outputs = await p.exportParts(() => {}, undefined, { want: 'zip', fitTest: false });
    const zip = unzipSync(outputs.zip);
    const back = (bytes: Uint8Array, pose: ReturnType<typeof coverPose>): WeldedMesh => withArena(api, (arena) => {
      const m = unpose(arena, bytes, pose).getMesh();
      return { positions: Float32Array.from(m.vertProperties), indices: Uint32Array.from(m.triVerts) };
    });
    const model = readPart(zip['model_oriented.stl']).mesh;
    const report = JSON.parse(text(zip['report.json'])) as ExportReport;
    expect(meshBounds(model.positions).min[2]).toBeGreaterThanOrEqual(-1e-6);
    const readme = text(zip['README.txt']).replace(/\s+/g, ' ');
    expect(readme).toContain(`folded.stl as you opened it, trimmed where the base face cuts it, ${model.indices.length / 3} triangles as written, turned`);
    expect(readme).toContain('Your file lies inside the copy, proved over all of it but 12 triangles up to');
    expect(readme).not.toContain('0.000 mm');
    const gap = bruteGap(model, back(zip['cover.stl'], coverPose(outputs.rim!)), t + 2);
    const intoBase = bruteGap(model, back(zip['base.stl'], basePose(outputs.rim!)), 1);
    console.log(`foldedBox on the copy's bottom: measured ${report.clearance.measured!.toFixed(3)}, brute ${gap.toFixed(3)}, file to base ${intoBase.toFixed(3)}`);
    expect(gap).toBeGreaterThanOrEqual(t - 1e-6);
    expect(gap).toBeGreaterThanOrEqual(report.clearance.measured! - 1e-3);
    // Glued into its pocket, it stands on the pocket's floor and keeps the pocket's own clearance to its walls.
    expect(intoBase).toBeGreaterThan(0.1);
  }, 300_000);

  it('a flat file whose rebuilt copy dips below the plane is written as it is, not cut, and says so (RM\'s review)', async () => {
    // A rippled block with a hole and a fin, rebuilt on 0.35 mm: three of the copy's vertices lie 0.07 mm below its
    // plane, past the 0.05 mm tolerance, so the copy is trimmed; the file's flat bottom lies on the plane, so it is not.
    const block = withoutTriangles(heightBlockMesh({ n: 80, size: 40, height: 6, ripple: 1, wavelength: 2 }, weld), [807]);
    const t0 = 2 * (80 * 20 + 20);
    const corner = (k: number): number[] => Array.from(block.positions.subarray(block.indices[t0 * 3 + k] * 3, block.indices[t0 * 3 + k] * 3 + 3));
    const [a, b] = [corner(0), corner(1)];
    const fin = { positions: Float32Array.from([...a, ...b, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, a[2] + 3]), indices: Uint32Array.from([0, 1, 2]) };
    const { p, bytes } = await repaired(weldedFixture(join(block, fin)), 'rippled.stl', 0.35);
    const oriented = p.oriented!.value;
    expect(oriented.oriented.needsTrim).toBe(true);
    expect(oriented.oriented.below.depth).toBeGreaterThan(oriented.planeTol);
    const shown = p.diagnostics.map((d) => d.message).join('\n');
    expect(shown).toContain('vertices of the repaired copy lie up to 0.07 mm below this plane, so the mold is made for the copy trimmed there; model_oriented.stl, your own file, is trimmed only where it reaches below the plane too.');
    expect(shown).toContain('model_oriented.stl is your own file.');
    const glue = await glueExport(p);
    expect(sha(glue.oriented)).toBe(fileAsWritten(p, bytes));
    const file = weld(parseStl(bytes).positions).indices.length / 3;
    expect(glue.readme.replace(/\s+/g, ' ')).toContain(`rippled.stl as you opened it, with all its ${file.toLocaleString('en-US')} triangles, turned`);
    expect(glue.readme).not.toContain('trimmed where the base face cuts it');
    expect(glue.report.parts['model_oriented.stl']).toEqual({ triangles: file, volumeMm3: null });
  }, 300_000);

  it('reads a repaired open file after the build, whatever the copy\'s trim, as it is cut with no solid, and a closed one before (RM\'s review)', () => {
    const job = (route: 'soup' | 'manifold', needsTrim: boolean): Parameters<typeof originalStep>[0] => ({ want: 'zip', inputs: { needsTrim, original: { wholeSolid: false, repaired: { route, flipped: false, inverted: false } } } as unknown as ExportInputs });
    expect(originalStep(job('soup', true))).toBe('after');
    expect(originalStep(job('soup', false))).toBe('after');
    expect(originalStep(job('manifold', false))).toBe('before');
    expect(exportSteps({ want: 'zip', fitTest: false } as ExportRequest, originalStep(job('soup', true)))).toEqual(['import', 'field', 'tool', 'cover', 'base', 'clearance', 'original', 'files', 'zip']);
  });

  it('a far part nearer the cover than the copy raises the margin, so the file still keeps t (a print margin of -0.3 mm)', async () => {
    const { p } = await repaired(finnedBox(), 'finned.stl', 0.5, (params) => (params.silicone.printMargin = -0.3));
    const t = p.params.silicone.t;
    const glue = await glueExport(p);
    const gap = bruteGap(glue.model, glue.cover, t + 2);
    console.log(`finnedBox at a print margin of -0.3: measured ${glue.report.clearance.measured!.toFixed(3)}, far ${glue.report.clearance.outsideGap?.toFixed(3)}, raised by ${glue.report.clearance.marginRaisedBy.toFixed(3)}, brute ${gap.toFixed(3)}`);
    expect(glue.report.clearance.marginRaisedBy).toBeGreaterThan(0);
    expect(gap).toBeGreaterThanOrEqual(t - 1e-6);
    expect(gap).toBeGreaterThanOrEqual(glue.report.clearance.measured! - 1e-3);
  }, 300_000);
});
