import { moldExtent } from '../app/derived';
import { Pipeline } from '../app/pipeline';
import { toMat4 } from '../core/base/orient';
import { frameInverse } from '../core/field/frames';
import { MOLD_TYPE_IDS, type MoldTypeId } from '../core/mold/types';
import { parseStl } from '../core/stl/parse';
import { GALLERY, galleryEntry } from '../gallery/catalogue';
import { galleryUrl } from '../gallery/open';
import { buildHelpParts } from '../help/build';
import { HELP_MODEL } from '../help/config';
import { EXPLODE_FRAMES, EXPLODE_GRID, EXPLODE_QUALITY, EXPLODE_REACH, EXPLODE_SIZE, explodeAt, HELP_THEMES, partsSha256, type HelpTheme } from '../help/media';
import styles from '../ui/style.css?raw';
import { frameFixed } from '../view/fixedView';
import { PreviewScene, type ViewSide } from '../view/scene';
import { ThumbnailRenderer } from '../view/thumbnail';
import type { WorkerLike } from '../workers/protocol';

/**
 * GA: the media page (media.html), which scripts/make-help-media.mjs drives in Playwright's Chromium. It draws each
 * gallery model as the view draws a model (src/view/thumbnail.ts) and hands back the picture as WebP. HB: it draws
 * the help's explode animations here too, each mold type's real parts built from HELP_MODEL by the pipeline's own
 * workers and drawn by the view itself (src/view/scene.ts), its explode stepped frame by frame into a sprite sheet.
 */

/** A thumbnail's side in pixels, as public/gallery/thumbs/ holds them. */
export const THUMB_SIZE = 192;

/** The animations' one view: orthographic, this far round from the front and up from the bed, in degrees. */
const AZIMUTH_DEG = 35;
const ELEVATION_DEG = 30;
/** The space left round the parts at their furthest apart, as a share of the frame: less detail keeps each sheet under EXPLODE_MAX_BYTES. */
const MARGIN = 1.2;

export interface MediaHooks {
  /** The gallery's models, in its order: each id, and the file its thumbnail is saved as. */
  entries(): { id: string; thumbnail: string }[];
  /** One model's thumbnail, as a data: URL of a WebP. */
  thumbnail(id: string): Promise<string>;
  /** HB: the mold types, in their tiles' order, and the model the animations show. */
  types(): readonly string[];
  helpModel(): string;
  /** HB: one type's animation, a sprite sheet per theme as a data: URL of a WebP, and the hash of the parts it shows. */
  explode(type: string): Promise<{ partsSha256: string; sheets: Record<HelpTheme, string> }>;
}

const renderer = new ThumbnailRenderer(THUMB_SIZE);

function show(url: string, alt: string, width: number, height: number): void {
  const img = document.createElement('img');
  img.src = url;
  img.alt = alt;
  img.width = width;
  img.height = height;
  document.querySelector('#out')!.append(img);
}

async function thumbnail(id: string): Promise<string> {
  const entry = galleryEntry(id);
  if (!entry) throw new Error(`The gallery has no model "${id}".`);
  const response = await fetch(galleryUrl(entry.file));
  if (!response.ok) throw new Error(`Could not fetch gallery/${entry.file}: ${response.status}`);
  const url = renderer.draw(parseStl(new Uint8Array(await response.arrayBuffer())).positions);
  show(url, entry.title, THUMB_SIZE, THUMB_SIZE);
  return url;
}

/** Each theme's --ink, read from the app's own stylesheet, so the outlines follow it. */
function inkOf(theme: HelpTheme): [number, number, number] {
  const block = theme === 'dark' ? /:root\s*\{([^}]*)\}/.exec(styles) : /:root\[data-theme='light'\]\s*\{([^}]*)\}/.exec(styles);
  const ink = block && /--ink:\s*#([0-9a-f]{6})\s*;/i.exec(block[1]);
  if (!ink) throw new Error(`src/ui/style.css has no --ink for the ${theme} theme.`);
  const value = parseInt(ink[1], 16);
  return [value >> 16, (value >> 8) & 255, value & 255];
}

/** The outline's width in pixels, one CSS pixel at the 2x the help shows a frame at, and its opacity. */
const OUTLINE_PX = 2;
const OUTLINE_ALPHA = 0.85;
/** Below this alpha a pixel is background, so a part's soft edge is not outlined twice. */
const SOLID_ALPHA = 8;

/**
 * A frame's outline: every background pixel within OUTLINE_PX of a drawn one painted in the theme's ink, so the parts
 * stand clear of either theme's panel, the dark base on the dark one most. Only round the outside, as the cover is
 * see-through and a line inside it would cross the silicone.
 */
function outline(frame: ImageData, ink: [number, number, number]): void {
  const { width, height, data } = frame;
  const solid = new Uint8Array(width * height);
  for (let i = 0; i < solid.length; i++) solid[i] = data[4 * i + 3] >= SOLID_ALPHA ? 1 : 0;
  const r = OUTLINE_PX, alpha = Math.round(255 * OUTLINE_ALPHA);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (solid[i]) continue;
      let near = false;
      for (let dy = -r; dy <= r && !near; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width || dx * dx + dy * dy > r * r) continue;
          if (solid[yy * width + xx]) {
            near = true;
            break;
          }
        }
      }
      if (!near) continue;
      data[4 * i] = ink[0];
      data[4 * i + 1] = ink[1];
      data[4 * i + 2] = ink[2];
      data[4 * i + 3] = alpha;
    }
  }
}

const spawnField = (): WorkerLike => new Worker(new URL('../workers/field.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
const spawnSolid = (): WorkerLike => new Worker(new URL('../workers/solid.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;

async function explode(type: string): Promise<{ partsSha256: string; sheets: Record<HelpTheme, string> }> {
  if (!(MOLD_TYPE_IDS as readonly string[]).includes(type)) throw new Error(`There is no mold type "${type}".`);
  const entry = galleryEntry(HELP_MODEL);
  if (!entry) throw new Error(`HELP_MODEL names no gallery model ("${HELP_MODEL}").`);
  const response = await fetch(galleryUrl(entry.file));
  if (!response.ok) throw new Error(`Could not fetch gallery/${entry.file}: ${response.status}`);
  const stl = new Uint8Array(await response.arrayBuffer());
  const pipeline = new Pipeline({ spawnField, spawnSolid, frozen: true });
  const [width, height] = EXPLODE_SIZE, [columns, rows] = EXPLODE_GRID;
  const canvas = document.createElement('canvas');
  // One CSS pixel to one pixel whatever the screen, so a frame is EXPLODE_SIZE exactly.
  canvas.style.width = `${width / devicePixelRatio}px`;
  canvas.style.height = `${height / devicePixelRatio}px`;
  document.querySelector('#stage')!.append(canvas);
  const scene = new PreviewScene(canvas, { transparent: true });
  try {
    const parts = await buildHelpParts(pipeline, stl, entry.file, type as MoldTypeId);
    // The view's parts as src/ui/viewSync.ts hands them over: the model, the silicone, the split and the solids.
    const mesh = pipeline.modelMesh();
    scene.setModel(mesh, pipeline.displayProxy ?? mesh);
    const transform = pipeline.oriented?.value.oriented.transform ?? null;
    scene.setModelTransform(transform ? toMat4(transform) : null);
    scene.setModelClosed(pipeline.modelClosed());
    const field = pipeline.field!.value, cover = pipeline.cover!.value, rim = field.rim!;
    const clam = field.clam ?? null;
    scene.setField(clam ? null : field.field);
    scene.setSides(clam ? (clam.sides.map((side) => ({ field: side.field, matrix: [...toMat4(frameInverse(side.frame))], hs: side.hs })) as [ViewSide, ViewSide]) : null);
    scene.setSplit(clam ? { axis: clam.axis, xs: clam.xs, O: rim.O, Tb: rim.Tb, Zt: rim.Zt } : null);
    const extent = moldExtent(rim);
    scene.setMoldBox(extent.min, extent.max);
    scene.setPart('cover', cover.halves ? null : cover);
    scene.setPart('cover-neg', cover.halves?.[0] ?? null);
    scene.setPart('cover-pos', cover.halves?.[1] ?? null);
    scene.setClips(cover.clips ?? null);
    scene.setPart('base', pipeline.base!.value);
    scene.resize();
    // Framed once on the parts at rest and at their furthest apart, so the camera holds still through the frames.
    const reach = EXPLODE_REACH * (extent.max[2] - extent.min[2]);
    scene.setExplode(0);
    const box = scene.partsBox();
    scene.setExplode(reach);
    box.union(scene.partsBox());
    frameFixed(scene, box, AZIMUTH_DEG, ELEVATION_DEG, width / height, MARGIN);
    const sheet = document.createElement('canvas');
    sheet.width = width * columns;
    sheet.height = height * rows;
    const context = sheet.getContext('2d')!;
    // Each frame drawn once, then outlined in each theme's ink.
    const frames: ImageData[] = [];
    const still = document.createElement('canvas');
    still.width = width;
    still.height = height;
    const stillContext = still.getContext('2d', { willReadFrequently: true })!;
    for (let k = 0; k < EXPLODE_FRAMES; k++) {
      scene.setExplode(explodeAt(k, reach));
      scene.render();
      stillContext.clearRect(0, 0, width, height);
      stillContext.drawImage(canvas, 0, 0, width, height);
      frames.push(stillContext.getImageData(0, 0, width, height));
    }
    const sheets = {} as Record<HelpTheme, string>;
    for (const theme of HELP_THEMES) {
      context.clearRect(0, 0, sheet.width, sheet.height);
      frames.forEach((frame, k) => {
        const copy = new ImageData(new Uint8ClampedArray(frame.data), width, height);
        outline(copy, inkOf(theme));
        context.putImageData(copy, (k % columns) * width, Math.floor(k / columns) * height);
      });
      sheets[theme] = sheet.toDataURL('image/webp', EXPLODE_QUALITY);
      if (!sheets[theme].startsWith('data:image/webp')) throw new Error('The browser did not encode a WebP.');
      show(sheets[theme], `${type}, ${theme}`, sheet.width / 4, sheet.height / 4);
    }
    return { partsSha256: partsSha256(parts), sheets };
  } finally {
    pipeline.dispose();
    scene.dispose();
    canvas.remove();
  }
}

const hooks: MediaHooks = {
  entries: () => GALLERY.map(({ id, thumbnail: file }) => ({ id, thumbnail: file })),
  thumbnail,
  types: () => MOLD_TYPE_IDS,
  helpModel: () => HELP_MODEL,
  explode,
};
(window as unknown as { __media: MediaHooks }).__media = hooks;
