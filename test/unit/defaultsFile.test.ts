import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ConfigEnv } from 'vite';
import { checkDefaultsFile, DEFAULTS_FILE, overrideFiles } from '../../vite.config';
import { checkDefaults, checkDefaultsText, checkOverrides, checkOverridesText, givenTwice, jsonProblem } from '../../src/app/defaultsCheck';
import { defaultParams } from '../../src/core/params/defaults';
import { crossParameterErrors } from '../../src/core/params/rules';
import { MOLD_TYPE_IDS } from '../../src/core/mold/types';
import { PARAM_SCHEMA, type ParamDef } from '../../src/core/params/schema';

/**
 * CS: every setting's default in one JSON file, which the user asked for on 2026-11-16 so they could tune them
 * later (docs/REQUIREMENTS.md, section 2, D22), and the check that stops the build on a mistake in it.
 */

const root = join(import.meta.dirname, '..', '..');
const TEXT = readFileSync(join(root, DEFAULTS_FILE), 'utf8');
const fresh = (): Record<string, Record<string, unknown>> => JSON.parse(TEXT);
const GROUPS = Object.entries(PARAM_SCHEMA) as [string, Record<string, ParamDef>][];

describe('the defaults file', () => {
  it('holds every setting\'s default once, in the schema\'s order, and nothing else, and the check finds no problem in it', () => {
    expect(DEFAULTS_FILE).toBe('src/core/params/defaults.json');
    expect(checkDefaultsText(TEXT)).toEqual([]);
    // Every name the text gives, in its order: each group, then its settings, as PARAM_SCHEMA lists them.
    const names = [...TEXT.matchAll(/^\s*"(\w+)":/gm)].map((m) => m[1]);
    expect(names).toEqual(GROUPS.flatMap(([group, defs]) => [group, ...Object.keys(defs)]));
    expect(givenTwice(TEXT)).toEqual([]);
    // Its values are the schema's defaults, an automatic setting's null among them, and nothing more.
    const file = fresh();
    for (const [group, defs] of GROUPS) {
      expect(Object.keys(file[group]), group).toEqual(Object.keys(defs));
      for (const [key, def] of Object.entries(defs)) expect(file[group][key], `${group}.${key}`).toBe(def.kind === 'auto' ? null : def.default);
    }
    // So the params a new project starts with are the file, to the byte, in the order project.json writes them.
    expect(JSON.stringify(defaultParams())).toBe(JSON.stringify(file));
    expect(TEXT).toBe(`${JSON.stringify(file, null, 2)}\n`);
  });

  it('is where the schema takes every default from: a value changed in it changes that default, and no label, range or order', async () => {
    // Every value changed at once, so a row that writes its default itself, even one equal to the file's, is found:
    // a number one more, a flag turned over, another option, and for an automatic setting a number it never holds.
    // MT: but the type, as a page opens as the one-piece cover, which the check holds the file to (below).
    const changed = fresh();
    for (const [group, defs] of GROUPS) {
      for (const [key, def] of Object.entries(defs)) {
        if (group === 'mold') continue;
        changed[group][key] = def.kind === 'flag' ? !def.default : def.kind === 'choice' ? def.options.find((option) => option !== def.default) : def.kind === 'auto' ? 0.123 : def.default + 1;
      }
    }
    vi.resetModules();
    vi.doMock('../../src/core/params/defaults.json', () => ({ default: changed }));
    try {
      const schema = await import('../../src/core/params/schema');
      const defaults = await import('../../src/core/params/defaults');
      const read = schema.PARAM_SCHEMA as unknown as Record<string, Record<string, ParamDef>>;
      for (const [group, defs] of GROUPS) {
        for (const key of Object.keys(defs)) expect(read[group][key].default, `${group}.${key}`).toBe(changed[group][key]);
      }
      expect(schema.PARAM_SCHEMA.base.thickness).toEqual({ ...PARAM_SCHEMA.base.thickness, default: 5 });
      expect(JSON.stringify(defaults.defaultParams())).toBe(JSON.stringify(changed));
      // Labels, units and ranges stay in the schema's code.
      const strip = (s: typeof PARAM_SCHEMA): unknown => JSON.parse(JSON.stringify(s, (key, value) => (key === 'default' ? undefined : value)));
      expect(strip(schema.PARAM_SCHEMA)).toEqual(strip(PARAM_SCHEMA));
    } finally {
      vi.doUnmock('../../src/core/params/defaults.json');
      vi.resetModules();
    }
  });

  it('loads, as the build loads the check, with a group missing, misspelt or no object, so the check can say so', async () => {
    // The build loads the check's module, and with it the schema, which reads this same file: neither may stop on it.
    const cases: [string, unknown, string[]][] = [
      ['a misspelt group', (() => {
        const f = fresh();
        (f as Record<string, unknown>).silcone = f.silicone;
        delete (f as Record<string, unknown>).silicone;
        return f;
      })(), ['The group silicone is missing, with its 7 settings: Silicone thickness (silicone.t), Wall draft (silicone.wallDraftDeg), Close fins under (silicone.closeWidth), Base layer (silicone.baseLayer), Base layer slope (silicone.baseLayerSlopeDeg), Silicone density (silicone.density), Print margin (silicone.printMargin).', 'silcone is not a group of settings: did you mean silicone?']],
      ['a missing group', (() => {
        const f = fresh();
        delete (f as Record<string, unknown>).reports;
        return f;
      })(), ['The group reports is missing, with its 2 settings: Smallest reported volume (reports.minVolumeMl), Smallest air pocket depth (reports.undersidePersistence).']],
      ['a group that is null', { ...fresh(), grid: null }, ['grid must be an object of settings, not null.']],
      ['a list', [], ['The file must hold one object, with a group of settings for each of mold, base, silicone, cover, joint, bolts, pour, vents, seat, funnel, grid, print, quality, reports, clamshell, clips, not a list.']],
      ['null', null, ['The file must hold one object, with a group of settings for each of mold, base, silicone, cover, joint, bolts, pour, vents, seat, funnel, grid, print, quality, reports, clamshell, clips, not null.']],
    ];
    for (const [name, file, expected] of cases) {
      vi.resetModules();
      vi.doMock('../../src/core/params/defaults.json', () => ({ default: file }));
      try {
        const check = await import('../../src/app/defaultsCheck');
        expect(check.checkDefaults(file), name).toEqual(expected);
        expect(check.checkDefaultsText(JSON.stringify(file, null, 2)), name).toEqual(expected);
      } finally {
        vi.doUnmock('../../src/core/params/defaults.json');
        vi.resetModules();
      }
    }
  });
});

/** Each kind of mistake once, made on the real file, with every problem the check then says, in its order. */
const MISTAKES: [string, (file: Record<string, Record<string, unknown>>) => unknown, string[]][] = [
  ['a missing setting', (f) => delete f.base.thickness, ['Thickness (base.thickness) is missing: give it a number from 3 to 20 mm.']],
  ['a misspelt setting', (f) => {
    f.silicone.wallDraft = f.silicone.wallDraftDeg;
    delete f.silicone.wallDraftDeg;
  }, ['Wall draft (silicone.wallDraftDeg) is missing: give it a number from 0 to 5 deg.', 'silicone.wallDraft is not a setting: did you mean Wall draft (silicone.wallDraftDeg)?']],
  ['a setting in another group', (f) => {
    f.cover.taperDeg = f.joint.taperDeg;
    delete f.joint.taperDeg;
  }, ['cover.taperDeg is not a setting: did you mean Taper (joint.taperDeg)?', 'Taper (joint.taperDeg) is missing: give it a number from 5 to 30 deg.']],
  ['an unknown setting', (f) => (f.base.colour = 'red'), ['base.colour is not a setting of base, so take it out.']],
  ['an unknown group', (f) => (f.bolt = {}), ['bolt is not a group of settings: did you mean bolts?']],
  ['a missing group', (f) => delete f.reports, ['The group reports is missing, with its 2 settings: Smallest reported volume (reports.minVolumeMl), Smallest air pocket depth (reports.undersidePersistence).']],
  ['a group that is no object', (f) => ((f as Record<string, unknown>).grid = 4), ['grid must be an object of settings, not 4.']],
  ['a number of the wrong type', (f) => (f.base.thickness = '4'), ['Thickness (base.thickness) must be a number from 3 to 20 mm, not "4".']],
  ['a flag of the wrong type', (f) => (f.vents.enabled = 'yes'), ['Vents (vents.enabled) must be true or false, not "yes".']],
  ['a number outside its range', (f) => (f.base.thickness = 2), ['Thickness (base.thickness) is 2 mm, but must be from 3 to 20 mm.']],
  // The schema gives no floor, and the controls' own does: a cell of 0 asks for an endless lattice.
  ['a number under its control\'s floor', (f) => (f.quality.analysisCell = 0), ['Analysis cell (quality.analysisCell) is 0 mm, but must be at least 0.05 mm.']],
  ['a count that is not whole', (f) => (f.pour.perModel = 1.5), ['Pours per body (pour.perModel) is 1.5, but must be a whole number from 1 to 16.']],
  ['a choice that is none of its options', (f) => {
    f.base.mode = 'glued';
    f.bolts.size = 'M5';
  }, ['Mode (base.mode) must be "glue" or "merged", not "glued".', 'Bolt size (bolts.size) must be "M2.5", "M3" or "M4", not "M5".']],
  ['an automatic setting that is not null', (f) => (f.base.pocketDepth = 0.3), ['Pocket depth (base.pocketDepth) must be null, not 0.3: it is automatic (one layer), and null keeps it following that rule, which stays in the code.']],
  ['defaults that break a rule between settings', (f) => (f.seat.depth = 5), ['Seat depth (seat.depth) breaks a rule between settings: A seat 5 mm deep leaves under 1 mm of plastic in a top cap of 5 mm: use a seat of at most 4 mm, or a thicker cap.']],
  ['a funnel the rules refuse', (f) => (f.funnel.topDiameter = 12), ['Top diameter (funnel.topDiameter) breaks a rule between settings: A funnel top of 12 mm is under the 12.4 mm that a 10 mm pour and its walls need.']],
  // In the file the pocket stays null, so what to change is the layer it follows, not the pocket the app would ask for.
  ['a layer the pocket cannot follow', (f) => (f.print.layerHeight = 5), ['Layer height (print.layerHeight) is 5 mm, but must be from 0.05 to 2 mm, as the automatic Pocket depth (base.pocketDepth) follows it and takes only that range.']],
  // Infill is a fraction, which the box takes past 1, and the file does not.
  ['an infill in percent', (f) => (f.print.infill = 5), ['Infill (print.infill) is 5, but must be from 0 to 1: it is a fraction of solid, so 0.05 is 5 percent.']],
  // The rules read every value, so they wait until each is one its setting takes.
  ['a value and a rule broken at once', (f) => {
    f.base.thickness = 2;
    f.seat.depth = 5;
  }, ['Thickness (base.thickness) is 2 mm, but must be from 3 to 20 mm.']],
];

describe('the check of the defaults file', () => {
  it.each(MISTAKES)('names %s with the setting\'s label and path', (_, mistake, expected) => {
    const file = fresh();
    mistake(file);
    expect(checkDefaults(file)).toEqual(expected);
    expect(checkDefaultsText(JSON.stringify(file, null, 2))).toEqual(expected);
  });

  it('says when the file is no object, no JSON at all, or gives a setting twice', () => {
    expect(checkDefaults([])).toEqual(['The file must hold one object, with a group of settings for each of mold, base, silicone, cover, joint, bolts, pour, vents, seat, funnel, grid, print, quality, reports, clamshell, clips, not a list.']);
    // JSON has no comments and no comma after a group's last value, which a maker used to code may write.
    const comment = TEXT.replace('"thickness": 4,', '"thickness": 4, // was 3');
    expect(checkDefaultsText(comment)).toEqual([expect.stringMatching(/^The file is not valid JSON: .*\(line 7 column \d+\)\. JSON takes no comments, and no comma after a group's last value\.$/)]);
    const comma = TEXT.replace('"bedReliefRun": 0.3', '"bedReliefRun": 0.3,');
    expect(checkDefaultsText(comma)).toEqual([jsonProblem(comma)]);
    expect(jsonProblem(TEXT)).toBeNull();
    // JSON.parse keeps the last of the two without a word, so the maker who edits the first sees nothing change.
    const twice = TEXT.replace('"thickness": 4,', '"thickness": 4,\n    "thickness": 5,');
    expect(givenTwice(twice)).toEqual(['base.thickness']);
    expect(checkDefaultsText(twice)).toEqual(['Thickness (base.thickness) is given twice: give it once, as only the last would count.']);
    // The same name in two groups is no repeat.
    expect(givenTwice('{"cover": {"wall": 3}, "funnel": {"wall": 1.2, "note": "a \\"wall\\": here"}}')).toEqual([]);
    // A byte-order mark at the start, as an editor saving "UTF-8 with BOM" writes, is passed over, as Vite and Node do.
    expect(checkDefaultsText(`\uFEFF${TEXT}`)).toEqual([]);
    expect(checkDefaultsText(`\uFEFF${twice}`)).toEqual(checkDefaultsText(twice));
    expect(checkDefaultsText(`\uFEFF${comment}`)).toEqual(checkDefaultsText(comment));
  });

  describe('as the build runs it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-defaults-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    /** The plugin's own hook, on a copy of the file with this text, as Vite calls it while it reads the config. */
    const run = async (text: string, isPreview = false): Promise<void> => {
      const file = join(dir, `defaults-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(file, text);
      const hook = checkDefaultsFile(file).config as unknown as (config: object, env: ConfigEnv) => Promise<void>;
      await hook({}, { command: isPreview ? 'serve' : 'build', mode: 'production', isPreview });
    };

    it('stops before anything is built with every problem said, and goes on with the real file', async () => {
      await expect(run(TEXT)).resolves.toBeUndefined();
      const file = fresh();
      file.base.thickness = 2;
      file.pour.perModel = 1.5;
      const said = `${DEFAULTS_FILE} has 2 mistakes, so nothing was built:\n  - Thickness (base.thickness) is 2 mm, but must be from 3 to 20 mm.\n  - Pours per body (pour.perModel) is 1.5, but must be a whole number from 1 to 16.\nEach setting's range and options are in src/core/params/schema.ts; README.md, "Tuning the defaults", says more.`;
      await expect(run(JSON.stringify(file, null, 2))).rejects.toThrow(said);
      // Text that is no JSON is said in the check's own words, as the check's code could not load.
      const comment = TEXT.replace('"thickness": 4,', '"thickness": 4, // was 3');
      await expect(run(comment)).rejects.toThrow(`${DEFAULTS_FILE} has a mistake, so nothing was built:\n  - ${jsonProblem(comment)}\n`);
      // A preview serves a build already made, and checks nothing.
      await expect(run(comment, true)).resolves.toBeUndefined();
      // A byte-order mark is passed over here too.
      await expect(run(`\uFEFF${TEXT}`)).resolves.toBeUndefined();
    });

    it('says text that is no JSON itself, without loading the check, whose code reads the same file and would not load', async () => {
      // The build's runner, here one that fails as it would on the real file broken: with text that is no JSON
      // the hook never calls it and says the problem in the check's words; with good text it does call it.
      const runner = vi.fn(async () => {
        throw new Error('the runner could not load src/app/defaultsCheck.ts');
      });
      vi.resetModules();
      vi.doMock('vite', async (original) => ({ ...(await original<typeof import('vite')>()), runnerImport: runner }));
      try {
        const config = await import('../../vite.config');
        const hook = async (text: string): Promise<void> => {
          const file = join(dir, `defaults-${Math.random().toString(36).slice(2)}.json`);
          writeFileSync(file, text);
          await (config.checkDefaultsFile(file).config as unknown as (c: object, env: ConfigEnv) => Promise<void>)({}, { command: 'build', mode: 'production', isPreview: false });
        };
        const comment = TEXT.replace('"thickness": 4,', '"thickness": 4, // was 3');
        await expect(hook(comment)).rejects.toThrow(`${DEFAULTS_FILE} has a mistake, so nothing was built:\n  - ${jsonProblem(comment)}\n`);
        await expect(hook(TEXT.replace('"bedReliefRun": 0.3', '"bedReliefRun": 0.3,'))).rejects.toThrow('The file is not valid JSON: ');
        expect(runner).not.toHaveBeenCalled();
        await expect(hook(TEXT)).rejects.toThrow('the runner could not load src/app/defaultsCheck.ts');
        expect(runner).toHaveBeenCalledTimes(1);
      } finally {
        vi.doUnmock('vite');
        vi.resetModules();
      }
    });
  });
});

/**
 * MT: each mold type's defaults that differ, in src/core/params/defaults.<type>.json (docs/PLAN.md, MT and G13.14):
 * only what differs, checked by the build as defaults.json is.
 */
const OVERRIDES_TEXT = readFileSync(join(root, 'src', 'core', 'params', 'defaults.clamshell.json'), 'utf8');
const overrides = (): Record<string, Record<string, unknown>> => JSON.parse(OVERRIDES_TEXT);

describe('MT: the types\' defaults files', () => {
  it('are one per type but the one-piece cover, whose defaults are defaults.json, and the two-part cover\'s holds only its base layer of 0 and its flange width of 4, which the check passes', () => {
    expect(overrideFiles().map((path) => path.split('/').pop())).toEqual(MOLD_TYPE_IDS.filter((id) => id !== 'one-piece').map((id) => `defaults.${id}.json`));
    expect(overrides()).toEqual({ silicone: { baseLayer: 0 }, funnel: { flangeWidth: 4 } });
    expect(checkOverridesText('clamshell', OVERRIDES_TEXT)).toEqual([]);
    expect(OVERRIDES_TEXT).toBe(`${JSON.stringify(overrides(), null, 2)}\n`);
  });

  it('each merged set passes every setting\'s check and the rules between settings, under its type', () => {
    for (const id of MOLD_TYPE_IDS) {
      const merged = defaultParams(id);
      expect(merged.mold.type, id).toBe(id);
      expect(checkDefaults(merged, { overrides: true }), id).toEqual([]);
      expect(crossParameterErrors(merged), id).toEqual([]);
    }
  });

  it('a number on an automatic setting is taken in a type\'s file and a merged set, and still refused in defaults.json', () => {
    const merged = defaultParams('clamshell');
    expect(merged.silicone.baseLayer).toBe(0);
    expect(checkDefaults(merged, { overrides: true })).toEqual([]);
    const base = fresh();
    base.silicone.baseLayer = 0;
    expect(checkDefaults(base)).toEqual(['Base layer (silicone.baseLayer) must be null, not 0: it is automatic (the silicone thickness), and null keeps it following that rule, which stays in the code.']);
    // A merged set still holds a number to its range.
    const far = defaultParams('clamshell');
    far.silicone.baseLayer = 25;
    expect(checkDefaults(far, { overrides: true })).toEqual(['Base layer (silicone.baseLayer) is 25 mm, but must be from 0 to 20 mm.']);
  });

  it('defaults.json opens the page as the one-piece cover: another type there is refused', () => {
    const file = fresh();
    file.mold.type = 'clamshell';
    expect(checkDefaults(file)).toEqual(['Mold type (mold.type) must be "one-piece", not "clamshell": a page opens with that type, and each other type\'s defaults are in its own defaults.<type>.json.']);
    file.mold.type = 'box';
    expect(checkDefaults(file)).toEqual(['Mold type (mold.type) must be "one-piece" or "clamshell", not "box".']);
  });

  /** Each of the overrides' rules once, made on the real file, with what the check says; the real file is each one's negative control. */
  const OVERRIDE_MISTAKES: [string, (file: Record<string, Record<string, unknown>>) => void, string[]][] = [
    ['an unknown setting', (f) => (f.silicone.baseLayr = 0), ['silicone.baseLayr is not a setting: did you mean Base layer (silicone.baseLayer)?']],
    ['a setting of no group', (f) => (f.silicone.colour = 'red'), ['silicone.colour is not a setting of silicone, so take it out.']],
    ['an unknown group', (f) => (f.silicon = { t: 4 }), ['silicon is not a group of settings: did you mean silicone?']],
    ['a group that is no object', (f) => ((f as Record<string, unknown>).cover = 3), ['cover must be an object of settings, not 3.']],
    ['the type itself', (f) => (f.mold = { type: 'clamshell' }), ['Mold type (mold.type) is not a default a type can change, so take it out.']],
    ['an automatic setting given null', (f) => (f.silicone.baseLayer = null), ['Base layer (silicone.baseLayer) must be a number from 0 to 20 mm, not null: it is automatic in defaults.json, and a type gives it a number of its own.']],
    ['an automatic setting given text', (f) => (f.silicone.baseLayer = 'none'), ['Base layer (silicone.baseLayer) must be a number from 0 to 20 mm, not "none": it is automatic in defaults.json, and a type gives it a number of its own.']],
    ['an automatic setting out of its range', (f) => (f.silicone.baseLayer = 21), ['Base layer (silicone.baseLayer) is 21 mm, but must be from 0 to 20 mm.']],
    ['an automatic list setting off its list', (f) => (f.bolts = { length: 11 }), ['Bolt length (bolts.length) is 11 mm, but must be one of 6, 8, 10, 12, 16, 20, 25, 30, 35 or 40 mm.']],
    ['a value of the wrong kind', (f) => (f.cover = { wall: 'thick' }), ['Wall (cover.wall) must be a number at least 0.4 mm, not "thick".']],
    ['a value out of range', (f) => (f.cover = { topCap: 2 }), ['Top cap (cover.topCap) is 2 mm, but must be from 3 to 30 mm.']],
    ['a value equal to defaults.json\'s', (f) => (f.cover = { wall: 3 }), ['Wall (cover.wall) is 3 mm, as in defaults.json: a type\'s file holds only the defaults that differ, so take it out.']],
    ['a choice equal to defaults.json\'s', (f) => (f.clamshell = { fastener: 'bolts' }), ['Seam fasteners (clamshell.fastener) is "bolts", as in defaults.json: a type\'s file holds only the defaults that differ, so take it out.']],
    // The two-part cover's own rule, which holds only under its type: a seam land wider than the joint's.
    ['a merged set that breaks a rule of its type', (f) => (f.clamshell = { seamLand: 3 }), ['Seam land (clamshell.seamLand) breaks a rule between settings: A seam land of 3 mm is wider than the joint\'s inner land of 2 mm: use a seam land of at most 2 mm, or a wider inner land.', 'Top cap (cover.topCap) breaks a rule between settings: A top cap of 5 mm is under the 5.9 mm the seam needs: its land, the ridge, the groove\'s play on each side and 0.8 mm of plastic over them. Use a top cap of at least 5.9 mm, or a narrower seam land.']],
    ['a merged set that breaks a shared rule', (f) => (f.seat = { depth: 5 }), ['Seat depth (seat.depth) breaks a rule between settings: A seat 5 mm deep leaves under 1 mm of plastic in a top cap of 5 mm: use a seat of at most 4 mm, or a thicker cap.']],
  ];

  it.each(OVERRIDE_MISTAKES)('refuses %s, by the setting\'s label and path', (_, mistake, expected) => {
    const file = overrides();
    mistake(file);
    expect(checkOverrides('clamshell', file)).toEqual(expected);
    expect(checkOverridesText('clamshell', JSON.stringify(file, null, 2))).toEqual(expected);
  });

  it('refuses a file for no type, for the one-piece cover, no object, no JSON, or a setting given twice', () => {
    expect(checkOverrides('box', overrides())).toEqual(['There is no mold type "box": name the file after one of "clamshell", or take it out.']);
    expect(checkOverrides('one-piece', overrides())).toEqual(['The one-piece type\'s defaults are defaults.json itself, so take this file out.']);
    expect(checkOverrides('clamshell', [])).toEqual(['The file must hold one object, with a group for each setting whose default differs in this type, not a list.']);
    expect(checkOverridesText('clamshell', '{ "silicone": { "baseLayer": 0, } }')).toEqual([jsonProblem('{ "silicone": { "baseLayer": 0, } }')]);
    expect(checkOverridesText('clamshell', '{ "silicone": { "baseLayer": 0, "baseLayer": 1 } }')).toEqual(['silicone.baseLayer is given twice: give it once, as only the last would count.']);
    // Negative control: the same file once each is right, with a byte-order mark too.
    expect(checkOverridesText('clamshell', '\uFEFF{ "silicone": { "baseLayer": 1 } }')).toEqual([]);
  });

  it('the build stops on a type\'s file with its problems, once defaults.json is right, and goes on with the real one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-overrides-'));
    try {
      const base = join(dir, 'defaults.json');
      writeFileSync(base, TEXT);
      const bad = join(dir, 'defaults.clamshell.json');
      writeFileSync(bad, JSON.stringify({ silicone: { baseLayer: null } }));
      const hook = (files: string[]) => (checkDefaultsFile(base, files).config as unknown as (config: object, env: ConfigEnv) => Promise<void>)({}, { command: 'build', mode: 'production', isPreview: false });
      await expect(hook([bad])).rejects.toThrow('src/core/params/defaults.clamshell.json has a mistake, so nothing was built:\n  - Base layer (silicone.baseLayer) must be a number from 0 to 20 mm, not null: it is automatic in defaults.json, and a type gives it a number of its own.\n');
      await expect(hook(overrideFiles())).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
