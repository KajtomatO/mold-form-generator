import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '../../src/app/hash';
import { History } from '../../src/app/history';
import { Pipeline } from '../../src/app/pipeline';
import { projectFile, projectJson, type Project, type ProjectFile, type StoredPlane } from '../../src/app/project';
import { fileKind, holdsModel, MAX_STL_BYTES, MODEL_ENTRY, packProject, PROJECT_ENTRY, unpackProject } from '../../src/app/projectArchive';
import { migrate, MIGRATIONS, OPEN_AGAIN, OPEN_INSTEAD, ProjectError, readProjectJson, type Migration } from '../../src/app/projectFile';
import { ProjectFiles } from '../../src/app/projectFiles';
import { Store } from '../../src/app/store';
import { BUILD } from '../../src/app/buildInfo';
import { bodiesByPart } from '../../src/app/version';
import type { BaseCandidate } from '../../src/core/base/candidates';
import { findStoredPlane, nearestCandidate, PLANE_MATCH_MM, planeGap, planeOf, triangleOnPlane } from '../../src/core/base/storedPlane';
import { defaultParams } from '../../src/core/params/defaults';
import { SCHEMA_VERSION } from '../../src/core/params/schema';
import { DEFAULT_PLANE } from '../../src/workers/fieldStages';
import type { WorkerLike } from '../../src/workers/protocol';
import { HASH_ON_READ_BYTES, runProjectJob, type Opened } from '../../src/workers/projectJob';
import { inProcessField, inProcessProject, inProcessSolid } from '../fixtures/inProcessWorker';
import { exampleBytes, EXAMPLE_FILES } from '../fixtures/loadExamples';
import { declaredSize, raised, zipDates } from '../fixtures/projectFiles';
import { asciiStl, box, join as joinMeshes, toSoup } from '../fixtures/synthetic';

/** A binary STL of these triangles, with `count` in its header in place of the real one. */
function binaryOf(soup: Float32Array, count: number): Uint8Array {
  const bytes = new Uint8Array(84 + 50 * (soup.length / 9));
  const view = new DataView(bytes.buffer);
  view.setUint32(80, count, true);
  for (let t = 0; t < soup.length / 9; t++) for (let k = 0; k < 9; k++) view.setFloat32(84 + 50 * t + 12 + 4 * k, soup[t * 9 + k], true);
  return bytes;
}

const fixtures = join(import.meta.dirname, '..', 'fixtures', 'projects');
const fixture = (name: string): string => readFileSync(join(fixtures, name), 'utf8');
/** What the 2 to 3 step adds: the bolts off, at the values format 3 started with. */
const V3_BOLTS = { enabled: false, size: 'M3', length: null, holeClearance: 0.2, nutClearance: 0.15, minWall: 1.2 };
const nodeSha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function file(change: (f: ProjectFile) => void = () => {}): ProjectFile {
  const f = projectFile({ params: defaultParams(), plane: DEFAULT_PLANE, pins: [], removed: [] }, 'jersey-barrier.stl', { modelSha256: nodeSha(exampleBytes('jersey')), basePlane: { normal: [0, 0, -1], offset: 0, upper: false } });
  change(f);
  return f;
}

/** project.json with one field set to a value of any type, as a hand-edited file might have it, or left out for undefined. */
function edited(path: string, value: unknown): string {
  const raw = JSON.parse(projectJson(file())) as Record<string, unknown>;
  const keys = path.split('.');
  let at = raw as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) at = at[key] as Record<string, unknown>;
  if (value === undefined) delete at[keys.at(-1)!];
  else at[keys.at(-1)!] = value;
  return JSON.stringify(raw);
}

function refusal(run: () => unknown): ProjectError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectError);
    return error as ProjectError;
  }
  throw new Error('expected a ProjectError');
}
const reason = (run: () => unknown): string => refusal(run).message;

describe('SHA-256', () => {
  it('gives FIPS 180-4\'s own examples and what node:crypto gives at every padding boundary', () => {
    expect(sha256(strToU8('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256(strToU8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    let seed = 7;
    for (const length of [1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 65_537]) {
      const bytes = new Uint8Array(length).map(() => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24);
      expect(sha256(bytes), `${length} bytes`).toBe(nodeSha(bytes));
    }
  });

  it('hashes a real STL as sha256sum does, from a view into a larger buffer too', () => {
    const bytes = exampleBytes('jersey');
    expect(sha256(bytes)).toBe(nodeSha(bytes));
    const padded = new Uint8Array(bytes.length + 10);
    padded.set(bytes, 5);
    expect(sha256(padded.subarray(5, 5 + bytes.length))).toBe(nodeSha(bytes));
  });
});

describe('pack and unpack', () => {
  it('a .moldproj holds project.json and the STL byte for byte, dated 2026-01-01 whenever it is saved, so it packs the same bytes every time', () => {
    const stl = exampleBytes('jersey');
    const json = projectJson(file());
    const zip = packProject(json, stl);
    expect(Object.keys(unzipSync(zip)).sort()).toEqual([MODEL_ENTRY, PROJECT_ENTRY].sort());
    const back = unpackProject(zip, 'x.moldproj');
    expect(back.json).toBe(json);
    expect(Buffer.compare(Buffer.from(back.stl!), Buffer.from(stl))).toBe(0);
    // DOS date (2026 - 1980) << 9 | 1 << 5 | 1, at midnight, in both headers of both entries.
    const fixed: [number, number] = [(46 << 9) | (1 << 5) | 1, 0];
    expect(zipDates(zip)).toEqual({ local: [fixed, fixed], central: [fixed, fixed] });
    // Packed again a year and a day later, it is the same file.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2027, 5, 7, 13, 21, 44));
      expect(Buffer.compare(Buffer.from(packProject(json, stl)), Buffer.from(zip))).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells an STL, a ZIP and a project.json apart by extension, by their first bytes without one, and anything else apart from all three', () => {
    const zip = packProject('{}', new Uint8Array(84));
    expect(fileKind('a.stl', zip)).toBe('stl');
    expect(fileKind('a.STL', new Uint8Array(84))).toBe('stl');
    expect(fileKind('a.moldproj', new Uint8Array(4))).toBe('zip');
    expect(fileKind('a-mold.zip', zip)).toBe('zip');
    expect(fileKind('project.json', strToU8('{}'))).toBe('json');
    expect(fileKind('download', zip)).toBe('zip');
    expect(fileKind('cube.3mf', zip)).toBe('zip');
    expect(fileKind('download', strToU8('﻿ \n {"schemaVersion": 2}'))).toBe('json');
    expect(fileKind('download', strToU8('solid cube'))).toBe('stl');
    // A binary STL of the size its count gives, with no name to go by.
    expect(fileKind('download', exampleBytes('jersey'))).toBe('stl');
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Uint8Array(200)]);
    expect(fileKind('photo.png', png)).toBe('other');
    expect(fileKind('notes.txt', strToU8('hello'))).toBe('other');
  });

  it('refuses what is no ZIP, a ZIP with no project.json, and a damaged archive, each naming the file and what to do', () => {
    expect(reason(() => unpackProject(strToU8('solid cube\nendsolid'), 'cube.moldproj'))).toBe(`cube.moldproj is not a project saved by this app, as it is no ZIP archive. ${OPEN_INSTEAD}`);
    expect(reason(() => unpackProject(zipSync({ 'notes.txt': strToU8('hi') }), 'x.zip'))).toBe(`x.zip is not a project saved by this app, as it holds no project.json. ${OPEN_INSTEAD}`);
    // A maker's download of STLs, and a slicer's 3MF, say what to do instead.
    expect(reason(() => unpackProject(zipSync({ 'parts/left.STL': new Uint8Array(84), 'readme.txt': strToU8('hi') }), 'printables.zip'))).toBe('printables.zip holds STL files, not a project of this app. Unzip it, then open the STL you want.');
    expect(reason(() => unpackProject(zipSync({ '3D/3dmodel.model': strToU8('<model/>'), '[Content_Types].xml': strToU8('<x/>') }), 'plate'))).toBe('plate is a 3MF file, which this app does not read. Export the model from your slicer as an STL, then open that.');
    const zip = packProject(projectJson(file()), exampleBytes('jersey'));
    const cut = refusal(() => unpackProject(zip.subarray(0, zip.length - 30), 'cut.moldproj'));
    expect(cut.message).toBe(`cut.moldproj is damaged and cannot be unpacked. ${OPEN_AGAIN}`);
    expect(cut.details).toMatch(/^The ZIP reader says: /);
  });

  it('refuses an entry whose declared size is absurd before inflating it, measured against the bytes the file holds, so a ZIP bomb allocates nothing', () => {
    const zip = packProject(projectJson(file()), exampleBytes('jersey'));
    const declare = (name: string, size: number, packed?: number): Uint8Array => declaredSize(zip, name, size, packed);
    const t0 = performance.now();
    expect(reason(() => unpackProject(declare(MODEL_ENTRY, 0xf0000000), 'bomb.moldproj'))).toBe(`bomb.moldproj is damaged or too large: the model inside it says it unpacks to 3840 MB, past the 1024 MB this app takes. ${OPEN_AGAIN}`);
    expect(reason(() => unpackProject(declare(PROJECT_ENTRY, 64 * 1024 * 1024), 'bomb.moldproj'))).toBe(`bomb.moldproj is damaged or too large: the settings inside it say they unpack to 64 MB, past the 4.0 MB this app takes. ${OPEN_AGAIN}`);
    // Under the limit, but more than deflate can make from the whole file: 1100 times its 26 kB is 28.8 MB.
    expect(zip.length * 1100 + 1024).toBeLessThan(30 * 1024 * 1024);
    expect(zip.length * 1100 + 1024).toBeGreaterThan(20 * 1024 * 1024);
    expect(reason(() => unpackProject(declare(MODEL_ENTRY, 30 * 1024 * 1024), 'bomb.moldproj'))).toMatch(/^bomb\.moldproj is damaged: the model inside it says it unpacks to 30 MB from a file of 26 kB, which no ZIP can\./);
    // The same with its compressed size raised as well, which passed a check of the entry's two declared sizes.
    expect(reason(() => unpackProject(declare(MODEL_ENTRY, 512 * 1024 * 1024, 512 * 1024), 'bomb.moldproj'))).toMatch(/^bomb\.moldproj is damaged: the model inside it says it unpacks to 512 MB from a file of 26 kB/);
    // Within what deflate could make, but larger than the entry inflates to: never kept in the larger buffer.
    expect(reason(() => unpackProject(declare(PROJECT_ENTRY, 3 * 1024 * 1024), 'bomb.moldproj'))).toBe(`bomb.moldproj is damaged: the settings inside it are not the size the archive says. ${OPEN_AGAIN}`);
    const larger = refusal(() => unpackProject(declare(MODEL_ENTRY, 20 * 1024 * 1024), 'larger.moldproj'));
    expect(larger.message).toBe(`larger.moldproj is damaged: the model inside it is not the size the archive says. ${OPEN_AGAIN}`);
    expect(larger.details).toBe(`model.stl unpacks to ${exampleBytes('jersey').length} bytes, where ${20 * 1024 * 1024} are declared.`);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(MAX_STL_BYTES).toBe(1024 ** 3);
  });

  it('tells from the directory alone whether a ZIP holds its model', () => {
    expect(holdsModel(packProject('{}', new Uint8Array(84)))).toBe(true);
    expect(holdsModel(zipSync({ [PROJECT_ENTRY]: strToU8('{}'), 'cover.stl': new Uint8Array(84) }))).toBe(false);
    // Unreadable: the job says why, and is not sent the model on screen for it.
    expect(holdsModel(strToU8('hello'))).toBe(true);
  });
});

describe('migration', () => {
  it('M8\'s version 1 project.json, from a real export ZIP, migrates to version 4 with the hash and plane unknown and the bolts off', () => {
    const read = readProjectJson(fixture('v1-jersey-export.json'));
    const v1 = JSON.parse(fixture('v1-jersey-export.json'));
    expect(v1.schemaVersion).toBe(1);
    expect(read.from).toBe(1);
    expect(SCHEMA_VERSION).toBe(4);
    expect(read.file).toEqual({ ...v1, schemaVersion: SCHEMA_VERSION, modelSha256: null, basePlane: null, params: { ...v1.params, bolts: V3_BOLTS } });
    // The pocket's edited flag is its value, 0.4, where an unedited one is null.
    expect(read.file.params.base.pocketDepth).toBe(0.4);
    expect(read.file.params.silicone.printMargin).toBeNull();
    expect(read.notes).toEqual([{ severity: 'info', message: 'Saved in project format 1 by an earlier version of the app, and brought up to format 4.' }]);
  });

  it('M9\'s version 2 project.json, from a real export ZIP, migrates to version 4 with the bolts off and nothing else changed', () => {
    const read = readProjectJson(fixture('v2-jersey-export.json'));
    const v2 = JSON.parse(fixture('v2-jersey-export.json'));
    expect(v2).toMatchObject({ schemaVersion: 2, appVersion: '0.2.0' });
    expect(v2.params.bolts).toBeUndefined();
    expect(read.from).toBe(2);
    expect(read.file).toEqual({ ...v2, schemaVersion: SCHEMA_VERSION, params: { ...v2.params, bolts: V3_BOLTS } });
    expect(read.file.params.bolts).toEqual(defaultParams().bolts);
    // The hash and the plane came with format 2, and stay as saved.
    expect(read.file.modelSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(read.file.basePlane).toEqual(v2.basePlane);
    expect(read.notes).toEqual([{ severity: 'info', message: 'Saved in project format 2 by an earlier version of the app, and brought up to format 4.' }]);
  });

  it('runs one step per version, in order, so a version 0 with renamed fields and no pins or removed vents reaches the current one, with its gaps filled', () => {
    const seen: number[] = [];
    // A version 0 that never shipped: `stl` and `app` for model and appVersion, and grid.cols for grid.nx.
    // It never had pins or removed vents, and its step does not add them: the reader meets them missing.
    const v0ToV1: Migration = (f) => {
      seen.push(f.schemaVersion as number);
      const { stl, app, ...rest } = f;
      const params = rest.params as Record<string, Record<string, unknown>>;
      const { cols, ...grid } = params.grid;
      return { ...rest, model: stl, appVersion: app, params: { ...params, grid: { nx: cols, ...grid } } };
    };
    const v1ToV2: Migration = (f, notes) => {
      seen.push(f.schemaVersion as number);
      return MIGRATIONS[1](f, notes);
    };
    const v2ToV3: Migration = (f, notes) => {
      seen.push(f.schemaVersion as number);
      return MIGRATIONS[2](f, notes);
    };
    const v3ToV4: Migration = (f, notes) => {
      seen.push(f.schemaVersion as number);
      return MIGRATIONS[3](f, notes);
    };
    const read = readProjectJson(fixture('v0-synthetic.json'), { 0: v0ToV1, 1: v1ToV2, 2: v2ToV3, 3: v3ToV4 });
    expect(seen).toEqual([0, 1, 2, 3]);
    expect(read.file.params.bolts).toEqual(V3_BOLTS);
    expect(read.from).toBe(0);
    expect(read.file).toMatchObject({ schemaVersion: SCHEMA_VERSION, model: 'jersey-barrier.stl', appVersion: '0.0.1', pins: [], removed: [], modelSha256: null, basePlane: null });
    expect(read.file.params.grid.nx).toBe(2);
    expect(read.file.params.reports).toEqual(defaultParams().reports);
    expect(read.notes).toEqual([
      { severity: 'info', message: 'Saved in project format 0 by an earlier version of the app, and brought up to format 4.' },
      { severity: 'warning', message: 'Not in the file, so as for a new model: moved openings, so none; removed vents, so none.' },
      { severity: 'warning', message: 'Not in the file, so at their defaults: Smallest reported volume, Smallest air pocket depth.' },
    ]);
    // Without its step, version 0 is too old to read, and says so.
    expect(reason(() => readProjectJson(fixture('v0-synthetic.json'), MIGRATIONS, 'old.moldproj'))).toBe('old.moldproj was saved in project format 0, which is older than any this app can read. Open its STL and set it up again.');
  });

  it('a version newer than the app knows, and a file with no version, say so plainly, naming the file', () => {
    expect(reason(() => readProjectJson(edited('schemaVersion', 5), MIGRATIONS, 'next.moldproj'))).toBe(`next.moldproj was saved by a newer version of the app (app version ${BUILD.version}), in project format 5; this one reads formats up to 4. Open it in the version of the app that saved it.`);
    // A visitor cannot update a web page, and a new format reaches the beta site first, so a file from beta says where to open it.
    const fromBeta = JSON.stringify({ ...JSON.parse(edited('schemaVersion', 5)), appVersion: '0.2.0-beta+a1b2c3d' });
    expect(reason(() => readProjectJson(fromBeta, MIGRATIONS, 'next.moldproj'))).toBe("next.moldproj was saved by a newer version of the app (app version 0.2.0-beta+a1b2c3d), in project format 5; this one reads formats up to 4. Open it on the beta site that saved it, at the app's web address with beta/ at the end.");
    expect(reason(() => readProjectJson(edited('schemaVersion', undefined)))).toBe(`project.json does not say which project format it is in, so there is no telling how to read it. ${OPEN_AGAIN}`);
    expect(reason(() => readProjectJson(edited('schemaVersion', '2')))).toBe(`project.json does not say which project format it is in, so there is no telling how to read it. ${OPEN_AGAIN}`);
    expect(reason(() => migrate([1, 2]))).toBe(`project.json holds no settings this app can read. ${OPEN_AGAIN}`);
  });
});

describe('validation', () => {
  it('reads back exactly what was written, edited flags and all', () => {
    const f = file((x) => {
      x.params.base.pocketDepth = 0.4;
      x.params.grid.spacing = 12;
      x.plane = { pick: 17, upper: 0.41 };
      x.pins = [{ id: 'b0:pour:0', kind: 'pour', x: 1.5, y: -2 }];
      x.removed = ['b0:vent:beside'];
    });
    const read = readProjectJson(projectJson(f));
    expect(read.file).toEqual(f);
    expect(read.notes).toEqual([]);
  });

  it('leaves out unknown settings and fields, gives missing ones their defaults, and brings values into range, each with a note', () => {
    const raw = JSON.parse(projectJson(file())) as Record<string, unknown> & { params: Record<string, Record<string, unknown>> };
    raw.params.silicone.t = 50;
    raw.params.silicone.wallDraftDeg = -2;
    raw.params.pour.perModel = 2.4;
    raw.params.print.layerHeight = 0;
    raw.params.silicone.glitter = true;
    raw.params.lighting = { lux: 3 };
    delete raw.params.cover.topChamfer;
    delete raw.params.funnel;
    raw.camera = { fov: 35 };
    const read = readProjectJson(JSON.stringify(raw));
    const want = defaultParams();
    want.silicone.t = 20;
    want.silicone.wallDraftDeg = 0;
    want.pour.perModel = 2;
    want.print.layerHeight = 0.05;
    expect(read.file.params).toEqual(want);
    expect(read.notes.map((n) => n.message)).toEqual([
      'Fields this version does not know, left out: camera.',
      'Silicone thickness (silicone.t) was 50 mm, but must be from 1 to 20 mm, so it is 20 mm.',
      'Wall draft (silicone.wallDraftDeg) was -2 deg, but must be from 0 to 5 deg, so it is 0 deg.',
      'Pours per body (pour.perModel) was 2.4, but must be a whole number, so it is 2.',
      'Layer height (print.layerHeight) was 0 mm, but must be at least 0.05 mm, so it is 0.05 mm.',
      'Not in the file, so at their defaults: Top chamfer, Generate funnel, Top diameter, Height, Neck height, Wall, Tip wall, Seat clearance.',
      'Settings this version does not know, left out: silicone.glitter, lighting.',
    ]);
    expect(read.notes.every((n) => n.severity === 'warning')).toBe(true);
  });

  it('a bolt length off the list of lengths screws are sold in is brought to the nearest one, the shorter on a tie, with a note', () => {
    const read = (length: unknown) => readProjectJson(edited('params.bolts.length', length));
    const cases: [number, number, string][] = [
      [13, 12, 'Bolt length (bolts.length) was 13 mm, which is not one of 6, 8, 10, 12, 16, 20, 25, 30, 35, 40, so it is 12 mm.'],
      [14, 12, 'Bolt length (bolts.length) was 14 mm, which is not one of 6, 8, 10, 12, 16, 20, 25, 30, 35, 40, so it is 12 mm.'],
      [15, 16, 'Bolt length (bolts.length) was 15 mm, which is not one of 6, 8, 10, 12, 16, 20, 25, 30, 35, 40, so it is 16 mm.'],
      // Past the longest, it is the longest.
      [50, 40, 'Bolt length (bolts.length) was 50 mm, which is not one of 6, 8, 10, 12, 16, 20, 25, 30, 35, 40, so it is 40 mm.'],
      [2, 6, 'Bolt length (bolts.length) was 2 mm, which is not one of 6, 8, 10, 12, 16, 20, 25, 30, 35, 40, so it is 6 mm.'],
    ];
    for (const [length, kept, note] of cases) {
      const { file: opened, notes } = read(length);
      expect(opened.params.bolts.length, String(length)).toBe(kept);
      expect(notes, String(length)).toEqual([{ severity: 'warning', message: note }]);
    }
    // A listed length and auto stay as they are, with nothing to say.
    expect(read(16)).toMatchObject({ file: { params: { bolts: { length: 16 } } }, notes: [] });
    expect(read(null)).toMatchObject({ file: { params: { bolts: { length: null } } }, notes: [] });
  });

  it('a top-level field the file lacks takes its default or is unknown, with a note; only the model and the settings must be there', () => {
    const read = (path: string) => readProjectJson(edited(path, undefined));
    expect(read('pins')).toMatchObject({ file: { pins: [] }, notes: [{ severity: 'warning', message: 'Not in the file, so as for a new model: moved openings, so none.' }] });
    expect(read('removed')).toMatchObject({ file: { removed: [] }, notes: [{ severity: 'warning', message: 'Not in the file, so as for a new model: removed vents, so none.' }] });
    expect(read('plane')).toMatchObject({ file: { plane: DEFAULT_PLANE }, notes: [{ severity: 'warning', message: 'Not in the file, so as for a new model: the base face, so candidate 1.' }] });
    expect(read('basePlane')).toMatchObject({ file: { basePlane: null }, notes: [{ severity: 'info', message: 'Not in the file, so not known: the base plane itself.' }] });
    expect(read('appVersion')).toMatchObject({ file: { appVersion: 'unknown' }, notes: [{ severity: 'info', message: 'Not in the file, so not known: the app version that saved it.' }] });
    // Its absence is told by whoever matches the model by it: the open of a .moldproj, or the settings applied by name.
    expect(read('modelSha256')).toMatchObject({ file: { modelSha256: null }, notes: [] });
    // The version 1 fixture without its removed vents, as M8 could not have written but a hand edit can.
    const v1 = JSON.parse(fixture('v1-jersey-export.json')) as Record<string, unknown>;
    delete v1.removed;
    expect(readProjectJson(JSON.stringify(v1)).file.removed).toEqual([]);
    expect(reason(() => read('model'))).toBe(`project.json cannot be used: it does not name its STL. ${OPEN_AGAIN}`);
    expect(reason(() => read('params'))).toBe(`project.json cannot be used: it holds no settings. ${OPEN_AGAIN}`);
  });

  it('refuses a wrong type in a maker\'s words, naming the file, with the field and the reason in its details', () => {
    const cases: [string, unknown, string, string][] = [
      ['params.silicone.t', '3', 'its Silicone thickness must be a number, not "3"', 'In project.json: params.silicone.t. It takes a number.'],
      ['params.base.pocketDepth', 'auto', 'its Pocket depth must be a number, not "auto"', 'In project.json: params.base.pocketDepth. It takes a number, or null to follow its rule.'],
      ['params.silicone.t', null, 'its Silicone thickness must be a number, not null', 'In project.json: params.silicone.t. It takes a number.'],
      ['params.base.mode', 'glued', 'its Mode must be one of "glue", "merged", not "glued"', 'In project.json: params.base.mode.'],
      ['params.vents.enabled', 1, 'its Vents must be on or off, not 1', 'In project.json: params.vents.enabled.'],
      ['params.grid', [1, 1], 'its settings are not laid out as this app writes them', '"params.grid" must be an object, not a list.'],
      ['params', 'none', 'it holds no settings', '"params" must be an object, not "none".'],
      ['plane', { rank: 1.5, upper: false }, 'the base face it names is not a valid choice', '"plane.rank" must be a whole number from 0, not 1.5.'],
      ['plane', { rank: 0, pick: 3, upper: false }, 'the base face it names is not a valid choice', '"plane" must name either a ranked face ("rank") or a picked triangle ("pick").'],
      ['plane', { pick: 3, upper: 'yes' }, 'the base face it names is not a valid choice', '"plane.upper" must be false or a level\'s depth in mm, not "yes".'],
      ['pins', [{ id: 'b0:pour:0', kind: 'funnel', x: 0, y: 0 }], 'its moved opening 1 has no valid place', '"pins[0]" must have an id, a kind of "pour" or "vent", and an x and y in mm.'],
      ['pins', {}, 'its moved openings are not a list', '"pins" must be a list, not an object.'],
      ['removed', [3], 'its removed vents are not a list of vents', '"removed" must be a list of vent ids.'],
      ['model', 7, 'it does not name its STL', '"model" must be the STL\'s file name.'],
      ['appVersion', 2, 'the app version it names is not text', '"appVersion" must be text, not 2.'],
      ['modelSha256', 'abc', "its record of the model's contents is not valid", '"modelSha256" must be 64 hex digits or null.'],
      ['basePlane', { normal: [0, 0, -2], offset: 0, upper: false }, 'the base face it saved is not a valid plane', '"basePlane.normal" must be a unit vector.'],
      ['basePlane', { normal: [0, 0, -1], offset: '0', upper: false }, 'the base face it saved is not a valid plane', '"basePlane.offset" must be a number, not "0".'],
    ];
    for (const [path, value, what, details] of cases) {
      const error = refusal(() => readProjectJson(edited(path, value), MIGRATIONS, 'jersey for the shelf.moldproj'));
      expect(error.message, path).toBe(`jersey for the shelf.moldproj cannot be used: ${what}. ${OPEN_AGAIN}`);
      expect(error.details, path).toBe(details);
    }
    // JSON has no Infinity, but 1e999 reads as one.
    expect(reason(() => readProjectJson(edited('params.silicone.t', 0).replace('"t":0', '"t":1e999')))).toBe(`project.json cannot be used: its Silicone thickness must be a number, not Infinity. ${OPEN_AGAIN}`);
    const broken = refusal(() => readProjectJson('{"schemaVersion": 2, ', MIGRATIONS, 'broken.json'));
    expect(broken.message).toBe(`broken.json is damaged: its settings cannot be read. ${OPEN_AGAIN}`);
    expect(broken.details).toMatch(/^project\.json is not valid JSON: /);
  });
});

describe('project.worker\'s jobs', () => {
  const stl = exampleBytes('jersey');
  const pack = (f: ProjectFile, bytes = stl): Uint8Array => {
    const { reply } = runProjectJob({ t: 'pack', id: 1, file: f, stl: bytes.slice().buffer });
    if (reply.t !== 'packed') throw new Error(reply.t === 'project-error' ? reply.message : reply.t);
    return reply.zip;
  };
  const run = (bytes: Uint8Array, name: string, kind: 'zip' | 'json' = 'zip', loaded: Uint8Array | null = null) =>
    runProjectJob({ t: 'open', id: 2, bytes: bytes.slice().buffer, name, kind, loaded: loaded?.slice().buffer ?? null });
  const open = (bytes: Uint8Array, name: string, kind: 'zip' | 'json' = 'zip', loaded: Uint8Array | null = null): Opened | string => {
    const { reply } = run(bytes, name, kind, loaded);
    return reply.t === 'opened' ? reply.opened : reply.t === 'project-error' ? reply.message : reply.t;
  };

  it('a save works out the STL\'s hash when it is not known, and an open checks the STL against it and hands over a buffer of its own size', () => {
    const zip = pack(file((f) => (f.modelSha256 = null)));
    const { reply, transfer } = run(zip, 'jersey-barrier.moldproj');
    const opened = (reply as Extract<typeof reply, { t: 'opened' }>).opened;
    expect(opened.file.modelSha256).toBe(nodeSha(stl));
    expect(opened.stlSha256).toBe(nodeSha(stl));
    expect(Buffer.compare(Buffer.from(opened.stl!), Buffer.from(stl))).toBe(0);
    expect(opened.stl!.buffer.byteLength).toBe(stl.length);
    expect(transfer.map((b) => b.byteLength)).toEqual([stl.length]);
    expect(opened.notes).toEqual([]);
  });

  it('a model.stl that is not the one project.json names, a .moldproj without its STL, and malformed JSON are refused, naming the file', () => {
    const other = exampleBytes('barrel');
    const swapped = zipSync({ [PROJECT_ENTRY]: strToU8(projectJson(file())), [MODEL_ENTRY]: other });
    expect(open(swapped, 'swapped.moldproj')).toBe(`swapped.moldproj is damaged or was changed: the model inside it is not the one its settings were saved for. ${OPEN_AGAIN}`);
    const garbage = strToU8('solid nothing here');
    const unreadable = zipSync({ [PROJECT_ENTRY]: strToU8(projectJson(file((f) => (f.modelSha256 = nodeSha(garbage))))), [MODEL_ENTRY]: garbage });
    const { reply } = run(unreadable, 'unreadable.moldproj');
    expect(reply).toMatchObject({ t: 'project-error', message: `unreadable.moldproj is damaged: the model inside it cannot be read. ${OPEN_AGAIN}`, details: 'model.stl: The STL file contains no usable triangles.' });
    const bare = zipSync({ [PROJECT_ENTRY]: strToU8(projectJson(file())) });
    expect(open(bare, 'bare.moldproj')).toBe(`bare.moldproj is damaged: the model saved inside it is missing. ${OPEN_AGAIN}`);
    expect(open(zipSync({ [PROJECT_ENTRY]: strToU8('{"schemaVersion": 2,'), [MODEL_ENTRY]: stl }), 'bad.moldproj')).toBe(`bad.moldproj is damaged: its settings cannot be read. ${OPEN_AGAIN}`);
    expect(open(strToU8('{"schemaVersion": 2, "params": '), 'project.json', 'json')).toBe(`project.json is damaged: its settings cannot be read. ${OPEN_AGAIN}`);
    expect(open(new Uint8Array([0xff, 0xfe, 0x7b]), 'notes.json', 'json')).toBe(`notes.json is not a project's settings, as it is not text. ${OPEN_INSTEAD}`);
  });

  it('an export ZIP and a lone project.json are settings without a model, and the loaded model\'s hash comes back when it is sent', () => {
    const exported = zipSync({ 'cover.stl': new Uint8Array(84), [PROJECT_ENTRY]: strToU8(projectJson(file())), 'README.txt': strToU8('hi') });
    const settings = open(exported, 'jersey-barrier-mold.zip', 'zip', stl) as Opened;
    expect(settings.stl).toBeNull();
    expect(settings.loadedSha256).toBe(nodeSha(stl));
    const lone = open(strToU8(fixture('v1-jersey-export.json')), 'project.json', 'json') as Opened;
    expect(lone).toMatchObject({ stl: null, loadedSha256: null, from: 1 });
  });
});

describe('the stored plane', () => {
  const bounds = { min: [-10, -20, 0] as [number, number, number], max: [10, 20, 30] as [number, number, number] };
  const candidate = (normal: [number, number, number], support: number, offset: number, levels: number[] = []): Pick<BaseCandidate, 'normal' | 'support' | 'offset' | 'levels'> => ({ normal, support, offset, levels: levels.map((o) => ({ offset: o, area: 100, beyond: 0, faceArea: 100 })) });
  const tilted = (degrees: number, offset: number): StoredPlane => {
    const a = (degrees * Math.PI) / 180;
    return { normal: [0, Math.sin(a), -Math.cos(a)], offset, upper: false };
  };

  it('measures how far two planes come apart across the model\'s box, tilt included', () => {
    expect(planeGap({ normal: [0, 0, -1], offset: 0 }, { normal: [0, 0, -1], offset: 0.01 }, bounds)).toBeCloseTo(0.01, 12);
    const tilt = (0.01 * Math.PI) / 180;
    // A tilt of 0.01 degree about x moves the plane by 20 mm * tan(tilt) at the box's far ends.
    expect(planeGap({ normal: [0, Math.sin(tilt), -Math.cos(tilt)], offset: 0 }, { normal: [0, 0, -1], offset: 0 }, bounds)).toBeGreaterThan(20 * Math.tan(tilt) - 1e-9);
    expect(planeGap({ normal: [0, 0, 1], offset: 30 }, { normal: [0, 0, -1], offset: 0 }, bounds)).toBe(Infinity);
  });

  it('keeps the plane in the STL\'s coordinates: a base at z = 5, and its level 0.41 mm up, as worked out by hand', () => {
    // Facing -z, the support is the largest dot(n, v), -5 for a model whose lowest point is at z = 5.
    expect(planeOf(candidate([0, 0, -1], -5, 0))).toEqual({ normal: [0, 0, -1], offset: -5 });
    // Standing 0.41 mm into the model is the plane z = 5.41, which is dot(n, p) = -5.41.
    expect(planeOf(candidate([0, 0, -1], -5, 0.41)).offset).toBeCloseTo(-5.41, 12);
    // Facing +x on a model whose far side is at x = 10, the plane is x = 10.
    expect(planeOf(candidate([1, 0, 0], 10, 0))).toEqual({ normal: [1, 0, 0], offset: 10 });
  });

  it('finds the saved plane among the ranked candidates and their upper levels, wherever this version ranks it', () => {
    const ranked = [candidate([0, 0, 1], 30, 0), candidate([0, 0, -1], 0, 0, [0, 0.41]), candidate([1, 0, 0], 10, 0)];
    expect(nearestCandidate({ normal: [0, 0, -1], offset: 0 }, ranked, 0.05, bounds)).toEqual({ rank: 1, upper: false, gap: 0 });
    // VIS-35's upper level, 0.41 mm into the model, is the plane dot(n, p) = -0.41.
    const upper = nearestCandidate({ normal: [0, 0, -1], offset: -0.41 }, ranked, 0.05, bounds)!;
    expect(upper.rank).toBe(1);
    expect(upper.upper).toBe(0.41);
    expect(upper.gap).toBeLessThan(1e-12);
    expect(nearestCandidate({ normal: [0, 1, 0], offset: 20 }, ranked, 0.05, bounds)).toBeNull();
    expect(nearestCandidate({ normal: [0, 0, -1], offset: -0.3 }, ranked, 0.05, bounds)!.gap).toBeCloseTo(0.11, 12);
    // A model standing at z = 5: the support is -5, and its level 0.41 mm up is dot(n, p) = -5.41.
    const raisedRanks = [candidate([0, 0, 1], 35, 0), candidate([0, 0, -1], -5, 0, [0, 0.41])];
    expect(nearestCandidate({ normal: [0, 0, -1], offset: -5 }, raisedRanks, 0.05, bounds)).toEqual({ rank: 1, upper: false, gap: 0 });
    expect(nearestCandidate({ normal: [0, 0, -1], offset: -5.41 }, raisedRanks, 0.05, bounds)).toMatchObject({ rank: 1, upper: 0.41 });
    expect(nearestCandidate({ normal: [0, 0, -1], offset: 5 }, raisedRanks, 0.05, bounds)!.gap).toBeCloseTo(10, 12);
    expect(PLANE_MATCH_MM).toBe(0.02);
  });

  it('picks the largest triangle on the plane that faces out along its normal', () => {
    const mesh = box([0, 0, 0], [10, 20, 30]);
    const t = triangleOnPlane(mesh, { normal: [0, 0, -1], offset: 0 }, 0.05)!;
    const corners = [0, 1, 2].map((k) => mesh.indices[t * 3 + k]);
    expect(corners.every((v) => mesh.positions[v * 3 + 2] === 0)).toBe(true);
    // The top face lies on the plane z = 30 but faces the other way.
    expect(triangleOnPlane(mesh, { normal: [0, 0, -1], offset: -30 }, 0.05)).toBeNull();
    expect(triangleOnPlane(mesh, { normal: [0, 0, 1], offset: 30 }, 0.05)).not.toBeNull();
    expect(triangleOnPlane(mesh, { normal: [0, 0, -1], offset: -1 }, 0.05)).toBeNull();
    // Off the origin: a box standing at z = 5 has its base on dot(n, p) = -5.
    const high = box([0, 0, 5], [10, 20, 35]);
    const h = triangleOnPlane(high, { normal: [0, 0, -1], offset: -5 }, 0.05)!;
    expect([0, 1, 2].every((k) => high.positions[high.indices[h * 3 + k] * 3 + 2] === 5)).toBe(true);
    expect(triangleOnPlane(high, { normal: [0, 0, -1], offset: 5 }, 0.05)).toBeNull();
  });

  it('searches in order: a candidate or level that is the plane, else a triangle on it, else a guess within 1 mm and 1.5 degrees', () => {
    const mesh = box([-10, -20, 0], [10, 20, 30]);
    const ranked = [candidate([0, 0, 1], 30, 0), candidate([0, 0, -1], 0, 0, [0, 0.41]), candidate([1, 0, 0], 10, 0)];
    const find = (stored: StoredPlane) => findStoredPlane(stored, ranked, mesh, 0.05, bounds);
    // The base, which triangles lie on too: the candidate wins.
    expect(find({ normal: [0, 0, -1], offset: 0, upper: false })).toEqual({ choice: { rank: 1, upper: false }, exact: true });
    expect(find({ normal: [0, 0, -1], offset: -0.41, upper: 0.41 })).toEqual({ choice: { rank: 1, upper: 0.41 }, exact: true });
    // The front, y = -20, which no candidate faces: the largest triangle on it, as a pick.
    const front = find({ normal: [0, -1, 0], offset: 20, upper: false })!;
    expect(front.exact).toBe(true);
    expect('pick' in front.choice).toBe(true);
    const t = (front.choice as { pick: number }).pick;
    expect([0, 1, 2].every((k) => mesh.positions[mesh.indices[t * 3 + k] * 3 + 1] === -20)).toBe(true);
    // Tilted 1.4 degrees and 0.3 mm below the base: up to 0.79 mm off it across the box, so a guess.
    expect(planeGap(tilted(1.4, 0.3), planeOf(ranked[1]), bounds)).toBeCloseTo(20 * Math.sin((1.4 * Math.PI) / 180) + 0.3, 9);
    expect(find(tilted(1.4, 0.3))).toEqual({ choice: { rank: 1, upper: false }, exact: false });
    // The same tilt 0.3 mm into the model is nearer the level 0.41 mm up.
    expect(find(tilted(1.4, -0.3))).toEqual({ choice: { rank: 1, upper: 0.41 }, exact: false });
    // Tilted 1.6 degrees, past one histogram bin, though only 0.56 mm off: no guess.
    expect(find(tilted(1.6, 0))).toBeNull();
    // Square to the base but 1.1 mm below it, past the plane tolerance slider's reach: no guess either.
    expect(find({ normal: [0, 0, -1], offset: 1.1, upper: false })).toBeNull();
    expect(find({ normal: [0, 0, -1], offset: 0.9, upper: false })).toEqual({ choice: { rank: 1, upper: false }, exact: false });
  });

  it('a history step recorded since a file was opened, on the file\'s choice, takes the choice that found the saved plane; older steps stay', () => {
    const history = new History(() => 0);
    const at = (plane: Project['plane'], t: number): Project => {
      const params = defaultParams();
      params.silicone.t = t;
      return { params, plane, pins: [], removed: [] };
    };
    // The user's own, before the file: on rank 1 as this version numbers it.
    history.record(at({ rank: 1, upper: false }, 3), 'a', null, at({ rank: 1, upper: false }, 4));
    const since = history.nextSeq;
    history.record(at({ rank: 1, upper: false }, 4), 'b', null, at({ rank: 1, upper: false }, 5));
    history.record(at({ rank: 2, upper: false }, 5), 'c', null, at({ rank: 2, upper: false }, 6));
    history.replacePlane({ rank: 1, upper: false }, { rank: 0, upper: false }, since);
    expect(history.undo(at({ rank: 2, upper: false }, 6))!.plane).toEqual({ rank: 2, upper: false });
    expect(history.undo(at({ rank: 2, upper: false }, 5))!.plane).toEqual({ rank: 0, upper: false });
    expect(history.undo(at({ rank: 0, upper: false }, 4))!.plane).toEqual({ rank: 1, upper: false });
  });
});

describe('save and open with the real pipeline on jersey', () => {
  const pipelines: Pipeline[] = [];
  afterEach(() => {
    pipelines.splice(0).forEach((p) => p.dispose());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const files = new ProjectFiles(inProcessProject);
  const fresh = (): Pipeline => {
    const p = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true });
    pipelines.push(p);
    return p;
  };
  const jersey = exampleBytes('jersey');
  const barrel = exampleBytes('barrel');
  const moldproj = (f: ProjectFile, stl = jersey): File => new File([packProject(projectJson(f), stl).slice()], 'jersey-barrier.moldproj');
  const settingsJson = (f: ProjectFile): File => new File([projectJson(f)], 'project.json');

  /** saveBytes in Node: the anchor's click records the file it would save. */
  function captureSaves(): { name: string; bytes: Promise<Uint8Array> }[] {
    const saved: { name: string; bytes: Promise<Uint8Array> }[] = [];
    let blob: Blob | null = null;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      blob = b as Blob;
      return 'blob:test/1';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const anchor = { href: '', download: '', style: {}, click: () => saved.push({ name: anchor.download, bytes: blob!.arrayBuffer().then((b) => new Uint8Array(b)) }), remove: () => {} };
    vi.stubGlobal('document', { createElement: () => anchor, body: { append: () => {} } });
    return saved;
  }

  it('Save project then Open gives the same project, edited flags included, the same STL and geometry, an empty history, and undo after it', async () => {
    const saves = captureSaves();
    let now = 0;
    const store = new Store(fresh(), () => (now += 1000), files);
    const p = store.pipeline;
    store.load(jersey, EXAMPLE_FILES.jersey);
    await p.idle();
    expect(store.unsaved()).toBe(false);
    const [pour] = p.placement!.value.placement.openings.filter((o) => o.kind === 'pour');
    const [vent] = p.placement!.value.placement.openings.filter((o) => o.kind === 'vent');
    store.setParam('silicone.t', 3.5);
    store.setParam('base.pocketDepth', 0.4);
    store.moveOpening(pour.id, pour.x - 1, pour.y);
    store.removeVent(vent.id);
    await p.idle();
    expect(store.unsaved()).toBe(true);
    const before = { project: structuredClone(p.project()), hash: p.geometryHash() };
    expect(before.project.pins).toHaveLength(1);

    await store.saveProject();
    expect(store.fileNotice.value).toEqual({ severity: 'info', message: 'Saved jersey-barrier.moldproj.', notes: [], saved: 'jersey-barrier.moldproj' });
    expect(store.unsaved()).toBe(false);
    expect(saves.map((s) => s.name)).toEqual(['jersey-barrier.moldproj']);
    const zip = await saves[0].bytes;
    const inside = unzipSync(zip);
    expect(Buffer.compare(Buffer.from(inside[MODEL_ENTRY]), Buffer.from(jersey))).toBe(0);
    const json = JSON.parse(text(inside[PROJECT_ENTRY])) as ProjectFile;
    // Jersey's lowest point is at z = 0, read from its bytes: it stands on dot((0, 0, -1), p) = -0.
    expect(json.basePlane).toEqual({ normal: [0, 0, -1], offset: 0, upper: false });
    expect(json).toEqual(JSON.parse(projectJson(projectFile(before.project, EXAMPLE_FILES.jersey, { modelSha256: nodeSha(jersey), basePlane: json.basePlane }))));
    expect(p.modelSha256).toBe(nodeSha(jersey));

    // Another page with work of its own opens it: it asks first, then everything comes back, and the history starts empty.
    const second = new Store(fresh(), () => (now += 1000), files);
    second.load(barrel, EXAMPLE_FILES.barrel);
    await second.pipeline.idle();
    second.setParam('silicone.t', 5);
    await second.openFile(new File([zip.slice()], 'jersey-barrier.moldproj'));
    expect(second.replacing.value).toEqual({ name: 'jersey-barrier.moldproj', model: EXAMPLE_FILES.barrel });
    expect(second.pipeline.modelName).toBe(EXAMPLE_FILES.barrel);
    await second.answerReplace('discard');
    await second.pipeline.idle();
    const q = second.pipeline;
    expect(second.replacing.value).toBeNull();
    expect(q.modelName).toBe(EXAMPLE_FILES.jersey);
    expect(second.projectName.value).toBe('jersey-barrier.moldproj');
    expect(q.project()).toEqual(before.project);
    expect(q.modelSha256).toBe(nodeSha(jersey));
    expect(q.geometryHash()).toEqual(before.hash);
    expect(second.history.depth).toEqual({ undo: 0, redo: 0 });
    expect(second.fileNotice.value).toBeNull();
    expect(second.unsaved()).toBe(false);
    expect(q.diagnostics.filter((d) => d.code.startsWith('plane-'))).toEqual([]);

    // The pocket's edited flag: reset to follow the layer, then undo brings back the edited 0.4.
    second.setParam('base.pocketDepth', null);
    expect(q.params.base.pocketDepth).toBeNull();
    expect(second.unsaved()).toBe(true);
    second.undo();
    expect(q.params.base.pocketDepth).toBe(0.4);
    expect(second.unsaved()).toBe(false);
    await q.idle();
    expect(q.geometryHash()).toEqual(before.hash);

    // Saving an opened project keeps its name.
    await second.saveProject();
    expect(saves.map((s) => s.name)).toEqual(['jersey-barrier.moldproj', 'jersey-barrier.moldproj']);
  });

  it('with the bolts on, Save and Open give the bolts back with the same geometry, and undo walks them back to the taped mold', async () => {
    const saves = captureSaves();
    let now = 0;
    const store = new Store(fresh(), () => (now += 1000), files);
    const p = store.pipeline;
    store.load(jersey, EXAMPLE_FILES.jersey);
    await p.idle();
    const taped = { project: structuredClone(p.project()), hash: p.geometryHash() };
    store.setParam('bolts.enabled', true);
    store.setParam('bolts.size', 'M4');
    store.setParam('bolts.length', 16);
    store.setParam('bolts.nutClearance', 0.2);
    await p.idle();
    expect(p.params.bolts).toEqual({ enabled: true, size: 'M4', length: 16, holeClearance: 0.2, nutClearance: 0.2, minWall: 1.2 });
    expect(p.field!.value.rim.bolts).toMatchObject({ size: 'M4', length: 16 });
    const bolted = { project: structuredClone(p.project()), hash: p.geometryHash() };
    expect(bolted.hash.cover).not.toBe(taped.hash.cover);
    expect(bolted.hash.base).not.toBe(taped.hash.base);

    await store.saveProject();
    const zip = await saves[0].bytes;
    expect((JSON.parse(text(unzipSync(zip)[PROJECT_ENTRY])) as ProjectFile).params.bolts).toEqual(bolted.project.params.bolts);
    const second = new Store(fresh(), () => (now += 1000), files);
    await second.openFile(new File([zip.slice()], 'jersey-barrier.moldproj'));
    await second.pipeline.idle();
    expect(second.pipeline.project()).toEqual(bolted.project);
    expect(second.pipeline.geometryHash()).toEqual(bolted.hash);
    expect(second.fileNotice.value).toBeNull();

    // Four steps, one per control, and back to the mold with no bolts, geometry and all.
    expect(store.history.depth.undo).toBe(4);
    for (let k = 0; k < 4; k++) store.undo();
    await p.idle();
    expect(p.project()).toEqual(taped.project);
    expect(p.geometryHash()).toEqual(taped.hash);
    for (let k = 0; k < 4; k++) store.redo();
    await p.idle();
    expect(p.geometryHash()).toEqual(bolted.hash);
  });

  it('keeps the plane in the STL\'s own coordinates: jersey raised to stand at z = 5 saves offset -5, and its base triangles lie on it', async () => {
    const p = fresh();
    const high = raised(jersey, 5);
    p.load(high, 'raised.stl');
    await p.orientedReady();
    const stored = p.storedPlane()!;
    expect(stored.normal).toEqual([0, 0, -1]);
    expect(stored.offset).toBeCloseTo(-5, 5);
    expect(stored.upper).toBe(false);
    const mesh = p.modelMesh()!;
    const t = triangleOnPlane(mesh, stored, 0.05)!;
    expect(t).not.toBeNull();
    for (let k = 0; k < 3; k++) expect(mesh.positions[mesh.indices[t * 3 + k] * 3 + 2]).toBeCloseTo(5, 5);

    // VIS-35 on its upper level: the plane kept is the level's, 0.41 mm above its lowest point read from
    // its bytes, and faces of that level lie on it; the lower plane would not be the one saved.
    const vis = fresh();
    const bytes = exampleBytes('vis35');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let minZ = Infinity;
    for (let at = 84; at < bytes.length; at += 50) for (let k = 0; k < 3; k++) minZ = Math.min(minZ, view.getFloat32(at + 12 + 12 * k + 8, true));
    vis.load(bytes, EXAMPLE_FILES.vis35);
    await vis.orientedReady();
    const level = vis.oriented!.value.candidates[0].levels.find((l) => Math.abs(l.offset - 0.41) < 0.05)!;
    vis.setPlane({ rank: 0, upper: level.offset });
    await vis.orientedReady();
    const upper = vis.storedPlane()!;
    expect(upper.normal).toEqual([0, 0, -1]);
    expect(upper.upper).toBe(level.offset);
    expect(upper.offset).toBeCloseTo(-(minZ + 0.41), 1);
    const onLevel = triangleOnPlane(vis.modelMesh()!, upper, 0.05)!;
    expect(onLevel).not.toBeNull();
    const zs = [0, 1, 2].map((k) => vis.modelMesh()!.positions[vis.modelMesh()!.indices[onLevel * 3 + k] * 3 + 2]);
    for (const z of zs) expect(Math.abs(z - (minZ + level.offset))).toBeLessThan(0.05);
    expect(Math.abs(zs[0] - minZ)).toBeGreaterThan(0.3);
  });

  it('a corrupt project says why, naming the file, and the model on screen, its settings and its history stay as they were', async () => {
    const store = new Store(fresh(), () => 0, files);
    const p = store.pipeline;
    store.load(jersey, EXAMPLE_FILES.jersey);
    await p.idle();
    store.setParam('silicone.t', 4);
    await p.idle();
    const before = { project: structuredClone(p.project()), hash: p.geometryHash(), depth: store.history.depth };
    expect(before.depth).toEqual({ undo: 1, redo: 0 });
    const good = projectFile(before.project, EXAMPLE_FILES.jersey, { modelSha256: nodeSha(jersey), basePlane: null });
    const packed = packProject(projectJson(good), jersey);
    const garbage = strToU8('solid nothing here');
    const cases: [string, Uint8Array, RegExp][] = [
      ['notes.moldproj', strToU8('hello'), /^notes\.moldproj is not a project saved by this app, as it is no ZIP archive\. Open a \.moldproj/],
      ['empty.zip', zipSync({ 'a.txt': strToU8('a') }), /^empty\.zip is not a project saved by this app, as it holds no project\.json\./],
      ['bare.moldproj', zipSync({ [PROJECT_ENTRY]: unzipSync(packed)[PROJECT_ENTRY] }), /^bare\.moldproj is damaged: the model saved inside it is missing\./],
      ['bad.moldproj', zipSync({ [PROJECT_ENTRY]: strToU8('{"schemaVersion": 2, "params"'), [MODEL_ENTRY]: jersey }), /^bad\.moldproj is damaged: its settings cannot be read\./],
      ['typed.json', strToU8(edited('params.silicone.t', 'thick')), /^typed\.json cannot be used: its Silicone thickness must be a number, not "thick"\./],
      ['newer.json', strToU8(edited('schemaVersion', 9)), /^newer\.json was saved by a newer version of the app/],
      ['cut.moldproj', packed.subarray(0, packed.length - 40), /^cut\.moldproj is damaged and cannot be unpacked\./],
      ['swapped.moldproj', zipSync({ [PROJECT_ENTRY]: strToU8(projectJson(good)), [MODEL_ENTRY]: barrel }), /^swapped\.moldproj is damaged or was changed: the model inside it is not the one its settings were saved for\./],
      ['unreadable.moldproj', zipSync({ [PROJECT_ENTRY]: strToU8(projectJson({ ...good, modelSha256: nodeSha(garbage) })), [MODEL_ENTRY]: garbage }), /^unreadable\.moldproj is damaged: the model inside it cannot be read\./],
      ['bomb.moldproj', declaredSize(packed, MODEL_ENTRY, 0xf0000000), /^bomb\.moldproj is damaged or too large: the model inside it says it unpacks to 3840 MB/],
      ['photo.png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, ...new Uint8Array(100)]), /^photo\.png is not an STL or a project file, so it was not opened\./],
    ];
    for (const [name, bytes, why] of cases) {
      await store.openFile(new File([bytes.slice()], name));
      expect(store.fileNotice.value?.severity, name).toBe('error');
      expect(store.fileNotice.value?.message, name).toMatch(why);
      expect(store.fileBusy.value, name).toBeNull();
      expect(store.replacing.value, name).toBeNull();
      expect(p.modelName, name).toBe(EXAMPLE_FILES.jersey);
      expect(p.project(), name).toEqual(before.project);
      expect(store.history.depth, name).toEqual(before.depth);
    }
    await p.idle();
    expect(p.geometryHash()).toEqual(before.hash);
  });

  it('M11: an STL is read before it replaces the model, so one that cannot be read leaves it as it was, naming the file; a clamped count loads with a warning; and the hash is known from the read', async () => {
    const store = new Store(fresh(), () => 0, files);
    const p = store.pipeline;
    // On an empty page there is no model on screen to stay, so the reason does not mention one.
    await store.openFile(new File([new Uint8Array(0)], 'first.stl'));
    expect(store.fileNotice.value).toMatchObject({ severity: 'error', message: 'first.stl cannot be opened: The file is empty. Export the STL again from the program that made it.' });
    expect(p.modelName).toBeNull();
    await store.openFile(new File([jersey.slice()], EXAMPLE_FILES.jersey));
    await p.idle();
    expect(p.modelName).toBe(EXAMPLE_FILES.jersey);
    // A small file is hashed by the export or a save, as before M11.
    expect(p.modelSha256).toBeNull();
    const before = { project: structuredClone(p.project()), hash: p.geometryHash() };
    const cube = new TextDecoder().decode(asciiStl(toSoup(box([0, 0, 0], [20, 20, 20])), 'cube'));
    const cases: [string, Uint8Array, string][] = [
      ['cut.stl', strToU8(cube.slice(0, cube.lastIndexOf('vertex') + 12)), 'The ASCII STL ends in the middle of a triangle, so it looks cut off.'],
      ['empty.stl', new Uint8Array(0), 'The file is empty.'],
      ['nothing.stl', strToU8('solid nothing\nendsolid nothing\n'), 'The STL file contains no usable triangles.'],
    ];
    for (const [name, bytes, why] of cases) {
      await store.openFile(new File([bytes.slice()], name));
      expect(store.fileNotice.value, name).toMatchObject({ severity: 'error', message: `${name} cannot be opened: ${why} The model on screen stays as it was. Export the STL again from the program that made it.` });
      expect(store.fileBusy.value, name).toBeNull();
      expect(p.modelName, name).toBe(EXAMPLE_FILES.jersey);
      expect(p.project(), name).toEqual(before.project);
    }
    await p.idle();
    expect(p.geometryHash()).toEqual(before.hash);
    // A header of 20 over 12 records: the 12 load, and the warning names the file.
    const clamped = binaryOf(toSoup(box([0, 0, 0], [20, 20, 20])), 20);
    await store.openFile(new File([clamped.slice()], 'clamped.stl'));
    expect(p.modelName).toBe('clamped.stl');
    expect(store.fileNotice.value).toEqual({ severity: 'warning', message: 'Opened clamped.stl, with a warning.', notes: [{ severity: 'warning', message: 'The file header says 20 triangles but the file holds only 12, so it looks cut off: the 12 were read. Export the STL again from the program that made it.' }] });
    await p.idle();
    expect(p.parsed!.value.triangles).toBe(12);
    // From 32 MB the check works out the hash, so the export is not sent a copy of the file to hash.
    const big = new Uint8Array(84 + 50 * Math.ceil(HASH_ON_READ_BYTES / 50));
    new DataView(big.buffer).setUint32(80, (big.length - 84) / 50, true);
    // Every record a triangle of three distinct corners, so the file is a readable STL.
    for (let t = 0, view = new DataView(big.buffer); t < (big.length - 84) / 50; t++) for (let k = 0; k < 9; k++) view.setFloat32(84 + 50 * t + 12 + 4 * k, k === 0 ? t % 1000 : k === 4 ? 1 : k === 8 ? 1 + (t % 7) : 0, true);
    await store.openFile(new File([big.slice()], 'big.stl'));
    expect(p.modelName).toBe('big.stl');
    expect(p.modelSha256).toBe(nodeSha(big));
  }, 120_000);

  it('settings from an export ZIP or a project.json apply to the same model in full and as one step, and count as saved; to another model, its parameters alone; with no model, a note', async () => {
    const store = new Store(fresh(), () => 0, files);
    const p = store.pipeline;
    // No model yet: a note, and nothing changes.
    await store.openFile(new File([fixture('v1-jersey-export.json')], 'project.json'));
    expect(store.fileNotice.value).toMatchObject({ severity: 'warning', message: 'project.json holds the settings for jersey-barrier.stl, but not the model itself. Open jersey-barrier.stl first, then open project.json again to use them.' });
    expect(p.modelName).toBeNull();

    store.load(jersey, EXAMPLE_FILES.jersey);
    await p.idle();
    store.setParam('silicone.t', 5);
    expect(store.unsaved()).toBe(true);
    // The version 1 fixture has no hash, so it is matched by name: all of it applies, as one undoable step.
    const v1 = JSON.parse(fixture('v1-jersey-export.json')) as ProjectFile;
    await store.openFile(new File([fixture('v1-jersey-export.json')], 'project.json'));
    expect(store.fileNotice.value).toEqual({
      severity: 'info',
      message: 'Applied the settings of project.json to jersey-barrier.stl.',
      notes: [
        { severity: 'info', message: 'Saved in project format 1 by an earlier version of the app, and brought up to format 4.' },
        { severity: 'info', message: 'project.json does not record its model\'s contents, so it was matched to jersey-barrier.stl by the file name alone.' },
      ],
    });
    // Migrated, so with the bolts off as version 1 molds were.
    const params = { ...v1.params, bolts: V3_BOLTS } as ProjectFile['params'];
    expect(p.project()).toEqual({ params, plane: v1.plane, pins: v1.pins, removed: v1.removed });
    // The file opens again to just this, so leaving the page now loses nothing.
    expect(store.unsaved()).toBe(false);
    expect(store.history.depth).toEqual({ undo: 2, redo: 0 });
    expect(store.history.undoLabel).toBe('opening the settings of project.json');
    await p.idle();
    expect(p.placement!.value.placement.openings.find((o) => o.id === v1.pins[0].id)).toMatchObject({ x: v1.pins[0].x, y: v1.pins[0].y, pinned: true });
    expect(p.placement!.value.placement.openings.some((o) => o.id === v1.removed[0])).toBe(false);
    store.undo();
    expect(p.project().pins).toEqual([]);
    expect(p.params.silicone.t).toBe(5);

    // The same settings saved for another model of the same name, by hash: the parameters only.
    const other = projectFile({ params, plane: { rank: 2, upper: false }, pins: v1.pins, removed: v1.removed }, EXAMPLE_FILES.jersey, { modelSha256: nodeSha(barrel), basePlane: null });
    const zip = zipSync({ 'cover.stl': new Uint8Array(84), [PROJECT_ENTRY]: strToU8(projectJson(other)) });
    await store.openFile(new File([zip.slice()], 'barrel-mold.zip'));
    expect(store.fileNotice.value).toMatchObject({ severity: 'warning', message: 'barrel-mold.zip was saved for another model of the same name, jersey-barrier.stl, whose contents differ from the one on screen, so only its settings were applied: the model keeps its own base face, pinned openings and removed vents.' });
    expect(p.project()).toEqual({ params, plane: DEFAULT_PLANE, pins: [], removed: [] });
    expect(p.modelSha256).toBe(nodeSha(jersey));
    const renamed = zipSync({ [PROJECT_ENTRY]: strToU8(projectJson({ ...other, model: 'cube.stl' })) });
    await store.openFile(new File([renamed.slice()], 'cube-mold.zip'));
    expect(store.fileNotice.value?.message).toBe('cube-mold.zip was saved for cube.stl, not jersey-barrier.stl, so only its settings were applied: the model keeps its own base face, pinned openings and removed vents.');
  });

  it('bodiesByPart goes by the format, and by the app version only for format 3, where 1.0.1 alone had joined parts', () => {
    const cases: [number, string, boolean][] = [
      [1, '0.1.0', true],
      [2, '0.2.0', true],
      [3, '0.3.0', true],
      [3, '1.0.0', true],
      [3, '1.0.1', false],
      // Only that exact build: a format 3 file never came from anything else that joined parts.
      [3, '1.0.1-local+a1b2c3d', true],
      [3, 'unknown', true],
      [4, BUILD.version, false],
      [4, '0.1.0', false],
      // A format 4 file keeps its pins whatever version it names: no version number is compared.
      [4, '1.0.0', false],
      [5, '0.0.1', false],
    ];
    expect(cases.map(([format, appVersion]) => bodiesByPart({ format, appVersion }))).toEqual(cases.map(([, , reset]) => reset));
  });

  it('R1: a project of format 3 saved by 1.0.0, of a model whose parts are one body now, opens with its moved openings and removed vents reset and a warning; format 3 saved by 1.0.1, and format 4 whatever version it names, keep them, as does a model of one part', async () => {
    // A box with a part on top: two parts, one body since 1.0.1, where 1.0.0 numbered the top part body 1.
    const hat = asciiStl(toSoup(joinMeshes(box([0, 0, 0], [30, 30, 10]), box([10, 10, 10], [20, 20, 16]))), 'hat');
    const p = fresh();
    p.load(hat, 'hat.stl');
    await p.idle();
    const old: Project = { ...structuredClone(p.project()), pins: [{ id: 'b1:pour:0', kind: 'pour', x: 15, y: 15 }], removed: ['b0:vent:beside'] };
    const json = (schemaVersion: number, appVersion: string): string => projectJson({ ...projectFile(old, 'hat.stl', { modelSha256: null, basePlane: null }), schemaVersion, appVersion });
    const saved = (schemaVersion: number, appVersion: string): File => new File([packProject(json(schemaVersion, appVersion), hat).slice()], 'hat.moldproj');
    const opened = async (file: File): Promise<Store> => {
      const store = new Store(fresh(), () => 0, files);
      await store.openFile(file);
      await store.pipeline.idle();
      return store;
    };

    const store = await opened(saved(3, '1.0.0'));
    expect(store.pipeline.project().pins).toEqual([]);
    expect(store.pipeline.project().removed).toEqual([]);
    expect(store.pipeline.diagnostics.find((d) => d.code === 'openings-reset')).toEqual({
      code: 'openings-reset',
      severity: 'warning',
      message: 'This project was saved by an early test build of the app (1.0.0), from before the public versions, which took each part of the file for a model of its own. Parts that overlap or touch are now one model, so the openings it moved and the vents it removed were reset: move or remove them again.',
    });
    // Its one body has its own pour and the vent beside it.
    expect(store.pipeline.placement!.value.placement.openings.map((o) => [o.id, o.pinned])).toEqual([['b0:pour:0', false], ['b0:vent:beside', false]]);
    // The project on screen is no longer the file's, so leaving asks first.
    expect(store.unsaved()).toBe(true);

    // Format 3 by 1.0.1, the one internal build with the rule, and format 4 by this build or naming any
    // version: their pins name this numbering, and they stay.
    for (const [format, version] of [[3, '1.0.1'], [4, BUILD.version], [4, '1.0.0']] as const) {
      const kept = await opened(saved(format, version));
      expect(kept.pipeline.project(), `${format} ${version}`).toMatchObject({ pins: old.pins, removed: old.removed });
      expect(kept.pipeline.diagnostics.some((d) => d.code === 'openings-reset'), `${format} ${version}`).toBe(false);
    }
    // A format 3 file that names 0.1.0, which never wrote format 3, is reset as any other format 3 one.
    expect((await opened(saved(3, '0.1.0'))).pipeline.project().pins).toEqual([]);

    // What a save writes now is format 4 with this build's version, and it opens with its pins.
    expect(JSON.parse(projectJson(projectFile(old, 'hat.stl', { modelSha256: null, basePlane: null })))).toMatchObject({ schemaVersion: 4, appVersion: BUILD.version });

    // A model of one part numbers its body the same in every version, so a 1.0.0 project of it keeps them.
    const jerseyPins: Project = { ...old, pins: [{ id: 'b0:pour:0', kind: 'pour', x: 3, y: 0 }], removed: [] };
    const q = fresh();
    q.loadProject(jersey, EXAMPLE_FILES.jersey, jerseyPins, null, null, { format: 3, appVersion: '1.0.0' });
    await q.idle();
    expect(q.project().pins).toEqual(jerseyPins.pins);
    expect(q.diagnostics.some((d) => d.code === 'openings-reset')).toBe(false);

    // Settings from a format 3 project.json by 1.0.0, applied to the model on screen, are reset the same way,
    // in the same step; from a format 4 one they stay.
    const r = new Store(fresh(), () => 0, files);
    r.pipeline.load(hat, 'hat.stl');
    await r.pipeline.idle();
    await r.openFile(new File([json(3, '1.0.0')], 'project.json'));
    expect(r.pipeline.project()).toMatchObject({ pins: [], removed: [] });
    await r.pipeline.idle();
    expect(r.pipeline.diagnostics.find((d) => d.code === 'openings-reset')?.message).toContain('saved by an early test build of the app (1.0.0), from before the public versions');
    await r.openFile(new File([json(4, BUILD.version)], 'project.json'));
    await r.pipeline.idle();
    expect(r.pipeline.project()).toMatchObject({ pins: old.pins, removed: old.removed });
  });

  it('a saved plane its choice no longer finds is found under another choice, pins kept; one found nowhere warns and keeps the best guess', async () => {
    const p = fresh();
    p.load(jersey, EXAMPLE_FILES.jersey);
    await p.idle();
    const { candidates } = p.oriented!.value;
    expect(candidates.length).toBeGreaterThan(1);
    const [pour] = p.placement!.value.placement.openings.filter((o) => o.kind === 'pour');
    p.dropOpening(pour.id, pour.x - 1, pour.y);
    await p.idle();
    const project = structuredClone(p.project());
    const hash = p.geometryHash();
    const stored = { ...planeOf(candidates[0]), upper: false as const };

    // As if a later version ranked the faces the other way round: the file says rank 1, and meant rank 0's plane.
    const q = fresh();
    let resolved: unknown = null;
    q.onPlaneResolved = (from, to) => (resolved = { from, to });
    q.loadProject(jersey, EXAMPLE_FILES.jersey, { ...project, plane: { rank: 1, upper: false } }, stored, null);
    await q.idle();
    expect(q.project()).toEqual(project);
    expect(resolved).toEqual({ from: { rank: 1, upper: false }, to: { rank: 0, upper: false } });
    expect(q.diagnostics.find((d) => d.code === 'plane-found')).toMatchObject({ severity: 'info', message: 'The base face saved with this project, facing −Z, is candidate 1 in this version of the app, which numbers the faces differently, so the model stands on it as saved.' });
    expect(q.geometryHash()).toEqual(hash);

    // A plane tilted 20 degrees, which jersey has no face on: the choice stands, with a warning.
    const tilt = (20 * Math.PI) / 180;
    const r = fresh();
    r.loadProject(jersey, EXAMPLE_FILES.jersey, project, { normal: [0, Math.sin(tilt), -Math.cos(tilt)], offset: 0, upper: false }, null);
    await r.idle();
    expect(r.project()).toEqual(project);
    const warning = r.diagnostics.find((d) => d.code === 'plane-mismatch')!;
    expect(warning.severity).toBe('warning');
    expect(warning.message).toBe('The base face saved with this project, facing −Z 20.0°, is not one this version of the app finds, so the model stands on candidate 1, which faces −Z. Check the base face before you export.');
    // Choosing a face oneself ends the warning.
    r.setPlane({ rank: 1, upper: false });
    await r.idle();
    expect(r.diagnostics.some((d) => d.code === 'plane-mismatch')).toBe(false);
  });

  it('a project whose plane is found under another choice opens with nothing unsaved; settings resolved so rewrite only their own steps, so undo goes back to the user\'s own face', async () => {
    let now = 0;
    const store = new Store(fresh(), () => (now += 1000), files);
    const p = store.pipeline;
    store.load(jersey, EXAMPLE_FILES.jersey);
    await p.idle();
    const ranks = p.oriented!.value.candidates.map((c) => ({ ...planeOf(c), upper: false as const }));
    const at = (t: number, plane: Project['plane']): Project => ({ ...structuredClone(p.project()), params: { ...structuredClone(p.params), silicone: { ...p.params.silicone, t } }, plane });

    // A .moldproj that says rank 1 for rank 0's plane: found, and nothing to save, as the file means this.
    const resolvedFile = projectFile({ ...p.project(), plane: { rank: 1, upper: false } }, EXAMPLE_FILES.jersey, { modelSha256: nodeSha(jersey), basePlane: ranks[0] });
    await store.openFile(moldproj(resolvedFile));
    await p.idle();
    expect(p.project().plane).toEqual({ rank: 0, upper: false });
    expect(p.diagnostics.some((d) => d.code === 'plane-found')).toBe(true);
    expect(store.history.depth).toEqual({ undo: 0, redo: 0 });
    expect(store.unsaved()).toBe(false);

    // The user's own steps on rank 0, then settings for this model that say rank 0 and mean rank 1's face.
    store.setParam('silicone.t', 4);
    store.setParam('silicone.t', 5);
    const atRank1 = projectFile(at(6, { rank: 0, upper: false }), EXAMPLE_FILES.jersey, { modelSha256: nodeSha(jersey), basePlane: ranks[1] });
    await store.openFile(settingsJson(atRank1));
    await p.idle();
    expect(p.project().plane).toEqual({ rank: 1, upper: false });
    expect(p.params.silicone.t).toBe(6);
    expect(store.unsaved()).toBe(false);
    const undone = (): [number, Project['plane']] => {
      store.undo();
      return [p.params.silicone.t, p.project().plane];
    };
    expect([undone(), undone(), undone()]).toEqual([
      [5, { rank: 0, upper: false }],
      [4, { rank: 0, upper: false }],
      [3, { rank: 0, upper: false }],
    ]);

    // Settings whose choice is looked for after they apply, with a step of the user's in between: that
    // step was taken on the file's face, so it moves with it, and the apply's own "before" does not.
    store.setPlane({ rank: 2, upper: false });
    await p.idle();
    await store.openFile(settingsJson(projectFile(at(6, { rank: 0, upper: false }), EXAMPLE_FILES.jersey, { modelSha256: nodeSha(jersey), basePlane: ranks[1] })));
    expect(p.project().plane).toEqual({ rank: 0, upper: false });
    store.setParam('silicone.t', 7);
    await p.idle();
    expect(p.project().plane).toEqual({ rank: 1, upper: false });
    expect(undone()).toEqual([6, { rank: 1, upper: false }]);
    expect(undone()).toEqual([3, { rank: 2, upper: false }]);
  });

  it('a picked face past the end of the mesh, as another version\'s weld can leave it, is no crash: the saved plane is found, or the best-ranked face is used with a warning', async () => {
    const reference = fresh();
    reference.load(jersey, EXAMPLE_FILES.jersey);
    await reference.idle();
    const rank0 = { ...planeOf(reference.oriented!.value.candidates[0]), upper: false as const };
    const hash = reference.geometryHash();
    const triangles = reference.modelMesh()!.indices.length / 3;
    expect(triangles).toBe(1340);

    const store = new Store(fresh(), () => 0, files);
    const p = store.pipeline;
    const base = projectFile(reference.project(), EXAMPLE_FILES.jersey, { modelSha256: nodeSha(jersey), basePlane: rank0 });
    await store.openFile(moldproj({ ...base, plane: { pick: triangles, upper: false } }));
    await p.idle();
    expect(p.status().error).toBeNull();
    expect(p.project().plane).toEqual({ rank: 0, upper: false });
    expect(p.cellScale()).toBe(1);
    expect(p.diagnostics.map((d) => d.code).filter((code) => code.startsWith('plane-') || code === 'preview-coarser')).toEqual(['plane-found']);
    expect(p.geometryHash()).toEqual(hash);
    expect(store.unsaved()).toBe(false);

    // With no saved plane to look for, the best-ranked face, and a warning that names the face.
    await store.openFile(moldproj({ ...base, basePlane: null, plane: { pick: 1e8, upper: false } }));
    await p.idle();
    expect(p.status().error).toBeNull();
    expect(p.project().plane).toEqual({ rank: 0, upper: false });
    expect(p.diagnostics.find((d) => d.code === 'plane-mismatch')).toMatchObject({ severity: 'warning', message: 'The face picked as the base, triangle 100000001, is not a face of this model as this version of the app reads it, so the model stands on candidate 1. Check the base face before you export.' });
    expect(p.geometryHash()).toEqual(hash);
    expect(store.unsaved()).toBe(false);
    // A face chosen afterwards builds at the same cell as a fresh load would.
    store.setPlane({ rank: 1, upper: false });
    await p.idle();
    expect(p.cellScale()).toBe(1);
    expect(p.diagnostics.some((d) => d.code === 'plane-mismatch' || d.code === 'preview-coarser')).toBe(false);
  });

  it('a newer open or load supersedes a project still being read, and an STL that cannot be read cannot be saved', async () => {
    const saves = captureSaves();
    // A project worker that holds its job until released, so the load comes while the open waits for it.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow = new ProjectFiles(() => {
      const inner = inProcessProject();
      const outer: WorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage: (message, transfer) => void held.then(() => inner.postMessage(message, transfer)),
        terminate: () => inner.terminate(),
      };
      inner.onmessage = (event) => outer.onmessage?.(event);
      return outer;
    });
    const store = new Store(fresh(), () => 0, slow);
    const p = store.pipeline;
    const opening = store.openFile(moldproj(file()));
    await vi.waitFor(() => expect(store.fileBusy.value).toBe('Opening jersey-barrier.moldproj…'));
    store.load(barrel, EXAMPLE_FILES.barrel);
    release();
    await opening;
    expect(p.modelName).toBe(EXAMPLE_FILES.barrel);
    expect(store.projectName.value).toBeNull();
    expect(store.fileBusy.value).toBeNull();
    expect(store.fileNotice.value).toBeNull();

    // An ASCII STL cut off mid-triangle: the error shows, and Save project does nothing but say why.
    store.load(strToU8('solid broken\nfacet normal 0 0 1\n outer loop\n vertex 0 0 0\n'), 'broken.stl');
    await p.idle();
    expect(p.status().error).toBe('The ASCII STL ends in the middle of a triangle, so it looks cut off.');
    expect(store.canSave()).toBe(false);
    await store.saveProject();
    expect(saves).toEqual([]);
    expect(store.fileNotice.value).toMatchObject({ severity: 'error', message: 'broken.stl cannot be saved as a project, as it could not be read. Open an STL that loads, then save.' });
  });

  it('a file that would replace a model with unsaved changes asks first: cancel keeps it, save saves then opens, and opening without saving opens', async () => {
    const saves = captureSaves();
    let now = 0;
    const store = new Store(fresh(), () => (now += 1000), files);
    const p = store.pipeline;
    store.load(jersey, EXAMPLE_FILES.jersey);
    await p.idle();
    // Nothing changed: an STL replaces it at once.
    await store.openFile(new File([barrel.slice()], EXAMPLE_FILES.barrel));
    expect(p.modelName).toBe(EXAMPLE_FILES.barrel);
    await p.idle();
    store.setParam('silicone.t', 4);
    await store.openFile(new File([jersey.slice()], EXAMPLE_FILES.jersey));
    expect(store.replacing.value).toEqual({ name: EXAMPLE_FILES.jersey, model: EXAMPLE_FILES.barrel });
    await store.answerReplace('cancel');
    expect(store.replacing.value).toBeNull();
    expect(p.modelName).toBe(EXAMPLE_FILES.barrel);
    expect(p.params.silicone.t).toBe(4);
    expect(store.history.depth).toEqual({ undo: 1, redo: 0 });

    // Settings alone never ask: they are one step undo takes back.
    await store.openFile(settingsJson(projectFile({ ...p.project(), params: { ...p.params, silicone: { ...p.params.silicone, t: 4.5 } } }, EXAMPLE_FILES.barrel, { modelSha256: nodeSha(barrel), basePlane: null })));
    expect(store.replacing.value).toBeNull();
    expect(p.params.silicone.t).toBe(4.5);
    store.setParam('silicone.t', 4);

    await store.openFile(new File([jersey.slice()], EXAMPLE_FILES.jersey));
    expect(store.replacing.value).not.toBeNull();
    await store.answerReplace('save');
    expect(saves.map((s) => s.name)).toEqual(['l_medieval_barrel.moldproj']);
    expect(JSON.parse(text(unzipSync(await saves[0].bytes)[PROJECT_ENTRY])).params.silicone.t).toBe(4);
    expect(p.modelName).toBe(EXAMPLE_FILES.jersey);
    expect(store.replacing.value).toBeNull();
    await p.idle();

    store.setParam('silicone.t', 5);
    await store.openFile(new File([barrel.slice()], EXAMPLE_FILES.barrel));
    // A newer file supersedes the question.
    await store.openFile(new File([barrel.slice()], 'barrel copy.stl'));
    expect(store.replacing.value).toEqual({ name: 'barrel copy.stl', model: EXAMPLE_FILES.jersey });
    await store.answerReplace('discard');
    expect(p.modelName).toBe('barrel copy.stl');
    expect(store.history.depth).toEqual({ undo: 0, redo: 0 });
    expect(saves).toHaveLength(1);
  });
});
