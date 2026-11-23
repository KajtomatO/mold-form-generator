import { afterEach, describe, expect, it } from 'vitest';
import { applySwitch, planSwitch, typeOnOpen, unavailableNotice } from '../../src/app/moldSwitch';
import { changedPaths } from '../../src/app/stages';
import { disableMoldType, enableMoldType } from '../../src/core/mold/types';
import { defaultParams } from '../../src/core/params/defaults';

/**
 * MT: what switching the mold type does to the settings (src/app/moldSwitch.ts; docs/PLAN.md, MT; R44, D27): the
 * window lists every setting the user changed whose value differs from the new type's default, the user's rule.
 */

const rowsOf = (plan: ReturnType<typeof planSwitch>): string[] => plan.rows.map((row) => row.path);

afterEach(() => disableMoldType('clamshell'));

describe('MT: the switch between mold types', () => {
  it('the table of cases: not changed, changed and different, changed and equal to the new default, an automatic one set, one that does not apply, a locked one and the type', () => {
    const params = defaultParams();
    // Changed and different from the new default: a row.
    params.silicone.t = 4;
    // An automatic setting set to a number other than the new type's: a row.
    params.base.pocketDepth = 0.4;
    // Changed, and equal to the new default: the two-part cover's base layer of 0. No row, kept, now at its default.
    params.silicone.baseLayer = 0;
    // Locked in the new type, and not at the lock's value: a row, shown off with its reason and the value the type holds.
    params.grid.nx = 2;
    const plan = planSwitch(params, 'clamshell');
    expect(plan.from).toBe('one-piece');
    expect(plan.to).toBe('clamshell');
    expect(rowsOf(plan)).toEqual(['base.pocketDepth', 'silicone.t', 'grid.nx']);
    const t = plan.rows.find((row) => row.path === 'silicone.t')!;
    expect(t).toEqual({ path: 'silicone.t', yours: 4, newDefault: 3, oldDefault: 3, sameInBoth: true, locked: null, holds: undefined });
    expect(plan.rows.find((row) => row.path === 'grid.nx')).toMatchObject({ locked: 'This type makes one model.', holds: 1, sameInBoth: false });
    expect(plan.rows.find((row) => row.path === 'base.pocketDepth')).toMatchObject({ yours: 0.4, newDefault: null, oldDefault: null });
    // Transfer, all ticked: every value kept, the base layer at the new default it already holds.
    const kept = applySwitch(plan, rowsOf(plan) as never);
    expect(kept.mold.type).toBe('clamshell');
    expect([kept.silicone.t, kept.base.pocketDepth, kept.silicone.baseLayer, kept.grid.nx]).toEqual([4, 0.4, 0, 2]);
    expect(changedPaths(kept)).toEqual(['base.pocketDepth', 'silicone.t']);
    // The settings passed in are not touched.
    expect(params.mold.type).toBe('one-piece');
  });

  it('a setting not changed takes the new default, the two-part cover\'s base layer of 0, and back again; with nothing changed there is no row and no window', () => {
    const plan = planSwitch(defaultParams(), 'clamshell');
    expect(plan.rows).toEqual([]);
    const two = applySwitch(plan, []);
    expect(two).toEqual(defaultParams('clamshell'));
    expect(two.silicone.baseLayer).toBe(0);
    const back = planSwitch(two, 'one-piece');
    expect(back.rows).toEqual([]);
    expect(applySwitch(back, [])).toEqual(defaultParams());
  });

  it('an automatic setting at the old type\'s number is not changed, and automatic where the type has a number is', () => {
    // The two-part cover's base layer set back to automatic: changed there, and equal to the one-piece's default.
    const two = defaultParams('clamshell');
    two.silicone.baseLayer = null;
    expect(planSwitch(two, 'one-piece').rows).toEqual([]);
    expect(applySwitch(planSwitch(two, 'one-piece'), []).silicone.baseLayer).toBeNull();
    // Set to 2 mm there: a row, the one-piece's automatic its new default.
    two.silicone.baseLayer = 2;
    const plan = planSwitch(two, 'one-piece');
    expect(plan.rows).toEqual([{ path: 'silicone.baseLayer', yours: 2, newDefault: null, oldDefault: 0, sameInBoth: false, locked: null }]);
    expect(applySwitch(plan, ['silicone.baseLayer']).silicone.baseLayer).toBe(2);
    expect(applySwitch(plan, []).silicone.baseLayer).toBeNull();
  });

  it('a setting that does not apply keeps its value, hidden, and comes back on switching; mold.type is never a row', () => {
    const two = defaultParams('clamshell');
    two.clamshell.ceilingDeg = 30;
    two.clips.rows = 3;
    const plan = planSwitch(two, 'one-piece');
    expect(rowsOf(plan)).toEqual([]);
    const one = applySwitch(plan, []);
    expect([one.clamshell.ceilingDeg, one.clips.rows, one.mold.type]).toEqual([30, 3, 'one-piece']);
    // Back in the two-part cover they are rows: changed there, and different from its defaults.
    const again = planSwitch(one, 'clamshell');
    expect(rowsOf(again)).toEqual(['clamshell.ceilingDeg', 'clips.rows']);
    expect(rowsOf(again)).not.toContain('mold.type');
    expect(applySwitch(again, rowsOf(again) as never).clamshell.ceilingDeg).toBe(30);
  });

  it('Discard sets every row to the new default; Transfer with some ticked keeps those alone, with none ticked it is Discard', () => {
    const params = defaultParams();
    params.silicone.t = 4;
    params.cover.wall = 4;
    const plan = planSwitch(params, 'clamshell');
    expect(rowsOf(plan)).toEqual(['silicone.t', 'cover.wall']);
    const discard = applySwitch(plan, []);
    expect([discard.silicone.t, discard.cover.wall]).toEqual([3, 3]);
    const some = applySwitch(plan, ['cover.wall']);
    expect([some.silicone.t, some.cover.wall]).toEqual([3, 4]);
    expect(applySwitch(plan, [])).toEqual(discard);
    expect(discard.mold.type).toBe('clamshell');
  });

  it('a locked setting already at the lock\'s value is no row, and one that is not shows the value the type holds', () => {
    // Pry notches off under the one-piece: the two-part cover holds them off, so nothing the user sees changes.
    const params = defaultParams();
    params.joint.pryNotches = false;
    const plan = planSwitch(params, 'clamshell');
    expect(plan.rows).toEqual([]);
    expect(applySwitch(plan, []).joint.pryNotches).toBe(false);
    // Corner bolts on: the type holds them off, which the row gives as its new value; Transfer keeps the user's.
    params.bolts.enabled = true;
    const bolts = planSwitch(params, 'clamshell');
    expect(bolts.rows).toEqual([{ path: 'bolts.enabled', yours: true, newDefault: false, oldDefault: false, sameInBoth: false, locked: expect.stringContaining('corner bolts'), holds: false }]);
    expect(applySwitch(bolts, ['bolts.enabled']).bolts.enabled).toBe(true);
    expect(applySwitch(bolts, ['bolts.enabled']).joint.pryNotches).toBe(false);
  });

  it('a project opens as its type, or as the one-piece with a notice where the type is unavailable, every value kept', () => {
    const two = defaultParams('clamshell');
    two.clamshell.ceilingDeg = 35;
    const NONE = { bodies: null, triangles: null, simplified: false };
    const shut = typeOnOpen(two, NONE);
    expect(shut.unavailable).toEqual({ type: 'clamshell', reason: 'Not built yet' });
    expect(shut.params.mold.type).toBe('one-piece');
    expect(shut.params.clamshell.ceilingDeg).toBe(35);
    expect(shut.params.silicone.baseLayer).toBe(0);
    expect(unavailableNotice('Two-part cover', 'Not built yet', 'One-piece cover')).toBe('This project is a Two-part cover, which this version does not build yet. It opened as a One-piece cover, with every other setting as saved.');
    expect(unavailableNotice('Two-part cover', 'It makes one model, and this file holds 2', 'One-piece cover')).toBe('This project is a Two-part cover, which cannot be used for this model, because it makes one model, and this file holds 2. It opened as a One-piece cover, with every other setting as saved.');
    enableMoldType('clamshell');
    expect(typeOnOpen(two, NONE)).toEqual({ params: two, unavailable: null });
    expect(typeOnOpen(two, { ...NONE, bodies: 2 }).unavailable).toEqual({ type: 'clamshell', reason: 'It makes one model, and this file holds 2' });
    expect(typeOnOpen(defaultParams(), { ...NONE, bodies: 2 }).unavailable).toBeNull();
  });
});
