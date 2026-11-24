import { sha256 } from '../app/hash';
import type { Field } from '../core/field/grid';
import type { PartMesh } from '../workers/solidStages';

/**
 * HB: the help's explode animations (docs/PLAN.md, HB): one sprite sheet per mold type and theme, drawn by
 * `npm run media -- explode` (scripts/make-help-media.mjs on media.html, src/diag/mediaPage.ts) from HELP_MODEL's
 * real parts at the preview cell, and public/help/explode.json, which says what they were drawn from. Sprite sheets,
 * not video: no encoder is needed, and Playwright's recording is neither transparent nor timed. No DOM here, so the
 * tests read the same names and build the same hash in Node.
 */

/** The themes each animation is drawn in, its outlines in that theme's --ink. */
export const HELP_THEMES = ['dark', 'light'] as const;
export type HelpTheme = (typeof HELP_THEMES)[number];

/** Frames per animation, laid out in a grid of columns by rows, the first frame top left, row by row. */
export const EXPLODE_FRAMES = 20;
export const EXPLODE_GRID: readonly [number, number] = [5, 4];
/** One frame in pixels: drawn at twice the 240 x 180 the help shows it at, so it is sharp on a 2x screen. */
export const EXPLODE_SIZE: readonly [number, number] = [480, 360];
export const EXPLODE_SCALE = 2;
/** 20 frames at 20 a second: the parts take one second to come apart. */
export const EXPLODE_FPS = 20;
/** How far the parts move at the last frame, as a share of the mold's height, by the view's own explode (EXPLODE). */
export const EXPLODE_REACH = 0.5;
/** A sheet's bytes at the most, each, as test/unit/help.test.ts holds them. */
export const EXPLODE_MAX_BYTES = 200_000;
/** The WebP quality the sheets are saved at. */
export const EXPLODE_QUALITY = 0.8;

/** What public/help/explode.json holds. */
export interface ExplodeManifest {
  /** HELP_MODEL when the sheets were drawn, and the sha256 of its STL then. */
  model: string;
  modelSha256: string;
  frames: number;
  /** Columns, rows. */
  grid: [number, number];
  /** One frame's width and height in pixels, and how many pixels the help shows it at per CSS pixel. */
  size: [number, number];
  scale: number;
  fps: number;
  /** Per mold type: the hash of the parts its sheets show (partsSha256). */
  types: Record<string, { partsSha256: string }>;
}

/** A sheet's file in public/help/. */
export function explodeFile(type: string, theme: HelpTheme): string {
  return `explode-${type}-${theme}.webp`;
}

/** Ease out, cubic: fast at first, settling at the end, as a part pulled free does. */
export function easeOut(t: number): number {
  const u = 1 - Math.min(1, Math.max(0, t));
  return 1 - u * u * u;
}

/** How far the view's explode is moved at a frame, the first at 0 and the last at `reach`. */
export function explodeAt(frame: number, reach: number, frames = EXPLODE_FRAMES): number {
  return reach * easeOut(frame / (frames - 1));
}

/** Where frame k lies in a sheet, as a background-position in percent, the grid's columns by rows. */
export function framePosition(k: number, grid: readonly [number, number] = EXPLODE_GRID): [number, number] {
  const [columns, rows] = grid;
  const column = k % columns, row = Math.floor(k / columns);
  return [columns > 1 ? (column / (columns - 1)) * 100 : 0, rows > 1 ? (row / (rows - 1)) * 100 : 0];
}

/**
 * What an animation shows, by the view's names: the cover or the halves, the base, and one seam clip with clips; the
 * silicone, the field or each half's side field; and the split P, its axis and place, for the two-part cover.
 */
export interface HelpParts {
  parts: { name: string; mesh: PartMesh }[];
  fields: { name: string; field: Field; hs: number }[];
  split: { axis: string; xs: number } | null;
}

/** What the pipeline holds of a cover, a base and a field, as HelpParts reads them: S13's, S15's and S6's outputs. */
export interface BuiltParts {
  cover: (PartMesh & { halves?: [PartMesh, PartMesh]; clips?: { key: PartMesh } | null }) | null;
  base: PartMesh | null;
  field?: { field: Field; clam?: { axis: string; xs: number; sides: readonly { field: Field; hs: number }[] } | null } | null;
}

/**
 * The parts of a build, as the animation draws them: neg's half first, then pos's, or the cover; then the base and a
 * clip; the side fields neg first, or the field; and the split.
 */
export function helpParts(built: BuiltParts): HelpParts {
  const parts: HelpParts['parts'] = [];
  const { cover, base, field } = built;
  if (cover?.halves) parts.push({ name: 'cover-neg', mesh: cover.halves[0] }, { name: 'cover-pos', mesh: cover.halves[1] });
  else if (cover) parts.push({ name: 'cover', mesh: cover });
  if (base) parts.push({ name: 'base', mesh: base });
  if (cover?.clips) parts.push({ name: 'clip', mesh: cover.clips.key });
  const clam = field?.clam ?? null;
  const fields: HelpParts['fields'] = clam
    ? clam.sides.map((side, k) => ({ name: k === 0 ? 'silicone-neg' : 'silicone-pos', field: side.field, hs: side.hs }))
    : field
      ? [{ name: 'silicone', field: field.field, hs: 0 }]
      : [];
  return { parts, fields, split: clam ? { axis: clam.axis, xs: clam.xs } : null };
}

/** Vertices, heights and places are rounded to this many mm before hashing, so a last bit's difference between builds does not count. */
export const PARTS_ROUND_MM = 1e-3;

/** Lengths in mm as 32-bit integers in units of PARTS_ROUND_MM. */
function rounded(values: ArrayLike<number>): Uint8Array {
  const out = new Int32Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = Math.round(values[i] / PARTS_ROUND_MM);
  return new Uint8Array(out.buffer);
}

/**
 * The sha256 of what an animation shows, as explode.json's `partsSha256`: each part's name, then its vertices in units
 * of PARTS_ROUND_MM as 32-bit integers, then its triangles; each field's name, its grid and seam height, then its
 * heights, rounded the same way; then the split's axis and place; little-endian. The same build again in Node gives it
 * (test/unit/help.test.ts), so a change to how the parts, the silicone or the split are built asks for the animations
 * to be drawn again.
 */
export function partsSha256({ parts, fields, split }: HelpParts): string {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const { name, mesh } of parts) {
    chunks.push(encoder.encode(`${name}\n`));
    const header = new Int32Array([mesh.positions.length / 3, mesh.indices.length / 3]);
    chunks.push(new Uint8Array(header.buffer), rounded(mesh.positions), new Uint8Array(new Uint32Array(mesh.indices).buffer));
  }
  for (const { name, field, hs } of fields) {
    chunks.push(encoder.encode(`${name}\n`), new Uint8Array(new Int32Array([field.nx, field.ny]).buffer), rounded([field.cell, field.x0, field.y0, hs]), rounded(field.values));
  }
  if (split) chunks.push(encoder.encode(`split ${split.axis}\n`), rounded([split.xs]));
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return sha256(bytes);
}
