import { parseStl } from '../core/stl/parse';
import { GALLERY, galleryEntry } from '../gallery/catalogue';
import { galleryUrl } from '../gallery/open';
import { ThumbnailRenderer } from '../view/thumbnail';

/**
 * GA: the media page (media.html), which scripts/make-help-media.mjs drives in Playwright's Chromium. It draws each
 * gallery model as the view draws a model (src/view/thumbnail.ts) and hands back the picture as WebP. HB adds the
 * explode animations here.
 */

/** A thumbnail's side in pixels, as public/gallery/thumbs/ holds them. */
export const THUMB_SIZE = 192;

export interface MediaHooks {
  /** The gallery's models, in its order: each id, and the file its thumbnail is saved as. */
  entries(): { id: string; thumbnail: string }[];
  /** One model's thumbnail, as a data: URL of a WebP. */
  thumbnail(id: string): Promise<string>;
}

const renderer = new ThumbnailRenderer(THUMB_SIZE);

async function thumbnail(id: string): Promise<string> {
  const entry = galleryEntry(id);
  if (!entry) throw new Error(`The gallery has no model "${id}".`);
  const response = await fetch(galleryUrl(entry.file));
  if (!response.ok) throw new Error(`Could not fetch gallery/${entry.file}: ${response.status}`);
  const url = renderer.draw(parseStl(new Uint8Array(await response.arrayBuffer())).positions);
  const img = document.createElement('img');
  img.src = url;
  img.alt = entry.title;
  img.width = img.height = THUMB_SIZE;
  document.querySelector('#out')!.append(img);
  return url;
}

const hooks: MediaHooks = { entries: () => GALLERY.map(({ id, thumbnail: file }) => ({ id, thumbnail: file })), thumbnail };
(window as unknown as { __media: MediaHooks }).__media = hooks;
