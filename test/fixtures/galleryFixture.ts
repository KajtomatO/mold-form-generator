import { GALLERY, type GalleryEntry, type ThirdPartyEntry } from '../../src/gallery/catalogue';

/**
 * GA: a gallery model not ours, for the tests, as the catalogue holds none until MP6 (docs/PLAN.md, GA): the cube's
 * file under another id, with an author, the pages and CC BY 4.0. Passed to the catalogue's functions in Node, and
 * added in the browser through the test hooks (addGalleryEntry) under ?test=1. Its pages are examples only, never
 * fetched.
 */
export const THIRD_PARTY: ThirdPartyEntry = {
  id: 'fixture-block',
  file: 'cube.stl',
  title: 'Test Block',
  thumbnail: 'cube.webp',
  heightMm: 40,
  triangles: 12,
  bytes: 684,
  twoPart: false,
  own: false,
  author: 'A. Tester',
  authorUrl: 'https://www.printables.com/@ATester_1',
  url: 'https://www.printables.com/model/1',
  licence: 'CC-BY-4.0',
  modified: 'No',
};

/** The gallery with the fixture's model at its end, as a test page's is once the hook has added it. */
export const WITH_THIRD_PARTY: readonly GalleryEntry[] = [...GALLERY, THIRD_PARTY];
