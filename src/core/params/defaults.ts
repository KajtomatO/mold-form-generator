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

/** The auto values that depend only on other parameters and the model's size. */
export interface ResolvedAuto {
  pocketDepth: number;
  printMargin: number;
  ventPersistence: number;
  planeTol: number;
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
    boltLength: boltNeeds(params).autoLength,
  };
}

export function baseOptions(params: Params, bounds: Bounds): BaseOptions {
  return { planeTol: resolveAuto(params, bounds).planeTol, minIsland: params.base.minIsland };
}
