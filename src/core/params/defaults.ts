import { autoPlaneTol, type BaseOptions } from '../base/candidates';
import type { Bounds } from '../mesh/weld';
import { boltNeeds } from '../parts/bolts';
import { PARAM_SCHEMA, type ParamDef, type Params } from './schema';

/** A fresh object every call, so editing one project's values cannot reach another's. */
export function defaultParams(): Params {
  const groups = Object.entries(PARAM_SCHEMA).map(([group, defs]) => [
    group,
    Object.fromEntries(Object.entries(defs as Record<string, ParamDef>).map(([key, def]) => [key, def.default])),
  ]);
  return Object.fromEntries(groups) as Params;
}

/**
 * Whether a setting holds its default, which the sidebar marks with a grey dot (CS, D22). An auto setting is at
 * its default only while it is null, following its rule: one typed equal to what the rule gives, such as a
 * pocket of 0.2 at a 0.2 layer, no longer follows it, so it counts as changed. Every other kind compares its
 * value with the schema's default exactly: the slider and the wheel round to the step, typing gives the number
 * typed, and JSON keeps numbers as they are, so 3.0000001 typed by hand is changed, as it is.
 */
export function isDefault(def: ParamDef, value: unknown): boolean {
  return def.kind === 'auto' ? value === null : value === def.default;
}

/** The auto values that depend only on other parameters and the model's size. */
export interface ResolvedAuto {
  pocketDepth: number;
  printMargin: number;
  ventPersistence: number;
  planeTol: number;
  /** The silicone base layer follows the silicone thickness until edited. */
  baseLayer: number;
  /** The shortest standard screw that passes the nut, whether or not the bolts are on. */
  boltLength: number;
}

export function resolveAuto(params: Params, bounds: Bounds): ResolvedAuto {
  const layer = params.print.layerHeight;
  return {
    pocketDepth: params.base.pocketDepth ?? layer,
    printMargin: params.silicone.printMargin ?? layer / 2,
    ventPersistence: params.vents.persistence ?? params.silicone.t / 2,
    planeTol: params.base.planeTol ?? autoPlaneTol(bounds),
    baseLayer: params.silicone.baseLayer ?? params.silicone.t,
    boltLength: boltNeeds(params).autoLength,
  };
}

export function baseOptions(params: Params, bounds: Bounds): BaseOptions {
  return { planeTol: resolveAuto(params, bounds).planeTol, minIsland: params.base.minIsland };
}
