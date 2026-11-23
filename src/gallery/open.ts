import type { GalleryEntry } from './catalogue';

/**
 * GA: where a gallery file is, relative to the page, never by `/…`, so it loads at `/`, at `/mold-form-generator/`
 * and at `/mold-form-generator/beta/` alike. `folder` is `gallery/` for a model and `gallery/thumbs/` for its thumbnail.
 */
export function galleryUrl(file: string, folder = 'gallery/', base = document.baseURI): string {
  return new URL(`${folder}${encodeURIComponent(file)}`, base).href;
}

/** A gallery model's STL as the site serves it, or an error naming the file and the answer. */
export async function fetchGalleryModel(entry: GalleryEntry): Promise<Blob> {
  const response = await fetch(galleryUrl(entry.file));
  if (!response.ok) throw new Error(`Could not fetch gallery/${entry.file}: ${response.status} ${response.statusText}`.trim());
  return response.blob();
}
