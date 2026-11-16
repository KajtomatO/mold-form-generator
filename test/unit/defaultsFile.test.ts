import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ConfigEnv } from 'vite';
import { checkDefaultsFile, DEFAULTS_FILE } from '../../vite.config';
import { checkDefaults, checkDefaultsText, givenTwice, jsonProblem } from '../../src/app/defaultsCheck';
import { defaultParams } from '../../src/core/params/defaults';
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
    const changed = fresh();
    for (const [group, defs] of GROUPS) {
      for (const [key, def] of Object.entries(defs)) {
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
      ['a list', [], ['The file must hold one object, with a group of settings for each of base, silicone, cover, joint, bolts, pour, vents, seat, funnel, grid, print, quality, reports, not a list.']],
      ['null', null, ['The file must hold one object, with a group of settings for each of base, silicone, cover, joint, bolts, pour, vents, seat, funnel, grid, print, quality, reports, not null.']],
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
    expect(checkDefaults([])).toEqual(['The file must hold one object, with a group of settings for each of base, silicone, cover, joint, bolts, pour, vents, seat, funnel, grid, print, quality, reports, not a list.']);
    // JSON has no comments and no comma after a group's last value, which a maker used to code may write.
    const comment = TEXT.replace('"thickness": 4,', '"thickness": 4, // was 3');
    expect(checkDefaultsText(comment)).toEqual([expect.stringMatching(/^The file is not valid JSON: .*\(line 4 column \d+\)\. JSON takes no comments, and no comma after a group's last value\.$/)]);
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
