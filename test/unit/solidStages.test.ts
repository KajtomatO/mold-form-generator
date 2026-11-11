import type { ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { hashMesh } from '../../src/app/hash';
import { stageKeys, type StageId } from '../../src/app/stages';
import { replicateOpenings } from '../../src/core/analysis/placement';
import { openingSizes, placementSpace } from '../../src/core/analysis/validate';
import { emptyField } from '../../src/core/field/grid';
import { defaultParams, resolveAuto } from '../../src/core/params/defaults';
import { DEFAULT_PLANE, FieldStages, PLAIN_IMPORT, type PlaneChoice } from '../../src/workers/fieldStages';
import { SolidStages, type SolidInputs } from '../../src/workers/solidStages';
import { MeshoptSimplifier } from 'meshoptimizer';
import { auditEdges } from '../../src/core/mesh/audit';
import { DISPLAY_TRIANGLE_LIMIT } from '../../src/core/mesh/simplify';
import { meshBounds, weld as weldSoup, type WeldedMesh } from '../../src/core/mesh/weld';
import { exampleBytes, loadManifold, skipWithout, type ExampleId } from '../fixtures/loadExamples';

let api: ManifoldToplevel;
beforeAll(async () => {
  api = await loadManifold();
});

/** jersey at defaults, as main would send it to solid.worker. */
function jerseyJob(): { keys: Record<StageId, string>; inputs: SolidInputs } {
  const params = defaultParams();
  const keys = stageKeys(params, { file: 'f', import: 'plain', plane: JSON.stringify(DEFAULT_PLANE), tier: 'preview', cellScale: 1, pins: [], removed: [], drag: null });
  const { S1, S2, S6, S7 } = new FieldStages().run(keys, ['S1', 'S2', 'S6', 'S7'], params, { file: exampleBytes('jersey').slice().buffer, import: PLAIN_IMPORT, plane: DEFAULT_PLANE, cellScale: 1, pins: [], removed: [] });
  const space = placementSpace(S6!.field, S6!.rim, S6!.mold.offsets, openingSizes(params));
  return {
    keys,
    inputs: {
      model: { welded: S1!.welded, audit: S1!.audit },
      plane: { candidate: S2!.chosen, transform: S2!.oriented.transform, needsTrim: S2!.oriented.needsTrim, planeTol: S2!.planeTol, pocketDepth: resolveAuto(params, S2!.bounds).pocketDepth },
      rim: S6!.rim,
      offsets: S6!.mold.offsets,
      field: S6!.field,
      clip: S6!.rim.D,
      tol: params.quality.tinTolPreview,
      copies: replicateOpenings(S7!.placement.openings, space),
      drag: null,
    },
  };
}

describe('solid.worker\'s stage cache', () => {
  it('a build that throws leaves the entry it would have replaced whole, and usable under its own key', () => {
    const stages = new SolidStages(api);
    const { keys, inputs } = jerseyJob();
    const params = defaultParams();
    const first = stages.run(keys, ['S13'], params, inputs).S13!;
    // A field with no cavity cannot make a tool, so this S11 throws part way.
    const empty = { ...inputs, field: emptyField(inputs.field!), copies: [] };
    expect(() => stages.run({ ...keys, S11: 'other', S12: 'other' }, ['S13'], params, empty)).toThrow(/no cavity/);
    expect(stages.cached().S11).toBe(keys.S11);
    // The old tool is still there: a new cover body is cut with it, with no field sent, and comes out the same.
    const again = stages.run({ ...keys, S12: 'rebuilt' }, ['S13'], params, { ...inputs, field: null }).S13!;
    expect(hashMesh(again.positions, again.indices)).toBe(hashMesh(first.positions, first.indices));
    stages.clear();
  });

  it('keeps only the model, tool, cover body, base body and funnel between jobs', () => {
    const stages = new SolidStages(api);
    const { keys, inputs } = jerseyJob();
    stages.run(keys, ['S1', 'S13', 'S15', 'S16'], defaultParams(), inputs);
    expect(Object.keys(stages.cached()).sort()).toEqual(['S1', 'S11', 'S12', 'S14', 'S16', 'S2']);
    expect(stages.heldEntries()).toBe(5);
    // A drag holds the cover cut for the others while it lasts, and any other job frees it.
    const [moved, ...rest] = inputs.copies;
    stages.run({ ...keys, S13: 'drag' }, ['S13'], defaultParams(), { ...inputs, drag: { rest, moved: [{ ...moved, x: moved.x + 0.5 }] } });
    expect(stages.heldEntries()).toBe(6);
    stages.run(keys, ['S13'], defaultParams(), inputs);
    expect(stages.heldEntries()).toBe(5);
    stages.clear();
  });

  it('a drag cuts the other openings once, on its first step, and each step after only cuts the dragged one', () => {
    const stages = new SolidStages(api);
    const { keys, inputs } = jerseyJob();
    const params = defaultParams();
    stages.run(keys, ['S13'], params, inputs);
    const [moved, ...rest] = inputs.copies;
    expect(rest.length).toBeGreaterThan(0);
    const step = (dx: number, others = rest): void => {
      const out = stages.run({ ...keys, S13: `drag ${dx}` }, ['S13'], params, { ...inputs, drag: { rest: others, moved: [{ ...moved, x: moved.x + dx }] } }).S13!;
      expect(out.provisional).toBe(true);
    };
    step(0.5);
    step(1);
    step(1.5);
    expect(stages.dragRestCuts).toBe(1);
    // A drop runs a job with no drag, which frees that cover, so the next drag cuts the rest again.
    stages.run(keys, ['S13'], params, inputs);
    step(0.5);
    expect(stages.dragRestCuts).toBe(2);
    // So does a drag of another opening, whose rest is another set.
    step(0.5, [moved]);
    expect(stages.dragRestCuts).toBe(3);
    stages.clear();
  });
});

/** S1 and S2 of an example on a plane, as main sends them for base confirmation, before any field. */
function footprintJob(id: ExampleId, plane: PlaneChoice): { keys: Record<StageId, string>; inputs: SolidInputs } {
  const params = defaultParams();
  const keys = stageKeys(params, { file: id, import: 'plain', plane: JSON.stringify(plane), tier: 'preview', cellScale: 1, pins: [], removed: [], drag: null });
  const { S1, S2 } = new FieldStages().run(keys, ['S1', 'S2'], params, { file: exampleBytes(id).slice().buffer, import: PLAIN_IMPORT, plane, cellScale: 1, pins: [], removed: [] });
  return {
    keys,
    inputs: {
      model: { welded: S1!.welded, audit: S1!.audit },
      plane: { candidate: S2!.chosen, transform: S2!.oriented.transform, needsTrim: S2!.oriented.needsTrim, planeTol: S2!.planeTol, pocketDepth: resolveAuto(params, S2!.bounds).pocketDepth },
      rim: null,
      offsets: [],
      field: null,
      clip: null,
      tol: params.quality.tinTolPreview,
      copies: [],
      drag: null,
    },
  };
}

describe('base confirmation in solid.worker', () => {
  it('S2 places VIS-35\'s 0.41 mm level against the footprint, which "Use upper level" then clears', (ctx) => {
    skipWithout(ctx, 'vis35');
    const stages = new SolidStages(api);
    const low = footprintJob('vis35', DEFAULT_PLANE);
    const report = stages.run(low.keys, ['S2'], defaultParams(), low.inputs).S2!;
    // The plan's G2.6 figures: a 764 mm2 face 0.41 mm above the 361 mm2 pad, all of it open to the cavity.
    // It measures 769.4 mm2, the M1 golden, within the 1% the M1 area checks allow.
    const useUpper = report.levels.useUpper!;
    expect(useUpper.gap).toBeCloseTo(0.405, 2);
    expect(Math.abs(useUpper.exposedArea / 764 - 1)).toBeLessThan(0.01);
    expect(useUpper.enclosedArea).toBe(0);
    expect(report.levels.diagnostics.map((d) => d.code)).toEqual(['upper-level']);
    expect(report.levels.diagnostics[0].message).toContain('0.41 mm above this plane');
    // The footprint stays cached for the base, under the same key.
    expect(stages.cached().S2).toBe(low.keys.S2);

    const high = footprintJob('vis35', { rank: 0, upper: useUpper.offset });
    expect(high.inputs.plane.candidate.offset).toBeCloseTo(0.405, 2);
    const raised = stages.run(high.keys, ['S2'], defaultParams(), high.inputs).S2!;
    expect(raised.levels.useUpper).toBeNull();
    expect(raised.levels.diagnostics).toEqual([]);
    stages.clear();
  }, 60_000);

  it('S2 lists the islands the footprint dropped, as wolf has (G2.5)', () => {
    const stages = new SolidStages(api);
    const job = footprintJob('wolf', DEFAULT_PLANE);
    const report = stages.run(job.keys, ['S2'], defaultParams(), job.inputs).S2!;
    expect(report.diagnostics.map((d) => d.code)).toEqual(['footprint-islands']);
    // A recess in the underside is noted and offered no trim.
    expect(report.levels.useUpper).toBeNull();
    expect(report.levels.diagnostics.map((d) => d.code)).toEqual(['recess-level']);
    stages.clear();
  }, 60_000);
});

/** A closed box with each face split into n x n squares, so its triangle count is 12 n^2. */
function tessellatedBox(n: number, size: number): WeldedMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const faces: [number, number, number, 1 | -1][] = [[0, 1, 2, -1], [0, 1, 2, 1], [1, 2, 0, -1], [1, 2, 0, 1], [2, 0, 1, -1], [2, 0, 1, 1]];
  for (const [u, v, w, side] of faces) {
    const start = positions.length / 3;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const point = [0, 0, 0];
        point[u] = (i / n) * size;
        point[v] = (j / n) * size;
        point[w] = side > 0 ? size : 0;
        positions.push(...point);
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = start + j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
        // Outward on the far side, so each face winds by its side.
        if (side > 0) indices.push(a, b, d, a, d, c);
        else indices.push(a, d, b, a, c, d);
      }
    }
  }
  // The faces share their edges, so a weld by position joins them into one closed solid.
  const soup = new Float32Array(indices.length * 3);
  indices.forEach((vertex, k) => soup.set(positions.slice(vertex * 3, vertex * 3 + 3), k * 3));
  return weldSoup(soup);
}

describe('the display proxy (G1.8)', () => {
  it('comes with the import above 300k triangles, within the limit, and not below it', async () => {
    await MeshoptSimplifier.ready;
    const heavy = tessellatedBox(160, 40);
    expect(heavy.indices.length / 3).toBeGreaterThan(DISPLAY_TRIANGLE_LIMIT);
    const params = defaultParams();
    const keys = stageKeys(params, { file: 'heavy', import: 'plain', plane: JSON.stringify(DEFAULT_PLANE), tier: 'preview', cellScale: 1, pins: [], removed: [], drag: null });
    const stages = new SolidStages(api, () => 0, MeshoptSimplifier);
    const out = stages.run(keys, ['S1'], params, { ...jerseyJob().inputs, model: { welded: heavy, audit: auditEdges(heavy) } }).S1!;
    expect(out.report.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(out.display).not.toBeNull();
    expect(out.display!.indices.length / 3).toBeLessThanOrEqual(DISPLAY_TRIANGLE_LIMIT);
    expect(out.display!.indices.length / 3).toBeGreaterThan(DISPLAY_TRIANGLE_LIMIT / 4);
    // The same shape, lighter: the box's extent, and still closed, which a list cut short would not be.
    const bounds = meshBounds(out.display!.positions);
    expect(bounds.min.map((v) => Math.abs(v)).every((v) => v < 1e-3)).toBe(true);
    expect(bounds.max.map((v) => Math.abs(v - 40)).every((v) => v < 1e-3)).toBe(true);
    const audit = auditEdges(out.display!);
    expect([audit.openEdges, audit.nonManifoldEdges]).toEqual([0, 0]);
    stages.clear();

    const light = new SolidStages(api, () => 0, MeshoptSimplifier);
    const { keys: jerseyKeys, inputs } = jerseyJob();
    expect(light.run(jerseyKeys, ['S1'], params, inputs).S1!.display).toBeNull();
    light.clear();
  }, 60_000);
});

describe('G1.8\'s copy in the preview\'s base', () => {
  // jersey's 1,340 triangles past a limit of 1,000, as 3 million are past 2 million.
  const LIMITS = { limit: 1000, target: 500 };

  it('says what the base used: the copy with its error, or, where the copy is no closed solid, the whole mesh', async () => {
    await MeshoptSimplifier.ready;
    const { keys, inputs } = jerseyJob();
    const codes = (simplifier: typeof MeshoptSimplifier): string[] => {
      const stages = new SolidStages(api, () => 0, simplifier, LIMITS);
      const out = stages.run(keys, ['S1', 'S15'], defaultParams(), inputs).S15!;
      stages.clear();
      return out.diagnostics.map((d) => d.code);
    };
    expect(codes(MeshoptSimplifier)).toContain('mode-b-simplified');
    // A copy missing a triangle is open, so Manifold refuses it, and the warning says the whole mesh is used.
    const open: typeof MeshoptSimplifier = { ...MeshoptSimplifier, simplify: (...args: Parameters<typeof MeshoptSimplifier.simplify>) => {
      const [indices, error] = MeshoptSimplifier.simplify(...args);
      return [indices.slice(3), error];
    } };
    const used = codes(open);
    expect(used).toContain('mode-b-unsimplified');
    expect(used).not.toContain('mode-b-simplified');
  }, 60_000);
});
