import { afterEach, describe, expect, it } from 'vitest';
import { dragCheck, openingLabel } from '../../src/app/derived';
import { GROUP_MS, History, HISTORY_LIMIT } from '../../src/app/history';
import { Pipeline } from '../../src/app/pipeline';
import type { Project } from '../../src/app/project';
import { explodeDistance, explodeMax, sectionPlane, Store } from '../../src/app/store';
import { dropOpening } from '../../src/core/analysis/validate';
import { defaultParams } from '../../src/core/params/defaults';
import type { Rim } from '../../src/core/parts/rim';
import { DEFAULT_PLANE } from '../../src/workers/fieldStages';
import { inProcessField, inProcessSolid } from '../fixtures/inProcessWorker';
import { exampleBytes, EXAMPLE_FILES, skipWithout } from '../fixtures/loadExamples';

/** A project that differs from the defaults only in t, so steps can be told apart. */
function project(t: number): Project {
  const params = defaultParams();
  params.silicone.t = t;
  return { params, plane: DEFAULT_PLANE, pins: [], removed: [] };
}

const T = 'the change to Silicone thickness', T_GROUP = 'param:silicone.t';

describe('History', () => {
  it('groups changes to one control while each comes within 400 ms of the last, and no longer', () => {
    let now = 0;
    const history = new History(() => now);
    // A slider drag: 10 changes 50 ms apart, so 450 ms from first to last, is one step.
    for (let k = 0; k < 10; k++, now += 50) history.record(project(3 + k / 10), T, T_GROUP, project(3 + (k + 1) / 10));
    expect(history.depth).toEqual({ undo: 1, redo: 0 });
    // Two changes 500 ms apart are two steps.
    now += GROUP_MS + 100;
    history.record(project(4), T, T_GROUP, project(4.05));
    expect(history.depth.undo).toBe(2);
    // Another control within the time is a step of its own, and so is a change with no group.
    now += 10;
    history.record(project(4.1), 'the change to Wall', 'param:cover.wall', project(4.15));
    now += 10;
    history.record(project(4.2), 'moving Pour 1', null, project(4.25));
    now += 10;
    history.record(project(4.3), 'moving Pour 1', null, project(4.35));
    expect(history.depth.undo).toBe(5);
    // Undo of the first step goes back to where the slider drag started, not to one of its changes.
    for (let k = 0; k < 4; k++) history.undo(project(9));
    expect(history.undo(project(9))!.params.silicone.t).toBe(3);
    expect(history.undo(project(9))).toBeNull();
  });

  it('drops a grouped step that ends where it began, and the same drag going on starts afresh', () => {
    let now = 0;
    const history = new History(() => now);
    history.record(project(2), 'the change to Wall', 'param:cover.wall', project(2.5));
    now += 1000;
    // 3 to 3.5 and back to 3 in one drag: nothing changed, so nothing to undo but the step before.
    history.record(project(3), T, T_GROUP, project(3.25));
    now += 40;
    history.record(project(3.25), T, T_GROUP, project(3.5));
    now += 40;
    history.record(project(3.5), T, T_GROUP, project(3));
    expect(history.depth.undo).toBe(1);
    expect(history.undoLabel).toBe('the change to Wall');
    // On from there, within the time: a step of its own from 3, not part of the one under it.
    now += 40;
    history.record(project(3), T, T_GROUP, project(3.1));
    expect(history.depth.undo).toBe(2);
    expect(history.undo(project(3.1))!.params.silicone.t).toBe(3);
    expect(history.undo(project(3))!.params.silicone.t).toBe(2);
  });

  it('keeps a held slider\'s changes in one step however long it rests, and a new press starts a new one', () => {
    let now = 0;
    const history = new History(() => now);
    history.hold(T_GROUP);
    history.record(project(3), T, T_GROUP, project(3.5));
    // The pointer rests on the thumb for well past the grouping time, then moves on.
    now += 5 * GROUP_MS;
    history.record(project(3.5), T, T_GROUP, project(4));
    expect(history.depth.undo).toBe(1);
    history.hold(null);
    // Pressed again within the time: a second drag is a second step.
    now += 50;
    history.hold(T_GROUP);
    history.record(project(4), T, T_GROUP, project(4.5));
    history.hold(null);
    expect(history.depth.undo).toBe(2);
    expect(history.undo(project(4.5))!.params.silicone.t).toBe(4);
    expect(history.undo(project(4))!.params.silicone.t).toBe(3);
  });

  it('labels the next undo and redo, clears redo on a new change, and starts a new step after an undo', () => {
    let now = 0;
    const history = new History(() => now);
    expect([history.undoLabel, history.redoLabel]).toEqual([null, null]);
    history.record(project(3), T, T_GROUP, project(3.5));
    now += 10;
    history.record(project(3.5), 'the change to Wall', 'param:cover.wall', project(4));
    expect(history.undoLabel).toBe('the change to Wall');
    expect(history.undo(project(4))!.params.silicone.t).toBe(3.5);
    expect([history.undoLabel, history.redoLabel]).toEqual([T, 'the change to Wall']);
    expect(history.redo(project(3.5))!.params.silicone.t).toBe(4);
    expect(history.redoLabel).toBeNull();
    history.undo(project(4));
    // A change after an undo drops what redo held, and does not join the step under it, however soon it comes.
    now += 1;
    history.record(project(3.5), T, T_GROUP, project(3.6));
    expect(history.depth).toEqual({ undo: 2, redo: 0 });
    history.clear();
    expect(history.depth).toEqual({ undo: 0, redo: 0 });
  });

  it('keeps at most its limit of steps, dropping the oldest', () => {
    let now = 0;
    const history = new History(() => now);
    for (let k = 0; k < HISTORY_LIMIT + 5; k++, now += 1) history.record(project(k), `step ${k}`, null, project(k + 1));
    expect(history.depth.undo).toBe(HISTORY_LIMIT);
    let last: Project | null = null;
    for (let k = 0; k < HISTORY_LIMIT; k++) last = history.undo(project(0));
    expect(last!.params.silicone.t).toBe(5);
  });
});

describe('the section plane', () => {
  const box = { min: [-10, -5, -4] as [number, number, number], max: [30, 15, 20] as [number, number, number] };
  it('keeps the side away from the first view, or the other side flipped, and stays inside the box', () => {
    expect(sectionPlane({ on: true, axis: 'x', flip: false, at: null }, box)).toEqual({ normal: [-1, 0, 0], point: [10, 5, 8], at: 10 });
    expect(sectionPlane({ on: true, axis: 'y', flip: true, at: 12 }, box)).toEqual({ normal: [0, -1, 0], point: [10, 12, 8], at: 12 });
    expect(sectionPlane({ on: true, axis: 'z', flip: false, at: 99 }, box)).toEqual({ normal: [0, 0, -1], point: [10, 5, 20], at: 20 });
  });
});

describe('the exploded view', () => {
  // Only the box's height, from the base's underside to the top, matters here.
  const rim = (height: number): Rim => ({ O: { x0: 0, y0: 0, x1: 50, y1: 40 }, Zt: height - 4, Tb: 4 }) as unknown as Rim;
  it('starts at a quarter of the box, and keeps any distance on the slider of the box it is used on', () => {
    expect(explodeMax(rim(171.4))).toBe(258);
    expect(explodeDistance({ on: true, distance: null }, rim(171.4))).toBe(43);
    expect(explodeDistance({ on: true, distance: 12 }, rim(171.4))).toBe(12);
    // Set on wolf, used on jersey: held at the end of jersey's slider, as the slider's thumb is.
    expect(explodeDistance({ on: true, distance: 200 }, rim(33.1))).toBe(50);
    expect(explodeDistance({ on: true, distance: null }, rim(33.1))).toBe(8);
  });
});

describe('undo and redo on the store, with the real pipeline on jersey', () => {
  const stores: Store[] = [];
  afterEach(() => stores.splice(0).forEach((s) => s.pipeline.dispose()));

  async function loaded(id: 'jersey' | 'benchy' = 'jersey'): Promise<{ store: Store; tick: () => void; advance: (ms: number) => void }> {
    let now = 0;
    const store = new Store(new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true }), () => now);
    stores.push(store);
    store.load(exampleBytes(id), EXAMPLE_FILES[id]);
    await store.pipeline.idle();
    // Each change after a tick comes well after the last, so none of them group.
    return { store, tick: () => (now += 1000), advance: (ms) => (now += ms) };
  }

  it('20 edits undo to the loaded state and redo to the edited one, params and geometry hash alike', async () => {
    const { store, tick } = await loaded();
    const p = store.pipeline;
    const start = { project: JSON.stringify(p.project()), hash: p.geometryHash().all };
    const [pour] = p.placement!.value.placement.openings.filter((o) => o.kind === 'pour');
    const [vent] = p.placement!.value.placement.openings.filter((o) => o.kind === 'vent');
    const edits: (() => void)[] = [
      () => store.moveOpening(pour.id, pour.x - 1, pour.y),
      () => store.removeVent(vent.id),
      () => store.setParam('silicone.t', 3.5),
      () => store.setParam('silicone.wallDraftDeg', 2),
      () => store.setParam('cover.wall', 4),
      () => store.setParam('cover.topCap', 6),
      () => store.setParam('base.thickness', 5),
      // The pocket's edited flag is its value no longer being null.
      () => store.setParam('base.pocketDepth', 0.4),
      () => store.setParam('base.pocketEnlarge', 0.3),
      () => store.setParam('pour.diameter', 8),
      () => store.setParam('vents.diameter', 3),
      () => store.setParam('seat.depth', 2.5),
      () => store.setParam('funnel.topDiameter', 36),
      () => store.setParam('joint.taperDeg', 20),
      () => store.setParam('joint.ridgeHeight', 1.4),
      () => store.setParam('grid.nx', 2),
      () => store.setParam('grid.spacing', 12),
      () => store.restoreVents(),
      () => store.setParam('base.mode', 'merged'),
      () => store.setParam('silicone.t', 4),
    ];
    for (const edit of edits) {
      tick();
      edit();
    }
    expect(store.history.depth).toEqual({ undo: 20, redo: 0 });
    expect(store.history.undoLabel).toBe('the change to Silicone thickness');
    await p.idle();
    const end = { project: JSON.stringify(p.project()), hash: p.geometryHash().all };
    expect(end.hash).not.toBe(start.hash);
    expect(p.params.base.pocketDepth).toBe(0.4);

    for (let k = 0; k < 20; k++) store.undo();
    expect(JSON.stringify(p.project())).toBe(start.project);
    expect(p.params.base.pocketDepth).toBeNull();
    expect(store.history.depth).toEqual({ undo: 0, redo: 20 });
    await p.idle();
    expect(p.geometryHash().all).toBe(start.hash);

    for (let k = 0; k < 20; k++) store.redo();
    expect(JSON.stringify(p.project())).toBe(end.project);
    await p.idle();
    expect(p.geometryHash().all).toBe(end.hash);
  });

  it('a drag is one step, Esc records nothing, a change that ends where it began is no step, and a new file clears it all', async (ctx) => {
    skipWithout(ctx, 'barrel');
    const { store, tick, advance } = await loaded();
    const p = store.pipeline;
    const openings = p.placement!.value.placement.openings;
    const pour = openings.find((o) => o.kind === 'pour')!;
    expect(openingLabel(openings, pour.id)).toBe('Pour 1');
    // Away from the vent, a mm at a time, then dropped: one step, named after the opening.
    const away = Math.sign(pour.x - openings.find((o) => o.kind === 'vent')!.x) || 1;
    for (let k = 1; k <= 4; k++) store.dragOpening(pour.id, pour.x + (away * k) / 4, pour.y, { x: 0, y: 0 });
    expect(store.drag.value!.check).toMatchObject({ valid: true, problems: [], reason: null, lands: { x: pour.x + away, y: pour.y } });
    expect(p.dragging).toEqual({ id: pour.id, x: pour.x + away, y: pour.y });
    expect(store.history.depth.undo).toBe(0);
    store.dropDrag();
    expect(store.history.depth.undo).toBe(1);
    expect(store.history.undoLabel).toBe('moving Pour 1');
    expect(p.project().pins).toEqual([{ id: pour.id, kind: 'pour', x: pour.x + away, y: pour.y }]);
    await p.idle();

    // Onto the vent: invalid, for the land, and Esc puts it back with nothing recorded.
    const vent = p.placement!.value.placement.openings.find((o) => o.kind === 'vent')!;
    tick();
    store.dragOpening(pour.id, vent.x, vent.y, { x: 0, y: 0 });
    expect(store.drag.value!.check.valid).toBe(false);
    expect(store.drag.value!.check.problems).toContain('land');
    // FL: and its flange would rest on the vent, which the reason says too, as the flange reaches further.
    expect(store.drag.value!.check.reason).toBe("it is too close to another opening, and its funnel's flange would rest on a vent and close it");
    expect(dragCheck(p, pour.id, vent.x, vent.y)).toEqual(store.drag.value!.check);
    // Where the drop would go is the drop's own snap, worked out on each move so the view can show it.
    const lands = store.drag.value!.check.lands!;
    const others = p.placement!.value.placement.openings.filter((o) => o.id !== pour.id);
    expect(lands).toEqual((({ x, y }) => ({ x, y }))(dropOpening(p.placement!.value.space, { kind: 'pour', x: vent.x, y: vent.y }, others)));
    expect(Math.hypot(lands.x - vent.x, lands.y - vent.y)).toBeGreaterThan(0);
    // Undo is ignored while the drag goes on: the drop's step and its pin stay, and so does the drag.
    store.undo();
    store.redo();
    expect(store.history.depth).toEqual({ undo: 1, redo: 0 });
    expect(p.project().pins).toEqual([{ id: pour.id, kind: 'pour', x: pour.x + away, y: pour.y }]);
    expect(p.dragging).toEqual({ id: pour.id, x: vent.x, y: vent.y });
    store.cancelDrag();
    expect(p.dragging).toBeNull();
    expect(store.history.depth.undo).toBe(1);
    expect(p.project().pins[0].x).toBe(pour.x + away);

    // The same value again changes nothing, so it is no step.
    tick();
    store.setParam('silicone.t', 3);
    expect(store.history.depth.undo).toBe(1);
    // Nor is a slider drag that ends where it began, however far it went in between.
    tick();
    for (const t of [3.2, 3.5, 3.2, 3]) {
      advance(40);
      store.setParam('silicone.t', t);
    }
    expect(store.history.depth.undo).toBe(1);
    expect(store.history.undoLabel).toBe('moving Pour 1');

    // Undo never touches the way the mold is looked at.
    store.setSection({ on: true, axis: 'y', at: 2 });
    store.setExplode({ on: true, distance: 12 });
    store.undo();
    expect(p.project().pins).toEqual([]);
    expect(store.section.value).toEqual({ on: true, axis: 'y', flip: false, at: 2 });
    expect(store.explode.value).toEqual({ on: true, distance: 12 });
    expect(store.history.redoLabel).toBe('moving Pour 1');

    store.load(exampleBytes('barrel'), EXAMPLE_FILES.barrel);
    expect(store.history.depth).toEqual({ undo: 0, redo: 0 });
    // A distance set on one model's box starts again at a quarter of the next one's.
    expect(store.explode.value).toEqual({ on: true, distance: null });
    await p.idle();
  });

  it('FL: a vent dragged under the pour\'s flange is refused for the flange, in a maker\'s words, and the drop snaps it out clear of it', async () => {
    const { store } = await loaded();
    const p = store.pipeline;
    const openings = p.placement!.value.placement.openings;
    const pour = openings.find((o) => o.kind === 'pour')!, vent = openings.find((o) => o.kind === 'vent')!;
    // Half way between where the land would let it go and where the flange does: the seat 6.73, the mouth 1.55
    // and the land 1.5 against the flange 10.73, the mouth and its 0.5 mm gap, by hand.
    const seat = 5 + 3 * Math.tan(Math.PI / 6);
    const reach = seat + 4 + 1.55 + 0.5;
    const along = (seat + 1.55 + 1.5 + reach) / 2;
    const ux = (vent.x - pour.x) / Math.hypot(vent.x - pour.x, vent.y - pour.y), uy = (vent.y - pour.y) / Math.hypot(vent.x - pour.x, vent.y - pour.y);
    store.dragOpening(vent.id, pour.x + ux * along, pour.y + uy * along, { x: 0, y: 0 });
    const check = store.drag.value!.check;
    expect(check).toMatchObject({ valid: false, problems: ['flange'], reason: "a funnel's flange would rest on it and close it" });
    expect(Math.hypot(check.lands!.x - pour.x, check.lands!.y - pour.y)).toBeGreaterThanOrEqual(reach);
    store.dropDrag();
    await p.idle();
    const dropped = p.placement!.value.placement.openings.find((o) => o.id === vent.id)!;
    expect(dropped).toMatchObject({ pinned: true, valid: true, x: check.lands!.x, y: check.lands!.y });
    expect(store.lastMove.value!.result).toMatchObject({ snapped: true, valid: true, refused: ['flange'] });
    // Nearer, inside the land too, it is refused for both, and the reason names the flange's as well, the one to clear.
    store.dragOpening(vent.id, pour.x + ux * 8, pour.y + uy * 8, { x: 0, y: 0 });
    expect(store.drag.value!.check).toMatchObject({ valid: false, problems: ['land', 'flange'], reason: "it is too close to another opening, and a funnel's flange would rest on it and close it" });
    store.cancelDrag();
    // With no flange the same spot is fine, as the land alone allows it.
    store.cancelDrag();
    store.setParam('funnel.flangeWidth', 0);
    await p.idle();
    store.dragOpening(vent.id, pour.x + ux * along, pour.y + uy * along, { x: 0, y: 0 });
    expect(store.drag.value!.check).toMatchObject({ valid: true, problems: [], reason: null });
    store.cancelDrag();
  });

  it('a change of base plane undoes to the old plane with the pins and removed vents it had, and redoes to the new one without them', async () => {
    const { store, tick } = await loaded();
    const p = store.pipeline;
    const openings = p.placement!.value.placement.openings;
    const pour = openings.find((o) => o.kind === 'pour')!, vent = openings.find((o) => o.kind === 'vent')!;
    tick();
    store.moveOpening(pour.id, pour.x - 1, pour.y);
    tick();
    store.removeVent(vent.id);
    await p.idle();
    const before = { project: p.project(), hash: p.geometryHash().all };
    expect(before.project.pins).toHaveLength(1);
    expect(before.project.removed).toEqual([vent.id]);

    // Another plane places the openings afresh: no pins, no removed vents.
    tick();
    store.setPlane({ rank: 1, upper: false });
    expect(store.history.undoLabel).toBe('choosing another base face');
    expect(p.project().plane).toEqual({ rank: 1, upper: false });
    expect([p.project().pins, p.project().removed]).toEqual([[], []]);
    await p.idle();
    expect(p.error).toBeNull();
    const after = { project: JSON.stringify(p.project()), hash: p.geometryHash().all };
    expect(after.hash).not.toBe(before.hash);

    store.undo();
    expect(p.project()).toEqual(before.project);
    expect(p.project().plane).toEqual(DEFAULT_PLANE);
    await p.idle();
    expect(p.geometryHash().all).toBe(before.hash);
    expect(p.placement!.value.placement.openings.find((o) => o.id === pour.id)).toMatchObject({ x: pour.x - 1, y: pour.y, pinned: true });
    expect(p.placement!.value.placement.openings.some((o) => o.id === vent.id)).toBe(false);

    store.redo();
    expect(JSON.stringify(p.project())).toBe(after.project);
    await p.idle();
    expect(p.geometryHash().all).toBe(after.hash);
  });
});
