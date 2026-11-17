import { unzipSync } from 'fflate';
import { MeshoptSimplifier } from 'meshoptimizer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ModelSimplifier } from '../../src/app/modelSimplifier';
import { Pipeline } from '../../src/app/pipeline';
import { ProjectFiles } from '../../src/app/projectFiles';
import { Store } from '../../src/app/store';
import type { WeldedMesh } from '../../src/core/mesh/weld';
import { writeBinaryStl } from '../../src/core/stl/write';
import type { ExportOutputs, ExportReport } from '../../src/workers/exportJob';
import { unmeasuredParts } from '../../src/app/derived';
import { inProcessField, inProcessProject, inProcessSolid } from '../fixtures/inProcessWorker';
import { finnedBox } from '../fixtures/synthetic';

/**
 * RM, decision D: the measured clearance of a rebuilt model in glue mode is the smaller of the copy's (less how far
 * the file lies outside it) and that of the parts the copy left out, measured on their own. On the fixtures the copy's
 * is always the smaller, as the field holds both at the same radius and e_near comes off the copy's alone, so here the
 * left-out parts' prisms are moved 2 mm up, towards the cover's ceiling, as a part the field held too tightly would
 * stand: their gap must then be the one measured, and the one the margin is raised for.
 */
const state = vi.hoisted(() => ({ lift: 2, limit: null as number | null }));
vi.mock('../../src/core/mesh/outside', async (load) => {
  const real = await load<typeof import('../../src/core/mesh/outside')>();
  return {
    ...real,
    farPrisms: (mesh: WeldedMesh, eps?: number): WeldedMesh => {
      const prisms = real.farPrisms(mesh, eps);
      const positions = prisms.positions.slice();
      for (let k = 2; k < positions.length; k += 3) positions[k] += state.lift;
      return { positions, indices: prisms.indices };
    },
  };
});
// The limit past which the left-out parts are not measured, lowered by the second test.
vi.mock('../../src/core/mesh/repair', async (load) => {
  const real = await load<typeof import('../../src/core/mesh/repair')>();
  return {
    ...real,
    get OUTSIDE_MEASURE_LIMIT(): number {
      return state.limit ?? real.OUTSIDE_MEASURE_LIMIT;
    },
  };
});

const files = new ProjectFiles(inProcessProject);
const pipelines: Pipeline[] = [];
beforeAll(async () => {
  await MeshoptSimplifier.ready;
});
afterEach(() => {
  pipelines.splice(0).forEach((p) => p.dispose());
});

/** finnedBox opened, repaired on a 0.5 mm grid, its fin of 2 triangles left out, and its glue-mode ZIP's report.json and README.txt. */
async function finnedExport(): Promise<{ p: Pipeline; outputs: ExportOutputs; report: ExportReport; readme: string }> {
  const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true });
  pipelines.push(p);
  const store = new Store(p, () => 0, files, new ModelSimplifier(inProcessSolid, p.memory));
  const fin = finnedBox();
  await store.openFile(new File([writeBinaryStl(fin.positions, fin.indices) as BlobPart], 'finned.stl'));
  await p.idle();
  store.setRepairCell(0.5);
  await store.repairMesh();
  await p.idle();
  const outputs = await p.exportParts(() => {}, undefined, { want: 'zip', fitTest: false });
  const zip = unzipSync(outputs.zip);
  const text = (name: string): string => new TextDecoder().decode(zip[name]);
  return { p, outputs, report: JSON.parse(text('report.json')) as ExportReport, readme: text('README.txt') };
}

describe('RM: the clearance of a rebuilt model in glue mode', () => {
  it('is the left-out parts\' own gap where that is the smaller, and the margin is raised for it', async () => {
    state.lift = 2;
    state.limit = null;
    const { report } = await finnedExport();
    const { clearance } = report;
    const copy = clearance.minGap! - clearance.decimationError! - clearance.repairNearMm!;
    expect(clearance.outsideGap!).toBeLessThan(copy);
    expect(clearance.measured).toBe(clearance.outsideGap);
    // The first build's left-out parts stood about 1.4 mm from the cover, so the margin was raised once for them.
    expect(clearance.marginRaisedBy).toBeGreaterThan(1);
    expect(report.diagnostics.map((d) => d.code)).toContain('margin-raised');
  }, 120_000);

  it('is unverified, not measured, where the left-out parts are too many to measure (RM\'s review)', async () => {
    state.lift = 0;
    state.limit = 1;
    const { p, outputs, report, readme } = await finnedExport();
    const { clearance } = report;
    // The copy's part is still measured, and raises the margin if it must; the file's figure is not given.
    expect(clearance.measured).toBeNull();
    expect(clearance.outsideGap).toBeNull();
    expect(clearance.outsideTriangles).toBe(2);
    expect(clearance.minGap! - clearance.decimationError! - clearance.repairNearMm!).toBeGreaterThanOrEqual(p.params.silicone.t);
    expect(report.diagnostics.find((d) => d.code === 'outside-unmeasured')!.message).toBe('The repair left out 2 triangles of your file, too many to measure on their own: the mold leaves room for them, at least 3 mm as planned, but the silicone thickness round them is not checked.');
    const said = readme.replace(/\s+/g, ' ');
    expect(said).toContain('The clearance could not be measured for all of your file. Where it lies near the repaired copy or inside it, it is ');
    expect(said).toContain('The 2 triangles of your file the repair left out are too many to measure: the mold is planned to leave at least 3 mm round them, but that is not verified.');
    expect(said).not.toContain('Measured clearance:');
    // The status strip says unverified, as it does for an open mesh.
    expect(unmeasuredParts(outputs.clearance)).toBe(2);
    // And the Diagnostics row says so, past the same limit.
    expect(p.diagnostics.find((d) => d.code === 'model-repaired')!.message).toContain('the mold leaves room for them, but they are too many to measure the silicone round them, so it is planned there, not checked.');
  }, 120_000);

  it('is measured with the left-out parts as many as the limit', async () => {
    state.lift = 0;
    state.limit = 2;
    const { p, outputs, report } = await finnedExport();
    expect(report.clearance.outsideGap).not.toBeNull();
    expect(report.clearance.measured).toBe(Math.min(report.clearance.outsideGap!, report.clearance.minGap! - report.clearance.decimationError! - report.clearance.repairNearMm!));
    expect(unmeasuredParts(outputs.clearance)).toBeNull();
    expect(p.diagnostics.find((d) => d.code === 'model-repaired')!.message).toContain('the mold leaves room for them, and the silicone thickness round them is measured on its own.');
  }, 120_000);
});
