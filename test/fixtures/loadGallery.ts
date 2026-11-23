import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GALLERY, galleryEntry, type GalleryEntry } from '../../src/gallery/catalogue';

/** Where the gallery's files are: the site serves public/ as it is. */
export const GALLERY_DIR = join(import.meta.dirname, '..', '..', 'public', 'gallery');

/** GA: a gallery model's STL by its id, as loadExamples.ts gives the test models. */
export function loadGallery(id: string, list: readonly GalleryEntry[] = GALLERY): Uint8Array {
  const entry = galleryEntry(id, list);
  if (!entry) throw new Error(`The gallery has no model "${id}".`);
  return new Uint8Array(readFileSync(join(GALLERY_DIR, entry.file)));
}
