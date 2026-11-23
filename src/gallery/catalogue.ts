/**
 * GA: the example gallery (R47, R48, D29). The one list the UI, the tests and the constants read: each model's
 * file in public/gallery/, its thumbnail in public/gallery/thumbs/, its size and counts, and whose it is. The
 * project's own models are CC0; a model not ours carries its author, its pages, its licence and whether it was
 * changed, which public/gallery/SOURCES.md repeats for the site. test/unit/gallery.test.ts holds the list to
 * the files git tracks there, to SOURCES.md and to the thumbnails.
 */

/** The licences a gallery model may carry, by SPDX id: each allows any use, commercial use and changes included. */
export const GALLERY_LICENCES = {
  'CC0-1.0': { name: 'CC0 1.0 Universal', short: 'CC0 1.0', deed: 'https://creativecommons.org/publicdomain/zero/1.0/' },
  'CC-BY-4.0': { name: 'Creative Commons Attribution 4.0 International', short: 'CC BY 4.0', deed: 'https://creativecommons.org/licenses/by/4.0/' },
  'CC-BY-SA-4.0': { name: 'Creative Commons Attribution-ShareAlike 4.0 International', short: 'CC BY-SA 4.0', deed: 'https://creativecommons.org/licenses/by-sa/4.0/' },
} as const;

export type GalleryLicence = keyof typeof GALLERY_LICENCES;

export const isGalleryLicence = (value: unknown): value is GalleryLicence => typeof value === 'string' && Object.hasOwn(GALLERY_LICENCES, value);

interface EntryBase {
  /** As `?model=<id>` names it, and as project.json's `gallery.id` keeps it. */
  id: string;
  /** In public/gallery/. */
  file: string;
  title: string;
  /** In public/gallery/thumbs/, 192 x 192 WebP, from `npm run media -- thumbs`. */
  thumbnail: string;
  /** From its lowest point to its highest, in mm, as it stands on its base face. */
  heightMm: number;
  triangles: number;
  bytes: number;
  /** It suits the two-part cover: the sphere, and a complex model measured to save at least 15 % silicone with it. */
  twoPart: boolean;
}

/** One of the project's own models, made by scripts/make-gallery-primitives.mjs and published under CC0. */
export interface OwnEntry extends EntryBase {
  own: true;
  licence: 'CC0-1.0';
}

/** A model the project does not own: whose it is and where it comes from, which the credit shows (R48). */
export interface ThirdPartyEntry extends EntryBase {
  own: false;
  author: string;
  /** The author's page on the model's source. */
  authorUrl: string;
  /** The model's own page on its source, such as a Printables page by its number alone. */
  url: string;
  licence: GalleryLicence;
  /** "No", or "Yes, " and what was changed. */
  modified: string;
}

export type GalleryEntry = OwnEntry | ThirdPartyEntry;

/**
 * What project.json keeps of a model not ours (`gallery`), so a saved project shows its credit again without
 * looking it up, in README.txt too.
 */
export interface GalleryCredit {
  id: string;
  title: string;
  author: string;
  authorUrl: string;
  url: string;
  licence: GalleryLicence;
}

export const GALLERY: readonly GalleryEntry[] = [
  { id: 'sphere', file: 'sphere.stl', title: 'Sphere', thumbnail: 'sphere.webp', heightMm: 40, triangles: 2022, bytes: 101_184, twoPart: true, own: true, licence: 'CC0-1.0' },
  { id: 'cube', file: 'cube.stl', title: 'Cube', thumbnail: 'cube.webp', heightMm: 40, triangles: 12, bytes: 684, twoPart: false, own: true, licence: 'CC0-1.0' },
  { id: 'cylinder', file: 'cylinder.stl', title: 'Cylinder', thumbnail: 'cylinder.webp', heightMm: 40, triangles: 508, bytes: 25_484, twoPart: false, own: true, licence: 'CC0-1.0' },
  { id: 'cone', file: 'cone.stl', title: 'Cone', thumbnail: 'cone.webp', heightMm: 40, triangles: 254, bytes: 12_784, twoPart: false, own: true, licence: 'CC0-1.0' },
];

/** The model a plain page load opens (D29), and the one the help's animations show. */
export const DEFAULT_GALLERY_MODEL = 'sphere';

/** The `?model=` value that keeps the page empty. */
export const NO_MODEL = 'none';

export function galleryEntry(id: string, list: readonly GalleryEntry[] = GALLERY): GalleryEntry | null {
  return list.find((entry) => entry.id === id) ?? null;
}

/** The credit of a model not ours, as project.json keeps it; null for our own, which needs none. */
export function creditOf(entry: GalleryEntry): GalleryCredit | null {
  if (entry.own) return null;
  return { id: entry.id, title: entry.title, author: entry.author, authorUrl: entry.authorUrl, url: entry.url, licence: entry.licence };
}

/** Where a model's page is, as the credit names it: Printables, or the page's host. */
export function sourceName(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
  const known: Record<string, string> = { 'printables.com': 'Printables', 'thingiverse.com': 'Thingiverse', 'sketchfab.com': 'Sketchfab', '3d.si.edu': 'Smithsonian 3D' };
  return known[host] ?? host;
}

/** The credit as one line of plain text, as README.txt and a card's title say it: "<Title> by <author> · <source> · <licence>". */
export function creditText(credit: GalleryCredit): string {
  return `${credit.title} by ${credit.author} · ${sourceName(credit.url)} · ${GALLERY_LICENCES[credit.licence].short}`;
}

/** "40 mm tall, 2,022 triangles", as a card says it. */
export function entryFacts(entry: GalleryEntry): string {
  return `${entry.heightMm} mm tall, ${entry.triangles.toLocaleString('en-US')} triangles`;
}

/** A page's `?model=` value, or null when it names none. */
export function modelOfQuery(search: string): string | null {
  return new URLSearchParams(search).get('model');
}

/**
 * Which gallery model a page load opens (D29): `?model=<id>` on any load, `model=none` none; with neither, the
 * default on a plain load and none under `?test=1`, so the tests that start from an empty page keep it.
 */
export function modelToOpen(search: string, list: readonly GalleryEntry[] = GALLERY): string | null {
  const query = new URLSearchParams(search);
  const asked = query.get('model');
  if (asked === NO_MODEL) return null;
  if (asked !== null) return galleryEntry(asked, list) ? asked : null;
  return query.get('test') === '1' ? null : DEFAULT_GALLERY_MODEL;
}
