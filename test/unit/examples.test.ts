import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import { allDiagnostics, exportBlocked, modelSize } from '../../src/app/derived';
import { Pipeline } from '../../src/app/pipeline';
import { parseStl } from '../../src/core/stl/parse';
import type { ExportReport } from '../../src/workers/exportJob';
import { inProcessField, inProcessSolid } from '../fixtures/inProcessWorker';
import { EXAMPLE_FILES, LOCAL_ONLY } from '../fixtures/loadExamples';
import { tableRows } from '../fixtures/requirementMap';
import { readPart } from '../fixtures/solidChecks';

const root = join(import.meta.dirname, '..', '..');
const FULL = process.env.CFG_FULL === '1';
// Before the changes to examples/ are staged, git's index still holds the files of before; this counts them as staged.
const UNSTAGED = process.env.CFG_UNSTAGED === '1';
const doc = (path: string): string => readFileSync(join(root, path), 'utf8');
// -z, before any paths, so names with spaces or other characters come back as they are.
const git = (command: string, ...args: string[]): string[] => execFileSync('git', [command, '-z', ...args], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);

/** Each licence a published example may carry, by its full name, with its deed: all allow sharing. */
const DEEDS: Record<string, string> = {
  'CC0 1.0 Universal': 'https://creativecommons.org/publicdomain/zero/1.0/',
  'Creative Commons Attribution 4.0 International': 'https://creativecommons.org/licenses/by/4.0/',
  'Creative Commons Attribution-ShareAlike 4.0 International': 'https://creativecommons.org/licenses/by-sa/4.0/',
  'Creative Commons Attribution-NonCommercial 4.0 International': 'https://creativecommons.org/licenses/by-nc/4.0/',
  'Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International': 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
  'Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International': 'https://creativecommons.org/licenses/by-nc-nd/4.0/',
};

/**
 * What is wrong with examples/SOURCES.md's table against the model files git tracks in examples/ (names
 * relative to it): a file with no row or a row with no file, and a row without its Printables page, its
 * author, a licence of the list with its own deed, or whether it was modified. NoDerivatives allows no change.
 */
function catalogueProblems(sources: string, tracked: string[]): string[] {
  const problems: string[] = [];
  const listed: string[] = [];
  for (const [file, model, author, licence, modified, ...extra] of tableRows(sources)) {
    const name = /^`([^`]+)`$/.exec(file ?? '')?.[1];
    if (!name || extra.length > 0) {
      problems.push(`A row is not | \`file\` | model | author | licence | modified |: ${file}`);
      continue;
    }
    if (listed.includes(name)) problems.push(`${name} has two rows.`);
    listed.push(name);
    // By its number alone: the full address ends in the title, which may carry names the repository must not (R37).
    if (!/^\[[^\]]+\]\(https:\/\/www\.printables\.com\/model\/\d+\)/.test(model ?? '')) problems.push(`${name}: the model's name does not link to its page on Printables by its number alone.`);
    if (!author) problems.push(`${name}: no author.`);
    const deed = /^\[([^\]]+)\]\((https:\/\/creativecommons\.org\/[^)]+)\)/.exec(licence ?? '');
    if (!deed || !(deed[1] in DEEDS)) problems.push(`${name}: the licence is not one of the list, by its full name with a link to its deed.`);
    else if (DEEDS[deed[1]] !== deed[2]) problems.push(`${name}: ${deed[1]} links to ${deed[2]}, not its deed ${DEEDS[deed[1]]}.`);
    if (!/^(No|Yes|Format only)\b/.test(modified ?? '')) problems.push(`${name}: whether it was modified is not said.`);
    else if (deed?.[1].includes('NoDerivatives') && !modified.startsWith('No')) problems.push(`${name}: NoDerivatives, so it may only be shared unmodified.`);
  }
  for (const name of tracked) if (!listed.includes(name)) problems.push(`examples/${name} is tracked by git but has no row in examples/SOURCES.md.`);
  for (const name of listed) if (!tracked.includes(name)) problems.push(`examples/SOURCES.md lists ${name}, which git does not track in examples/.`);
  return problems;
}

/** What git says of examples/: its index, the files outside it that .gitignore leaves, and the indexed ones .gitignore names. */
interface GitExamples {
  cached: string[];
  untracked: string[];
  ignoredCached: string[];
}

const gitExamples = (): GitExamples => ({
  cached: git('ls-files', '--cached', '--', 'examples'),
  untracked: git('ls-files', '--others', '--exclude-standard', '--', 'examples'),
  ignoredCached: git('ls-files', '--cached', '--ignored', '--exclude-standard', '--', 'examples'),
});

/**
 * The files git tracks in examples/, relative to it: its index, which is what the next commit holds, so a
 * model not yet added counts as unpublished, a file dropped in only to try the app is no concern of the
 * catalogue, and a local-only model still in the index counts as published. With `unstaged`
 * (CFG_UNSTAGED=1), for a tree whose changes are not staged yet, as R2's were not: what staging it as it
 * stands would leave there, the index and the new files, less those deleted and those .gitignore names,
 * which git rm --cached takes out.
 */
function trackedInExamples(g: GitExamples, unstaged: boolean, onDisk: (path: string) => boolean): string[] {
  const files = unstaged ? [...g.cached, ...g.untracked].filter((f) => onDisk(f) && !g.ignoredCached.includes(f)) : g.cached;
  return files.map((f) => f.slice('examples/'.length));
}

const trackedNow = (): string[] => trackedInExamples(gitExamples(), UNSTAGED, (f) => existsSync(join(root, f)));

/**
 * What is wrong with how the local-only models are kept out: each must be a line of .gitignore, out of git's
 * index and out of the table, and still named on the page, so a clone knows why some tests skip.
 */
function localOnlyProblems(tracked: string[], gitignore: string, sources: string): string[] {
  const problems: string[] = [];
  const lines = gitignore.split('\n');
  for (const id of LOCAL_ONLY) {
    const file = EXAMPLE_FILES[id];
    if (!lines.includes(`/examples/${file}`)) problems.push(`.gitignore has no line /examples/${file}.`);
    if (tracked.includes(file)) problems.push(`examples/${file} is tracked by git: take it out of the index with git rm --cached.`);
    if (sources.includes(`| \`${file}\` |`)) problems.push(`examples/SOURCES.md lists ${file} in its table.`);
    if (!sources.includes(`\`${file}\``)) problems.push(`examples/SOURCES.md does not name ${file}.`);
  }
  return problems;
}

const modelFiles = (tracked: string[]): string[] => tracked.filter((f) => f !== 'SOURCES.md');

/**
 * The names the user asked on 2026-11-11 to keep out of the repository (R37): the console maker's, and its
 * games' and characters'. Spelled backwards, so that this file, which the scan reads too, does not hold them.
 */
const BARRED = ['odnetnin', 'adlez', 'oiram', 'ktot', 'eluryh', 'modgnik eht fo sraet'].map((name) => [...name].reverse().join(''));

/** Any of these as a whole word in any case: no letter on either side, so underscores, digits and dots part words as spaces do. */
const anyOf = (words: string[]): RegExp => new RegExp(`(?<![a-z])(?:${words.join('|')})(?![a-z])`, 'i');
const IN_TEXT = anyOf(BARRED);
// In text "switch" is an ordinary word, barred only after the maker's name, which BARRED bars already; a file
// name is where the console stood, so there it is barred alone.
const IN_NAME = anyOf([...BARRED, 'switch']);

/** What the scan reads of a file: a binary STL's 80-byte header, which is text, a text file whole, and nothing of another binary. */
function scannedText(path: string, bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (/\.stl$/i.test(path) && bytes.length >= 84 && bytes.length === 84 + 50 * view.getUint32(80, true)) return new TextDecoder('latin1').decode(bytes.subarray(0, 80));
  return bytes.includes(0) ? '' : new TextDecoder().decode(bytes);
}

/** Where a barred name stands: `path (its name)` for a file's path, `path:line` in its text. */
function barredNames(files: { path: string; text: string }[]): string[] {
  const hits: string[] = [];
  for (const { path, text } of files) {
    if (IN_NAME.test(path)) hits.push(`${path} (its name)`);
    text.split('\n').forEach((line, k) => {
      if (IN_TEXT.test(line)) hits.push(`${path}:${k + 1}`);
    });
  }
  return hits;
}

describe('the example models and where they come from (R37)', () => {
  it('examples/SOURCES.md lists exactly the model files git tracks in examples/, each with its author, Printables page, licence and deed', () => {
    const tracked = trackedNow();
    expect(tracked, 'examples/SOURCES.md is not in git\'s index: git add it, or before staging run with CFG_UNSTAGED=1').toContain('SOURCES.md');
    expect(modelFiles(tracked).length).toBeGreaterThan(10);
    expect(catalogueProblems(doc('examples/SOURCES.md'), modelFiles(tracked))).toEqual([]);
  });

  it('the two local-only models are named in .gitignore, not tracked and not listed', () => {
    expect(localOnlyProblems(trackedNow(), doc('.gitignore'), doc('examples/SOURCES.md'))).toEqual([]);
    // git itself matches each, whether or not the file is here.
    for (const id of LOCAL_ONLY) expect(spawnSync('git', ['check-ignore', '-q', '--no-index', `examples/${EXAMPLE_FILES[id]}`], { cwd: root }).status, EXAMPLE_FILES[id]).toBe(0);
  });

  it('negative controls: git\'s index is what is tracked, and a local-only model in it, in the table, unnamed on the page or missing from .gitignore fails', () => {
    const [vis, barrel] = LOCAL_ONLY.map((id) => EXAMPLE_FILES[id]);
    const g: GitExamples = { cached: ['examples/a.stl', 'examples/gone.stl', `examples/${vis}`], untracked: ['examples/new.stl'], ignoredCached: [`examples/${vis}`] };
    const onDisk = (f: string): boolean => f !== 'examples/gone.stl';
    // A file on disk only is not tracked: a model not yet added fails the catalogue as a row with no file, and
    // a local-only model the index still holds is published.
    expect(trackedInExamples(g, false, onDisk)).toEqual(['a.stl', 'gone.stl', vis]);
    expect(catalogueProblems(['| File | Model | Author | Licence | Modified |', '|---|---|---|---|---|', '| `new.stl` | [A](https://www.printables.com/model/1) | Someone | [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) | No |'].join('\n'), ['a.stl'])).toEqual(['examples/a.stl is tracked by git but has no row in examples/SOURCES.md.', 'examples/SOURCES.md lists new.stl, which git does not track in examples/.']);
    // Before staging: the new file counts, and neither the deleted one nor the one .gitignore names.
    expect(trackedInExamples(g, true, onDisk)).toEqual(['a.stl', 'new.stl']);
    const gitignore = `/examples/${vis}\n/examples/${barrel}\n`;
    const sources = `\`${vis}\` and \`${barrel}\` have no known source.`;
    expect(localOnlyProblems(['a.stl'], gitignore, sources)).toEqual([]);
    expect(localOnlyProblems(trackedInExamples(g, false, onDisk), gitignore, sources)).toEqual([`examples/${vis} is tracked by git: take it out of the index with git rm --cached.`]);
    expect(localOnlyProblems([], `/examples/${vis}\n`, sources)).toEqual([`.gitignore has no line /examples/${barrel}.`]);
    expect(localOnlyProblems([], gitignore, `${sources}\n| \`${barrel}\` | x |`)).toEqual([`examples/SOURCES.md lists ${barrel} in its table.`]);
    expect(localOnlyProblems([], gitignore, `\`${vis}\``)).toEqual([`examples/SOURCES.md does not name ${barrel}.`]);
  });

  it('no file git tracks or would add, no file name, STL header or commit message names the console maker or its characters', () => {
    // What git add -A would publish: the index and every file .gitignore leaves, as they are on disk.
    const paths = git('ls-files', '--cached', '--others', '--exclude-standard').filter((f) => existsSync(join(root, f)));
    expect(paths.length).toBeGreaterThan(200);
    expect(paths).toContain('examples/SOURCES.md');
    const files = paths.map((path) => ({ path, text: scannedText(path, readFileSync(join(root, path))) }));
    const messages = execFileSync('git', ['log', '--format=%B'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    expect(messages.trim().length).toBeGreaterThan(0);
    expect(barredNames([...files, { path: 'git log', text: messages }])).toEqual([]);
  });

  it('negative controls: each barred name in a line, a file name, a binary STL\'s header or an ASCII STL fails in any case, and switch alone in text or a word holding a name does not', () => {
    const capital = (word: string): string => word[0].toUpperCase() + word.slice(1);
    for (const name of BARRED) {
      expect(barredNames([{ path: 'a.md', text: `one\nthe ${capital(name)}'s two` }]), name).toEqual(['a.md:2']);
      const file = `examples/${name.toUpperCase()}_v1.stl`;
      expect(barredNames([{ path: file, text: '' }]), name).toEqual([`${file} (its name)`]);
    }
    expect(barredNames([{ path: 'examples/Switch_stand_v1.stl', text: '' }])).toEqual(['examples/Switch_stand_v1.stl (its name)']);
    expect(barredNames([{ path: 'src/a.ts', text: 'switch (kind) {\n  // a switched-off toggle\n}' }])).toEqual([]);
    expect(barredNames([{ path: 'a.md', text: `a ${BARRED[2]}nette` }])).toEqual([]);
    // A binary STL: its header is read, in which a name fails, and the numbers past it are not.
    const stl = (header: string, past = ''): Uint8Array => {
      const bytes = new Uint8Array(84 + 50);
      new TextEncoder().encodeInto(header, bytes);
      new DataView(bytes.buffer).setUint32(80, 1, true);
      new TextEncoder().encodeInto(past, bytes.subarray(96));
      return bytes;
    };
    expect(barredNames([{ path: 'm.stl', text: scannedText('m.stl', stl(`${capital(BARRED[0])} stand`)) }])).toEqual(['m.stl:1']);
    expect(scannedText('m.stl', stl('', BARRED[0]))).toBe('\0'.repeat(80));
    expect(barredNames([{ path: 'a.stl', text: scannedText('a.stl', new TextEncoder().encode(`solid x\nendsolid ${BARRED[1]}\n`)) }])).toEqual(['a.stl:2']);
    // Another binary file is not read as text.
    expect(scannedText('a.png', new Uint8Array([0, 1, ...new TextEncoder().encode(BARRED[0])]))).toBe('');
  });

  it('README.md and docs/THIRD_PARTY.md point to examples/SOURCES.md, which says the models are not under the MIT licence', () => {
    expect(doc('README.md')).toContain('examples/SOURCES.md');
    expect(doc('docs/THIRD_PARTY.md')).toContain('examples/SOURCES.md');
    const sources = doc('examples/SOURCES.md');
    for (const phrase of ['not covered by Mold Form Generator\'s MIT licence', 'may not be used for commercial purposes', 'shared here unmodified', 'belong to their owners', 'have no known source']) expect(sources).toContain(phrase);
  });

  it('negative controls: a file with no row, a row with no file, two rows, no page, no author, an unknown licence, the wrong deed, nothing on changes and a changed NoDerivatives model each fail', () => {
    const row = (cells: Partial<Record<'file' | 'model' | 'author' | 'licence' | 'modified', string>> = {}): string => {
      const c = { file: '`a.stl`', model: '[A](https://www.printables.com/model/1)', author: 'Someone', licence: '[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) (public domain dedication)', modified: 'No', ...cells };
      return `| ${c.file} | ${c.model} | ${c.author} | ${c.licence} | ${c.modified} |`;
    };
    const table = (...rows: string[]): string => ['| File | Model | Author | Licence | Modified |', '|---|---|---|---|---|', ...rows].join('\n');
    const nd = '[Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International](https://creativecommons.org/licenses/by-nc-nd/4.0/)';
    expect(catalogueProblems(table(row()), ['a.stl'])).toEqual([]);
    expect(catalogueProblems(table(row({ licence: nd })), ['a.stl'])).toEqual([]);
    expect(catalogueProblems(table(row()), ['a.stl', 'b.stl'])).toEqual(['examples/b.stl is tracked by git but has no row in examples/SOURCES.md.']);
    expect(catalogueProblems(table(row(), row({ file: '`b.stl`' })), ['a.stl'])).toEqual(['examples/SOURCES.md lists b.stl, which git does not track in examples/.']);
    expect(catalogueProblems(table(row(), row()), ['a.stl'])).toEqual(['a.stl has two rows.']);
    const noPage = "a.stl: the model's name does not link to its page on Printables by its number alone.";
    expect(catalogueProblems(table(row({ model: 'A' })), ['a.stl'])).toEqual([noPage]);
    expect(catalogueProblems(table(row({ model: '[A](https://www.thingiverse.com/thing:1)' })), ['a.stl'])).toEqual([noPage]);
    // The full address, which ends in the model's title.
    expect(catalogueProblems(table(row({ model: '[A](https://www.printables.com/model/1-a-title)' })), ['a.stl'])).toEqual([noPage]);
    expect(catalogueProblems(table(row({ author: '' })), ['a.stl'])).toEqual(['a.stl: no author.']);
    expect(catalogueProblems(table(row({ licence: 'All rights reserved' })), ['a.stl'])).toEqual(['a.stl: the licence is not one of the list, by its full name with a link to its deed.']);
    expect(catalogueProblems(table(row({ licence: '[Standard Digital File License](https://www.printables.com/licenses)' })), ['a.stl'])).toEqual(['a.stl: the licence is not one of the list, by its full name with a link to its deed.']);
    expect(catalogueProblems(table(row({ licence: '[Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by-nc/4.0/)' })), ['a.stl'])).toEqual(['a.stl: Creative Commons Attribution 4.0 International links to https://creativecommons.org/licenses/by-nc/4.0/, not its deed https://creativecommons.org/licenses/by/4.0/.']);
    expect(catalogueProblems(table(row({ modified: '' })), ['a.stl'])).toEqual(['a.stl: whether it was modified is not said.']);
    expect(catalogueProblems(table(row({ licence: nd, modified: 'Yes, scaled' })), ['a.stl'])).toEqual(['a.stl: NoDerivatives, so it may only be shared unmodified.']);
  });
});

/**
 * The models R2 published beside the regression set. They have no goldens: each is held to going through
 * the app's own path in Node, at defaults with the base layer, and what it gives is recorded in docs/PLAN.md.
 */
const R2_MODELS = ['barricate_type_2_straight.stl', 'war-barricade.stl', 'N Scale Oil Barrel.stl', 'Damaged 40ft Shipping Container.stl', 'doomedmarine.stl', 'Factorio gear.stl', 'charge-and-play-stand.stl'];
/** The one of them whose mesh is open (a hole of 3.1 mm2, docs/PLAN.md), so it runs in soup mode with its clearance unmeasured. */
const OPEN_MESH = 'N Scale Oil Barrel.stl';

describe.runIf(FULL)('the models R2 added, through the app', () => {
  const rows: string[] = [];

  it('are the published models outside the regression set', () => {
    const regression = Object.values(EXAMPLE_FILES) as string[];
    expect(modelFiles(trackedNow()).filter((f) => !regression.includes(f)).sort()).toEqual([...R2_MODELS].sort());
  });

  it.each(R2_MODELS)('%s: parse, weld, import, base candidates, field, placement, reports and an export ZIP at defaults with the base layer, with no error', async (file) => {
    const bytes = new Uint8Array(readFileSync(join(root, 'examples', file)));
    const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true, reports: true });
    try {
      p.load(bytes, file);
      await p.idle();
      expect(p.status().error).toBeNull();
      expect(allDiagnostics(p).filter((d) => d.severity === 'error')).toEqual([]);
      expect(exportBlocked(p)).toBeNull();
      expect(p.reports, 'the Demold report').not.toBeNull();
      const started = performance.now();
      const outputs = await p.exportParts(() => {}, undefined, { want: 'zip', fitTest: false });
      const seconds = (performance.now() - started) / 1000;
      const files = unzipSync(outputs.zip);
      expect(Object.keys(files)).toEqual(expect.arrayContaining(['cover.stl', 'base.stl', 'funnel.stl', 'model_oriented.stl', 'README.txt', 'report.json', 'project.json']));
      for (const part of ['cover.stl', 'base.stl']) expect(readPart(files[part]).audit, part).toMatchObject({ openEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 });
      expect(parseStl(files['model_oriented.stl']).rawTriangleCount).toBe(p.parsed!.value.triangles);
      const report = JSON.parse(new TextDecoder().decode(files['report.json'])) as ExportReport;
      // The export finds errors of its own, which do not stop its ZIP: its own list, report.json's, which holds
      // main's and the reports' too, and the card's once the export is current must have none.
      expect(outputs.diagnostics.filter((d) => d.severity === 'error'), 'the export').toEqual([]);
      expect(report.diagnostics.filter((d) => d.severity === 'error'), 'report.json').toEqual([]);
      expect(allDiagnostics(p).filter((d) => d.severity === 'error'), 'after the export').toEqual([]);
      expect(report.reportsError).toBeNull();
      expect(report.reports, 'the reports in report.json').not.toBeNull();
      // At defaults the base layer follows t, so it is on.
      expect(p.params.silicone.baseLayer).toBeNull();
      expect(report.silicone.ml).toBeGreaterThan(0);
      const imported = p.imported!.value;
      // Every model but the open one is closed, so its clearance is measured, and at least t.
      expect(imported.clearanceVerified).toBe(file !== OPEN_MESH);
      expect(outputs.clearance === null).toBe(file === OPEN_MESH);
      if (file !== OPEN_MESH) expect(outputs.clearance!.measured).toBeGreaterThanOrEqual(p.params.silicone.t);
      if (file === 'Factorio gear.stl') {
        // Converted from the author's 3MF: closed and the right way out, one body of genus 1, with the 3MF's
        // triangles and volume, as docs/PLAN.md records.
        expect(p.parsed!.value.audit).toMatchObject({ triangleCount: 3592, openEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 });
        expect({ route: imported.route, flipped: imported.flipped, bodies: imported.bodies, shells: imported.shells.map((s) => [s.kind, s.genus]) }).toEqual({ route: 'manifold', flipped: false, bodies: 1, shells: [['solid', 1]] });
        expect(imported.solidVolume).toBeCloseTo(3346.4, 0);
      }
      const { chosen } = p.oriented!.value;
      const size = modelSize(p.oriented!.value.bounds).map((v) => v.toFixed(1)).join(' x ');
      const face = `${chosen.normal.map((v) => Math.round(v * 1000) / 1000).join(', ')}; ${chosen.area.toFixed(0)} mm2`;
      const clearance = outputs.clearance ? `${outputs.clearance.measured.toFixed(2)} mm` : 'not measured';
      rows.push(`| ${file} | ${p.parsed!.value.triangles} | ${size} | ${imported.bodies} | ${face} | ${report.silicone.ml.toFixed(2)} | ${clearance} | ${seconds.toFixed(1)} | ${p.reports!.value.demold.verdict} |`);
    } finally {
      p.dispose();
    }
  }, 600_000);

  afterAll(() => {
    console.log(['| File | Triangles | Size, mm | Bodies | Base face (normal; area) | Silicone, ml | Measured clearance | Export, s | Demold |', '|---|---|---|---|---|---|---|---|---|', ...rows].join('\n'));
  });
});
