import { autoPlaneTol, type BaseOptions } from '../base/candidates';
import type { Bounds } from '../mesh/weld';
import type { ParamPath } from '../../app/stages';
import { DEFAULT_MOLD_TYPE, MOLD_TYPES, moldTypeOf, type MoldTypeId } from '../mold/types';
import { boltNeeds } from '../parts/bolts';
import { PARAM_SCHEMA, type ParamDef, type Params } from './schema';

/**
 * A fresh object every call, so editing one project's values cannot reach another's: the schema's defaults, which
 * are defaults.json's, with the type's overrides (MT). With no type, the one-piece cover's, which every caller that
 * is not about a type, such as the pipeline's start and the tests' fixtures, keeps.
 */
export function defaultParams(type: MoldTypeId = DEFAULT_MOLD_TYPE): Params {
  const groups = Object.entries(PARAM_SCHEMA).map(([group, defs]) => [
    group,
    Object.fromEntries(Object.entries(defs as Record<string, ParamDef>).map(([key]) => [key, defaultOf(`${group}.${key}` as ParamPath, type)])),
  ]);
  return Object.fromEntries(groups) as Params;
}

/** The schema's definition of a path, split here, as this module cannot import the stage table's. */
function defOfPath(path: ParamPath): ParamDef {
  const [group, key] = path.split('.');
  return (PARAM_SCHEMA as unknown as Record<string, Record<string, ParamDef>>)[group][key];
}

/**
 * A setting's default in a type (MT): its override in the type's defaults file, or the schema's. `mold.type`'s is
 * the type itself. An automatic setting's is null, following its rule, unless the type gives it a number, as the
 * two-part cover gives the base layer 0.
 */
export function defaultOf(path: ParamPath, type: MoldTypeId = DEFAULT_MOLD_TYPE): unknown {
  if (path === 'mold.type') return type;
  const overrides = MOLD_TYPES[type].overrides;
  return Object.hasOwn(overrides, path) ? overrides[path] : defOfPath(path).default;
}

/**
 * Whether a setting holds its default in the type `params` are for, which the sidebar marks with a grey dot (CS,
 * D22; MT). An auto setting whose default is null is at it only while it is null, following its rule: one typed
 * equal to what the rule gives, such as a pocket of 0.2 at a 0.2 layer, no longer follows it, so it counts as
 * changed; one the type gives a number is at it while it holds that number, and automatic counts as changed. Every
 * other kind compares its value with the default exactly: the slider and the wheel round to the step, typing gives
 * the number typed, and JSON keeps numbers as they are, so 3.0000001 typed by hand is changed, as it is. The type
 * itself is no setting a mark or a Reset reads, so it is always at its default.
 */
export function isDefaultAt(path: ParamPath, params: Params): boolean {
  if (path === 'mold.type') return true;
  return isDefaultIn(path, valueAt(params, path), moldTypeOf(params).id as MoldTypeId);
}

/** The same for a value under a type named: what the switch window asks of the type it leaves. */
export function isDefaultIn(path: ParamPath, value: unknown, type: MoldTypeId): boolean {
  return value === defaultOf(path, type);
}

function valueAt(params: Params, path: ParamPath): unknown {
  const [group, key] = path.split('.') as [keyof Params, string];
  return (params[group] as Record<string, unknown>)[key];
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
