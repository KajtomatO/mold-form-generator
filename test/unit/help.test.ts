import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Pipeline } from '../../src/app/pipeline';
import { MOLD_TYPE_IDS } from '../../src/core/mold/types';
import { GALLERY, GALLERY_IDS, galleryEntry } from '../../src/gallery/catalogue';
import { buildHelpParts } from '../../src/help/build';
import { HELP_MODEL } from '../../src/help/config';
import { EXPLODE_FPS, EXPLODE_FRAMES, EXPLODE_GRID, EXPLODE_MAX_BYTES, EXPLODE_SCALE, EXPLODE_SIZE, easeOut, explodeAt, explodeFile, framePosition, HELP_THEMES, helpParts, partsSha256, type ExplodeManifest, type HelpParts } from '../../src/help/media';
import { HELP, helpTopic, isHelpId } from '../../src/help/topics';
import { MOLD_TYPE_UI } from '../../src/ui/mold/moldTypeUi';
import { inProcessField, inProcessSolid } from '../fixtures/inProcessWorker';
import { GALLERY_DIR, loadGallery } from '../fixtures/loadGallery';

const root = join(import.meta.dirname, '..', '..');
const HELP_DIR = join(root, 'public', 'help');
const REDRAW = 'run npm run media -- explode';

/** Every file under src/, relative to the root. */
function sources(dir = join(root, 'src')): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []));
}

/**
 * Every help id src/ names in place: `data-help="<id>"`, `<HelpButton id="<id>"`, and each mold type's `help` in
 * moldTypeUi.ts. An id held in a variable is a topic's own, which the registry gave it; "<id>" in a comment is none.
 */
function helpIdsIn(text: string): string[] {
  return [/data-help="([^"<>]+)"/g, /<HelpButton\s+id="([^"<>]+)"/g].flatMap((pattern) => [...text.matchAll(pattern)].map((m) => m[1]));
}

function usedHelpIds(): { id: string; file: string }[] {
  const used: { id: string; file: string }[] = [];
  for (const file of sources()) for (const id of helpIdsIn(readFileSync(file, 'utf8'))) used.push({ id, file: relative(root, file) });
  for (const ui of Object.values(MOLD_TYPE_UI)) used.push({ id: ui.help, file: 'src/ui/mold/moldTypeUi.ts' });
  return used;
}

/** A WebP's canvas width and height, from its VP8X chunk, which a picture with alpha has. */
function webpSize(bytes: Buffer): [number, number] | null {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.toString('ascii', 12, 16) !== 'VP8X') return null;
  return [bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1];
}

const manifest = (): ExplodeManifest => JSON.parse(readFileSync(join(HELP_DIR, 'explode.json'), 'utf8')) as ExplodeManifest;

/** HELP_MODEL's parts for each type, as the media page builds them, in process. */
async function helpModelParts(type: (typeof MOLD_TYPE_IDS)[number]): Promise<HelpParts> {
  const entry = galleryEntry(HELP_MODEL)!;
  const pipeline = new Pipeline({ spawnField: inProcessField, spawnSolid: inProcessSolid, frozen: true });
  try {
    return await buildHelpParts(pipeline, loadGallery(HELP_MODEL), entry.file, type);
  } finally {
    pipeline.dispose();
  }
}

describe('HB: the help registry (R46)', () => {
  it('every help id used in src/, by data-help, <HelpButton id> or a mold type\'s topic, is in the registry', () => {
    const used = usedHelpIds();
    // The switch's "?" and its tiles' topics, at the least.
    expect(used.map((u) => u.id)).toEqual(expect.arrayContaining(['mold.type', 'mold.one-piece', 'mold.clamshell']));
    expect(used.filter((u) => !isHelpId(u.id))).toEqual([]);
    // Negative control: an id the registry does not hold is found and refused.
    const found = helpIdsIn('<button data-help="mold.box" /> <HelpButton id="seam-tape" /> {/* data-help="<id>" */}');
    expect(found).toEqual(['mold.box', 'seam-tape']);
    expect(found.filter((id) => !isHelpId(id))).toEqual(found);
  });

  it('each topic has a title, a summary and text; what it leads on to is in the registry; each type\'s topic shows that type\'s animation', () => {
    for (const [id, topic] of Object.entries(HELP)) {
      expect(topic.title, id).not.toBe('');
      expect(topic.summary, id).toMatch(/\.$/);
      expect(topic.body.length, id).toBeGreaterThan(0);
      for (const related of topic.related ?? []) expect(isHelpId(related), `${id} leads on to ${related}`).toBe(true);
    }
    expect(HELP['mold.type'].related).toEqual(MOLD_TYPE_IDS.map((type) => MOLD_TYPE_UI[type].help));
    for (const type of MOLD_TYPE_IDS) expect(helpTopic(MOLD_TYPE_UI[type].help)?.media).toEqual({ kind: 'animation', type });
    // A tile's hint card says its topic's summary, which is the tile's own blurb.
    for (const type of MOLD_TYPE_IDS) expect(helpTopic(MOLD_TYPE_UI[type].help)?.summary).toBe(MOLD_TYPE_UI[type].blurb);
    expect(helpTopic('none')).toBeNull();
  });

  it('HELP_MODEL is one of the gallery\'s own models, CC0, with its file on disk, so the help needs no credit', () => {
    expect(GALLERY.map((e) => e.id)).toEqual([...GALLERY_IDS]);
    const entry = galleryEntry(HELP_MODEL);
    expect(entry).not.toBeNull();
    expect(entry!.own).toBe(true);
    expect(entry!.licence).toBe('CC0-1.0');
    expect(readdirSync(GALLERY_DIR)).toContain(entry!.file);
  });
});

describe('HB: the explode animations', () => {
  it('explode.json names HELP_MODEL and its file\'s sha256, the mold types, and the frames, grid, size and rate the app plays', () => {
    const m = manifest();
    expect(m.model, REDRAW).toBe(HELP_MODEL);
    expect(m.modelSha256, `public/gallery/${galleryEntry(HELP_MODEL)!.file} changed: ${REDRAW}`).toBe(createHash('sha256').update(loadGallery(HELP_MODEL)).digest('hex'));
    expect(Object.keys(m.types)).toEqual([...MOLD_TYPE_IDS]);
    expect({ frames: m.frames, grid: m.grid, size: m.size, scale: m.scale, fps: m.fps }).toEqual({ frames: EXPLODE_FRAMES, grid: [...EXPLODE_GRID], size: [...EXPLODE_SIZE], scale: EXPLODE_SCALE, fps: EXPLODE_FPS });
    for (const type of MOLD_TYPE_IDS) expect(m.types[type].partsSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it(`each type has a sheet in both themes, WebP of the grid's size, under ${EXPLODE_MAX_BYTES} bytes, and public/help/ holds nothing else`, () => {
    const files = MOLD_TYPE_IDS.flatMap((type) => HELP_THEMES.map((theme) => explodeFile(type, theme)));
    expect(readdirSync(HELP_DIR).sort()).toEqual([...files, 'explode.json'].sort());
    expect(EXPLODE_GRID[0] * EXPLODE_GRID[1]).toBe(EXPLODE_FRAMES);
    for (const file of files) {
      const bytes = readFileSync(join(HELP_DIR, file));
      expect(bytes.length, file).toBeLessThan(EXPLODE_MAX_BYTES);
      expect(webpSize(bytes), file).toEqual([EXPLODE_SIZE[0] * EXPLODE_GRID[0], EXPLODE_SIZE[1] * EXPLODE_GRID[1]]);
    }
  });

  it('the frames ease out from at rest to the reach, and each lies at its place in the sheet', () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(explodeAt(0, 20)).toBe(0);
    expect(explodeAt(EXPLODE_FRAMES - 1, 20)).toBe(20);
    const steps = Array.from({ length: EXPLODE_FRAMES }, (_, k) => explodeAt(k, 1));
    for (let k = 1; k < steps.length; k++) {
      expect(steps[k]).toBeGreaterThan(steps[k - 1]);
      // Ease out: each step no longer than the one before.
      if (k > 1) expect(steps[k] - steps[k - 1]).toBeLessThanOrEqual(steps[k - 1] - steps[k - 2] + 1e-12);
    }
    expect(framePosition(0)).toEqual([0, 0]);
    expect(framePosition(4)).toEqual([100, 0]);
    expect(framePosition(5)[0]).toBe(0);
    expect(framePosition(5)[1]).toBeCloseTo(100 / 3, 9);
    expect(framePosition(EXPLODE_FRAMES - 1)).toEqual([100, 100]);
  });

  it('the parts\' hash reads every part\'s name, vertices to 0.001 mm and triangles, each field\'s grid and heights, and the split', () => {
    const mesh = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
    const base = partsSha256(helpParts({ cover: mesh, base: mesh }));
    const nudged = { positions: new Float32Array([0, 0, 0, 1.0001, 0, 0, 0, 1, 0]), indices: mesh.indices };
    expect(partsSha256(helpParts({ cover: nudged, base: mesh }))).toBe(base);
    const moved = { positions: new Float32Array([0, 0, 0, 1.002, 0, 0, 0, 1, 0]), indices: mesh.indices };
    expect(partsSha256(helpParts({ cover: moved, base: mesh }))).not.toBe(base);
    expect(partsSha256(helpParts({ cover: mesh, base: { ...mesh, indices: new Uint32Array([0, 2, 1]) } }))).not.toBe(base);
    expect(partsSha256(helpParts({ cover: { ...mesh, halves: [mesh, mesh] }, base: mesh }))).not.toBe(base);
    // The silicone and the split count too, as the sheets draw them.
    const field = { nx: 2, ny: 1, cell: 1, x0: 0, y0: 0, values: new Float32Array([1, 2]) };
    const withField = partsSha256(helpParts({ cover: mesh, base: mesh, field: { field } }));
    expect(withField).not.toBe(base);
    expect(partsSha256(helpParts({ cover: mesh, base: mesh, field: { field: { ...field, values: new Float32Array([1, 2.0001]) } } }))).toBe(withField);
    expect(partsSha256(helpParts({ cover: mesh, base: mesh, field: { field: { ...field, values: new Float32Array([1, 2.01]) } } }))).not.toBe(withField);
    expect(partsSha256(helpParts({ cover: mesh, base: mesh, field: { field: { ...field, x0: 0.5 } } }))).not.toBe(withField);
    const clam = (xs: number, hs = 0) => ({ field, clam: { axis: 'x', xs, sides: [{ field, hs }, { field, hs }] } });
    const split = partsSha256(helpParts({ cover: mesh, base: mesh, field: clam(0) }));
    expect(split).not.toBe(withField);
    expect(partsSha256(helpParts({ cover: mesh, base: mesh, field: clam(0.01) }))).not.toBe(split);
    expect(partsSha256(helpParts({ cover: mesh, base: mesh, field: clam(0, 0.01) }))).not.toBe(split);
    expect(partsSha256(helpParts({ cover: mesh, base: mesh, field: { ...clam(0), clam: { ...clam(0).clam, axis: 'y' } } }))).not.toBe(split);
  });

  // In the quick suite: the sphere's parts build in process in under a second, and the hash is the stronger check.
  it('HELP_MODEL yields parts for every type, and they, the silicone and the split are those the animations show (partsSha256)', async () => {
    const m = manifest();
    const names: Record<string, string[]> = {};
    for (const type of MOLD_TYPE_IDS) {
      const built = await helpModelParts(type);
      names[type] = [...built.parts.map((p) => p.name), ...built.fields.map((f) => f.name), ...(built.split ? ['split'] : [])];
      for (const part of built.parts) expect(part.mesh.indices.length, `${type} ${part.name}`).toBeGreaterThan(0);
      for (const { name, field } of built.fields) expect(field.values.length, `${type} ${name}`).toBe(field.nx * field.ny);
      expect(partsSha256(built), `the ${type} parts changed: ${REDRAW}`).toBe(m.types[type].partsSha256);
    }
    expect(names).toEqual({ 'one-piece': ['cover', 'base', 'silicone'], clamshell: ['cover-neg', 'cover-pos', 'base', 'silicone-neg', 'silicone-pos', 'split'] });
  }, 120_000);
});
