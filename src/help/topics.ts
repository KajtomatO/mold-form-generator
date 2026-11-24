import type { MoldTypeId } from '../core/mold/types';

/**
 * HB: the help registry (R46, D27), one for the whole app: each topic's title, a one-line summary, its text in plain
 * paragraphs, what it shows, and the topics it leads on to. A control names its topic by `data-help="<id>"`, and a "?"
 * by `<HelpButton id="<id>">` (src/help/HelpButton.tsx); test/unit/help.test.ts holds every id used in src/ to this
 * list. Later help moves the settings' `title=` hints (HINTS) here one at a time. Plain data, with no DOM, so the
 * tests read it in Node.
 */
export type HelpId = 'mold.type' | 'mold.one-piece' | 'mold.clamshell' | 'seam-bolts' | 'seam-clips';

/** The help's pictograms, each a drawing in src/help/Pictogram.tsx (PICTOGRAMS). */
export type PictogramId = 'one-piece' | 'clamshell' | 'seam-bolts' | 'seam-clips';

/** What a topic shows: a mold type's explode animation (public/help/), or a pictogram. */
export type HelpMedia = { kind: 'animation'; type: MoldTypeId } | { kind: 'image'; pictogram: PictogramId };

export interface HelpTopic {
  title: string;
  /** One line, as the hover card says it. */
  summary: string;
  /** Plain text, a paragraph each. */
  body: string[];
  media?: HelpMedia;
  related?: HelpId[];
}

export const HELP: Readonly<Record<HelpId, HelpTopic>> = {
  'mold.type': {
    title: 'Mold type',
    summary: 'How the cover round the model comes apart, and so how much silicone it takes.',
    body: [
      'Each type has its own defaults. Where a setting you changed differs from the new type\'s default, switching opens a window to keep or drop each such change. Ctrl+Z switches back.',
    ],
    related: ['mold.one-piece', 'mold.clamshell'],
  },
  'mold.one-piece': {
    title: 'One-piece cover',
    summary: 'A cover that lifts straight up off the base. Every model and grid.',
    body: [
      'The cover is one print, set over the model on its base plate and held to it by tape or by corner bolts. It works for any model and for a grid of copies.',
      'To demold, take the base off from below, then slide the silicone out of the cover, which widens toward the base.',
    ],
    media: { kind: 'animation', type: 'one-piece' },
  },
  'mold.clamshell': {
    title: 'Two-part cover',
    summary: 'Two halves that slide apart, for less silicone. One model.',
    body: [
      'One upright plane splits the cover into two halves that slide off the base sideways, so their ceilings follow the model\'s sides and the silicone stays a jacket round it. The app places the split for the least silicone among those whose halves fit your bed, and the Two-part tile says what it saves on this model.',
      'Each half\'s ceilings slope up toward the seam, where the vents are. It makes one model, so the grid stays at 1 x 1. To demold, take the seam fasteners out and slide the halves apart.',
    ],
    media: { kind: 'animation', type: 'clamshell' },
    related: ['seam-bolts', 'seam-clips'],
  },
  'seam-bolts': {
    title: 'Seam bolts',
    summary: 'M3 countersunk screws through printed lugs on the two end faces, into nuts in the other half.',
    body: ['The default Seam fasteners. README.txt lists the screws and nuts to buy, and the fit test\'s seam bolt coupon checks them on your printer.'],
    media: { kind: 'image', pictogram: 'seam-bolts' },
  },
  'seam-clips': {
    title: 'Seam clips',
    summary: 'Printed tapered clips that slide into dovetail sockets in a pair of ears, one on each half. Nothing to buy.',
    body: ['Print them at 100 percent infill, standing on their heads as clips.stl lays them out, and set Clip clearance from the fit test\'s clip coupon first. Keep Vaseline off them, and do not warm a PLA mold above 40 C to speed the cure.'],
    media: { kind: 'image', pictogram: 'seam-clips' },
  },
};

export function isHelpId(id: string): id is HelpId {
  return Object.hasOwn(HELP, id);
}

/** A topic by its id, or null for one the registry does not hold, such as a test's fixture type's. */
export function helpTopic(id: string): HelpTopic | null {
  return isHelpId(id) ? HELP[id] : null;
}
