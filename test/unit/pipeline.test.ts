import type { ManifoldToplevel } from 'manifold-3d';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CRASH_SCALE, Pipeline, type PipelineEvent } from '../../src/app/pipeline';
import { hashFloats, hashMesh, hashString } from '../../src/app/hash';
import { stageKeys } from '../../src/app/stages';
import { findBodies } from '../../src/core/analysis/bodies';
import { placementSettings, placeOpenings, replicateOpenings } from '../../src/core/analysis/placement';
import { openingSizes, placementSpace } from '../../src/core/analysis/validate';
import { defaultParams } from '../../src/core/params/defaults';
import { buildCoverBody, buildCoverFinal } from '../../src/core/parts/cover';
import { deriveRim, moldBounds } from '../../src/core/parts/rim';
import { withArena } from '../../src/core/solid/arena';
import { buildToolMesh, toolSolid } from '../../src/core/solid/tool';
import { fieldHost } from '../../src/workers/fieldHost';
import { DEFAULT_PLANE, PLAIN_IMPORT, previewCell } from '../../src/workers/fieldStages';
import type { FromWorker, ToWorker, WorkerLike } from '../../src/workers/protocol';
import { buildField } from '../../src/core/field/build';
import { exportPlan, fieldSettings, planField } from '../../src/core/field/grid';
import { orientedExample } from '../fixtures/fieldRuns';
import { exampleBytes, EXAMPLE_FILES, loadManifold, type ExampleId } from '../fixtures/loadExamples';
import { inProcessField, inProcessSolid } from '../fixtures/inProcessWorker';
import { asciiStl, box, inverted, toSoup, withoutTriangles } from '../fixtures/synthetic';

const pipelines: Pipeline[] = [];
function pipeline(spawnField: () => WorkerLike = inProcessField, spawnSolid: () => WorkerLike = inProcessSolid): Pipeline {
  const p = new Pipeline({ spawnField, spawnSolid, frozen: true });
  pipelines.push(p);
  return p;
}

/** A pipeline whose budgets adapt, as the page runs it without ?test=1. T2 does not wait, to keep the test short. */
function livePipeline(): Pipeline {
  const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid });
  p.budgets.settings.debounceMs = 0;
  pipelines.push(p);
  return p;
}

let api: ManifoldToplevel;
beforeAll(async () => {
  api = await loadManifold();
});
afterEach(() => {
  pipelines.splice(0).forEach((p) => p.dispose());
});

function load(p: Pipeline, id: ExampleId): void {
  p.load(exampleBytes(id), EXAMPLE_FILES[id]);
}

/** The same state from nothing, in a pipeline with workers of its own. */
async function fresh(p: Pipeline): Promise<string> {
  const other = pipeline();
  other.restore(p.snapshot()!);
  await other.idle();
  return other.geometryHash().all;
}

const until = async (test: () => boolean, ms = 20_000): Promise<void> => {
  const end = performance.now() + ms;
  while (!test()) {
    if (performance.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

const applied = (p: Pipeline, slot: PipelineEvent['slot']): PipelineEvent[] => p.events.filter((e) => e.kind === 'applied' && e.slot === slot);
const logged = (p: Pipeline, gate: string, event: string): number => p.log.filter((e) => e.gate === gate && e.event === event).length;

describe('the pipeline in one process, on the real stage code', () => {
  it('builds jersey from its bytes: field, placement, cover and base, and the badge clears', async () => {
    const p = pipeline();
    load(p, 'jersey');
    expect(p.status().stale).toBe(true);
    await p.idle();
    expect(p.error).toBeNull();
    expect(p.status()).toMatchObject({ stale: false, busy: false });
    expect(p.field!.value.field.values.length).toBeGreaterThan(1000);
    expect(p.placement!.value.placement.openings.length).toBeGreaterThan(0);
    expect(p.cover!.value.indices.length).toBeGreaterThan(1000);
    expect(p.base!.value.indices.length).toBeGreaterThan(100);
    expect(p.timing.t1).toHaveLength(1);
    // The distance map came from field.worker with the placement, so a drop on main never builds it.
    const { space } = p.placement!.value;
    expect(space.clearance).toBeInstanceOf(Float32Array);
    expect(space.clearance!.length).toBe(space.field.values.length);
    expect(Object.keys(space.fits).sort()).toEqual(['pour', 'vent']);
  });

  it('a burst of 50 t changes runs few jobs, applies results in order, and ends on the last value', async () => {
    const p = pipeline();
    load(p, 'x8');
    await p.idle();
    // In one process a job runs on the test's own thread, so the changes come in groups between jobs.
    const values = Array.from({ length: 50 }, (_, k) => 3 + (k + 1) * 0.02);
    const before = logged(p, 'field', 'dispatch');
    for (let k = 0; k < values.length; k++) {
      p.setParams((params) => (params.silicone.t = values[k]));
      if (k % 10 === 9) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await p.idle();
    const fields = applied(p, 'field').slice(1);
    expect(logged(p, 'field', 'dispatch') - before).toBeLessThanOrEqual(10);
    expect(fields.length).toBeGreaterThanOrEqual(2);
    for (let k = 1; k < fields.length; k++) expect(fields[k].rev).toBeGreaterThan(fields[k - 1].rev);
    expect(fields.some((e) => e.stale)).toBe(true);
    expect(fields.at(-1)!.t).toBeCloseTo(values.at(-1)!, 9);
    expect(applied(p, 'cover').at(-1)!.t).toBeCloseTo(values.at(-1)!, 9);
    expect(p.status().stale).toBe(false);
    expect(p.geometryHash().all).toBe(await fresh(p));
  }, 120_000);

  it('T2 waits 400 ms from the change itself, not from when the field for it arrives', async () => {
    const p = pipeline();
    load(p, 'x8');
    await p.idle();
    expect(p.budgets.settings.debounceMs).toBe(400);
    const changedAt = performance.now();
    p.setParams((params) => (params.silicone.t = 3.5));
    await p.idle();
    const placedAt = p.events.filter((e) => e.kind === 'applied' && e.slot === 'placement').at(-1)!.at;
    const sentAt = p.log.filter((e) => e.gate === 'solid' && e.event === 'dispatch').at(-1)!.at;
    console.log(`debounce: placement ${Math.round(placedAt - changedAt)} ms and T2 sent ${Math.round(sentAt - changedAt)} ms after the change`);
    expect(placedAt - changedAt).toBeGreaterThan(20);
    expect(sentAt - changedAt).toBeGreaterThanOrEqual(395);
    // Counted from the field's arrival, it would go at 400 ms past that.
    expect(sentAt - changedAt).toBeLessThan(Math.max(400, placedAt - changedAt) + 30);
  }, 60_000);

  it('rejects a result for the file before, which was in flight when the next was loaded', async () => {
    const p = pipeline();
    load(p, 'x8');
    await until(() => logged(p, 'solid', 'dispatch') > 0);
    load(p, 'jersey');
    await p.idle();
    expect(p.events.filter((e) => e.kind === 'rejected' && e.reason === 'model').length).toBeGreaterThan(0);
    expect(p.modelName).toBe(EXAMPLE_FILES.jersey);
    expect(p.geometryHash().all).toBe(await fresh(p));
  }, 120_000);

  it('a drag straight after a recycle misses, re-sends with the field, and the drop ends as a fresh build', async () => {
    const p = pipeline();
    load(p, 'jersey');
    await p.idle();
    const [opening] = p.placement!.value.placement.openings;
    p.recycleSolid();
    p.dragOpening(opening.id, opening.x + 1, opening.y);
    await p.idle();
    expect(logged(p, 'solid', 'miss')).toBe(1);
    expect(p.cover!.value.provisional).toBe(true);
    expect(p.status().stale).toBe(false);
    p.dropOpening(opening.id, opening.x + 1, opening.y);
    await p.idle();
    expect(p.cover!.value.provisional).toBe(false);
    expect(p.geometryHash().all).toBe(await fresh(p));
  }, 120_000);

  it('a job past its budget is ended for a newer one, the worker respawns, and the newer one lands', async () => {
    const p = pipeline();
    load(p, 'jersey');
    await p.idle();
    p.budgets.freeze({ terminateFloorMs: 300, debounceMs: 0 });
    p.armFault('solid', { kind: 'delay', ms: 5_000 });
    const before = logged(p, 'solid', 'dispatch');
    p.setParams((params) => (params.silicone.t = 3.5));
    await until(() => logged(p, 'solid', 'dispatch') > before);
    p.setParams((params) => (params.silicone.t = 3.6));
    await p.idle();
    expect(logged(p, 'solid', 'terminated')).toBe(1);
    expect(p.log.some((e) => e.gate === 'solid' && e.event === 'respawned' && e.detail === 'terminated')).toBe(true);
    expect(p.status()).toMatchObject({ stale: false, error: null });
    expect(p.geometryHash().all).toBe(await fresh(p));
  }, 120_000);

  it('a crash is retried once at twice the cell, a crash at that cell gives a clean inline error, and the next change builds again at it', async () => {
    const p = pipeline();
    load(p, 'jersey');
    await p.idle();
    p.armFault('solid', { kind: 'oob' });
    p.setParams((params) => (params.silicone.t = 3.5));
    await p.idle();
    expect(logged(p, 'solid', 'crashed')).toBe(1);
    expect(p.status()).toMatchObject({ stale: false, error: null });
    expect(p.diagnostics.map((d) => d.code)).toContain('preview-coarser');
    expect(p.field!.value.cell).toBe(1);

    // The cell is doubled already, so this crash is not retried and the cell does not grow again.
    p.armFault('solid', { kind: 'oob' });
    p.setParams((params) => (params.silicone.t = 3.6));
    await p.idle();
    expect(logged(p, 'solid', 'crashed')).toBe(2);
    expect(p.status().error).toMatch(/coarser cell/);
    expect(p.cellScale()).toBe(CRASH_SCALE);

    p.setParams((params) => (params.silicone.t = 3.7));
    await p.idle();
    expect(p.status()).toMatchObject({ stale: false, error: null });
    expect(p.field!.value.cell).toBe(1);
    expect(p.geometryHash().all).toBe(await fresh(p));
  }, 120_000);

  it('a preview cell of 0 is the user\'s input and no crash: an inline error, no coarser cell, and back to normal once undone', async () => {
    const p = pipeline();
    load(p, 'jersey');
    await p.idle();
    const cell = p.field!.value.cell;
    p.setParams((params) => (params.quality.cellPreview = 0));
    await p.idle();
    expect(p.status().error).toMatch(/preview cell of 0 mm/);
    expect(logged(p, 'field', 'crashed')).toBe(0);
    expect(p.cellScale()).toBe(1);
    p.setParams((params) => (params.quality.cellPreview = null));
    await p.idle();
    expect(p.status()).toMatchObject({ stale: false, error: null });
    expect(p.field!.value.cell).toBe(cell);
    expect(p.diagnostics.map((d) => d.code)).not.toContain('preview-coarser');
  }, 120_000);

  it('a result past the heap limit recycles solid.worker between jobs, and the next job builds on the fresh one', async () => {
    const p = pipeline();
    load(p, 'jersey');
    await p.idle();
    p.budgets.freeze({ recycleBytes: 1 });
    p.setParams((params) => (params.silicone.t = 3.5));
    await p.idle();
    p.budgets.freeze({ recycleBytes: 1.5e9 });
    const solid = p.log.filter((e) => e.gate === 'solid');
    const recycled = solid.findIndex((e) => e.event === 'respawned' && e.detail === 'recycled');
    expect(recycled).toBeGreaterThan(0);
    expect(solid[recycled - 1].event).toBe('result');
    const [opening] = p.placement!.value.placement.openings;
    p.dropOpening(opening.id, opening.x + 0.5, opening.y);
    await p.idle();
    expect(p.log.filter((e) => e.gate === 'solid').slice(recycled).some((e) => e.event === 'dispatch')).toBe(true);
    expect(p.status()).toMatchObject({ stale: false, error: null });
    expect(p.geometryHash().all).toBe(await fresh(p));
  }, 120_000);

  it.each([
    // Wound inside out, which the import flips by its signed volume. On the welded mesh S2 finds no face to stand on.
    ['flipped', inverted(box([0, 0, 0], [30, 20, 12])), 'mesh-flipped', 1],
    // A side wall missing a triangle: S2 stands it on its base, and again in soup mode once the import gives up on a solid.
    ['open', withoutTriangles(box([0, 0, 0], [30, 20, 12]), [8]), 'soup-mode', 2],
  ] as const)('a mesh the import changes (%s): field.worker starts on the welded mesh, S2 goes again on the import\'s, and the end is a fresh build', async (_, mesh, code, oriented) => {
    const p = pipeline();
    p.load(asciiStl(toSoup(mesh)), 'changed by the import');
    await p.idle();
    expect(p.error).toBeNull();
    expect(p.diagnostics.map((d) => d.code)).toContain(code);
    expect(applied(p, 'oriented')).toHaveLength(oriented);
    // What shows is keyed by the import's mesh, not the welded one field.worker began with.
    const plain = stageKeys(p.params, { file: 'f1', import: PLAIN_IMPORT.key, plane: JSON.stringify(DEFAULT_PLANE), tier: 'preview', cellScale: 1, pins: [], removed: [], drag: null });
    expect(p.oriented!.key).not.toBe(plain.S2);
    expect(p.oriented!.key).toBe(p.keys().S2);
    expect(p.status()).toMatchObject({ stale: false, error: null });
    expect(p.cover!.value.indices.length).toBeGreaterThan(100);
    expect(p.geometryHash().all).toBe(await fresh(p));
  }, 60_000);
});

describe('the cell on a machine whose budgets adapt', () => {
  it('with fast T1 samples, a crash on every attempt gives exactly 2 crashes and then the inline error, and the cell stays doubled', async () => {
    const p = livePipeline();
    // Every sample counts as fast, as on a quick machine.
    p.budgets.settings.t1TargetMs = 1e6;
    load(p, 'jersey');
    await p.idle();
    for (const t of [3.1, 3.2, 3.3, 3.4, 3.5, 3.6]) {
      p.setParams((params) => (params.silicone.t = t));
      await p.idle();
    }
    expect(p.budgets.snapshot().medians.t1).not.toBeNull();
    for (let k = 0; k < 8; k++) p.armFault('solid', { kind: 'oob' });
    p.setParams((params) => (params.silicone.t = 3.7));
    await p.idle();
    expect(logged(p, 'solid', 'crashed')).toBe(2);
    expect(p.status().error).toMatch(/coarser cell/);
    expect(p.cellScale()).toBe(CRASH_SCALE);
    expect(p.field!.value.cell).toBe(1);
    // The next change tries once more at the doubled cell, and stops there.
    p.setParams((params) => (params.silicone.t = 3.8));
    await p.idle();
    expect(logged(p, 'solid', 'crashed')).toBe(3);
    expect(p.status().error).toMatch(/coarser cell/);
    expect(p.cellScale()).toBe(CRASH_SCALE);
    expect(p.diagnostics.find((d) => d.code === 'preview-coarser')!.message).toContain(`${CRASH_SCALE} times`);
  }, 120_000);

  it('with slow T1 samples, the cell grows one step per window of samples at the cell in use, each step its own revision', async () => {
    const p = livePipeline();
    // Every sample counts as slow.
    p.budgets.settings.t1TargetMs = 1e-6;
    load(p, 'jersey');
    await p.idle();
    const change = async (t: number): Promise<void> => {
      p.setParams((params) => (params.silicone.t = t));
      await p.idle();
    };
    // The load gave the first sample, so three changes give four, and the fourth change the fifth.
    for (const t of [3.1, 3.2, 3.3]) {
      await change(t);
      expect(p.cellScale()).toBe(1);
    }
    await change(3.4);
    expect(p.cellScale()).toBe(1.5);
    expect(p.field!.value.cell).toBe(0.75);
    // The step asked for the field at 1.5 at once, which is its first sample there.
    for (const t of [3.5, 3.6, 3.7]) {
      await change(t);
      expect(p.cellScale()).toBe(1.5);
    }
    await change(3.8);
    expect(p.cellScale()).toBe(2);
    expect(p.field!.value.cell).toBe(1);
    for (const t of [3.9, 4, 4.1, 4.2, 4.3]) await change(t);
    expect(p.cellScale()).toBe(2);
    expect(p.status()).toMatchObject({ stale: false, error: null });
    expect(p.geometryHash().all).toBe(await fresh(p));
  }, 120_000);
});

describe('the preview against a build through core alone', () => {
  it('jersey: field, openings and cover are what the core builders make at the preview cell and the preview tolerance', async () => {
    const p = pipeline();
    load(p, 'jersey');
    await p.idle();
    const params = defaultParams();
    const { mesh, bounds } = orientedExample('jersey');
    const settings = fieldSettings(params, bounds, previewCell(params, bounds));
    const plan = planField(bounds, settings);
    const { field } = buildField(mesh, plan, settings);
    expect(hashFloats(p.field!.value.field.values)).toBe(hashFloats(field.values));
    // The box always comes from the export plan's bounds.
    const mold = moldBounds(mesh, bounds, fieldSettings(params, bounds));
    const rim = deriveRim(mold, params);
    const space = placementSpace(field, rim, mold.offsets, openingSizes(params));
    const opening = placementSettings(params, bounds);
    const placement = placeOpenings({ bodies: findBodies(mesh, plan, field, settings, opening).bodies, tile: field, space, settings: opening });
    const copies = replicateOpenings(placement.openings, space);
    expect(copies.length).toBeGreaterThan(0);
    expect(p.geometryHash().openings).toBe(hashString(JSON.stringify(copies)));
    const cover = withArena(api, (arena) => {
      const tool = toolSolid(arena, buildToolMesh(field, { raise: params.quality.tinTolPreview, tol: params.quality.tinTolPreview, clip: rim.D }));
      const final = buildCoverFinal(arena, buildCoverBody(arena, rim, tool), rim, copies).getMesh();
      return hashMesh(final.vertProperties, final.triVerts);
    });
    expect(p.geometryHash().cover).toBe(cover);
  }, 60_000);

  it('a drag step shows the cover cut once with the dragged opening where it is now', async () => {
    const p = pipeline();
    load(p, 'jersey');
    await p.idle();
    const shown = p.placement!.value;
    const pour = shown.placement.openings.find((o) => o.kind === 'pour')!;
    const at = { kind: pour.kind, x: pour.x + 0.5, y: pour.y };
    p.dragOpening(pour.id, at.x, at.y);
    await p.idle();
    expect(p.cover!.value.provisional).toBe(true);
    const moved = replicateOpenings([at, ...shown.placement.openings.filter((o) => o.id !== pour.id)], shown.space);
    const { field, rim } = p.field!.value;
    withArena(api, (arena) => {
      const tool = toolSolid(arena, buildToolMesh(field, { raise: 0.1, tol: 0.1, clip: rim.D }));
      const once = buildCoverFinal(arena, buildCoverBody(arena, rim, tool), rim, moved);
      const { positions, indices } = p.cover!.value;
      const drawn = arena.manifold(new api.Mesh({ numProp: 3, vertProperties: positions, triVerts: indices }));
      const volume = once.volume();
      expect(Math.abs(drawn.volume() - volume) / volume).toBeLessThan(1e-6);
      // Where the material is, not only how much: a bore left at the old spot has the same volume.
      const apart = arena.track(drawn.subtract(once)).volume() + arena.track(once.subtract(drawn)).volume();
      expect(apart / volume).toBeLessThan(1e-6);
    });
  }, 60_000);
});

describe('what a coarse preview may say', () => {
  it('VIS-35 2 x 1: the preview does not pass on its own field\'s wall check (G6), and the export, on the export field, warns of the thin wall at spacing 10', async () => {
    const p = pipeline();
    p.setParams((params) => {
      params.grid.nx = 2;
      params.grid.spacing = 9;
    });
    load(p, 'vis35');
    await p.idle();
    const { mesh, bounds } = orientedExample('vis35');
    // At spacing 9 the preview's own field does report the merge. G6 keeps it off the screen.
    const coarse = fieldSettings(structuredClone(p.params), bounds, p.field!.value.cell);
    expect(buildField(mesh, planField(bounds, coarse), coarse).diagnostics.map((d) => d.code)).toContain('tiles-merged');
    expect(p.diagnostics.map((d) => d.code)).not.toContain('tiles-merged');

    p.setParams((params) => (params.grid.spacing = 10));
    await p.idle();
    expect(p.diagnostics.map((d) => d.code)).not.toContain('thin-tile-wall');
    // The copies stand on the export plan's pitch, never the preview field's own.
    const settings = fieldSettings(structuredClone(p.params), bounds);
    const copies = p.placement!.value.copies;
    expect(copies[1].x - copies[0].x).toBeCloseTo(exportPlan(bounds, settings).pitchXmm, 9);
    // The warning reaches the user from the export, which reads the export field, as M2 checked. The
    // preview's field at its coarser cell does not see this wall at all.
    expect(buildField(mesh, planField(bounds, { ...coarse, spacing: 10 }), { ...coarse, spacing: 10 }).diagnostics.map((d) => d.code)).not.toContain('thin-tile-wall');
    const exported = await p.exportParts();
    expect(exported.diagnostics.map((d) => d.code)).toContain('thin-tile-wall');
  }, 180_000);
});

describe('base confirmation', () => {
  it('VIS-35: the footprint\'s level report comes with the import, ahead of T2, and "Use upper level" clears it', async () => {
    const p = pipeline();
    load(p, 'vis35');
    await p.idle();
    // One job for the import and the footprint, one for the parts: the report costs no job of its own.
    expect(logged(p, 'solid', 'dispatch')).toBe(2);
    expect(p.footprint!.value.levels.useUpper!.gap).toBeCloseTo(0.405, 2);
    expect(p.diagnostics.map((d) => d.code)).toContain('upper-level');
    expect(p.oriented!.value.candidates[0].members).toEqual(p.oriented!.value.chosen.members);

    p.setPlane({ rank: 0, upper: p.footprint!.value.levels.useUpper!.offset });
    await p.idle();
    expect(p.oriented!.value.chosen.offset).toBeCloseTo(0.405, 2);
    expect(p.footprint!.value.levels.useUpper).toBeNull();
    expect(p.diagnostics.map((d) => d.code)).not.toContain('upper-level');
    expect(p.status().stale).toBe(false);
    expect(p.geometryHash().all).toBe(await fresh(p));
  }, 120_000);

  it('"Use upper level" stands on the level the warning offered, not the largest one: the barrel\'s +Z face', async () => {
    const p = pipeline();
    load(p, 'barrel');
    await p.idle();
    p.setPlane({ rank: 1, upper: false });
    await p.idle();
    expect(p.oriented!.value.chosen.normal).toEqual([0, 0, 1]);
    // Two levels: an enclosed recess at 0.2 mm, the larger by area, and the open one at 0.5 mm, which is offered.
    const { levels, useUpper } = p.footprint!.value.levels;
    const recess = levels.find((l) => Math.abs(l.offset - 0.2) < 0.01)!;
    expect(recess.exposedArea).toBe(0);
    expect(recess.enclosedArea).toBeGreaterThan(useUpper!.exposedArea + useUpper!.enclosedArea);
    expect(useUpper!.offset).toBeCloseTo(0.501, 3);
    expect(p.diagnostics.map((d) => d.code)).toContain('upper-level');

    p.setPlane({ rank: 1, upper: useUpper!.offset });
    await p.idle();
    expect(p.oriented!.value.chosen.offset).toBe(useUpper!.offset);
    // Nothing further is offered, so the warning is gone rather than left with no button to act on it.
    expect(p.footprint!.value.levels.useUpper).toBeNull();
    expect(p.diagnostics.map((d) => d.code)).not.toContain('upper-level');
    expect(p.diagnostics.map((d) => d.code)).toContain('below-plane');
  }, 120_000);

  it('the same plane chosen again is no change: pins, removed vents and the shown parts stay', async () => {
    const p = pipeline();
    load(p, 'jersey');
    await p.idle();
    const [pour] = p.placement!.value.placement.openings.filter((o) => o.kind === 'pour');
    const vent = p.placement!.value.placement.openings.find((o) => o.kind === 'vent')!;
    p.dropOpening(pour.id, pour.x + 1, pour.y);
    p.setRemoved([vent.id]);
    await p.idle();
    const before = { project: p.project(), hash: p.geometryHash().all, jobs: p.log.length };
    p.setPlane({ rank: 0, upper: false });
    await p.idle();
    expect(p.project()).toEqual(before.project);
    expect(p.geometryHash().all).toBe(before.hash);
    expect(p.log.length).toBe(before.jobs);
    // Another plane does place afresh.
    p.setPlane({ rank: 1, upper: false });
    await p.idle();
    expect(p.project().pins).toEqual([]);
    expect(p.project().removed).toEqual([]);
  }, 120_000);

  it('a named upper level that the tolerance no longer finds leaves the model on the plane, and says so', async () => {
    const p = pipeline();
    load(p, 'jersey');
    await p.idle();
    p.setPlane({ rank: 0, upper: 0.4 });
    await p.idle();
    expect(p.oriented!.value.chosen.offset).toBe(0);
    expect(p.diagnostics.map((d) => d.code)).toContain('upper-level-gone');
  }, 120_000);

  it('a vent the user removes stays out until it is restored, and the result is a fresh build', async () => {
    const p = pipeline();
    load(p, 'jersey');
    await p.idle();
    const vent = p.placement!.value.placement.openings.find((o) => o.kind === 'vent')!;
    p.setRemoved([vent.id]);
    await p.idle();
    expect(p.placement!.value.placement.openings.map((o) => o.id)).not.toContain(vent.id);
    expect(p.project().removed).toEqual([vent.id]);
    expect(p.geometryHash().all).toBe(await fresh(p));
    p.setRemoved([]);
    await p.idle();
    expect(p.placement!.value.placement.openings.map((o) => o.id)).toContain(vent.id);
  }, 120_000);
});

describe('the export field\'s wall check, once the preview settles (G6)', () => {
  function counted(): { spawn: () => WorkerLike; spawned: () => number; terminated: () => number } {
    let spawned = 0, terminated = 0;
    return {
      spawn: () => {
        spawned++;
        const worker = inProcessField();
        const end = worker.terminate.bind(worker);
        worker.terminate = () => {
          terminated++;
          end();
        };
        return worker;
      },
      spawned: () => spawned,
      terminated: () => terminated,
    };
  }

  function walled(field: ReturnType<typeof counted>): Pipeline {
    const p = new Pipeline({ spawnField: field.spawn, spawnSolid: inProcessSolid, frozen: true, checkWalls: true });
    pipelines.push(p);
    return p;
  }

  it('Goddess 2 x 1: spacing 10 merges and 11 is too thin, as M2 measured, each read in a field.worker of its own that a newer change ends', async () => {
    const field = counted();
    const p = walled(field);
    p.setParams((params) => {
      params.grid.nx = 2;
      params.grid.spacing = 10;
    });
    load(p, 'goddess');
    await p.idle();
    // idle() does not wait for it: it starts once everything else is done.
    expect(p.wallStatus()).toEqual({ running: true, result: null });
    expect(field.spawned()).toBe(2);
    await until(() => p.wallStatus().result !== null, 60_000);
    expect(field.terminated()).toBe(1);
    const merged = p.diagnostics.filter((d) => d.code === 'tiles-merged');
    expect(merged).toHaveLength(1);
    expect(merged[0].exportCell).toBe(true);
    expect(p.diagnostics.map((d) => d.code)).not.toContain('tile-walls');
    expect(p.wallStatus().result!.cell).toBe(0.125);
    // The preview's own diagnostics come as they did, unmarked.
    expect(p.diagnostics.filter((d) => d.code !== 'tiles-merged').every((d) => !d.exportCell)).toBe(true);

    // A change ends the check, whatever it was doing, and the old answer no longer shows.
    p.setParams((params) => (params.grid.spacing = 11));
    expect(p.wallStatus()).toEqual({ running: false, result: null });
    await p.idle();
    expect(field.spawned()).toBe(3);
    await until(() => p.wallStatus().result !== null, 60_000);
    expect(field.terminated()).toBe(2);
    expect(p.diagnostics.map((d) => d.code)).not.toContain('tiles-merged');
    expect(p.diagnostics.filter((d) => d.code === 'thin-tile-wall').map((d) => d.exportCell)).toEqual([true]);
  }, 180_000);

  it('VIS-35 2 x 1 at spacing 10: the thin wall the preview cannot see is reported before any export', async () => {
    const p = walled(counted());
    p.setParams((params) => {
      params.grid.nx = 2;
      params.grid.spacing = 10;
    });
    load(p, 'vis35');
    await p.idle();
    // As 'what a coarse preview may say' shows, the preview's own field sees no thin wall here.
    expect(p.diagnostics.map((d) => d.code)).not.toContain('thin-tile-wall');
    await until(() => p.wallStatus().result !== null, 60_000);
    expect(p.diagnostics.filter((d) => d.code === 'thin-tile-wall').map((d) => d.exportCell)).toEqual([true]);
    expect(p.wallStatus().result!.minWall).toBeLessThan(p.wallStatus().result!.requiredWall);
  }, 180_000);

  it('a change while it runs terminates its worker, and one tile has no check at all', async () => {
    const field = counted();
    const p = walled(field);
    p.setParams((params) => (params.grid.nx = 2));
    load(p, 'jersey');
    await p.idle();
    expect(p.wallStatus().running).toBe(true);
    p.setParams((params) => (params.grid.spacing = 30));
    // The in-process worker had not started on it, so this is the cancel and not the end of a job.
    expect(field.terminated()).toBe(1);
    await p.idle();
    await until(() => p.wallStatus().result !== null, 60_000);
    expect(p.wallStatus().result!.minWall).toBeGreaterThan(20);
    expect(p.diagnostics.map((d) => d.code)).not.toContain('thin-tile-wall');
    // A check that passed is listed as well, so the card shows the walls were looked at.
    expect(p.diagnostics.filter((d) => d.code === 'tile-walls').map((d) => d.exportCell)).toEqual([true]);

    p.setParams((params) => (params.grid.nx = 1));
    await p.idle();
    expect(p.wallStatus()).toEqual({ running: false, result: null });
    expect(field.spawned()).toBe(3);
  }, 180_000);
});

describe('T3', () => {
  /** Counts the workers spawned and terminated, around the real in-process solid worker or a stand-in. */
  function counting(make: () => WorkerLike): { spawn: () => WorkerLike; spawned: () => number; terminated: () => number } {
    let spawned = 0, terminated = 0;
    return {
      spawn: () => {
        spawned++;
        const worker = make();
        const end = worker.terminate.bind(worker);
        worker.terminate = () => {
          terminated++;
          end();
        };
        return worker;
      },
      spawned: () => spawned,
      terminated: () => terminated,
    };
  }

  it('runs in a worker of its own, spawned for the export and terminated once it answers, and a crash gets one retry at a coarser cell', async () => {
    const solid = counting(inProcessSolid);
    const p = pipeline(inProcessField, solid.spawn);
    load(p, 'jersey');
    await p.idle();
    expect([solid.spawned(), solid.terminated()]).toEqual([1, 0]);
    const outputs = await p.exportParts();
    expect(Object.keys(outputs.files).sort()).toEqual(['README.txt', 'base.stl', 'cover.stl', 'funnel.stl', 'model_oriented.stl', 'project.json', 'report.json']);
    expect([solid.spawned(), solid.terminated()]).toEqual([2, 1]);
    const retried = await p.exportParts(() => {}, { kind: 'oob' });
    expect([solid.spawned(), solid.terminated()]).toEqual([4, 3]);
    expect(retried.diagnostics.map((d) => d.code)).toContain('export-coarser');
    // The gate's own worker was never touched.
    expect(p.log.filter((e) => e.gate === 'solid' && e.event === 'respawned')).toEqual([]);
  }, 120_000);

  it('an error that is no crash, such as the export\'s own check, is shown as it is and not retried', async () => {
    const solid = counting(inProcessSolid);
    let exports = 0;
    const faulty = (): WorkerLike => {
      const worker = inProcessSolid();
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (message, transfer) => {
        if (message.t !== 'export') return post(message, transfer);
        exports++;
        setTimeout(() => worker.onmessage?.({ data: { t: 'error', id: message.id, name: 'Error', message: 'The export field reaches past the rim at 3 nodes.', inline: false, cached: {} } }), 0);
      };
      return worker;
    };
    const p = pipeline(inProcessField, () => (solid.spawned() === 0 ? solid.spawn() : counting(faulty).spawn()));
    load(p, 'jersey');
    await p.idle();
    await expect(p.exportParts()).rejects.toThrow(/past the rim/);
    expect(exports).toBe(1);
  }, 60_000);
});

describe('transfers', () => {
  /** A worker whose messages cross by structuredClone with their transfer lists, recording what went. */
  function recording(spawn: () => WorkerLike): { spawn: () => WorkerLike; sent: { message: ToWorker; transfer: Transferable[] }[] } {
    const sent: { message: ToWorker; transfer: Transferable[] }[] = [];
    return {
      sent,
      spawn: () => {
        const worker = spawn();
        const post = worker.postMessage.bind(worker);
        worker.postMessage = (message, transfer = []) => {
          post(message, transfer);
          sent.push({ message, transfer });
        };
        return worker;
      },
    };
  }

  it('main sends copies: what it sent is detached, and what it keeps for a respawn is whole', async () => {
    const field = recording(inProcessField);
    const solid = recording(inProcessSolid);
    const p = pipeline(field.spawn, solid.spawn);
    const bytes = exampleBytes('jersey');
    const length = bytes.byteLength;
    p.load(bytes, 'jersey');
    await p.idle();
    const first = field.sent[0];
    expect(first.transfer.length).toBeGreaterThan(0);
    expect(first.transfer.every((b) => (b as ArrayBuffer).byteLength === 0)).toBe(true);
    expect(bytes.byteLength).toBe(length);
    const toSolid = solid.sent.flatMap((s) => s.transfer as ArrayBuffer[]);
    expect(toSolid.length).toBeGreaterThan(0);
    expect(toSolid.every((b) => b.byteLength === 0)).toBe(true);
    expect(p.parsed!.value.welded.positions.length).toBeGreaterThan(0);
    expect(p.field!.value.field.values.length).toBeGreaterThan(0);
  }, 60_000);

  it('field.worker sends copies of what it caches: the sent buffer detaches, its own stays whole for the next job', () => {
    const replies: { sent: FromWorker; received: FromWorker; transfer: ArrayBuffer[] }[] = [];
    const handle = fieldHost((message, transfer = []) => {
      const received = structuredClone(message, { transfer: transfer as Transferable[] });
      replies.push({ sent: message, received, transfer: transfer as ArrayBuffer[] });
    }, () => 0);
    const params = defaultParams();
    const keys = stageKeys(params, { file: 'f', import: 'plain', plane: JSON.stringify(DEFAULT_PLANE), tier: 'preview', cellScale: 1, pins: [], removed: [], drag: null });
    const job = (file: ArrayBuffer | null): ToWorker => ({ t: 'field', id: 1, keys, want: ['S6', 'S7'], params, inputs: { file, import: PLAIN_IMPORT, plane: DEFAULT_PLANE, cellScale: 1, pins: [], removed: [] } });
    handle(job(exampleBytes('jersey').slice().buffer));
    // The second job has no file, so its field can only come from the cache the first one left.
    handle(job(null));
    const stages = replies.filter((r) => r.sent.t === 'stage');
    expect(stages).toHaveLength(2);
    for (const { sent, received, transfer } of stages) {
      const field = (sent as Extract<FromWorker, { t: 'stage' }>).outputs.S6!.field.values;
      expect(transfer).toContain(field.buffer);
      expect(field.buffer.byteLength).toBe(0);
      expect((received as Extract<FromWorker, { t: 'stage' }>).outputs.S6!.field.values.length).toBeGreaterThan(1000);
    }
    const [a, b] = stages.map((r) => hashFloats((r.received as Extract<FromWorker, { t: 'stage' }>).outputs.S6!.field.values));
    expect(b).toBe(a);
  });
});
