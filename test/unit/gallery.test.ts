import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Module from 'manifold-3d';
import { describe, expect, it } from 'vitest';
import { allDiagnostics, exportBlocked } from '../../src/app/derived';
import { LARGE_MODEL } from '../../src/app/largeModel';
import { Pipeline } from '../../src/app/pipeline';
import { meshBounds, weld } from '../../src/core/mesh/weld';
import { parseStl } from '../../src/core/stl/parse';
import { creditOf, creditText, DEFAULT_GALLERY_MODEL, entryFacts, GALLERY, GALLERY_LICENCES, galleryEntry, modelToOpen, sourceName, type GalleryEntry } from '../../src/gallery/catalogue';
import { THIRD_PARTY, WITH_THIRD_PARTY } from '../fixtures/galleryFixture';
import { inProcessField, inProcessSolid } from '../fixtures/inProcessWorker';
import { ANY_USE, DEEDS } from '../fixtures/licences';
import { GALLERY_DIR, loadGallery } from '../fixtures/loadGallery';
import { EXAMPLE_FILES, LOCAL_ONLY } from '../fixtures/loadExamples';
import { tableRows } from '../fixtures/requirementMap';

const root = join(import.meta.dirname, '..', '..');
const FULL = process.env.CFG_FULL === '1';
// Before public/gallery/ is staged, git's index does not hold it yet; this counts the files on disk as staged, as
// test/unit/examples.test.ts does.
const UNSTAGED = process.env.CFG_UNSTAGED === '1';
const git = (...args: string[]): string[] => execFileSync('git', [args[0], '-z', ...args.slice(1)], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const OWN_AUTHOR = 'Mold Form Generator';

/** The files git tracks in public/gallery/, relative to it, or with CFG_UNSTAGED=1 those `git add -A` would add too. */
function trackedGallery(): string[] {
  const files = [...git('ls-files', '--cached', '--', 'public/gallery'), ...(UNSTAGED ? git('ls-files', '--others', '--exclude-standard', '--', 'public/gallery') : [])];
  return [...new Set(files)].filter((f) => existsSync(join(root, f))).map((f) => f.slice('public/gallery/'.length));
}

/**
 * What is wrong with the gallery: its ids and files once each, its STLs and thumbnails those git tracks in
 * public/gallery/ and thumbs/, a row of SOURCES.md for each model and none for anything else, each row saying what
 * the catalogue says, and every licence one of DEEDS that allows any use, so neither NonCommercial nor NoDerivatives,
 * even unmodified. A model not ours needs its author, its pages and whether it was changed.
 */
function galleryProblems(list: readonly GalleryEntry[], sources: string, tracked: string[], licences: Record<string, { name: string; deed: string }> = GALLERY_LICENCES, deeds: Record<string, string> = DEEDS): string[] {
  const problems: string[] = [];
  const ids = list.map((e) => e.id), files = list.map((e) => e.file);
  for (const id of ids.filter((id, k) => ids.indexOf(id) !== k)) problems.push(`The id ${id} is in the catalogue twice.`);
  for (const file of files.filter((file, k) => files.indexOf(file) !== k)) problems.push(`${file} is in the catalogue twice.`);
  const models = tracked.filter((f) => f.endsWith('.stl'));
  const thumbs = tracked.filter((f) => f.startsWith('thumbs/')).map((f) => f.slice('thumbs/'.length));
  for (const file of models) if (!files.includes(file)) problems.push(`public/gallery/${file} is tracked by git but not in the catalogue.`);
  for (const entry of list) {
    if (!models.includes(entry.file)) problems.push(`${entry.id}: public/gallery/${entry.file} is not tracked by git.`);
    if (!thumbs.includes(entry.thumbnail)) problems.push(`${entry.id}: public/gallery/thumbs/${entry.thumbnail} is not tracked by git.`);
  }
  for (const thumb of thumbs) if (!list.some((e) => e.thumbnail === thumb)) problems.push(`public/gallery/thumbs/${thumb} is no model's thumbnail.`);
  const rows = new Map<string, string[]>();
  for (const [file, ...cells] of tableRows(sources)) {
    const name = /^`([^`]+)`$/.exec(file ?? '')?.[1];
    if (!name || cells.length !== 4) {
      problems.push(`A row is not | \`file\` | model | author | licence | modified |: ${file}`);
      continue;
    }
    if (rows.has(name)) problems.push(`${name} has two rows.`);
    rows.set(name, cells);
    if (!files.includes(name)) problems.push(`public/gallery/SOURCES.md lists ${name}, which is not in the catalogue.`);
  }
  for (const entry of list) {
    const row = rows.get(entry.file);
    const licence = Object.hasOwn(licences, entry.licence) ? licences[entry.licence] : undefined;
    if (!licence || !(licence.name in deeds) || deeds[licence.name] !== licence.deed) {
      problems.push(`${entry.id}: its licence is not one of the list with its own deed.`);
      continue;
    }
    if (!ANY_USE.includes(licence.name)) problems.push(`${entry.id}: ${licence.name} does not allow any use.`);
    if (!row) {
      problems.push(`${entry.id}: public/gallery/SOURCES.md has no row for ${entry.file}.`);
      continue;
    }
    const [model, author, rowLicence, modified] = row;
    if (rowLicence !== `[${licence.name}](${licence.deed})`) problems.push(`${entry.id}: SOURCES.md's licence is not ${licence.name} linked to its deed.`);
    if (!/^(No|Yes)\b/.test(modified)) problems.push(`${entry.id}: SOURCES.md does not say whether it was modified.`);
    if (entry.own) {
      if ((entry.licence as string) !== 'CC0-1.0') problems.push(`${entry.id}: the project's own models are CC0.`);
      if (author !== OWN_AUTHOR) problems.push(`${entry.id}: SOURCES.md does not name ${OWN_AUTHOR} as its author.`);
      continue;
    }
    if (!entry.author.trim()) problems.push(`${entry.id}: no author.`);
    if (!/^https:\/\//.test(entry.authorUrl)) problems.push(`${entry.id}: no author's page.`);
    if (!/^https:\/\//.test(entry.url)) problems.push(`${entry.id}: no model's page.`);
    if (!/^(No|Yes, .+)$/.test(entry.modified)) problems.push(`${entry.id}: whether it was modified is not recorded.`);
    if (model !== `[${entry.title}](${entry.url})`) problems.push(`${entry.id}: SOURCES.md's model is not its title linked to its page.`);
    if (author !== `[${entry.author}](${entry.authorUrl})`) problems.push(`${entry.id}: SOURCES.md's author is not linked to their page.`);
  }
  return problems;
}

const sources = (): string => readFileSync(join(GALLERY_DIR, 'SOURCES.md'), 'utf8');

describe('GA: the gallery catalogue (R47, R48, D29)', () => {
  it('its ids and files, the STLs and thumbnails git tracks in public/gallery/ and the rows of its SOURCES.md are one list', () => {
    const tracked = trackedGallery();
    expect(tracked, 'public/gallery/ is not in git\'s index: git add it, or before staging run with CFG_UNSTAGED=1').toContain('SOURCES.md');
    expect(galleryProblems(GALLERY, sources(), tracked)).toEqual([]);
    expect(GALLERY.map((e) => e.id)).toEqual(['sphere', 'cube', 'cylinder', 'cone']);
    // Every file in the folders is one of the list's, so nothing is published by chance.
    expect(readdirSync(GALLERY_DIR).sort()).toEqual([...GALLERY.map((e) => e.file), 'SOURCES.md', 'thumbs'].sort());
    expect(readdirSync(join(GALLERY_DIR, 'thumbs')).sort()).toEqual(GALLERY.map((e) => e.thumbnail).sort());
  });

  it('the fixture\'s model not ours passes with its author, pages, licence and whether it was changed', () => {
    const row = `| \`${THIRD_PARTY.file}\` | [${THIRD_PARTY.title}](${THIRD_PARTY.url}) | [${THIRD_PARTY.author}](${THIRD_PARTY.authorUrl}) | [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/) | No |`;
    const table = ['| File | Model | Author | Licence | Modified |', '|---|---|---|---|---|', row].join('\n');
    expect(galleryProblems([THIRD_PARTY], table, [THIRD_PARTY.file, `thumbs/${THIRD_PARTY.thumbnail}`])).toEqual([]);
    expect(creditOf(THIRD_PARTY)).toEqual({ id: 'fixture-block', title: 'Test Block', author: 'A. Tester', authorUrl: 'https://www.printables.com/@ATester_1', url: 'https://www.printables.com/model/1', licence: 'CC-BY-4.0' });
    expect(creditText(creditOf(THIRD_PARTY)!)).toBe('Test Block by A. Tester · Printables · CC BY 4.0');
    // Our own models need no credit.
    for (const entry of GALLERY) expect(creditOf(entry), entry.id).toBeNull();
  });

  it('negative controls: a file with no row, a row with no file, an NC licence and an ND one, even unmodified, each fail', () => {
    const own = GALLERY[1];
    const ownRow = (file: string): string => `| \`${file}\` | Cube | ${OWN_AUTHOR} | [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) | No |`;
    const table = (...rows: string[]): string => ['| File | Model | Author | Licence | Modified |', '|---|---|---|---|---|', ...rows].join('\n');
    const tracked = [own.file, `thumbs/${own.thumbnail}`];
    expect(galleryProblems([own], table(ownRow(own.file)), tracked)).toEqual([]);
    expect(galleryProblems([own], table(), tracked)).toEqual([`cube: public/gallery/SOURCES.md has no row for ${own.file}.`]);
    expect(galleryProblems([own], table(ownRow(own.file), ownRow('ghost.stl')), tracked)).toEqual(['public/gallery/SOURCES.md lists ghost.stl, which is not in the catalogue.']);
    expect(galleryProblems([own], table(ownRow(own.file)), [...tracked, 'stray.stl'])).toEqual(['public/gallery/stray.stl is tracked by git but not in the catalogue.']);
    expect(galleryProblems([own], table(ownRow(own.file)), [`thumbs/${own.thumbnail}`])).toEqual([`cube: public/gallery/${own.file} is not tracked by git.`]);
    // A licence that forbids commercial use or changes is not one the gallery takes, as the Goddess Statue's.
    const withLicence = (name: string): GalleryEntry => ({ ...THIRD_PARTY, licence: name as GalleryEntry['licence'] });
    const nc = 'Creative Commons Attribution-NonCommercial 4.0 International', nd = 'Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International';
    expect(ANY_USE).not.toContain(nc);
    expect(ANY_USE).not.toContain(nd);
    expect(galleryProblems([withLicence('CC-BY-NC-4.0')], table(), [])).toContain('fixture-block: its licence is not one of the list with its own deed.');
    expect(galleryProblems([withLicence('CC-BY-NC-ND-4.0')], table(), [])).toContain('fixture-block: its licence is not one of the list with its own deed.');
    // And had the list one with its deed, the check of ANY_USE would refuse it: unmodified does not make an ND
    // licence any use. CC BY-ND 4.0 is in no list of the app's, so this adds it, with its deed, for the test alone.
    const byNd = { name: 'Creative Commons Attribution-NoDerivatives 4.0 International', short: 'CC BY-ND 4.0', deed: 'https://creativecommons.org/licenses/by-nd/4.0/' };
    const ndRow = `| \`${THIRD_PARTY.file}\` | [${THIRD_PARTY.title}](${THIRD_PARTY.url}) | [${THIRD_PARTY.author}](${THIRD_PARTY.authorUrl}) | [${byNd.name}](${byNd.deed}) | No |`;
    const ndTracked = [THIRD_PARTY.file, `thumbs/${THIRD_PARTY.thumbnail}`];
    const unmodifiedNd: GalleryEntry = { ...THIRD_PARTY, licence: 'CC-BY-ND-4.0' as GalleryEntry['licence'], modified: 'No' };
    expect(galleryProblems([unmodifiedNd], table(ndRow), ndTracked, { ...GALLERY_LICENCES, 'CC-BY-ND-4.0': byNd }, { ...DEEDS, [byNd.name]: byNd.deed })).toEqual([`fixture-block: ${byNd.name} does not allow any use.`]);
    // And an NC licence given its deed the same way, as CC BY-NC 4.0 is in DEEDS already.
    const byNc = { name: nc, short: 'CC BY-NC 4.0', deed: DEEDS[nc] };
    const ncRow = ndRow.replace(`[${byNd.name}](${byNd.deed})`, `[${nc}](${byNc.deed})`);
    expect(galleryProblems([withLicence('CC-BY-NC-4.0')], table(ncRow), ndTracked, { ...GALLERY_LICENCES, 'CC-BY-NC-4.0': byNc })).toEqual([`fixture-block: ${nc} does not allow any use.`]);
    expect(Object.values(GALLERY_LICENCES).map((l) => l.name).every((name) => ANY_USE.includes(name))).toBe(true);
    // A model not ours without its author, pages or a word on changes.
    const bare: GalleryEntry = { ...THIRD_PARTY, author: ' ', authorUrl: 'printables', url: '', modified: '' };
    const row = `| \`cube.stl\` | Test Block | A. Tester | [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/) | |`;
    expect(galleryProblems([bare], table(row), ['cube.stl', 'thumbs/cube.webp'])).toEqual([
      'fixture-block: SOURCES.md does not say whether it was modified.',
      'fixture-block: no author.',
      "fixture-block: no author's page.",
      "fixture-block: no model's page.",
      'fixture-block: whether it was modified is not recorded.',
      "fixture-block: SOURCES.md's model is not its title linked to its page.",
      "fixture-block: SOURCES.md's author is not linked to their page.",
    ]);
  });

  it('holds no test model and no local-only file, and public/third-party-notices.txt stays the software\'s list', () => {
    const testModels = readdirSync(join(root, 'test-models'));
    // The local-only ones by name too, as a checkout without them on disk still must not publish them.
    const localOnly = LOCAL_ONLY.map((id) => EXAMPLE_FILES[id]);
    expect(localOnly).toEqual(['VIS-35-skan-skalowany.stl', 'l_medieval_barrel.stl']);
    for (const entry of GALLERY) {
      expect(Object.values(EXAMPLE_FILES) as string[]).not.toContain(entry.file);
      expect(localOnly).not.toContain(entry.file);
      expect(testModels).not.toContain(entry.file);
    }
    // And by content: no gallery STL is a tracked test model under another name.
    const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
    const tracked = new Set(git('ls-files', '--', 'test-models').filter((f) => f.endsWith('.stl') && existsSync(join(root, f))).map((f) => digest(readFileSync(join(root, f)))));
    for (const entry of GALLERY) expect(tracked.has(digest(loadGallery(entry.id))), entry.id).toBe(false);
    // licences.test.ts parses that file strictly against the packages: the models' notice is SOURCES.md alone.
    const notices = readFileSync(join(root, 'public', 'third-party-notices.txt'), 'utf8');
    expect(notices).not.toMatch(/gallery|sphere\.stl|CC0 1\.0 Universal/i);
    expect(execFileSync('git', ['diff', '--quiet', 'HEAD', '--', 'public/third-party-notices.txt'], { cwd: root }).length).toBe(0);
  });

  it('every entry\'s bytes and triangles are its file\'s, under the large-model point, 2 MB each and 5 MB in all', () => {
    let total = 0;
    for (const entry of GALLERY) {
      const bytes = loadGallery(entry.id);
      const parsed = parseStl(bytes);
      expect(bytes.length, entry.id).toBe(entry.bytes);
      expect(parsed.rawTriangleCount, entry.id).toBe(entry.triangles);
      expect(entry.triangles, entry.id).toBeLessThan(LARGE_MODEL.triangles);
      expect(entry.bytes, entry.id).toBeLessThan(Math.min(LARGE_MODEL.bytes, 2_000_000));
      total += entry.bytes;
    }
    expect(total).toBeLessThan(5_000_000);
  });

  it('the generator, run into a temporary folder, gives the committed bytes; each primitive is closed, genus 0, 40 mm tall from z = 0, with its header', async () => {
    const out = mkdtempSync(join(tmpdir(), 'cfg-gallery-'));
    try {
      execFileSync(process.execPath, [join(root, 'scripts', 'make-gallery-primitives.mjs'), out], { cwd: root, stdio: 'pipe' });
      expect(readdirSync(out).sort()).toEqual(GALLERY.map((e) => e.file).sort());
      const wasm = await Module();
      wasm.setup();
      for (const entry of GALLERY) {
        const made = new Uint8Array(readFileSync(join(out, entry.file)));
        expect(Buffer.from(made).equals(Buffer.from(loadGallery(entry.id))), `${entry.file} is not what the generator makes`).toBe(true);
        // The header names the app and the model and nothing else (examples.test.ts's scan reads it too).
        expect(new TextDecoder('latin1').decode(made.subarray(0, 80)).replace(/\0+$/, '')).toBe(`binary STL, mold-form-generator gallery ${entry.id}`);
        const welded = weld(parseStl(made).positions);
        const bounds = meshBounds(welded.positions);
        expect(bounds.min[2], entry.id).toBeCloseTo(0, 6);
        expect(Math.abs(bounds.max[2] - bounds.min[2] - 40), entry.id).toBeLessThanOrEqual(0.5);
        expect(Math.abs(bounds.max[2] - bounds.min[2] - entry.heightMm), entry.id).toBeLessThanOrEqual(0.5);
        const mesh = new wasm.Mesh({ numProp: 3, vertProperties: welded.positions, triVerts: welded.indices });
        const solid = new wasm.Manifold(mesh);
        expect(solid.status(), entry.id).toBe('NoError');
        expect(solid.genus(), entry.id).toBe(0);
        expect(solid.volume(), entry.id).toBeGreaterThan(0);
        solid.delete();
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);

  it('the default model is a catalogue id, and src/ never fetches a gallery file by an absolute path', () => {
    expect(galleryEntry(DEFAULT_GALLERY_MODEL)).not.toBeNull();
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
    const absolute = walk(join(root, 'src')).filter((file) => /\.(ts|tsx)$/.test(file) && /['"`]\/gallery\//.test(readFileSync(file, 'utf8')));
    expect(absolute).toEqual([]);
    // Negative control: the pattern finds such a path.
    expect(/['"`]\/gallery\//.test("fetch('/gallery/sphere.stl')")).toBe(true);
  });

  it('which model a page load opens: the default on a plain load, none under ?test=1 unless named, none with model=none', () => {
    expect(modelToOpen('')).toBe('sphere');
    expect(modelToOpen('?theme=x')).toBe('sphere');
    expect(modelToOpen('?test=1')).toBeNull();
    expect(modelToOpen('?test=1&model=cone')).toBe('cone');
    expect(modelToOpen('?model=cube')).toBe('cube');
    expect(modelToOpen('?model=none')).toBeNull();
    expect(modelToOpen('?model=nothing-of-that-name')).toBeNull();
    expect(modelToOpen('?test=1&model=fixture-block')).toBeNull();
    expect(modelToOpen('?test=1&model=fixture-block', WITH_THIRD_PARTY)).toBe('fixture-block');
  });

  it('a card\'s facts and a credit\'s source read plainly', () => {
    expect(entryFacts(GALLERY[0])).toBe('40 mm tall, 2,022 triangles');
    expect(sourceName('https://www.printables.com/model/1')).toBe('Printables');
    expect(sourceName('https://example.org/a')).toBe('example.org');
  });
});

/** GA: each gallery model goes through the app's own path in Node at defaults, to an export with no error. */
describe('GA: the gallery\'s models export at defaults', () => {
  const ids = FULL ? GALLERY.map((e) => e.id) : [DEFAULT_GALLERY_MODEL];
  it.each(ids)('%s', async (id) => {
    const entry = galleryEntry(id)!;
    const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true, reports: true });
    try {
      p.load(loadGallery(id), entry.file);
      await p.idle();
      expect(p.status().error).toBeNull();
      expect(allDiagnostics(p).filter((d) => d.severity === 'error')).toEqual([]);
      expect(exportBlocked(p)).toBeNull();
      const outputs = await p.exportParts(() => {}, undefined, { want: 'zip', fitTest: false });
      expect(outputs.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(outputs.clearance!.measured).toBeGreaterThanOrEqual(p.params.silicone.t);
      // Our own models carry no credit: project.json has no gallery field.
      expect(JSON.parse(new TextDecoder().decode(outputs.files['project.json'])).gallery).toBeUndefined();
    } finally {
      p.dispose();
    }
  }, 300_000);
});
