import type { GalleryId } from '../gallery/catalogue';

/**
 * HB: the model every help animation shows (R46), one of the gallery's own models, so help needs no credit. The sphere,
 * by the user's answer of 2026-11-22: a cube has no overhang, so it shows no split. Change it here, then run
 * `npm run media -- explode` to draw the animations again; test/unit/help.test.ts fails until they are.
 */
export const HELP_MODEL: GalleryId = 'sphere';

/** HB: how long a pointer rests on a control, or the keyboard's focus stays on it, before its hint card shows. */
export const HINT_DELAY_MS = 400;
