import { afterEach, describe, expect, it } from 'vitest';
import { PARAM_PATHS } from '../../src/app/stages';
import { DEFAULT_MOLD_TYPE, disableMoldType, enableMoldType, MOLD_TYPE_IDS, MOLD_TYPE_LIST, MOLD_TYPES, NOT_BUILT_YET, type MoldType } from '../../src/core/mold/types';
import { MANIFOLD_TRIANGLE_LIMIT } from '../../src/core/mesh/simplify';
import { PARAM_SCHEMA } from '../../src/core/params/schema';
import { SECTION_PARAMS } from '../../src/ui/layout';
import { MOLD_TYPE_UI, moldTypeTiles } from '../../src/ui/mold/moldTypeUi';

/**
 * MT: the mold types' registry (src/core/mold/types.ts) and what the user reads of each (src/ui/mold/moldTypeUi.ts),
 * docs/PLAN.md, MT; R44. That the tiles render and wrap is e2e/moldType.spec.ts's, as Vitest runs in Node.
 */

const NONE = { bodies: null, triangles: null, simplified: false };

afterEach(() => disableMoldType('clamshell'));

describe('MT: the mold types', () => {
  it('have unique ids, the default among them, which the schema\'s mold.type takes, and the two registries agree', () => {
    expect(new Set(MOLD_TYPE_IDS).size).toBe(MOLD_TYPE_IDS.length);
    expect(MOLD_TYPE_IDS).toContain(DEFAULT_MOLD_TYPE);
    expect(PARAM_SCHEMA.mold.type.options).toEqual(MOLD_TYPE_IDS);
    expect(PARAM_SCHEMA.mold.type.default).toBe(DEFAULT_MOLD_TYPE);
    expect(Object.keys(MOLD_TYPES)).toEqual([...MOLD_TYPE_IDS]);
    expect(Object.keys(MOLD_TYPE_UI)).toEqual([...MOLD_TYPE_IDS]);
    expect(MOLD_TYPE_LIST.map((type) => type.id)).toEqual([...MOLD_TYPE_IDS]);
    for (const id of MOLD_TYPE_IDS) {
      expect(MOLD_TYPES[id].id, id).toBe(id);
      expect(MOLD_TYPE_UI[id].name, id).not.toBe('');
      expect(MOLD_TYPE_UI[id].blurb, id).not.toBe('');
    }
    expect(MOLD_TYPE_UI['one-piece'].name).toBe('One-piece cover');
    expect(MOLD_TYPE_UI.clamshell.name).toBe('Two-part cover');
    // The type is the switch's alone: in a section of its own, and no type's override or lock.
    expect(SECTION_PARAMS.moldType).toEqual(['mold.type']);
    for (const type of MOLD_TYPE_LIST) {
      expect(Object.keys(type.overrides), type.id).not.toContain('mold.type');
      expect(type.locked.map((lock) => lock.path), type.id).not.toContain('mold.type');
      for (const lock of type.locked) expect(PARAM_PATHS, lock.path).toContain(lock.path);
    }
  });

  it('the two-part cover locks one model, no corner bolts and no pry notches, each with its reason, and hides nothing; the one-piece hides the two-part cover\'s settings', () => {
    expect(MOLD_TYPES.clamshell.locked.map(({ path, value }) => [path, value])).toEqual([['grid.nx', 1], ['grid.ny', 1], ['bolts.enabled', false], ['joint.pryNotches', false]]);
    expect(MOLD_TYPES.clamshell.locked.find((lock) => lock.path === 'joint.pryNotches')!.reason).toBe('The halves slide off the base; pry at the seam\'s V pockets.');
    expect(MOLD_TYPES['one-piece'].locked).toEqual([]);
    expect(PARAM_PATHS.filter((path) => !MOLD_TYPES.clamshell.applies(path))).toEqual([]);
    expect(PARAM_PATHS.filter((path) => !MOLD_TYPES['one-piece'].applies(path))).toEqual(['clamshell.axis', 'clamshell.offset', 'clamshell.ceilingDeg', 'clamshell.seamLand', 'clamshell.pins', 'clamshell.fastener', 'clips.clearance', 'clips.rows']);
  });

  it('the two-part cover is "Not built yet" until MP5, or the test hook, lifts it; then not past G1.8\'s limit unless simplified, nor with more than one model', () => {
    const clamshell = MOLD_TYPES.clamshell;
    expect(clamshell.unavailable(NONE)).toBe(NOT_BUILT_YET);
    expect(MOLD_TYPES['one-piece'].unavailable({ bodies: 4, triangles: 3e6, simplified: false })).toBeNull();
    enableMoldType('clamshell');
    expect(clamshell.unavailable(NONE)).toBeNull();
    expect(clamshell.unavailable({ ...NONE, bodies: 1, triangles: MANIFOLD_TRIANGLE_LIMIT })).toBeNull();
    expect(clamshell.unavailable({ ...NONE, triangles: MANIFOLD_TRIANGLE_LIMIT + 1 })).toBe('Past 2,000,000 triangles it needs the model simplified when it is opened');
    expect(clamshell.unavailable({ ...NONE, triangles: MANIFOLD_TRIANGLE_LIMIT + 1, simplified: true })).toBeNull();
    expect(clamshell.unavailable({ ...NONE, bodies: 2 })).toBe('It makes one model, and this file holds 2');
    disableMoldType('clamshell');
    expect(clamshell.unavailable({ ...NONE, bodies: 2 })).toBe(NOT_BUILT_YET);
  });

  it('gives a tile per type in the layout data, in order with its words, and a third type gives a third tile with no other change', () => {
    const tiles = moldTypeTiles(MOLD_TYPE_LIST, MOLD_TYPE_UI, NONE);
    expect(tiles.map(({ id, name, unavailable }) => [id, name, unavailable])).toEqual([['one-piece', 'One-piece cover', null], ['clamshell', 'Two-part cover', NOT_BUILT_YET]]);
    const third: MoldType = { id: 'box', overrides: {}, locked: [], applies: () => true, unavailable: () => null };
    const ui = { ...MOLD_TYPE_UI, box: { name: 'Box', blurb: 'A test type.', icon: 'box', help: 'mold-type-box' } };
    const three = moldTypeTiles([...MOLD_TYPE_LIST, third], ui, NONE);
    expect(three.map((tile) => tile.id)).toEqual(['one-piece', 'clamshell', 'box']);
    expect(three[2]).toEqual({ id: 'box', name: 'Box', blurb: 'A test type.', icon: 'box', help: 'mold-type-box', unavailable: null });
    // Negative control: a type with no words is refused, as its tile would have no name.
    expect(() => moldTypeTiles([...MOLD_TYPE_LIST, third], MOLD_TYPE_UI, NONE)).toThrow('The mold type box has no name, blurb or pictogram in moldTypeUi.ts.');
  });
});
