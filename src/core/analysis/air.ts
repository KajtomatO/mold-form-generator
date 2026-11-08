import type { SealedDomain, IntervalReport, UndersidePocket } from './intervals';
import { HEIGHT_STEP } from './peaks';
import type { UncoveredLeaf } from './placement';

/** Said with every air result: the analysis knows the shape, not how fast the silicone is poured. */
export const RISING_LEVEL_NOTE = 'This assumes the silicone rises slowly and evenly; a fast pour can trap air elsewhere too.';

export interface AirReport {
  /** Peaks of the cover's ceiling past the vent persistence, from placement, and those with no opening. */
  ceilingLeaves: number;
  uncovered: UncoveredLeaf[];
  /** Pockets under the model past both filters, highest persistence first. */
  underside: UndersidePocket[];
  /** Sealed space past the volume filter, largest first. Harmless: no silicone goes there. */
  sealed: SealedDomain[];
  /**
   * What the silicone figure takes off per tile, in mm3: sealed space the base plate or the model closes
   * off. A void inside the model is not in it, as the model's volume already holds that.
   */
  sealedAir: number;
  /** How many each filter left out, so a report can say the tiny ones were looked at. */
  filtered: { underside: number; sealed: number };
}

export interface AirOptions {
  /** reports.minVolumeMl in mm3. */
  minVolume: number;
  /** reports.undersidePersistence in mm. */
  minPersistence: number;
}

/**
 * The plan's air traps: ceiling leaves, from M4's merge tree on the cover's ceiling; pockets under the
 * model with the model as their ceiling, past the persistence and volume filters, which no top vent can
 * reach; and sealed domains past the volume filter, which are harmless.
 */
export function airReport(s8: Pick<IntervalReport, 'pockets' | 'sealed'>, ceiling: { leaves: number; uncovered: UncoveredLeaf[] }, options: AirOptions): AirReport {
  const { minVolume, minPersistence } = options;
  // Persistence is in whole steps, so half a step of slack only absorbs float noise in the threshold.
  const underside = s8.pockets.filter((p) => p.persistence >= minPersistence - HEIGHT_STEP / 2 && p.volume >= minVolume);
  const sealed = s8.sealed.filter((d) => d.volume >= minVolume);
  const sealedAir = sealed.filter((d) => !d.inModel).reduce((sum, d) => sum + d.volume, 0);
  return {
    ceilingLeaves: ceiling.leaves,
    uncovered: ceiling.uncovered,
    underside,
    sealed,
    sealedAir,
    filtered: { underside: s8.pockets.length - underside.length, sealed: s8.sealed.length - sealed.length },
  };
}
