import type { MoldTypeId } from '../../core/mold/types';

/**
 * MT: what the user reads of each mold type (docs/PLAN.md, MT): its name, a one-line blurb, the pictogram its tile
 * draws (src/ui/mold/MoldTypeIcon.tsx) and the help topic HB's help registry will give it. The registry, with each
 * type's defaults and locks, is src/core/mold/types.ts; test/unit/moldTypes.test.ts holds both to the same keys.
 * Plain data, so the workers, project files and README.txt can name a type too.
 */
export interface MoldTypeUi {
  name: string;
  blurb: string;
  /** A key of MOLD_TYPE_ICONS in MoldTypeIcon.tsx. */
  icon: string;
  /** The topic its "?" opens once HB builds the help (src/help/). */
  help: string;
}

export const MOLD_TYPE_UI: Readonly<Record<MoldTypeId, MoldTypeUi>> = {
  'one-piece': {
    name: 'One-piece cover',
    blurb: 'A cover that lifts straight up off the base. Every model and grid.',
    icon: 'one-piece',
    help: 'mold-type-one-piece',
  },
  clamshell: {
    name: 'Two-part cover',
    blurb: 'Two halves that slide apart, for less silicone. One model.',
    icon: 'clamshell',
    help: 'mold-type-clamshell',
  },
};

/** One tile of the switch, as the layout lays it out: the type's id with what it shows, and why it cannot be chosen, if so. */
export interface MoldTypeTile extends MoldTypeUi {
  id: string;
  unavailable: string | null;
}

/**
 * The switch's tiles, one per type in the registry's order, each with its UI's words: the layout's data, which a
 * registry of any length fills with no other change, as more types wrap in the block's grid.
 */
export function moldTypeTiles(types: readonly { id: string; unavailable: (ctx: never) => string | null }[], ui: Readonly<Record<string, MoldTypeUi>>, ctx: unknown): MoldTypeTile[] {
  return types.map((type) => {
    const words = ui[type.id];
    if (!words) throw new Error(`The mold type ${type.id} has no name, blurb or pictogram in moldTypeUi.ts.`);
    return { id: type.id, ...words, unavailable: type.unavailable(ctx as never) };
  });
}
