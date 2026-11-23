import type { ParamPath } from '../../app/stages';
import { PARAM_SCHEMA, type Params } from '../params/schema';
import { MANIFOLD_TRIANGLE_LIMIT } from '../mesh/simplify';
// The attribute lets Node load it too, as the browser tests do through Playwright.
import CLAMSHELL from '../params/defaults.clamshell.json' with { type: 'json' };

/**
 * MT: the mold types (docs/PLAN.md, MT and G13.14; R44, D27). Each type shares every setting of the schema; what
 * differs is its defaults, kept as overrides of defaults.json in src/core/params/defaults.<type>.json, which the
 * build checks (src/app/defaultsCheck.ts, checkOverridesText), its locks, which effectiveParams applies, and when
 * it cannot be chosen. What the user reads of a type, its name, blurb and pictogram, is src/ui/mold/moldTypeUi.ts.
 */

/** The types by id, as the schema's `mold.type` takes them, in the order their tiles show. */
export const MOLD_TYPE_IDS = PARAM_SCHEMA.mold.type.options;
export type MoldTypeId = (typeof MOLD_TYPE_IDS)[number];

/** The type a page opens with, and a project file of format 7 that names none. A reload opens as it, as settings are not kept between visits. */
export const DEFAULT_MOLD_TYPE: MoldTypeId = 'one-piece';

/** A setting this type holds at one value, whatever the user set: the user's value stays in params, for switching back. */
export interface Lock {
  path: ParamPath;
  value: unknown;
  /** Why, in the words the locked row shows under itself and as its title. */
  reason: string;
}

/** What `unavailable` knows of the model on screen: each null while it is not known, or with no model. */
export interface TypeContext {
  /** Bodies the import found, joined parts counted as one (SolidReport.bodies). */
  bodies: number | null;
  /** The model's triangles as loaded. */
  triangles: number | null;
  /** Whether the model on screen is a simplified copy (G1.9, MM2). */
  simplified: boolean;
}

export interface MoldType {
  id: string;
  /** The settings whose default differs from defaults.json's, by path, from the type's defaults file. */
  overrides: Readonly<Partial<Record<ParamPath, unknown>>>;
  locked: readonly Lock[];
  /** Whether a setting means anything in this type: one that does not is hidden, and keeps its value. */
  applies(path: ParamPath): boolean;
  /** Why the type cannot be chosen for this model, or null when it can. */
  unavailable(ctx: TypeContext): string | null;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A defaults file's overrides, nested by group as defaults.json is, flattened to paths. A file the build's check
 * passed holds only known paths; one it did not never reaches a build, so nothing more is checked here.
 */
export function overridesOf(file: unknown): Partial<Record<ParamPath, unknown>> {
  const out: Partial<Record<ParamPath, unknown>> = {};
  if (!isObject(file)) return out;
  for (const [group, values] of Object.entries(file)) {
    if (!isObject(values)) continue;
    for (const [key, value] of Object.entries(values)) out[`${group}.${key}` as ParamPath] = value;
  }
  return out;
}

/** The two-part cover's own settings, which only it reads. */
const TWO_PART = (path: ParamPath): boolean => path.startsWith('clamshell.') || path.startsWith('clips.');

/**
 * Types built but not yet offered outside the tests: the two-part cover's tile shows, unavailable, until MP5 joins
 * its stages to the pipeline (docs/PLAN.md, 0.3.0's runs). `enableMoldType`, which the test hooks call under
 * ?test=1, lifts it, so this run's tests reach the switch window and its rows.
 */
const NOT_BUILT = new Set<string>(['clamshell']);

/** Lifts "Not built yet" from a type, for the tests (src/app/testHooks.ts). */
export function enableMoldType(id: string): void {
  NOT_BUILT.delete(id);
}

/** Puts "Not built yet" back, so one test's enable does not reach the next. */
export function disableMoldType(id: string): void {
  NOT_BUILT.add(id);
}

export const NOT_BUILT_YET = 'Not built yet';

export const MOLD_TYPES: Readonly<Record<MoldTypeId, MoldType>> = {
  'one-piece': {
    id: 'one-piece',
    overrides: {},
    locked: [],
    applies: (path) => !TWO_PART(path),
    unavailable: () => null,
  },
  clamshell: {
    id: 'clamshell',
    overrides: overridesOf(CLAMSHELL),
    // G13.14, with G13.10.13's reason for the bolts.
    locked: [
      { path: 'grid.nx', value: 1, reason: 'This type makes one model.' },
      { path: 'grid.ny', value: 1, reason: 'This type makes one model.' },
      { path: 'bolts.enabled', value: false, reason: 'The halves print on their backs, so corner bolts would lie sideways; this type bolts the seam (Seam fasteners).' },
      { path: 'joint.pryNotches', value: false, reason: 'The halves slide off the base; pry at the seam\'s V pockets.' },
    ],
    applies: () => true,
    unavailable(ctx) {
      if (NOT_BUILT.has('clamshell')) return NOT_BUILT_YET;
      if (ctx.bodies !== null && ctx.bodies > 1) return `It makes one model, and this file holds ${ctx.bodies}`;
      if (ctx.triangles !== null && ctx.triangles > MANIFOLD_TRIANGLE_LIMIT && !ctx.simplified) return `Past ${MANIFOLD_TRIANGLE_LIMIT.toLocaleString('en-US')} triangles it needs the model simplified when it is opened`;
      return null;
    },
  },
};

/** The types in the order their tiles show. */
export const MOLD_TYPE_LIST: readonly MoldType[] = MOLD_TYPE_IDS.map((id) => MOLD_TYPES[id]);

export function isMoldType(id: unknown): id is MoldTypeId {
  return typeof id === 'string' && (MOLD_TYPE_IDS as readonly string[]).includes(id);
}

/** The type a set of params is for: its own, or the default where it names none this version knows. */
export function moldTypeOf(params: Params): MoldType {
  const id = params.mold?.type;
  return MOLD_TYPES[isMoldType(id) ? id : DEFAULT_MOLD_TYPE];
}

/** The lock on a setting in this type, or null. */
export function lockOf(path: ParamPath, params: Params): Lock | null {
  return moldTypeOf(params).locked.find((lock) => lock.path === path) ?? null;
}

const memo = new WeakMap<Params, Params>();

/**
 * MT: the params every stage key, check, export and report reads: the user's, with the type's locks applied. A type
 * with no lock, the one-piece among them, gives the same object back, so nothing it builds can differ. The user's
 * own values stay in `params`, so a switch back finds them. One object per params, so a key worked out twice is one.
 */
export function effectiveParams(params: Params): Params {
  const locked = moldTypeOf(params).locked;
  if (locked.length === 0) return params;
  const known = memo.get(params);
  if (known) return known;
  let out = params;
  for (const lock of locked) {
    const [group, key] = lock.path.split('.') as [keyof Params, string];
    if ((out[group] as Record<string, unknown>)[key] === lock.value) continue;
    if (out === params) out = { ...params };
    out[group] = { ...(out[group] as object), [key]: lock.value } as never;
  }
  memo.set(params, out);
  return out;
}
